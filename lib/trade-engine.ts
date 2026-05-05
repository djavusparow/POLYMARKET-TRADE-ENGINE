// lib/trade-engine.ts
// ✅ PATCH #4: Null guard market_id di updateCryptoUpDownTrades
// ✅ FIXED: Duplikasi getCredentials() dihapus
// ✅ FIXED: credentials mapping cocok dengan server resolveCredentials
// ✅ FIXED: PnL formula untuk binary market (Polymarket)

import type {
  Trade,
  CombinedSignal,
  TradingSettings,
  PortfolioStats,
  AccountCredentials,
  SignalDirection,
} from './types'

function safeUUID(): string {
  try { return crypto.randomUUID() } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 6)}`
  }
}

const CREDENTIALS_KEY = 'polytrade_credentials'

// ═══════════════════════════════════════════════════════════════════════════════
// 1. CRYPTO UP/DOWN
// ═══════════════════════════════════════════════════════════════════════════════

export interface CryptoUpDownTrade {
  id: string
  market_id: string
  coin: string
  window: '5m' | '15m'
  side: 'UP' | 'DOWN'
  entryPrice: number
  currentPrice: number
  size: number
  entryTime: number
  expiryTime: number
  stopLossPct: number
  takeProfitPct: number
  stopLossPrice: number
  takeProfitPrice: number
  status: 'OPEN' | 'CLOSED_WIN' | 'CLOSED_LOSS' | 'EXPIRED'
  pnl: number
  pnlPct: number
  closedAt?: number
  signalConfidence: number
  rationale?: string
}

const CRYPTO_TRADES_KEY   = 'polytrade_crypto_updown_trades'
const CRYPTO_SETTINGS_KEY = 'polytrade_crypto_settings'

export interface CryptoUpDownSettings {
  auto_trade_enabled:      boolean
  max_position_size:       number
  min_position_size:       number
  max_open_positions:      number
  default_stop_loss_pct:   number
  default_take_profit_pct: number
  daily_loss_limit:        number
  enabled_coins:           string[]
  enabled_windows:         string[]
}

export const DEFAULT_CRYPTO_SETTINGS: CryptoUpDownSettings = {
  auto_trade_enabled:      false,
  max_position_size:       50,
  min_position_size:       5,
  max_open_positions:      5,
  default_stop_loss_pct:   50,
  default_take_profit_pct: 100,
  daily_loss_limit:        100,
  enabled_coins:           ['btc', 'eth', 'sol'],
  enabled_windows:         ['5m', '15m'],
}

export function getCryptoTrades(): CryptoUpDownTrade[] {
  if (typeof window === 'undefined') return []
  try { return JSON.parse(localStorage.getItem(CRYPTO_TRADES_KEY) ?? '[]') } catch { return [] }
}

export function saveCryptoTrades(trades: CryptoUpDownTrade[]): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(CRYPTO_TRADES_KEY, JSON.stringify(trades))
}

export function addCryptoTrade(trade: CryptoUpDownTrade): void {
  const trades = getCryptoTrades()
  trades.unshift(trade)
  saveCryptoTrades(trades)
}

export function updateCryptoTrade(id: string, updates: Partial<CryptoUpDownTrade>): void {
  const trades = getCryptoTrades()
  const idx = trades.findIndex(t => t.id === id)
  if (idx !== -1) {
    trades[idx] = { ...trades[idx], ...updates }
    saveCryptoTrades(trades)
  }
}

export function getOpenCryptoTrades(): CryptoUpDownTrade[] {
  return getCryptoTrades().filter(t => t.status === 'OPEN')
}

export function getCryptoSettings(): CryptoUpDownSettings {
  if (typeof window === 'undefined') return DEFAULT_CRYPTO_SETTINGS
  try {
    const stored = localStorage.getItem(CRYPTO_SETTINGS_KEY)
    return stored ? { ...DEFAULT_CRYPTO_SETTINGS, ...JSON.parse(stored) } : DEFAULT_CRYPTO_SETTINGS
  } catch { return DEFAULT_CRYPTO_SETTINGS }
}

export function saveCryptoSettings(settings: CryptoUpDownSettings): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(CRYPTO_SETTINGS_KEY, JSON.stringify(settings))
}

export function getCredentials(): AccountCredentials | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = localStorage.getItem(CREDENTIALS_KEY)
    return stored ? JSON.parse(stored) : null
  } catch { return null }
}

export function saveCredentials(creds: AccountCredentials): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(creds))
}

export function clearCredentials(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(CREDENTIALS_KEY)
}

function calculateBinaryPnL(entryPrice: number, currentPrice: number, size: number): { pnl: number; pnlPct: number } {
  const shares = size / entryPrice
  const pnl = (currentPrice - entryPrice) * shares
  const pnlPct = currentPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : -100
  return { pnl, pnlPct }
}

function calculateBinaryFinalPnL(entryPrice: number, isWin: boolean, size: number): { pnl: number; pnlPct: number } {
  if (isWin) {
    const pnl = ((1.0 - entryPrice) / entryPrice) * size
    const pnlPct = ((1.0 - entryPrice) / entryPrice) * 100
    return { pnl, pnlPct }
  }
  return { pnl: -size, pnlPct: -100 }
}

export async function executeCryptoUpDownAutoTrade(params: {
  coin:        string
  window:      '5m' | '15m'
  side:        'UP' | 'DOWN'
  entryPrice:  number
  expiryTime:  number
  confidence:  number
  rationale?:  string
  market_id?:  string
}): Promise<{ success: boolean; trade?: CryptoUpDownTrade; error?: string }> {
  const settings = getCryptoSettings()
  if (!settings.auto_trade_enabled) return { success: false, error: 'Crypto auto-trading disabled' }
  const creds = getCredentials()
  if (!creds || !creds.api_key || !creds.private_key) return { success: false, error: 'API Credentials missing' }
  const openTrades = getOpenCryptoTrades()
  if (openTrades.length >= settings.max_open_positions) return { success: false, error: `Max positions reached (${settings.max_open_positions})` }
  const confidenceMultiplier = Math.min(params.confidence / 100, 1)
  const size = Math.round(settings.min_position_size + (settings.max_position_size - settings.min_position_size) * confidenceMultiplier)
  if (!params.market_id) return { success: false, error: 'Market ID missing — cannot execute trade' }

  try {
    const res = await fetch('/api/trade/crypto-execute', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        market_id:    params.market_id,
        side:         params.side,
        size:         size,
        price:        params.entryPrice,
        question:     params.rationale,
        signal_confidence: params.confidence,
        credentials: {
          apiKey:        creds.api_key,
          apiSecret:     creds.api_secret,
          apiPassphrase: creds.api_passphrase,
          funderAddress: creds.funder_address,
          signatureType: creds.signature_type ?? 2,
          privateKey:    creds.private_key,
          builderCode:  creds.builder_code ?? '',
        },
      }),
    })
    const result = await res.json()
    if (!res.ok || !result.success) return { success: false, error: result.error ?? `On-chain fail: HTTP ${res.status}` }

    const stopLossPct   = settings.default_stop_loss_pct   / 100
    const takeProfitPct = settings.default_take_profit_pct / 100
    const entry         = params.entryPrice
    const stopLossPrice   = Math.max(0.01, entry * (1 - stopLossPct))
    const takeProfitPrice = Math.min(0.99, entry * (1 + takeProfitPct))

    const trade: CryptoUpDownTrade = {
      id:                result.order_id ?? safeUUID(),
      market_id:         params.market_id,
      coin:              params.coin,
      window:            params.window,
      side:              params.side,
      entryPrice:        entry,
      currentPrice:      entry,
      size,
      entryTime:         Date.now(),
      expiryTime:        params.expiryTime,
      stopLossPct:       settings.default_stop_loss_pct,
      takeProfitPct:     settings.default_take_profit_pct,
      stopLossPrice,
      takeProfitPrice,
      status:            'OPEN',
      pnl:               0,
      pnlPct:            0,
      signalConfidence:  params.confidence,
      rationale:         params.rationale,
    }

    console.log(`[CryptoUpDown] 📂 OPEN: ${params.side} ${params.coin} ${params.window} | entry:${entry.toFixed(3)} SL:${stopLossPrice.toFixed(3)} TP:${takeProfitPrice.toFixed(3)} size:$${size}`)
    addCryptoTrade(trade)
    return { success: true, trade }
  } catch (e: any) {
    return { success: false, error: `Network error: ${e.message}` }
  }
}

// ─── ✅ PATCH #4: updateCryptoUpDownTrades dengan null guard ──────────────────
export function updateCryptoUpDownTrades(
  priceUpdates: Array<{ coin: string; window: '5m' | '15m'; yesPrice: number }>
): { closed: CryptoUpDownTrade[]; updated: number } {
  const trades     = getCryptoTrades()
  const openTrades = trades.filter(t => t.status === 'OPEN')
  const closed: CryptoUpDownTrade[] = []
  let updated = 0

  for (const update of priceUpdates) {
    const matchingTrades = openTrades.filter(t => t.coin === update.coin && t.window === update.window)
    for (const trade of matchingTrades) {
      const idx = trades.findIndex(t => t.id === trade.id)
      if (idx === -1) continue

      const relevantPrice = trade.side === 'UP'
        ? update.yesPrice
        : (1 - update.yesPrice)

      let { pnl, pnlPct } = calculateBinaryPnL(trade.entryPrice, relevantPrice, trade.size)
      let newStatus = trade.status

      console.log(
        `[SL/TP check] ${trade.side} ${trade.coin} ${trade.window} | ` +
        `yesPrice:${update.yesPrice.toFixed(3)} relevant:${relevantPrice.toFixed(3)} ` +
        `entry:${trade.entryPrice.toFixed(3)} SL:${trade.stopLossPrice.toFixed(3)} TP:${trade.takeProfitPrice.toFixed(3)}`
      )

      if (relevantPrice <= trade.stopLossPrice) {
        newStatus = 'CLOSED_LOSS'
        console.log(`[CryptoUpDown] 🛑 STOP LOSS: ${trade.side} ${trade.coin} ${trade.window} entry:${trade.entryPrice.toFixed(3)} current:${relevantPrice.toFixed(3)} PnL:$${pnl.toFixed(2)}`)
      } else if (relevantPrice >= trade.takeProfitPrice) {
        newStatus = 'CLOSED_WIN'
        console.log(`[CryptoUpDown] 🎯 TAKE PROFIT: ${trade.side} ${trade.coin} ${trade.window} entry:${trade.entryPrice.toFixed(3)} current:${relevantPrice.toFixed(3)} PnL:$${pnl.toFixed(2)}`)
      } else if (Date.now() >= trade.expiryTime) {
        const isWin = relevantPrice >= 0.5
        newStatus   = isWin ? 'CLOSED_WIN' : 'CLOSED_LOSS'
        ;({ pnl, pnlPct } = calculateBinaryFinalPnL(trade.entryPrice, isWin, trade.size))
        console.log(`[CryptoUpDown] ⏰ EXPIRED ${isWin ? 'WIN' : 'LOSS'}: ${trade.side} ${trade.coin} ${trade.window} PnL:$${pnl.toFixed(2)}`)
      }

      const isClosed = newStatus !== 'OPEN'
      trades[idx] = {
        ...trade,
        currentPrice: relevantPrice,
        pnl,
        pnlPct,
        status: newStatus as CryptoUpDownTrade['status'],
        ...(isClosed && { closedAt: Date.now() }),
      }
      updated++
      
      // ✅ PATCH #4 FIX: Null guard untuk market_id saat push ke closed array
      if (isClosed) {
        if (!trades[idx].market_id) {
          console.error(
            `[CryptoUpDown] ❌ CRITICAL: market_id is NULL for trade ${trades[idx].id} — ` +
            `cannot send sell order to CLOB. Position marked as ${newStatus} in localStorage ` +
            `but NO on-chain settlement. Polymarket oracle will auto-resolve this.`
          )
        }
        closed.push(trades[idx])
      }
    }
  }

  if (updated > 0) saveCryptoTrades(trades)
  return { closed, updated }
}

export function calculateCryptoPortfolioStats() {
  const trades       = getCryptoTrades()
  const openTrades   = trades.filter(t => t.status === 'OPEN')
  const closedTrades = trades.filter(t => t.status === 'CLOSED_WIN' || t.status === 'CLOSED_LOSS')
  const wins         = closedTrades.filter(t => t.status === 'CLOSED_WIN').length
  const losses       = closedTrades.filter(t => t.status === 'CLOSED_LOSS').length
  const totalPnl     = closedTrades.reduce((sum, t) => sum + t.pnl, 0)
  const totalInvested = closedTrades.reduce((sum, t) => sum + t.size, 0)
  return {
    openPositions:  openTrades.length,
    totalTrades:    trades.length,
    wins, losses,
    winRate:        closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0,
    totalPnl, totalPnlPct: totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0,
    totalInvested, activeCoins: [...new Set(openTrades.map(t => t.coin))],
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. POLYMARKET TRADES (Legacy)
// ═══════════════════════════════════════════════════════════════════════════════

const TRADES_KEY    = 'polytrade_trades'
const SETTINGS_KEY  = 'polytrade_settings'
const PORTFOLIO_KEY = 'polytrade_portfolio'

export const DEFAULT_SETTINGS: TradingSettings = {
  auto_trade_enabled:  false, min_confidence: 75, min_trade_size: 10, max_trade_size: 100,
  default_stop_loss: 30, default_take_profit: 80, max_open_positions: 10,
  max_daily_trades: 20, max_daily_loss: 200, enabled_categories: [],
}

export function getTrades(): Trade[] {
  if (typeof window === 'undefined') return []
  try { return JSON.parse(localStorage.getItem(TRADES_KEY) ?? '[]') } catch { return [] }
}
export function saveTrades(trades: Trade[]): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(TRADES_KEY, JSON.stringify(trades))
}
export function addTrade(trade: Trade): void {
  const trades = getTrades(); trades.unshift(trade); saveTrades(trades)
}
export function updateTrade(id: string, updates: Partial<Trade>): void {
  const trades = getTrades(); const idx = trades.findIndex((t) => t.id === id)
  if (idx !== -1) { trades[idx] = { ...trades[idx], ...updates }; saveTrades(trades) }
}
export function getOpenTrades(): Trade[] { return getTrades().filter((t) => t.status === 'OPEN' || t.status === 'PENDING') }

export function getSettings(): TradingSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS
  try { const stored = localStorage.getItem(SETTINGS_KEY); return stored ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } : DEFAULT_SETTINGS } catch { return DEFAULT_SETTINGS }
}
export function saveSettings(settings: TradingSettings): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export function getPortfolioStats(): PortfolioStats {
  if (typeof window === 'undefined') return defaultPortfolio()
  try { const stored = localStorage.getItem(PORTFOLIO_KEY); return stored ? JSON.parse(stored) : defaultPortfolio() } catch { return defaultPortfolio() }
}
export function savePortfolioStats(stats: PortfolioStats): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(PORTFOLIO_KEY, JSON.stringify(stats))
}

function defaultPortfolio(): PortfolioStats {
  return { total_balance: 0, available_balance: 0, total_value: 0, total_pnl: 0, total_pnl_pct: 0, today_pnl: 0, today_trades: 0, win_rate: 0, open_positions: 0 }
}

export function calculateTradePnL(trade: Trade): { pnl: number; pnl_pct: number } {
  const currentPrice = trade.current_price ?? trade.entry_price
  const shares = trade.size / trade.entry_price
  return { pnl: (currentPrice - trade.entry_price) * shares, pnl_pct: ((currentPrice - trade.entry_price) / trade.entry_price) * 100 }
}

export function calculatePortfolioStats(): PortfolioStats {
  const trades = getTrades()
  const openTrades = trades.filter((t) => t.status === 'OPEN')
  const closedTrades = trades.filter((t) => ['CLOSED', 'STOP_LOSS', 'TAKE_PROFIT'].includes(t.status))
  const totalPnl = closedTrades.reduce((sum, t) => { const ep = t.exit_price ?? t.entry_price; return sum + (ep - t.entry_price) * (t.size / t.entry_price) }, 0)
  const todayStart = new Date().setHours(0, 0, 0, 0)
  const todayPnl = closedTrades.filter(t => (t.closed_at ?? 0) >= todayStart).reduce((sum, t) => { const ep = t.exit_price ?? t.entry_price; return sum + (ep - t.entry_price) * (t.size / t.entry_price) }, 0)
  const winners = closedTrades.filter(t => { const ep = t.exit_price ?? t.entry_price; return (ep - t.entry_price) * (t.size / t.entry_price) > 0 }).length
  const winRate = closedTrades.length > 0 ? (winners / closedTrades.length) * 100 : 0
  const todayTrades = trades.filter((t) => t.opened_at >= todayStart).length
  const totalSize = trades.reduce((sum, t) => sum + t.size, 0)
  return { total_balance: 0, available_balance: 0, total_value: 0, total_pnl: totalPnl, total_pnl_pct: totalSize > 0 ? (totalPnl / totalSize) * 100 : 0, today_pnl: todayPnl, today_trades: todayTrades, win_rate: winRate, open_positions: openTrades.length }
}

export async function executeAutoTrade(signal: CombinedSignal, settings: TradingSettings, retryCount = 0): Promise<{ success: boolean; trade?: Trade; error?: string }> {
  if (!settings.auto_trade_enabled) return { success: false, error: 'Auto trading disabled' }
  if (signal.confidence < settings.min_confidence) return { success: false, error: `Confidence ${signal.confidence}% below minimum` }
  const openTrades = getOpenTrades()
  if (openTrades.length >= settings.max_open_positions) return { success: false, error: 'Maximum open positions reached' }
  const todayStart = new Date().setHours(0, 0, 0, 0)
  const todayTrades = getTrades().filter((t) => t.opened_at >= todayStart)
  if (todayTrades.length >= settings.max_daily_trades) return { success: false, error: 'Daily trade limit reached' }
  const confidenceMultiplier = Math.min(signal.confidence / 100, 1)
  const tradeSize = Math.round(settings.min_trade_size + (settings.max_trade_size - settings.min_trade_size) * confidenceMultiplier)
  const price = signal.recommendedSide === 'YES' ? signal.yesPrice : signal.noPrice
  const storedCreds = getCredentials()
  if (!storedCreds) return { success: false, error: 'API credentials not configured' }
  const stopLossPct = settings.default_stop_loss / 100; const takeProfitPct = settings.default_take_profit / 100
  const stopLossPrice = signal.recommendedSide === 'YES' ? Math.max(0.01, price - price * stopLossPct) : Math.min(0.99, price + price * stopLossPct)
  const takeProfitPrice = signal.recommendedSide === 'YES' ? Math.min(0.99, price + price * takeProfitPct) : Math.max(0.01, price - price * takeProfitPct)
  try {
    const res = await fetch('/api/trade/execute', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        market_id: signal.market_id, question: signal.question, side: signal.recommendedSide,
        size: tradeSize, price, signal_confidence: signal.confidence,
        ai_rationale: signal.analyses.map((a) => a.rationale).join(' | '),
        stop_loss_pct: settings.default_stop_loss, take_profit_pct: settings.default_take_profit,
        stop_loss_price: stopLossPrice, take_profit_price: takeProfitPrice,
        credentials: { apiKey: storedCreds.api_key, apiSecret: storedCreds.api_secret, apiPassphrase: storedCreds.api_passphrase, funderAddress: storedCreds.funder_address, signatureType: storedCreds.signature_type ?? 2, privateKey: storedCreds.private_key, builderCode: storedCreds.builder_code ?? '' },
      }),
    })
    const result = await res.json()
    if (!res.ok || result.error) return { success: false, error: result.error ?? 'Trade execution failed' }
    const expectedTokenId = signal.recommendedSide === 'YES' ? (result.token_ids?.[0] ?? result.token_id ?? '') : (result.token_ids?.[1] ?? '')
    const trade: Trade = { id: result.trade_id ?? result.order_id ?? safeUUID(), market_id: signal.market_id, condition_id: result.condition_id ?? '', question: signal.question, side: signal.recommendedSide, token_id: expectedTokenId, size: tradeSize, entry_price: price, current_price: price, stop_loss: stopLossPrice, take_profit: takeProfitPrice, status: 'OPEN', signal_confidence: signal.confidence, ai_rationale: signal.analyses.map((a) => `[${a.model}] ${a.rationale}`).join('\n'), order_id: result.order_id, opened_at: Date.now() }
    addTrade(trade); return { success: true, trade }
  } catch (e: unknown) {
    const errorMessage = e instanceof Error ? e.message : 'Network error'
    if (retryCount < 1 && errorMessage.toLowerCase().includes('network')) { await new Promise((resolve) => setTimeout(resolve, 2000)); return executeAutoTrade(signal, settings, retryCount + 1) }
    return { success: false, error: errorMessage }
  }
}

export function updateTradeWithPrice(tradeId: string, newPrice: number): void {
  const trades = getTrades(); const idx = trades.findIndex((t) => t.id === tradeId)
  if (idx === -1) return
  const trade = trades[idx]; const stopLoss = trade.stop_loss ?? (trade.side === 'YES' ? 0 : 1); const takeProfit = trade.take_profit ?? (trade.side === 'YES' ? 1 : 0)
  const shares = trade.size / trade.entry_price; const pnl = (newPrice - trade.entry_price) * shares; const pnl_pct = ((newPrice - trade.entry_price) / trade.entry_price) * 100
  let newStatus = trade.status
  if ((trade.side === 'YES' && newPrice <= stopLoss) || (trade.side === 'NO' && newPrice >= stopLoss)) newStatus = 'STOP_LOSS'
  else if ((trade.side === 'YES' && newPrice >= takeProfit) || (trade.side === 'NO' && newPrice <= takeProfit)) newStatus = 'TAKE_PROFIT'
  const isClosed = ['STOP_LOSS', 'TAKE_PROFIT', 'CLOSED'].includes(newStatus)
  trades[idx] = { ...trade, current_price: newPrice, pnl, pnl_pct, status: newStatus, ...(isClosed && { exit_price: newPrice, closed_at: Date.now() }) }
  saveTrades(trades)
}

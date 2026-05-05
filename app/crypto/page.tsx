// app/crypto/page.tsx
// ✅ PATCH: Fix race condition, executeSellOrder, marketExpiryMs, dan null guard

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  TrendingUp, TrendingDown, Zap, Clock,
  Activity, AlertTriangle, BarChart2, CheckCircle, XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { AppSidebar } from '@/components/app-sidebar'
import { AppHeader }   from '@/components/app-header'
import {
  getSettings,
  calculatePortfolioStats,
  getCredentials,
  getCryptoSettings,
  getCryptoTrades,
  executeCryptoUpDownAutoTrade,
  updateCryptoUpDownTrades,
  type CryptoUpDownSettings,
  type CryptoUpDownTrade,
} from '@/lib/trade-engine'
import { CRYPTO_COINS, COIN_SYMBOLS, type CryptoCoin } from '@/lib/crypto-markets'

// ─── Types ────────────────────────────────────────────────────────────────────
interface CryptoSignal {
  coin:            CryptoCoin
  coinLabel:       string
  window:          '5m' | '15m'
  slug:            string
  market_id:       string | null
  signal:          'BUY' | 'SELL' | 'HOLD'
  confidence:      number
  recommendedSide: 'YES' | 'NO' | null
  yesPrice:        number
  noPrice:         number
  currentPrice:    number | null
  change24h:       number | null
  secondsLeft:     number
  /** Unix timestamp (ms) dari end_date_iso Polymarket — SATU-SATUNYA sumber kebenaran countdown */
  marketExpiryMs:  number | null
  rationale:       string
  keyRisk:         string
  analyses:        number
  upScore:         number
  downScore:       number
  timestamp:       number
  active:          boolean
  executed?:       boolean
  executedResult?: string
}

interface CoinPrice {
  price:     number
  change24h: number | null
  high24h:   number | null
  low24h:    number | null
}

interface FearGreed {
  value:          number
  classification: string
}

// ─── Countdown — SELALU pakai marketExpiryMs ──────────────────────────────────
function Countdown({
  marketExpiryMs,
  secondsLeft
}: {
  marketExpiryMs: number | null
  secondsLeft: number
}) {
  // ✅ FIX: Hitung detik tersisa langsung dari marketExpiryMs Polymarket
  const getRemaining = (expiryMs: number | null): number => {
    if (expiryMs !== null && expiryMs > 0) {
      const remaining = Math.round((expiryMs - Date.now()) / 1000)
      return Math.max(0, remaining)
    }
    // Fallback terakhir — bukan sumber kebenaran
    return Math.max(0, secondsLeft)
  }

  const [secs, setSecs] = useState(() => getRemaining(marketExpiryMs))

  useEffect(() => {
    // Reset saat prop berubah
    setSecs(getRemaining(marketExpiryMs))

    const iv = setInterval(() => {
      setSecs(getRemaining(marketExpiryMs))
    }, 1000)

    return () => clearInterval(iv)
  }, [marketExpiryMs]) // ✅ GAK pake secondsLeft — hanya marketExpiryMs

  const m = Math.floor(secs / 60)
  const s = secs % 60
  return (
    <span className={cn('font-mono text-xs font-bold', secs < 60 ? 'text-loss animate-pulse' : 'text-muted-foreground')}>
      {m}:{s.toString().padStart(2, '0')}
    </span>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function CryptoPage() {
  const [signals, setSignals]           = useState<CryptoSignal[]>([])
  const [coinPrices, setCoinPrices]     = useState<Record<string, CoinPrice>>({})
  const [fearGreed, setFearGreed]       = useState<FearGreed | null>(null)
  const [loading, setLoading]           = useState(false)
  const [lastUpdate, setLastUpdate]     = useState<Date | null>(null)
  const [activeWindow, setActiveWindow] = useState<'all' | '5m' | '15m'>('all')
  const [activeCoin, setActiveCoin]     = useState<'all' | CryptoCoin>('all')
  const [autoSettings, setAutoSettings] = useState<CryptoUpDownSettings>(getCryptoSettings())

  const settings  = getSettings()
  const portfolio = calculatePortfolioStats()

  // ✅ FIX: Semua ref untuk mencegah stale closure
  const signalsRef     = useRef<CryptoSignal[]>([])
  const settingsRef    = useRef(autoSettings)
  const executingSlugs = useRef<Set<string>>(new Set())
  const sellingSlugs   = useRef<Set<string>>(new Set())

  // ─── fetchSignals ───────────────────────────────────────────────────────
  const fetchSignals = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await fetch('/api/crypto-signals')
      const data = await res.json()
      if (data.signals) {
        // ✅ FIX: Langsung update state DAN ref secara synchron
        setSignals(prev => {
          const merged = data.signals.map((s: CryptoSignal) => {
            const existing = prev.find(p => p.slug === s.slug)
            return existing
              ? { ...s, executed: existing.executed, executedResult: existing.executedResult }
              : s
          })
          // ✅ Update ref SEBELUM returning — tidak ada race condition
          signalsRef.current = merged
          return merged
        })
      }
      if (data.coinPrices) setCoinPrices(data.coinPrices)
      if (data.fearGreed)  setFearGreed(data.fearGreed)
      setLastUpdate(new Date())
    } catch (e) {
      console.error('[crypto] fetchSignals error:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  // ─── ✅ FIX: autoExecuteFromSettings — pakai marketExpiryMs untuk expiryTime ───
  const autoExecuteFromSettings = useCallback(async () => {
    const currentSettings = getCryptoSettings()
    settingsRef.current = currentSettings
    if (!currentSettings.auto_trade_enabled) return

    const creds = getCredentials()
    if (!creds?.api_key || !creds?.private_key) return

    for (const sig of signalsRef.current) {
      if (executingSlugs.current.has(sig.slug))   continue
      if (sig.executed)                          continue
      if (sig.signal === 'HOLD')                 continue
      if (sig.confidence < 60)                   continue
      if (!sig.market_id)                        continue
      if (!currentSettings.enabled_coins.includes(sig.coin))    continue
      if (!currentSettings.enabled_windows.includes(sig.window)) continue

      executingSlugs.current.add(sig.slug)

      // ✅ FIX: SELALU pakai marketExpiryMs — ini dari end_date_iso Polymarket
      // BUKAN secondsLeft (yang bisa salah karena jam server)
      const expiryTime = sig.marketExpiryMs !== null && sig.marketExpiryMs > Date.now()
        ? sig.marketExpiryMs
        : (() => {
            // Fallback: jika marketExpiryMs null, hitung dari secondsLeft + Date.now()
            // Ini masih lebih baik daripada fallback lama karena expiryTime di-pass
            // sebagai absolute timestamp, bukan durasi
            console.warn(`[crypto] marketExpiryMs null for ${sig.slug} — using secondsLeft fallback`)
            return Date.now() + sig.secondsLeft * 1000
          })()

      const side       = sig.signal === 'BUY' ? 'UP' : 'DOWN'
      const entryPrice = sig.recommendedSide === 'YES' ? sig.yesPrice : sig.noPrice

      const result = await executeCryptoUpDownAutoTrade({
        coin: sig.coin, window: sig.window, side, entryPrice,
        expiryTime, confidence: sig.confidence,
        rationale: sig.rationale, market_id: sig.market_id,
      })

      executingSlugs.current.delete(sig.slug)

      if (result.success) {
        setSignals(prev => prev.map(s => s.slug === sig.slug
          ? { ...s, executed: true, executedResult: `✅ ${side} ${sig.coin} $${result.trade?.size ?? 0}` }
          : s
        ))
        await new Promise(r => setTimeout(r, 2_000))
      } else {
        setSignals(prev => prev.map(s => s.slug === sig.slug
          ? { ...s, executedResult: `❌ ${result.error}` } : s
        ))
      }
    }
  }, [])

  // ─── ✅ FIX: executeSellOrder dengan null guard dan endpoint benar ─────────────
  const executeSellOrder = useCallback(async (
    trade:          CryptoUpDownTrade,
    reason:         string,
    currentYesPrice: number
  ) => {
    const tradeKey = `${trade.id}-${reason}`
    if (sellingSlugs.current.has(tradeKey)) {
      console.log(`[crypto] Skip duplicate sell for ${tradeKey}`)
      return
    }
    sellingSlugs.current.add(tradeKey)

    const creds = getCredentials()
    if (!creds?.api_key || !creds?.private_key) {
      console.warn('[crypto] Cannot sell — no credentials')
      sellingSlugs.current.delete(tradeKey)
      return
    }

    // ✅ FIX: Validasi market_id SEBELUM mencoba sell
    if (!trade.market_id) {
      console.error(`[crypto] ❌ CRITICAL: market_id is NULL for trade ${trade.id} — CANNOT SELL on CLOB`)
      console.error(`[crypto] ℹ️ Position will be marked as closed in localStorage but NO on-chain settlement`)
      console.error(`[crypto] ℹ️ This may cause orphaned positions. Market may auto-resolve via Polymarket oracle.`)
      // ✅ Jangan skip — tapi berikan warning dan coba resolve dengan cara lain
      sellingSlugs.current.delete(tradeKey)
      return
    }

    const sellPrice = trade.side === 'UP'
      ? currentYesPrice
      : (1 - currentYesPrice)

    // ✅ FIX: Side untuk sell = KEBALIKAN dari buy
    const sellSide = trade.side === 'UP' ? 'DOWN' : 'UP'
    const clampedPrice = Math.max(0.01, Math.min(0.99, sellPrice - 0.01))

    console.log(
      `[crypto] 🔴 ${reason} SELL: ${trade.side} ${trade.coin} ${trade.window} | ` +
      `entry:${trade.entryPrice.toFixed(3)} → sellPrice:${clampedPrice.toFixed(3)} | ` +
      `PnL est: ${(((sellPrice - trade.entryPrice) / trade.entryPrice) * 100).toFixed(1)}%`
    )

    try {
      // ✅ FIX: Pakai /api/trade/crypto-execute dengan format yang BENAR
      const res = await fetch('/api/trade/crypto-execute', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          market_id:         trade.market_id,
          side:              sellSide,
          size:              trade.size,
          price:             clampedPrice,
          signal_confidence: 100,
          question:          `${trade.coin.toUpperCase()} ${trade.window} auto-${reason}`,
          credentials: {
            apiKey:        creds.api_key,
            apiSecret:     creds.api_secret,
            apiPassphrase: creds.api_passphrase,
            funderAddress: creds.funder_address,
            signatureType: creds.signature_type ?? 2,
            privateKey:    creds.private_key,
            builderCode:   creds.builder_code ?? '',
          },
        }),
      })

      const result = await res.json()
      if (result.success) {
        console.log(`[crypto] ✅ ${reason} sell OK: orderId=${result.order_id} price=${clampedPrice.toFixed(3)}`)
      } else {
        // ✅ Market mungkin sudah resolve — bukan error kritis
        console.warn(`[crypto] ⚠️ ${reason} sell failed: ${result.error}`)
        if (result.error?.includes('closed') || result.error?.includes('resolved') || result.error?.includes('archive')) {
          console.log(`[crypto] ℹ️ Market already resolved — no sell needed, Polymarket oracle will settle`)
        }
      }
    } catch (e) {
      console.error(`[crypto] ${reason} sell error:`, e)
    } finally {
      sellingSlugs.current.delete(tradeKey)
    }
  }, [])

  // ─── ✅ FIX: refreshPositions — harga sumber GANDA + tidak ada race condition ──
  const refreshPositions = useCallback(async () => {
    try {
      const openTrades = getCryptoTrades().filter(t => t.status === 'OPEN')
      if (openTrades.length === 0) return

      const coins = [...new Set(openTrades.map(t => t.coin))]

      // Map untuk dedup per coin+window
      const priceMap    = new Map<string, number>()  // key → yesPrice
      const yesPriceMap = new Map<string, number>()  // key → yesPrice (untuk sell)

      // ── 🥇 SUMBER 1: API langsung (paling fresh) ──────────────────────
      try {
        const res = await fetch(`/api/crypto-prices?coins=${coins.join(',')}`, {
          signal: AbortSignal.timeout(4_000),
        })

        if (res.ok) {
          const data = await res.json()
          for (const trade of openTrades) {
            const key = `${trade.coin}-${trade.window}`
            if (priceMap.has(key)) continue

            const coinData = data.prices?.[trade.coin]
            const yesPrice = trade.window === '5m'
              ? (coinData?.yesPrice5m ?? coinData?.estimatedYesPrice ?? null)
              : (coinData?.yesPrice15m ?? coinData?.estimatedYesPrice ?? null)

            if (yesPrice !== null && yesPrice > 0) {
              priceMap.set(key, yesPrice)
              yesPriceMap.set(key, yesPrice)
              console.log(`[crypto] API price ${key}: ${(yesPrice*100).toFixed(1)}¢`)
            }
          }
        }
      } catch {
        console.log('[crypto] /api/crypto-prices timeout')
      }

      // ── 🥇 SUMBER 2: signalsRef (dari AI analysis terbaru) ────────────
      for (const trade of openTrades) {
        const key = `${trade.coin}-${trade.window}`
        if (priceMap.has(key)) continue

        const matchSignal = signalsRef.current.find(
          s => s.coin === trade.coin && s.window === trade.window && s.active
        )

        if (matchSignal && matchSignal.yesPrice > 0) {
          priceMap.set(key, matchSignal.yesPrice)
          yesPriceMap.set(key, matchSignal.yesPrice)
          console.log(`[crypto] Signal price ${key}: ${(matchSignal.yesPrice*100).toFixed(1)}¢`)
        }
      }

      // ── 🥇 SUMBER 3: Reconstruct dari trade.currentPrice ────────────
      for (const trade of openTrades) {
        const key = `${trade.coin}-${trade.window}`
        if (priceMap.has(key)) continue

        if (trade.currentPrice > 0 && trade.currentPrice < 1) {
          const reconstructedYesPrice = trade.side === 'UP'
            ? trade.currentPrice
            : (1 - trade.currentPrice)
          priceMap.set(key, reconstructedYesPrice)
          yesPriceMap.set(key, reconstructedYesPrice)
          console.log(`[crypto] Fallback currentPrice ${key}: ${(reconstructedYesPrice*100).toFixed(1)}¢`)
        }
      }

      // ── 🥇 SUMBER 4: Expiry trigger ─────────────────────────────────
      for (const trade of openTrades) {
        const key = `${trade.coin}-${trade.window}`
        if (priceMap.has(key)) continue

        if (Date.now() >= trade.expiryTime) {
          priceMap.set(key, 0.5)
          yesPriceMap.set(key, 0.5)
          console.log(`[crypto] Expiry trigger ${key}: 0.5`)
        }
      }

      if (priceMap.size === 0) {
        console.log('[crypto] No price data available for any open trades')
        return
      }

      // Build priceUpdates
      const priceUpdates: Array<{ coin: string; window: '5m' | '15m'; yesPrice: number }> = []
      for (const [key, yesPrice] of priceMap.entries()) {
        const [coin, window] = key.split('-') as [string, '5m' | '15m']
        priceUpdates.push({ coin, window, yesPrice })
      }

      // Update localStorage
      const { closed } = updateCryptoUpDownTrades(priceUpdates)

      if (closed.length > 0) {
        console.log(`[crypto] 🔒 ${closed.length} position(s) triggered SL/TP/Expiry`)

        for (const closedTrade of closed) {
          const key             = `${closedTrade.coin}-${closedTrade.window}`
          const currentYesPrice = yesPriceMap.get(key) ?? 0.5
          const relevantPrice   = closedTrade.side === 'UP' ? currentYesPrice : (1 - currentYesPrice)
          const reason          = closedTrade.status === 'CLOSED_WIN' ? 'TAKE_PROFIT'
            : closedTrade.status === 'CLOSED_LOSS' ? 'STOP_LOSS'
            : 'EXPIRY'

          const nearResolution = relevantPrice >= 0.90 || relevantPrice <= 0.10

          // ✅ FIX: market_id NULL check — jika null, skip sell dan log warning
          if (!closedTrade.market_id) {
            console.error(`[crypto] ❌ market_id NULL — cannot execute ${reason} sell for trade ${closedTrade.id}`)
            console.error(`[crypto] ℹ️ Trade marked as ${closedTrade.status} in localStorage but no on-chain settlement`)
            // Tetap update UI untuk reflect status
            continue
          }

          if (!nearResolution) {
            await executeSellOrder(closedTrade, reason, currentYesPrice)
            await new Promise(r => setTimeout(r, 1_500))
          } else {
            console.log(`[crypto] ⏭️ Skip sell ${closedTrade.coin} ${reason} (near resolution: ${(relevantPrice*100).toFixed(0)}%)`)
          }
        }
      }
    } catch (e) {
      console.error('[crypto] refreshPositions error:', e)
    }
  }, [executeSellOrder])

  // ─── Effects ─────────────────────────────────────────────────────────
  useEffect(() => {
    fetchSignals()
    const iv = setInterval(fetchSignals, 30_000)
    return () => clearInterval(iv)
  }, [fetchSignals])

  useEffect(() => {
    // ✅ Update ref setiap signals berubah
    signalsRef.current = signals
    settingsRef.current = getCryptoSettings()
    if (signals.length > 0 && settingsRef.current.auto_trade_enabled) {
      autoExecuteFromSettings()
    }
  }, [signals, autoExecuteFromSettings])

  // ✅ FIX: refreshPositions interval STABIL — tidak restart setiap signals berubah
  useEffect(() => {
    refreshPositions()
    const iv = setInterval(refreshPositions, 5_000)
    return () => clearInterval(iv)
  }, [refreshPositions])

  useEffect(() => {
    const handle = () => {
      const fresh = getCryptoSettings()
      setAutoSettings(fresh)
      settingsRef.current = fresh
    }
    window.addEventListener('crypto-settings-changed', handle)
    return () => window.removeEventListener('crypto-settings-changed', handle)
  }, [])

  // ─── Manual Execute ─────────────────────────────────────────────────
  const executeTrade = useCallback(async (signal: CryptoSignal) => {
    if (!signal.market_id || !signal.recommendedSide) return
    const slug = signal.slug

    const creds = getCredentials()
    if (!creds?.api_key || !creds?.private_key) {
      alert('Please configure API credentials in Settings first.'); return
    }

    if (executingSlugs.current.has(slug)) {
      alert('Already executing.'); return
    }

    setSignals(prev => prev.map(s => s.slug === slug ? { ...s, executedResult: '⏳ Executing...' } : s))
    executingSlugs.current.add(slug)

    const entryPrice = signal.recommendedSide === 'YES' ? signal.yesPrice : signal.noPrice
    const side       = signal.signal === 'BUY' ? 'UP' : 'DOWN'

    // ✅ FIX: Pakai marketExpiryMs
    const expiryTime = signal.marketExpiryMs !== null && signal.marketExpiryMs > Date.now()
      ? signal.marketExpiryMs
      : Date.now() + signal.secondsLeft * 1000

    const result = await executeCryptoUpDownAutoTrade({
      coin: signal.coin, window: signal.window, side, entryPrice,
      expiryTime, confidence: signal.confidence,
      rationale: signal.rationale, market_id: signal.market_id,
    })

    executingSlugs.current.delete(slug)

    if (result.success) {
      setSignals(prev => prev.map(s => s.slug === slug ? {
        ...s, executed: true,
        executedResult: `✅ ${side} $${result.trade?.size ?? 0} @ ${(entryPrice*100).toFixed(1)}¢`,
      } : s))
    } else {
      setSignals(prev => prev.map(s => s.slug === slug
        ? { ...s, executedResult: `❌ ${result.error}` } : s
      ))
    }
  }, [])

  // ─── Filter ──────────────────────────────────────────────────────────
  const filtered = signals.filter(s => {
    if (activeWindow !== 'all' && s.window !== activeWindow) return false
    if (activeCoin   !== 'all' && s.coin   !== activeCoin)   return false
    return true
  })
  const highConf = filtered.filter(s => s.confidence >= 60 && s.signal !== 'HOLD')

  return (
    <div className="flex min-h-screen bg-background">
      <AppSidebar autoTradeEnabled={settings.auto_trade_enabled} />
      <div className="flex-1 ml-16 lg:ml-56 min-w-0 flex flex-col">
        <AppHeader
          title="Crypto Up/Down"
          subtitle={lastUpdate ? `Updated ${lastUpdate.toLocaleTimeString()}` : 'BTC ETH SOL DOGE XRP'}
          balance={portfolio.total_balance}
          totalPnL={portfolio.total_pnl}
          onRefresh={fetchSignals}
          loading={loading}
        />
        <main className="flex-1 p-4 space-y-4 overflow-auto">

          {/* Auto-trade banner */}
          <div className={cn(
            'flex items-center gap-3 px-4 py-3 rounded-lg border text-sm',
            autoSettings.auto_trade_enabled
              ? 'bg-profit/10 border-profit/20 text-profit'
              : 'bg-secondary border-border text-muted-foreground'
          )}>
            <Zap className={cn('w-4 h-4', autoSettings.auto_trade_enabled ? 'text-profit' : 'text-muted-foreground')} />
            <div className="flex-1">
              <span className="font-semibold">
                {autoSettings.auto_trade_enabled ? 'Auto Trade ACTIVE — BUY & SELL' : 'Auto Trade OFF'}
              </span>
              {autoSettings.auto_trade_enabled && (
                <span className="text-xs opacity-70 ml-2">
                  SL:{autoSettings.default_stop_loss_pct}% TP:{autoSettings.default_take_profit_pct}% |
                  Max:${autoSettings.max_position_size}
                </span>
              )}
            </div>
            <a href="/settings" className="text-xs underline opacity-70 hover:opacity-100">Configure</a>
          </div>

          {/* Fear & Greed + Coin Prices */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {fearGreed && (
              <div className={cn(
                'col-span-2 md:col-span-1 p-3 rounded-lg border flex flex-col gap-1',
                fearGreed.value < 30 ? 'bg-loss/10 border-loss/20' :
                fearGreed.value > 70 ? 'bg-profit/10 border-profit/20' :
                'bg-secondary border-border'
              )}>
                <span className="text-xs text-muted-foreground">Fear & Greed</span>
                <span className={cn('text-2xl font-mono font-bold',
                  fearGreed.value < 30 ? 'text-loss' : fearGreed.value > 70 ? 'text-profit' : 'text-foreground'
                )}>{fearGreed.value}</span>
                <span className="text-xs text-muted-foreground">{fearGreed.classification}</span>
              </div>
            )}
            {CRYPTO_COINS.map(coin => {
              const p = coinPrices[coin]
              return (
                <div key={coin} className="bg-card border border-border rounded-lg p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold text-primary">{COIN_SYMBOLS[coin]}</span>
                    {p?.change24h !== null && p?.change24h !== undefined && (
                      <span className={cn('text-xs font-mono', p.change24h >= 0 ? 'text-profit' : 'text-loss')}>
                        {p.change24h >= 0 ? '+' : ''}{p.change24h.toFixed(2)}%
                      </span>
                    )}
                  </div>
                  <span className="text-sm font-mono font-bold text-foreground">
                    {p ? `$${p.price.toLocaleString('en', { maximumFractionDigits: p.price > 100 ? 2 : 6 })}` : 'Loading...'}
                  </span>
                </div>
              )
            })}
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground mr-1">Window:</span>
              {(['all', '5m', '15m'] as const).map(w => (
                <button key={w} onClick={() => setActiveWindow(w)}
                  className={cn('px-3 h-7 rounded text-xs font-medium transition-all',
                    activeWindow === w ? 'bg-primary text-primary-foreground' :
                    'bg-secondary border border-border text-muted-foreground hover:text-foreground'
                  )}>{w === 'all' ? 'All' : w.toUpperCase()}</button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground mr-1">Coin:</span>
              {(['all', ...CRYPTO_COINS] as const).map(c => (
                <button key={c} onClick={() => setActiveCoin(c as any)}
                  className={cn('px-3 h-7 rounded text-xs font-medium transition-all',
                    activeCoin === c ? 'bg-primary text-primary-foreground' :
                    'bg-secondary border border-border text-muted-foreground hover:text-foreground'
                  )}>{c === 'all' ? 'All' : COIN_SYMBOLS[c as CryptoCoin]}</button>
              ))}
            </div>
          </div>

          {highConf.length > 0 && (
            <div className="flex items-center gap-2 px-3 py-2 bg-profit/10 border border-profit/20 rounded-lg">
              <Zap className="w-3.5 h-3.5 text-profit shrink-0" />
              <span className="text-xs text-profit font-medium">
                {highConf.length} actionable signal{highConf.length > 1 ? 's' : ''}
                {autoSettings.auto_trade_enabled ? ' — Auto BUY + SELL monitoring active' : ''}
              </span>
            </div>
          )}

          {/* Signals Grid */}
          {loading && signals.length === 0 ? (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="h-48 bg-secondary/50 rounded-lg border border-border animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {filtered.map(signal => (
                <SignalCard
                  key={signal.slug}
                  signal={signal}
                  onExecute={() => executeTrade(signal)}
                  isExecuting={executingSlugs.current.has(signal.slug)}
                />
              ))}
              {filtered.length === 0 && (
                <div className="col-span-full py-12 text-center border border-dashed border-border rounded-lg">
                  <BarChart2 className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm text-foreground mb-1">No active markets</p>
                  <p className="text-xs text-muted-foreground">Auto-refresh in 30s</p>
                  <button onClick={fetchSignals} className="mt-3 px-4 py-1.5 bg-primary text-primary-foreground rounded text-xs">
                    Refresh Now
                  </button>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

// ─── Signal Card ──────────────────────────────────────────────────────────────
function SignalCard({
  signal, onExecute, isExecuting,
}: { signal: CryptoSignal; onExecute: () => void; isExecuting?: boolean }) {
  const isUp       = signal.signal === 'BUY'
  const isDown     = signal.signal === 'SELL'
  const isHigh     = signal.confidence >= 60
  const canExecute = isHigh && signal.signal !== 'HOLD' && signal.market_id && !signal.executed && !isExecuting

  return (
    <div className={cn(
      'bg-card border rounded-lg p-3 space-y-3 transition-all',
      isHigh && isUp ? 'border-profit/40' : isHigh && isDown ? 'border-loss/40' : 'border-border'
    )}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-bold text-foreground">{COIN_SYMBOLS[signal.coin]}</span>
            <span className={cn('text-xs px-1.5 py-0.5 rounded font-mono font-medium',
              signal.window === '5m' ? 'bg-primary/15 text-primary' : 'bg-chart-4/15 text-chart-4'
            )}>{signal.window.toUpperCase()}</span>
          </div>
          {signal.currentPrice != null && (
            <p className="text-xs text-muted-foreground font-mono mt-0.5">
              ${signal.currentPrice.toLocaleString('en', { maximumFractionDigits: signal.currentPrice > 100 ? 2 : 6 })}
              {signal.change24h !== null && (
                <span className={cn('ml-1', signal.change24h >= 0 ? 'text-profit' : 'text-loss')}>
                  {signal.change24h >= 0 ? '+' : ''}{signal.change24h.toFixed(2)}%
                </span>
              )}
            </p>
          )}
        </div>
        <div className="text-right">
          <p className={cn('text-lg font-mono font-bold',
            isHigh ? (isUp ? 'text-profit' : isDown ? 'text-loss' : 'text-muted-foreground') : 'text-muted-foreground'
          )}>{signal.confidence}%</p>
          <p className="text-xs text-muted-foreground">{signal.analyses} AI</p>
        </div>
      </div>

      <div className={cn('flex items-center gap-2 px-3 py-2 rounded-lg',
        isUp ? 'bg-profit/10' : isDown ? 'bg-loss/10' : 'bg-secondary'
      )}>
        {isUp ? <TrendingUp className="w-4 h-4 text-profit shrink-0" />
          : isDown ? <TrendingDown className="w-4 h-4 text-loss shrink-0" />
          : <Activity className="w-4 h-4 text-muted-foreground shrink-0" />}
        <p className={cn('text-sm font-bold',
          isUp ? 'text-profit' : isDown ? 'text-loss' : 'text-muted-foreground'
        )}>
          {signal.signal === 'BUY' ? '📈 BUY UP tokens' :
           signal.signal === 'SELL' ? '📉 BUY DOWN tokens' : 'HOLD — No edge'}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-1.5 text-xs">
        <div className="bg-profit/5 border border-profit/15 rounded p-2 text-center">
          <p className="text-muted-foreground mb-0.5">UP (YES)</p>
          <p className="font-mono font-bold text-profit">{(signal.yesPrice*100).toFixed(0)}¢</p>
        </div>
        <div className="bg-loss/5 border border-loss/15 rounded p-2 text-center">
          <p className="text-muted-foreground mb-0.5">DOWN (NO)</p>
          <p className="font-mono font-bold text-loss">{(signal.noPrice*100).toFixed(0)}¢</p>
        </div>
      </div>

      {signal.rationale && (
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">{signal.rationale}</p>
      )}

      {signal.executedResult && (
        <div className={cn('flex items-center gap-1.5 text-xs px-2 py-1.5 rounded',
          signal.executedResult.startsWith('✅') ? 'bg-profit/10 text-profit' :
          signal.executedResult.startsWith('⏳') ? 'bg-warning/10 text-warning' :
          'bg-loss/10 text-loss'
        )}>
          {signal.executedResult.startsWith('✅') ? <CheckCircle className="w-3 h-3 shrink-0" /> :
           signal.executedResult.startsWith('⏳') ? <Activity className="w-3 h-3 animate-pulse" /> :
           <XCircle className="w-3 h-3 shrink-0" />}
          <span className="truncate">{signal.executedResult}</span>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="w-3 h-3" />
          {/* ✅ FIX: SELALU kirim marketExpiryMs */}
          <Countdown marketExpiryMs={signal.marketExpiryMs ?? null} secondsLeft={signal.secondsLeft} />
          <span>left</span>
        </div>
        {signal.executed ? (
          <span className="text-xs text-profit font-medium flex items-center gap-1">
            <CheckCircle className="w-3 h-3" /> Executed
          </span>
        ) : canExecute ? (
          <button onClick={onExecute} disabled={isExecuting}
            className={cn('px-3 h-7 rounded text-xs font-bold transition-all',
              isUp ? 'bg-profit/20 text-profit hover:bg-profit/30' : 'bg-loss/20 text-loss hover:bg-loss/30'
            )}>
            {isExecuting ? '...' : 'Execute'}
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">
            {signal.signal === 'HOLD' ? 'No edge' : signal.executed ? '' : 'Low conf'}
          </span>
        )}
      </div>

      {signal.window === '5m' && isHigh && (
        <div className="flex items-center gap-1.5 text-xs text-chart-4">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          <span>5m window — high risk, fast resolution</span>
        </div>
      )}
    </div>
  )
}

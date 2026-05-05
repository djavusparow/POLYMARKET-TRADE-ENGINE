'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { BrainCircuit, Zap, TrendingUp, TrendingDown, Activity, ChevronRight, Wifi, WifiOff } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { AppSidebar } from '@/components/app-sidebar'
import { AppHeader } from '@/components/app-header'
import { PortfolioStatsBar } from '@/components/portfolio-stats'
import {
  getSettings, saveSettings, calculatePortfolioStats,
  getOpenTrades, getTrades, getCredentials,
} from '@/lib/trade-engine'
import { useRealtimePrices } from '@/hooks/use-realtime-prices'
import type { PolymarketMarket, CombinedSignal, TradingSettings, PortfolioStats } from '@/lib/types'

// ─── Interface untuk crypto signal dari API ───────────────────────────────────
interface CryptoSignalSummary {
  total: number
  actionable: number
  bulls: number
  bears: number
  holds: number
}

export default function DashboardPage() {
  const [markets, setMarkets]       = useState<PolymarketMarket[]>([])
  const [signals, setSignals]       = useState<CombinedSignal[]>([])
  const [settings, setSettings]     = useState<TradingSettings>(getSettings())
  const [portfolio, setPortfolio]   = useState<PortfolioStats>(calculatePortfolioStats())
  const [loading, setLoading]       = useState(false)
  const [scanProgress, setScanProgress] = useState(0)
  const [scanning, setScanning]     = useState(false)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [notifications, setNotifications] = useState<string[]>([])

  // ── ✅ FIX: State untuk Crypto Signals ─────────────────────────────────────
  const [cryptoSummary, setCryptoSummary] = useState<CryptoSignalSummary | null>(null)
  const [cryptoActionable, setCryptoActionable] = useState(0)

  const heartbeatRef    = useRef<ReturnType<typeof setInterval> | null>(null)
  const autoScanRef     = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Collect all YES/NO token IDs ──────────────────────────────────────────
  const tokenIds = useMemo(() => {
    const ids: string[] = []
    for (const m of markets) {
      if (m.clobTokenIds?.[0]) ids.push(m.clobTokenIds[0])
      if (m.clobTokenIds?.[1]) ids.push(m.clobTokenIds[1])
    }
    return ids
  }, [markets])

  // Gunakan satu hook useRealtimePrices
  const { prices: realtimePrices, connected: wsConnected } = useRealtimePrices(tokenIds)

  // ── ✅ FIX: Fetch Crypto Signals ────────────────────────────────────────────
  const fetchCryptoSignals = useCallback(async () => {
    try {
      const res = await fetch('/api/crypto-signals')
      const data = await res.json()
      if (data.summary) {
        setCryptoSummary(data.summary)
        setCryptoActionable(data.summary.actionable ?? 0)
      }
    } catch {
      // silent — crypto data opsional di dashboard
    }
  }, [])

  // ── Live balance fetch ────────────────────────────────────────────────────
  const fetchLiveBalance = useCallback(async () => {
    const storedCreds = getCredentials()
    if (!storedCreds?.api_key) return
    try {
      const clobCreds = {
        apiKey:        storedCreds.api_key,
        apiSecret:     storedCreds.api_secret,
        apiPassphrase: storedCreds.api_passphrase,
        funderAddress: storedCreds.funder_address,
        signatureType: storedCreds.signature_type ?? 2,
      }
      const res = await fetch('/api/portfolio', {
        headers: { 'X-Clob-Creds': JSON.stringify(clobCreds) },
      })
      const data = await res.json()
      if (data.configured && typeof data.balance === 'number') {
        setPortfolio(prev => ({ ...prev, total_balance: data.balance, available_balance: data.balance }))
      }
    } catch { /* silently fail */ }
  }, [])

  // ── Market fetch ──────────────────────────────────────────────────────────
  const fetchMarkets = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/markets?type=top&limit=20')
      const data = await res.json()
      setMarkets(data.markets ?? [])
    } catch (e) {
      console.error('[dashboard] fetchMarkets error:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  // ── AI Scan ───────────────────────────────────────────────────────────────
  const runAIScan = useCallback(async () => {
    if (!markets.length || scanning) return
    setScanning(true)
    setScanProgress(0)
    const newSignals: CombinedSignal[] = []

    for (let i = 0; i < markets.length; i++) {
      const market = markets[i]
      setScanProgress(Math.round(((i + 1) / markets.length) * 100))
      try {
        const res = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ market }),
        })
        const data = await res.json()
        if (data.signal) {
          newSignals.push(data.signal)
          setSignals(prev => {
            const filtered = prev.filter(s => s.market_id !== data.signal.market_id)
            return [...filtered, data.signal].sort((a, b) => b.confidence - a.confidence)
          })
        }
      } catch (e) {
        console.error('[dashboard] analyze error:', e)
      }
      await new Promise(r => setTimeout(r, 400))
    }

    setScanning(false)
    setLastUpdate(new Date())

    // ── Auto-execute high confidence signals ────────────────────────────────
    if (settings.auto_trade_enabled) {
      const highConf = newSignals.filter(
        s => s.confidence >= settings.min_confidence && s.direction !== 'HOLD'
      )

      const storedCreds = getCredentials()

      // ✅ FIX: builderCode ikut dikirim
      const clobCreds = storedCreds?.api_key
        ? {
            apiKey:        storedCreds.api_key,
            apiSecret:     storedCreds.api_secret,
            apiPassphrase: storedCreds.api_passphrase,
            funderAddress: storedCreds.funder_address,
            signatureType: storedCreds.signature_type ?? 2,
            privateKey:    storedCreds.private_key,
            builderCode:  storedCreds.builder_code ?? '',
          }
        : undefined

      for (const signal of highConf) {
        try {
          const res = await fetch('/api/trade/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              market_id:         signal.market_id,
              question:          signal.question,
              side:              signal.recommendedSide,
              size:              settings.min_trade_size,
              price:             signal.recommendedSide === 'YES' ? signal.yesPrice : signal.noPrice,
              signal_confidence: signal.confidence,
              ai_rationale:      signal.analyses.map(a => a.rationale).join(' | '),
              stop_loss_pct:     settings.default_stop_loss,
              take_profit_pct:   settings.default_take_profit,
              credentials:       clobCreds,
            }),
          })
          const result = await res.json()
          if (result.success) {
            setNotifications(n => [
              `Auto-traded: ${signal.direction} ${signal.question.slice(0, 40)}... (${signal.confidence}%)`,
              ...n.slice(0, 4),
            ])
            setPortfolio(calculatePortfolioStats())
          }
        } catch (e) {
          console.error('[dashboard] auto-execute error:', e)
        }
      }
    }
  }, [markets, scanning, settings])

  const toggleAutoTrade = () => {
    const newSettings = { ...settings, auto_trade_enabled: !settings.auto_trade_enabled }
    setSettings(newSettings)
    saveSettings(newSettings)
  }

  // ── Effects ───────────────────────────────────────────────────────────────
  useEffect(() => {
    fetchMarkets()
    fetchLiveBalance()
    fetchCryptoSignals() // ✅ FIX: Ambil crypto signals juga
  }, [fetchMarkets, fetchLiveBalance, fetchCryptoSignals])

  useEffect(() => {
    const local = calculatePortfolioStats()
    setPortfolio(prev => ({
      ...local,
      total_balance:     prev.total_balance,
      available_balance: prev.available_balance,
    }))
  }, [])

  // ✅ FIX: Refresh crypto signals setiap 30 detik
  useEffect(() => {
    const cryptoInterval = setInterval(fetchCryptoSignals, 30_000)
    const interval = setInterval(() => {
      fetchMarkets()
      fetchLiveBalance()
    }, 60_000)
    return () => {
      clearInterval(interval)
      clearInterval(cryptoInterval)
    }
  }, [fetchMarkets, fetchLiveBalance, fetchCryptoSignals])

  // ── CLOB Heartbeat ──────────────────────────────────────────────────────
  useEffect(() => {
    if (heartbeatRef.current) clearInterval(heartbeatRef.current)
    if (!settings.auto_trade_enabled) return
    const storedCreds = getCredentials()
    if (!storedCreds?.api_key) return

    const clobCreds = {
      apiKey:        storedCreds.api_key,
      apiSecret:     storedCreds.api_secret,
      apiPassphrase: storedCreds.api_passphrase,
      funderAddress: storedCreds.funder_address,
      signatureType: storedCreds.signature_type ?? 2,
    }

    heartbeatRef.current = setInterval(async () => {
      try {
        await fetch('/api/trade/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(clobCreds),
        })
      } catch { /* silent */ }
    }, 25_000)

    return () => { if (heartbeatRef.current) clearInterval(heartbeatRef.current) }
  }, [settings.auto_trade_enabled])

  // ── Derived state ─────────────────────────────────────────────────────────
  const highConfSignals = signals.filter(s => s.confidence >= 75 && s.direction !== 'HOLD')
  const buySignals      = highConfSignals.filter(s => s.direction === 'BUY')
  const sellSignals     = highConfSignals.filter(s => s.direction === 'SELL')
  const openTrades      = getOpenTrades()
  const allTrades       = getTrades()

  return (
    <div className="flex min-h-screen bg-background">
      <AppSidebar
        autoTradeEnabled={settings.auto_trade_enabled}
        scanning={scanning}
        connected={wsConnected}
      />

      <div className="flex-1 ml-16 lg:ml-56 min-w-0 flex flex-col">
        <AppHeader
          title="Dashboard"
          subtitle={lastUpdate ? `Last scan: ${lastUpdate.toLocaleTimeString()}` : 'Awaiting scan'}
          balance={portfolio.total_balance}
          totalPnL={portfolio.total_pnl}
          autoTradeEnabled={settings.auto_trade_enabled}
          onToggleAutoTrade={toggleAutoTrade}
          onRefresh={fetchMarkets}
          loading={loading}
        />

        <main className="flex-1 p-4 space-y-4 overflow-auto">
          {/* Notifications */}
          {notifications.length > 0 && (
            <div className="space-y-1.5">
              {notifications.map((n, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-2 bg-profit/10 border border-profit/20 rounded-md text-xs text-profit">
                  <Zap className="w-3.5 h-3.5 shrink-0" />
                  {n}
                </div>
              ))}
            </div>
          )}

          {/* WebSocket status */}
          <div className={cn(
            'flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium w-fit',
            wsConnected
              ? 'bg-profit/10 text-profit border border-profit/20'
              : 'bg-secondary text-muted-foreground border border-border'
          )}>
            {wsConnected ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
            {wsConnected ? 'Real-time prices connected' : 'Connecting to live prices...'}
            {wsConnected && <span className="ml-1 opacity-70">{tokenIds.length} tokens</span>}
          </div>

          {/* Portfolio stats */}
          <PortfolioStatsBar stats={portfolio} />

          {/* ✅ FIX: Quick stats — sekarang 5 kolom (tambah crypto) */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <QuickStat icon={BrainCircuit} label="Signals Found"    value={String(signals.length)}      sub={`${highConfSignals.length} high confidence`} color="primary" />
            <QuickStat icon={TrendingUp}   label="BUY Signals"      value={String(buySignals.length)}    sub="above 75%"                                  color="profit"  />
            <QuickStat icon={TrendingDown} label="SELL Signals"     value={String(sellSignals.length)}   sub="above 75%"                                  color="loss"    />
            <QuickStat icon={Zap}          label="Crypto ↑↓ Signals" value={String(cryptoActionable)}    sub={cryptoSummary ? `${cryptoSummary.bulls} UP · ${cryptoSummary.bears} DOWN` : 'Awaiting data'} color="profit" />
            <QuickStat icon={Activity}     label="Open Positions"   value={String(openTrades.length)}    sub={`${allTrades.length} total trades`}          color="primary" />
          </div>

          <div className="grid lg:grid-cols-3 gap-4">
            {/* Market scan section */}
            <div className="lg:col-span-2 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground">Market Scan</h2>
                <div className="flex items-center gap-2">
                  {scanning && <span className="text-xs text-primary font-mono">{scanProgress}%</span>}
                  <button
                    onClick={runAIScan}
                    disabled={scanning || !markets.length}
                    className="flex items-center gap-1.5 px-3 h-8 bg-primary text-primary-foreground rounded-md text-xs font-semibold hover:bg-primary/90 transition-all disabled:opacity-50"
                  >
                    <BrainCircuit className={cn('w-3.5 h-3.5', scanning && 'animate-pulse')} />
                    {scanning ? `Scanning ${scanProgress}%` : 'Run AI Scan'}
                  </button>
                </div>
              </div>

              {scanning && (
                <div className="h-1 bg-secondary rounded-full overflow-hidden">
                  <div className="h-full bg-primary transition-all duration-300 rounded-full" style={{ width: `${scanProgress}%` }} />
                </div>
              )}

              <div className="space-y-2">
                {signals.slice(0, 8).map(signal => (
                  <SignalRow key={signal.market_id} signal={signal} />
                ))}
                {signals.length === 0 && !scanning && (
                  <div className="flex flex-col items-center justify-center py-12 text-center border border-dashed border-border rounded-lg">
                    <BrainCircuit className="w-10 h-10 text-muted-foreground mb-3" />
                    <p className="text-sm font-medium text-foreground mb-1">No signals yet</p>
                    <p className="text-xs text-muted-foreground mb-3">
                      {markets.length > 0
                        ? `${markets.length} markets loaded. Click "Run AI Scan" to analyze.`
                        : 'Loading markets...'}
                    </p>
                  </div>
                )}
                {signals.length > 8 && (
                  <Link href="/signals" className="flex items-center justify-center gap-1.5 py-2 text-xs text-primary hover:underline">
                    View all {signals.length} signals <ChevronRight className="w-3.5 h-3.5" />
                  </Link>
                )}
              </div>
            </div>

            {/* Right panel */}
            <div className="space-y-3">
              <div className={cn(
                'p-4 rounded-lg border',
                settings.auto_trade_enabled ? 'bg-profit/5 border-profit/20' : 'bg-secondary border-border'
              )}>
                <div className="flex items-center gap-2 mb-2">
                  <div className={cn('w-2 h-2 rounded-full', settings.auto_trade_enabled ? 'bg-profit animate-pulse' : 'bg-muted-foreground')} />
                  <span className="text-sm font-semibold text-foreground">
                    {settings.auto_trade_enabled ? 'Auto Trading Active' : 'Auto Trading Inactive'}
                  </span>
                </div>
                <div className="space-y-1.5 text-xs">
                  <ConfigRow label="Min Confidence" value={`${settings.min_confidence}%`} />
                  <ConfigRow label="Trade Size"     value={`$${settings.min_trade_size}–$${settings.max_trade_size}`} />
                  <ConfigRow label="Stop Loss"      value={`${settings.default_stop_loss}%`} />
                  <ConfigRow label="Take Profit"    value={`${settings.default_take_profit}%`} />
                  <ConfigRow label="Max Positions"  value={String(settings.max_open_positions)} />
                </div>
                <Link href="/settings" className="mt-3 flex items-center justify-center gap-1.5 w-full h-8 border border-border rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-all">
                  Configure <ChevronRight className="w-3 h-3" />
                </Link>
              </div>

              <div className="bg-card border border-border rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                  <span className="text-sm font-semibold text-foreground">Open Positions</span>
                  <Link href="/portfolio" className="text-xs text-primary hover:underline">View all</Link>
                </div>
                <div className="divide-y divide-border">
                  {openTrades.slice(0, 4).map(t => <OpenPositionRow key={t.id} trade={t} />)}
                  {openTrades.length === 0 && (
                    <p className="px-4 py-4 text-xs text-muted-foreground text-center">No open positions</p>
                  )}
                </div>
              </div>

              <div className="bg-card border border-border rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-foreground">Markets Loaded</span>
                  <span className="text-lg font-mono font-bold text-primary">{markets.length}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Top volume markets from Polymarket. Updates every minute.
                </p>
              </div>

              {/* ✅ FIX: Crypto summary card */}
              {cryptoSummary && (
                <div className="bg-card border border-warning/30 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Zap className="w-4 h-4 text-warning" />
                    <span className="text-sm font-semibold text-foreground">Crypto ↑↓ Signals</span>
                  </div>
                  <div className="space-y-1.5 text-xs">
                    <ConfigRow label="Actionable" value={String(cryptoSummary.actionable)} />
                    <ConfigRow label="UP (BUY)"   value={String(cryptoSummary.bulls)} />
                    <ConfigRow label="DOWN (SELL)" value={String(cryptoSummary.bears)} />
                    <ConfigRow label="Total markets" value={String(cryptoSummary.total)} />
                  </div>
                  <Link href="/crypto" className="mt-3 flex items-center justify-center gap-1.5 w-full h-8 border border-warning/30 rounded-md text-xs text-warning hover:bg-warning/5 transition-all">
                    View Crypto Page <ChevronRight className="w-3 h-3" />
                  </Link>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SignalRow({ signal }: { signal: CombinedSignal }) {
  const isHigh = signal.confidence >= 75
  return (
    <div className={cn(
      'flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all',
      isHigh
        ? signal.direction === 'BUY' ? 'bg-profit/5 border-profit/20' : 'bg-loss/5 border-loss/20'
        : 'bg-secondary/30 border-border'
    )}>
      <div className={cn(
        'w-6 h-6 rounded flex items-center justify-center shrink-0',
        signal.direction === 'BUY' ? 'bg-profit/20' : signal.direction === 'SELL' ? 'bg-loss/20' : 'bg-secondary'
      )}>
        {signal.direction === 'BUY'
          ? <TrendingUp className="w-3.5 h-3.5 text-profit" />
          : signal.direction === 'SELL'
            ? <TrendingDown className="w-3.5 h-3.5 text-loss" />
            : <Activity className="w-3.5 h-3.5 text-muted-foreground" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-foreground truncate">{signal.question}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-muted-foreground font-mono">YES: {(signal.yesPrice * 100).toFixed(0)}¢</span>
          <span className={cn('text-xs font-semibold', signal.direction === 'BUY' ? 'text-profit' : 'text-loss')}>
            → BUY {signal.recommendedSide}
          </span>
        </div>
      </div>
      <div className="text-right shrink-0">
        <span className={cn(
          'text-sm font-mono font-bold',
          signal.confidence >= 80 ? 'text-profit' : signal.confidence >= 65 ? 'text-chart-4' : 'text-muted-foreground'
        )}>{signal.confidence}%</span>
        <p className="text-xs text-muted-foreground">{signal.analyses.length} AI</p>
      </div>
    </div>
  )
}

function OpenPositionRow({ trade }: { trade: ReturnType<typeof getOpenTrades>[0] }) {
  const pnl = trade.pnl ?? 0
  return (
    <div className="px-4 py-2.5 flex items-center gap-3">
      <span className={cn('text-xs font-semibold px-1.5 py-0.5 rounded', trade.side === 'YES' ? 'bg-profit/10 text-profit' : 'bg-loss/10 text-loss')}>
        {trade.side}
      </span>
      <p className="flex-1 text-xs text-foreground truncate">{trade.question}</p>
      <span className={cn('text-xs font-mono font-semibold', pnl >= 0 ? 'text-profit' : 'text-loss')}>
        {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
      </span>
    </div>
  )
}

function QuickStat({ icon: Icon, label, value, sub, color }: {
  icon: React.ElementType; label: string; value: string; sub: string; color: string
}) {
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Icon className={cn('w-4 h-4', color === 'primary' ? 'text-primary' : color === 'profit' ? 'text-profit' : 'text-loss')} />
      </div>
      <p className={cn('text-2xl font-mono font-bold', color === 'primary' ? 'text-foreground' : color === 'profit' ? 'text-profit' : 'text-loss')}>{value}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>
    </div>
  )
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium text-foreground">{value}</span>
    </div>
  )
}

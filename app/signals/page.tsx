'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  BrainCircuit, TrendingUp, TrendingDown, Activity,
  Filter, Loader2, RefreshCw, AlertCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { AppSidebar } from '@/components/app-sidebar'
import { AppHeader } from '@/components/app-header'
import {
  getSettings,
  calculatePortfolioStats,
  getTrades,          // ← tambah import
  saveTrades,         // ← tambah import
  getCredentials,
} from '@/lib/trade-engine'
import type { CombinedSignal, PolymarketMarket, TradingSettings, Trade, TradeSide, TradeStatus } from '@/lib/types'

type FilterType = 'all' | 'high' | 'buy' | 'sell'

interface AnalyzeResponse {
  signal?: CombinedSignal
  error?: string
}

const RATE_LIMIT_DELAY = 500

// ─── Safe UUID ────────────────────────────────────────────────────────────────
function safeUUID(): string {
  try { return crypto.randomUUID() } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 6)}`
  }
}

export default function SignalsPage() {
  const [markets, setMarkets]         = useState<PolymarketMarket[]>([])
  const [signals, setSignals]         = useState<CombinedSignal[]>([])
  const [scanning, setScanning]       = useState(false)
  const [progress, setProgress]       = useState(0)
  const [filter, setFilter]           = useState<FilterType>('all')
  const [selected, setSelected]       = useState<CombinedSignal | null>(null)
  const [executingIds, setExecutingIds] = useState<Set<string>>(new Set())
  const [retryCount, setRetryCount]   = useState(0)
  const [lastError, setLastError]     = useState<string | null>(null)
  const [analyzingMarkets, setAnalyzingMarkets] = useState<Set<string>>(new Set())

  const settings  = getSettings()
  const portfolio = calculatePortfolioStats()

  const executedThisSession = useRef<Set<string>>(new Set())

  const calcTradeSize = (sig: CombinedSignal): number => {
    const mult = Math.min(sig.confidence / 100, 1)
    return Math.round(settings.min_trade_size + (settings.max_trade_size - settings.min_trade_size) * mult)
  }

  // ── Analyze dengan retry ──────────────────────────────────────────────────
  const analyzeWithRetry = useCallback(async (market: PolymarketMarket): Promise<AnalyzeResponse | null> => {
    const MAX_RETRIES = 10
    let delay = 1000

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ market }),
        })

        if (response.status === 425) {
          await new Promise(r => setTimeout(r, delay))
          delay = Math.min(delay * 2, 30_000)
          continue
        }
        if (!response.ok) return null
        return await response.json()
      } catch {
        await new Promise(r => setTimeout(r, delay))
      }
    }
    return null
  }, [])

  // ── Scan semua markets ────────────────────────────────────────────────────
  const fetchAndScan = useCallback(async () => {
    setScanning(true)
    setProgress(0)
    setSignals([])
    setAnalyzingMarkets(new Set())
    setLastError(null)
    executedThisSession.current.clear()

    try {
      const res = await fetch('/api/markets?type=top&limit=15')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { markets: mData } = await res.json()
      const validMarkets: PolymarketMarket[] = mData ?? []
      setMarkets(validMarkets)

      for (let i = 0; i < validMarkets.length; i++) {
        const market = validMarkets[i]
        setProgress(Math.round(((i + 1) / validMarkets.length) * 100))
        setAnalyzingMarkets(prev => new Set([...prev, market.id]))

        const result = await analyzeWithRetry(market)
        if (result?.signal) {
          setSignals(prev => [...prev, result.signal!].sort((a, b) => b.confidence - a.confidence))
        }

        setAnalyzingMarkets(prev => {
          const next = new Set(prev)
          next.delete(market.id)
          return next
        })

        await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY))
      }

      setRetryCount(0)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      setLastError(msg)
      console.error('[signals] fetchAndScan error:', msg)
    } finally {
      setScanning(false)
    }
  }, [analyzeWithRetry])

  const handleRetry = useCallback(() => {
    const delay = Math.min(1000 * Math.pow(2, retryCount), 30_000)
    setTimeout(() => {
      setRetryCount(prev => prev + 1)
      fetchAndScan()
    }, delay)
  }, [retryCount, fetchAndScan])

  // ── Execute signal ────────────────────────────────────────────────────────
  const executeSignal = useCallback(async (signal: CombinedSignal) => {
    if (executedThisSession.current.has(signal.market_id)) return
    executedThisSession.current.add(signal.market_id)
    setExecutingIds(prev => new Set(prev).add(signal.market_id))

    const storedCreds = getCredentials()

    if (!storedCreds?.api_key || !storedCreds?.api_secret || !storedCreds?.funder_address) {
      alert('Please configure complete API credentials in Settings first.')
      setExecutingIds(prev => { const next = new Set(prev); next.delete(signal.market_id); return next })
      executedThisSession.current.delete(signal.market_id)
      return
    }

    if (!storedCreds.private_key) {
      alert('Private key not configured. Please add your wallet private key in Settings.')
      setExecutingIds(prev => { const next = new Set(prev); next.delete(signal.market_id); return next })
      executedThisSession.current.delete(signal.market_id)
      return
    }

    const clobCreds = {
      apiKey:        storedCreds.api_key,
      apiSecret:     storedCreds.api_secret,
      apiPassphrase: storedCreds.api_passphrase,
      funderAddress: storedCreds.funder_address,
      signatureType: storedCreds.signature_type ?? 2,
      privateKey:    storedCreds.private_key,
    }

    try {
      const res = await fetch('/api/trade/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          market_id:         signal.market_id,
          question:          signal.question,
          side:              signal.recommendedSide,
          size:              calcTradeSize(signal),
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
        const price = signal.recommendedSide === 'YES' ? signal.yesPrice : signal.noPrice

        // Gunakan getTrades() + saveTrades()
        const newTrade: Trade = {
          id:                result.trade_id ?? safeUUID(),
          market_id:         signal.market_id,
          condition_id:      result.condition_id ?? '',
          question:          signal.question,
          side:              signal.recommendedSide as TradeSide,
          token_id:          result.token_id ?? '',
          size:              calcTradeSize(signal),
          entry_price:       price,
          current_price:     price,
          stop_loss:         Math.max(0.01, price * (1 - settings.default_stop_loss / 100)),
          take_profit:       Math.min(0.99, price * (1 + settings.default_take_profit / 100)),
          status:            'OPEN' as TradeStatus,
          signal_confidence: signal.confidence,
          ai_rationale:      signal.analyses.map(a => `[${a.model}] ${a.rationale}`).join('\n'),
          order_id:          result.order_id,
          opened_at:         Date.now(),
        }

        const trades = getTrades()
        trades.unshift(newTrade)
        saveTrades(trades)

        setSignals(prev => prev.map(s => s.market_id === signal.market_id ? { ...s, executed: true } : s))
      } else {
        console.error('[signals] trade failed:', result.error)
        executedThisSession.current.delete(signal.market_id)
      }
    } catch (e) {
      console.error('[signals] execution error:', e)
      executedThisSession.current.delete(signal.market_id)
    } finally {
      setExecutingIds(prev => { const next = new Set(prev); next.delete(signal.market_id); return next })
    }
  }, [settings, calcTradeSize])

  // ── Auto-trade watcher ────────────────────────────────────────────────────
  useEffect(() => {
    if (!settings.auto_trade_enabled) return
    signals.forEach(sig => {
      const canTrade = sig.confidence >= settings.min_confidence && sig.direction !== 'HOLD' && !sig.executed
      if (canTrade) executeSignal(sig)
    })
  }, [signals, settings.auto_trade_enabled, settings.min_confidence, executeSignal])

  // ── Initial scan ──────────────────────────────────────────────────────────
  useEffect(() => {
    fetchAndScan()
    return () => {
      setAnalyzingMarkets(new Set())
      setSignals([])
    }
  }, [fetchAndScan])

  const filtered = useMemo(() => signals.filter(s => {
    if (filter === 'high') return s.confidence >= 75
    if (filter === 'buy')  return s.direction === 'BUY'
    if (filter === 'sell') return s.direction === 'SELL'
    return true
  }), [signals, filter])

  return (
    <div className="flex min-h-screen bg-background">
      <AppSidebar autoTradeEnabled={settings.auto_trade_enabled} scanning={scanning} />

      <div className="flex-1 ml-16 lg:ml-56 min-w-0 flex flex-col">
        <AppHeader
          title="AI Signals"
          subtitle={`${signals.length} signals${scanning ? ` · scanning ${progress}%` : ''}`}
          balance={portfolio.total_balance}
          totalPnL={portfolio.total_pnl}
          onRefresh={fetchAndScan}
          loading={scanning}
        />

        <main className="flex-1 p-4 space-y-4 overflow-auto">
          {scanning && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <BrainCircuit className="w-4 h-4 text-primary animate-pulse" />
                <span className="text-sm text-foreground">Analyzing {markets.length} markets with AI models...</span>
                <span className="ml-auto font-mono text-primary text-sm">{progress}%</span>
              </div>
              <div className="h-2 bg-secondary rounded-full overflow-hidden">
                <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {lastError && !scanning && (
            <div className="p-4 bg-loss/10 border border-loss/20 rounded-lg flex items-center justify-between">
              <div className="flex items-center gap-2 text-loss text-sm">
                <AlertCircle className="w-4 h-4" />
                <span>{lastError}</span>
              </div>
              <button onClick={handleRetry} className="flex items-center gap-1 px-3 py-1 bg-secondary border border-border rounded text-xs hover:bg-primary/10 transition">
                <RefreshCw className="w-3 h-3" /> Retry ({retryCount})
              </button>
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Total Signals',           value: signals.length,                                    color: 'text-foreground', bg: '' },
              { label: 'High Confidence (75%+)',  value: signals.filter(s => s.confidence >= 75).length,    color: 'text-profit',     bg: 'bg-profit/5 border-profit/20' },
              { label: 'BUY Signals',             value: signals.filter(s => s.direction === 'BUY').length, color: 'text-profit',     bg: '' },
              { label: 'SELL Signals',            value: signals.filter(s => s.direction === 'SELL').length,color: 'text-loss',       bg: '' },
            ].map(stat => (
              <div key={stat.label} className={cn('bg-card border border-border rounded-lg p-3', stat.bg)}>
                <p className="text-xs text-muted-foreground mb-1">{stat.label}</p>
                <p className={cn('text-2xl font-mono font-bold', stat.color)}>{stat.value}</p>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-muted-foreground" />
            {(['all', 'high', 'buy', 'sell'] as FilterType[]).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={cn('px-3 h-8 rounded-md text-xs font-medium transition-all',
                  filter === f ? 'bg-primary text-primary-foreground' : 'bg-secondary border border-border text-muted-foreground hover:text-foreground'
                )}>
                {f === 'all' ? 'All' : f === 'high' ? 'High Confidence' : f.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="grid lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 space-y-2">
              {filtered.map(signal => (
                <SignalCard
                  key={signal.market_id}
                  signal={signal}
                  selected={selected?.market_id === signal.market_id}
                  isAnalyzing={analyzingMarkets.has(signal.market_id)}
                  onSelect={() => setSelected(selected?.market_id === signal.market_id ? null : signal)}
                  onExecute={() => executeSignal(signal)}
                  executing={executingIds.has(signal.market_id)}
                  settings={settings}
                />
              ))}
              {filtered.length === 0 && !scanning && (
                <div className="py-12 text-center border border-dashed border-border rounded-lg">
                  <BrainCircuit className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm text-foreground mb-1">No signals found</p>
                  <button onClick={fetchAndScan} className="text-xs text-primary hover:underline">Run AI scan</button>
                </div>
              )}
            </div>

            <div>
              {selected ? (
                <SignalDetail signal={selected} settings={settings}
                  onExecute={() => executeSignal(selected)}
                  executing={executingIds.has(selected.market_id)} />
              ) : (
                <div className="bg-card border border-border rounded-lg p-6 text-center">
                  <BrainCircuit className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">Select a signal to see detailed AI analysis</p>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}

// ─── Signal Card ──────────────────────────────────────────────────────────────
function SignalCard({ signal, selected, isAnalyzing, onSelect, onExecute, executing, settings }: {
  signal: CombinedSignal; selected: boolean; isAnalyzing: boolean
  onSelect: () => void; onExecute: () => void; executing: boolean; settings: TradingSettings
}) {
  const isHigh       = signal.confidence >= settings.min_confidence
  const isExecutable = isHigh && signal.direction !== 'HOLD'
  return (
    <div onClick={onSelect} className={cn(
      'bg-card border rounded-lg p-3 cursor-pointer transition-all',
      selected ? 'border-primary' : isHigh
        ? signal.direction === 'BUY' ? 'border-profit/30' : 'border-loss/30'
        : 'border-border hover:border-border/80'
    )}>
      <div className="flex items-start gap-3">
        <div className={cn('mt-0.5 w-7 h-7 rounded flex items-center justify-center shrink-0',
          signal.direction === 'BUY' ? 'bg-profit/15' : signal.direction === 'SELL' ? 'bg-loss/15' : 'bg-secondary'
        )}>
          {isAnalyzing ? <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
            : signal.direction === 'BUY' ? <TrendingUp className="w-4 h-4 text-profit" />
            : signal.direction === 'SELL' ? <TrendingDown className="w-4 h-4 text-loss" />
            : <Activity className="w-4 h-4 text-muted-foreground" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground leading-snug line-clamp-2">{signal.question}</p>
          <div className="flex items-center flex-wrap gap-2 mt-1.5">
            <span className={cn('text-xs font-semibold',
              signal.direction === 'BUY' ? 'text-profit' : signal.direction === 'SELL' ? 'text-loss' : 'text-muted-foreground'
            )}>{signal.direction} {signal.recommendedSide}</span>
            <span className="text-xs text-muted-foreground font-mono">YES {(signal.yesPrice * 100).toFixed(0)}¢ / NO {(signal.noPrice * 100).toFixed(0)}¢</span>
            <span className="text-xs text-muted-foreground">{signal.analyses.length} AI models</span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className={cn('text-lg font-mono font-bold',
            signal.confidence >= 80 ? 'text-profit' : signal.confidence >= 65 ? 'text-chart-4' : 'text-muted-foreground'
          )}>{signal.confidence}%</p>
          {isExecutable && !signal.executed && (
            <button onClick={e => { e.stopPropagation(); onExecute() }} disabled={executing}
              className={cn('mt-1 px-2 py-1 rounded text-xs font-semibold transition-all disabled:opacity-50',
                signal.direction === 'BUY' ? 'bg-profit/15 text-profit hover:bg-profit/25' : 'bg-loss/15 text-loss hover:bg-loss/25'
              )}>{executing ? '...' : 'Execute'}</button>
          )}
          {signal.executed && <span className="text-xs text-profit font-medium">Executed</span>}
        </div>
      </div>
    </div>
  )
}

// ─── Signal Detail ────────────────────────────────────────────────────────────
function SignalDetail({ signal, settings, onExecute, executing }: {
  signal: CombinedSignal; settings: TradingSettings; onExecute: () => void; executing: boolean
}) {
  return (
    <div className="bg-card border border-primary/20 rounded-lg overflow-hidden sticky top-4">
      <div className={cn('h-1', signal.direction === 'BUY' ? 'bg-profit' : signal.direction === 'SELL' ? 'bg-loss' : 'bg-muted')} />
      <div className="p-4 space-y-4">
        <div>
          <p className="text-xs text-muted-foreground mb-1">Market Question</p>
          <p className="text-sm font-medium text-foreground leading-relaxed">{signal.question}</p>
        </div>
        <div>
          <div className="flex justify-between text-xs mb-1.5">
            <span className="text-muted-foreground">Ensemble Confidence</span>
            <span className="font-mono font-bold text-profit">{signal.confidence}%</span>
          </div>
          <div className="h-2 bg-secondary rounded-full overflow-hidden">
            <div className={cn('h-full rounded-full transition-all',
              signal.confidence >= 80 ? 'bg-profit' : signal.confidence >= 65 ? 'bg-chart-4' : 'bg-primary'
            )} style={{ width: `${signal.confidence}%` }} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <PriceBox label="YES Price" value={`${(signal.yesPrice * 100).toFixed(1)}¢`} color="profit" />
          <PriceBox label="NO Price"  value={`${(signal.noPrice  * 100).toFixed(1)}¢`} color="loss" />
        </div>
        <div className={cn('p-3 rounded-lg', signal.direction === 'BUY' ? 'bg-profit/10' : 'bg-loss/10')}>
          <p className="text-xs text-muted-foreground mb-0.5">AI Recommendation</p>
          <p className={cn('text-base font-bold', signal.direction === 'BUY' ? 'text-profit' : 'text-loss')}>
            {signal.direction === 'BUY' ? 'BUY' : 'SELL'} {signal.recommendedSide} tokens
          </p>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">AI Model Analyses</p>
          {signal.analyses.map((a, i) => (
            <div key={i} className="bg-secondary/50 rounded p-2.5">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-mono text-primary font-semibold">{a.model}</span>
                <div className="flex items-center gap-1.5">
                  <span className={cn('text-xs font-semibold', a.signal === 'BUY' ? 'text-profit' : a.signal === 'SELL' ? 'text-loss' : 'text-muted-foreground')}>{a.signal}</span>
                  <span className="text-xs text-muted-foreground">{a.confidence}%</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{a.rationale}</p>
            </div>
          ))}
        </div>
        {signal.confidence >= settings.min_confidence && signal.direction !== 'HOLD' && !signal.executed && (
          <button onClick={onExecute} disabled={executing}
            className={cn('w-full h-10 rounded-lg text-sm font-bold transition-all disabled:opacity-50',
              signal.direction === 'BUY' ? 'bg-profit text-foreground hover:bg-profit/90' : 'bg-loss text-foreground hover:bg-loss/90'
            )}>
            {executing ? 'Executing...' : `Execute ${signal.direction} — $${settings.min_trade_size} USDC`}
          </button>
        )}
        {signal.executed && (
          <div className="w-full h-10 rounded-lg bg-profit/10 border border-profit/30 flex items-center justify-center text-sm font-medium text-profit">
            Trade Executed
          </div>
        )}
      </div>
    </div>
  )
}

function PriceBox({ label, value, color }: { label: string; value: string; color: 'profit' | 'loss' }) {
  return (
    <div className={cn('rounded p-2 text-center border', color === 'profit' ? 'bg-profit/5 border-profit/15' : 'bg-loss/5 border-loss/15')}>
      <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
      <p className={cn('text-lg font-mono font-bold', color === 'profit' ? 'text-profit' : 'text-loss')}>{value}</p>
    </div>
  )
}

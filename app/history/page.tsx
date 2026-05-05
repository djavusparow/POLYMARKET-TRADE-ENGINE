'use client'

import { useState, useEffect } from 'react'
import { History, Download, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AppSidebar } from '@/components/app-sidebar'
import { AppHeader } from '@/components/app-header'
import { TradeTable } from '@/components/trade-table'
import { getSettings, getTrades, calculatePortfolioStats } from '@/lib/trade-engine'
import type { Trade } from '@/lib/types'

type FilterStatus = 'all' | 'open' | 'closed' | 'stop_loss' | 'take_profit'

export default function HistoryPage() {
  const [trades, setTrades] = useState<Trade[]>([])
  const [filter, setFilter] = useState<FilterStatus>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  
  const settings = getSettings()
  const portfolio = calculatePortfolioStats()

  // Fetch trades and set up polling for real-time updates
  useEffect(() => {
    let isMounted = true

    const fetchTrades = () => {
      try {
        const data = getTrades()
        if (isMounted) {
          setTrades(data)
          setError(null)
        }
      } catch (e) {
        if (isMounted) {
          setError(e instanceof Error ? e.message : 'Failed to load trades')
        }
      } finally {
        if (isMounted) {
          setLoading(false)
        }
      }
    }

    // Initial fetch
    fetchTrades()

    // Poll every 30 seconds for real-time updates
    const interval = setInterval(fetchTrades, 30_000)

    return () => {
      isMounted = false
      clearInterval(interval)
    }
  }, [])

  const filtered = trades.filter(t => {
    if (filter === 'all') return true
    // Include CLOB API statuses for "open" filter
    if (filter === 'open') return (
      t.status === 'OPEN' || 
      t.status === 'PENDING' || 
      t.status === 'MATCHED' || 
      t.status === 'MINED' ||
      t.status === 'RETRYING'
    )
    // Include CLOB API status for "closed" filter
    if (filter === 'closed') return (
      t.status === 'CLOSED' || 
      t.status === 'CONFIRMED' || 
      t.status === 'CANCELLED' ||
      t.status === 'FAILED'
    )
    if (filter === 'stop_loss') return t.status === 'STOP_LOSS'
    if (filter === 'take_profit') return t.status === 'TAKE_PROFIT'
    return true
  })

  const totalPnL = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0)
  const winners = trades.filter(t => (t.pnl ?? 0) > 0).length
  const losers = trades.filter(t => (t.pnl ?? 0) < 0).length
  const winRate = trades.length > 0 ? (winners / trades.length) * 100 : 0

  const exportCSV = () => {
    const rows = [
      ['Date', 'Market', 'Side', 'Size', 'Entry', 'Exit', 'P&L', 'Status', 'Confidence'],
      ...trades.map(t => [
        new Date(t.opened_at).toLocaleDateString('en-US', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }),
        t.question,
        t.side,
        t.size,
        t.entry_price,
        t.exit_price ?? '',
        t.pnl ?? '',
        t.status,
        t.signal_confidence,
      ]),
    ]
    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `polytrade-history-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex min-h-screen bg-background">
      <AppSidebar autoTradeEnabled={settings.auto_trade_enabled} />

      <div className="flex-1 ml-16 lg:ml-56 min-w-0 flex flex-col">
        <AppHeader
          title="Trade History"
          subtitle={`${trades.length} total trades`}
          balance={portfolio.total_balance}
          totalPnL={portfolio.total_pnl}
        />

        <main className="flex-1 p-4 space-y-4 overflow-auto">
          {/* Error state */}
          {error && (
            <div className="flex items-center gap-2 p-3 bg-loss/10 border border-loss/20 rounded-lg text-loss text-sm">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Summary stats */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <SummaryCard label="Total Trades" value={String(trades.length)} />
            <SummaryCard
              label="Total P&L"
              value={`${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`}
              valueClass={totalPnL >= 0 ? 'text-profit' : 'text-loss'}
            />
            <SummaryCard
              label="Win Rate"
              value={`${winRate.toFixed(1)}%`}
              valueClass={winRate >= 50 ? 'text-profit' : 'text-loss'}
            />
            <SummaryCard label="Winners" value={String(winners)} valueClass="text-profit" />
            <SummaryCard label="Losers" value={String(losers)} valueClass="text-loss" />
          </div>

          {/* Controls */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2">
              {([
                { key: 'all', label: 'All' },
                { key: 'open', label: 'Open' },
                { key: 'closed', label: 'Closed' },
                { key: 'stop_loss', label: 'Stop Loss' },
                { key: 'take_profit', label: 'Take Profit' },
              ] as { key: FilterStatus; label: string }[]).map(f => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={cn(
                    'px-3 h-8 rounded-md text-xs font-medium transition-all',
                    filter === f.key
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary border border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <button
              onClick={exportCSV}
              disabled={trades.length === 0}
              className="flex items-center gap-1.5 px-3 h-8 rounded-md border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-all disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </button>
          </div>

          {/* Loading or Trade Table */}
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
              Loading trades...
            </div>
          ) : (
            <TradeTable trades={filtered} title={`${filtered.length} trades`} />
          )}
        </main>
      </div>
    </div>
  )
}

function SummaryCard({
  label, value, valueClass = 'text-foreground',
}: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="bg-card border border-border rounded-lg p-3">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className={cn('text-xl font-mono font-bold', valueClass)}>{value}</p>
    </div>
  )
}

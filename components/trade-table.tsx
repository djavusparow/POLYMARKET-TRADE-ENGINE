'use client'

import { useState } from 'react'
import {
  TrendingUp, TrendingDown, Clock, CheckCircle, XCircle,
  AlertTriangle, ChevronDown, ChevronUp, Activity,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Trade } from '@/lib/types'

interface TradeTableProps {
  trades: Trade[]
  title?: string
  showPagination?: boolean
}

// Updated STATUS_CONFIG with Polymarket API status codes + Custom statuses
const STATUS_CONFIG: Record<string, { label: string; icon: React.ElementType; class: string }> = {
  // Polymarket API Standard Statuses
  MATCHED:     { label: 'Matched',     icon: Clock,          class: 'text-muted-foreground' },
  MINED:       { label: 'Mined',       icon: Activity,       class: 'text-primary' },
  CONFIRMED:   { label: 'Confirmed',   icon: CheckCircle,    class: 'text-profit' },
  RETRYING:    { label: 'Retrying',    icon: AlertTriangle,  class: 'text-chart-4' },
  FAILED:      { label: 'Failed',      icon: XCircle,        class: 'text-loss' },

  // Custom Internal Statuses
  PENDING:     { label: 'Pending',     icon: Clock,          class: 'text-muted-foreground' },
  OPEN:        { label: 'Open',        icon: Activity,       class: 'text-primary' },
  CLOSED:      { label: 'Closed',      icon: CheckCircle,    class: 'text-profit' },
  CANCELLED:   { label: 'Cancelled',   icon: XCircle,        class: 'text-muted-foreground' },
  STOP_LOSS:   { label: 'Stop Loss',   icon: AlertTriangle,  class: 'text-loss' },
  TAKE_PROFIT: { label: 'Take Profit', icon: CheckCircle,    class: 'text-profit' },
}

export function TradeTable({ trades, title = 'Trade History', showPagination = true }: TradeTableProps) {
  const [page, setPage] = useState(0)
  const [expandedRow, setExpandedRow] = useState<string | null>(null)
  const PAGE_SIZE = 10
  
  // Safely handle date parsing for both timestamps (number) and ISO strings (string)
  const parseDate = (dateValue: number | string | undefined): Date => {
    if (!dateValue) return new Date()
    if (typeof dateValue === 'number') return new Date(dateValue)
    return new Date(dateValue)
  }

  const paged = trades.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const totalPages = Math.ceil(trades.length / PAGE_SIZE)

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <span className="text-xs text-muted-foreground">{trades.length} trades</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="px-4 py-2.5 text-left text-xs text-muted-foreground font-medium">Market</th>
              <th className="px-3 py-2.5 text-center text-xs text-muted-foreground font-medium">Side</th>
              <th className="px-3 py-2.5 text-right text-xs text-muted-foreground font-medium">Size</th>
              <th className="px-3 py-2.5 text-right text-xs text-muted-foreground font-medium">Entry</th>
              <th className="px-3 py-2.5 text-right text-xs text-muted-foreground font-medium">Current</th>
              <th className="px-3 py-2.5 text-right text-xs text-muted-foreground font-medium">P&amp;L</th>
              <th className="px-3 py-2.5 text-center text-xs text-muted-foreground font-medium">Confidence</th>
              <th className="px-3 py-2.5 text-center text-xs text-muted-foreground font-medium">Status</th>
              <th className="px-3 py-2.5 text-left text-xs text-muted-foreground font-medium">Date</th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {paged.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-muted-foreground text-sm">
                  No trades found
                </td>
              </tr>
            )}
            {paged.map((trade) => {
              const pnl = trade.pnl ?? 0
              const currentPrice = trade.current_price ?? trade.entry_price
              const isExpanded = expandedRow === trade.id
              
              // Fallback to 'OPEN' if status is unknown
              const StatusCfg = STATUS_CONFIG[trade.status] ?? STATUS_CONFIG['OPEN']
              const StatusIcon = StatusCfg.icon

              return [
                <tr
                  key={trade.id}
                  className={cn(
                    'border-b border-border/50 hover:bg-secondary/30 cursor-pointer transition-colors',
                    isExpanded && 'bg-secondary/20'
                  )}
                  onClick={() => setExpandedRow(isExpanded ? null : trade.id)}
                >
                  <td className="px-4 py-2.5">
                    <p className="text-xs text-foreground font-medium line-clamp-1 max-w-[200px]">
                      {trade.question}
                    </p>
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <span className={cn(
                      'inline-flex items-center gap-1 text-xs font-semibold px-1.5 py-0.5 rounded',
                      trade.side === 'YES' ? 'bg-profit/10 text-profit' : 'bg-loss/10 text-loss'
                    )}>
                      {trade.side === 'YES'
                        ? <TrendingUp className="w-3 h-3" />
                        : <TrendingDown className="w-3 h-3" />}
                      {trade.side}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <span className="text-xs font-mono text-foreground">${trade.size}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <span className="text-xs font-mono text-foreground">{(trade.entry_price * 100).toFixed(1)}¢</span>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <span className="text-xs font-mono text-foreground">{(currentPrice * 100).toFixed(1)}¢</span>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <span className={cn(
                      'text-xs font-mono font-semibold',
                      pnl >= 0 ? 'text-profit' : 'text-loss'
                    )}>
                      {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <span className={cn(
                      'text-xs font-mono font-semibold',
                      trade.signal_confidence >= 80 ? 'text-profit' :
                      trade.signal_confidence >= 65 ? 'text-chart-4' : 'text-muted-foreground'
                    )}>{trade.signal_confidence}%</span>
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <span className={cn('flex items-center justify-center gap-1 text-xs', StatusCfg.class)}>
                      <StatusIcon className="w-3 h-3" />
                      {StatusCfg.label}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="text-xs text-muted-foreground">
                      {parseDate(trade.opened_at).toLocaleDateString()}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    {isExpanded
                      ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
                      : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
                  </td>
                </tr>,
                isExpanded && (
                  <tr key={`${trade.id}-expand`} className="bg-secondary/20">
                    <td colSpan={10} className="px-4 py-3">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-2">
                        <InfoCell label="Order ID" value={trade.order_id ?? 'N/A'} mono />
                        <InfoCell label="Stop Loss" value={trade.stop_loss ? `${(trade.stop_loss * 100).toFixed(1)}¢` : 'N/A'} />
                        <InfoCell label="Take Profit" value={trade.take_profit ? `${(trade.take_profit * 100).toFixed(1)}¢` : 'N/A'} />
                        <InfoCell label="Opened" value={parseDate(trade.opened_at).toLocaleString()} />
                      </div>
                      {trade.ai_rationale && (
                        <div className="mt-2 p-2 bg-background/50 rounded text-xs text-muted-foreground leading-relaxed">
                          <span className="text-primary font-medium">AI Rationale: </span>
                          {trade.ai_rationale}
                        </div>
                      )}
                    </td>
                  </tr>
                ),
              ]
            })}
          </tbody>
        </table>
      </div>

      {showPagination && totalPages > 1 && (
        <div className="px-4 py-3 border-t border-border flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            Page {page + 1} of {totalPages}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-3 h-7 text-xs rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-all disabled:opacity-40"
            >Prev</button>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="px-3 h-7 text-xs rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-all disabled:opacity-40"
            >Next</button>
          </div>
        </div>
      )}
    </div>
  )
}

function InfoCell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
      <p className={cn('text-xs text-foreground', mono && 'font-mono truncate')}>{value}</p>
    </div>
  )
}

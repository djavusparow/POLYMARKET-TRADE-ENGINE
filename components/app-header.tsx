'use client'

import { RefreshCw, Power } from 'lucide-react'
import { cn } from '@/lib/utils'

interface AppHeaderProps {
  title: string
  subtitle?: string
  balance?: number
  totalPnL?: number
  autoTradeEnabled?: boolean
  onToggleAutoTrade?: () => void
  onRefresh?: () => void
  loading?: boolean
}

export function AppHeader({
  title,
  subtitle,
  balance = 0,
  totalPnL = 0,
  autoTradeEnabled = false,
  onToggleAutoTrade,
  onRefresh,
  loading = false,
}: AppHeaderProps) {
  const pnlPositive = totalPnL >= 0

  return (
    <header className="h-14 border-b border-border bg-card/50 backdrop-blur-sm flex items-center px-4 gap-4 sticky top-0 z-30">
      {/* Title */}
      <div className="flex-1 min-w-0">
        <h1 className="text-sm font-semibold text-foreground truncate">{title}</h1>
        {subtitle && (
          <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
        )}
      </div>

      {/* Stats row */}
      <div className="hidden md:flex items-center gap-4">
        <StatChip 
          label="Balance (USDC)" 
          value={`$${balance.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} 
        />
        <StatChip
          label="Total P&L"
          value={`${pnlPositive ? '+' : ''}$${totalPnL.toFixed(2)}`}
          valueClass={pnlPositive ? 'text-profit' : 'text-loss'}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {onRefresh && (
          <button
            onClick={onRefresh}
            disabled={loading}
            className="w-8 h-8 rounded-md border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-all disabled:opacity-50"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>
        )}

        {onToggleAutoTrade && (
          <button
            onClick={onToggleAutoTrade}
            className={cn(
              'flex items-center gap-1.5 px-3 h-8 rounded-md text-xs font-semibold border transition-all',
              autoTradeEnabled
                ? 'bg-profit/10 border-profit/30 text-profit hover:bg-profit/20'
                : 'bg-secondary border-border text-muted-foreground hover:text-foreground hover:bg-secondary/80'
            )}
          >
            <Power className="w-3 h-3" />
            <span className="hidden sm:inline">{autoTradeEnabled ? 'Auto: ON' : 'Auto: OFF'}</span>
          </button>
        )}
      </div>
    </header>
  )
}

function StatChip({
  label,
  value,
  valueClass = 'text-foreground',
}: {
  label: string
  value: string
  valueClass?: string
}) {
  return (
    <div className="flex flex-col items-end">
      <span className="text-xs text-muted-foreground leading-none">{label}</span>
      <span className={cn('text-sm font-mono font-semibold mt-0.5', valueClass)}>{value}</span>
    </div>
  )
}

'use client'

import { useState, useEffect } from 'react'
import {
  TrendingUp, TrendingDown, Activity, Target, DollarSign,
  Coins, BarChart3, Zap, ArrowUp, ArrowDown,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PortfolioStats } from '@/lib/types'
import {
  getCryptoTrades,
  getOpenCryptoTrades,
  calculateCryptoPortfolioStats,
} from '@/lib/trade-engine'

interface PortfolioStatsProps {
  stats: PortfolioStats
  collateral?: string // 'pUSD' untuk V2, 'USDC' untuk legacy
}

export function PortfolioStatsBar({ stats, collateral = 'pUSD' }: PortfolioStatsProps) {
  // ── Ambil data crypto up/down ──────────────────────────────────────
  const [cryptoStats, setCryptoStats] = useState<ReturnType<typeof calculateCryptoPortfolioStats> | null>(null)

  useEffect(() => {
    function refresh() {
      setCryptoStats(calculateCryptoPortfolioStats())
    }
    refresh()
    const interval = setInterval(refresh, 5_000) // refresh tiap 5 detik
    return () => clearInterval(interval)
  }, [])

  // ── Data ───────────────────────────────────────────────────────────
  if (!stats) return null

  const totalBalance     = stats.total_balance     ?? 0
  const availableBalance = stats.available_balance ?? 0
  const totalPnl         = stats.total_pnl         ?? 0
  const todayPnl         = stats.today_pnl         ?? 0
  const winRate          = stats.win_rate           ?? 0
  const openPositions    = stats.open_positions     ?? 0

  // Crypto up/down stats
  const cryptoOpenPositions = cryptoStats?.openPositions ?? 0
  const cryptoTrades        = cryptoStats?.totalTrades ?? 0
  const cryptoWins          = cryptoStats?.wins ?? 0
  const cryptoLosses        = cryptoStats?.losses ?? 0
  const cryptoWinRate       = cryptoStats?.winRate ?? 0
  const cryptoTotalPnl      = cryptoStats?.totalPnl ?? 0
  const cryptoActiveCoins   = cryptoStats?.activeCoins ?? []

  const fmt2 = (n: number) => n.toLocaleString('en', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

  return (
    <div className="space-y-4">
      {/* ── Collateral badge ────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Coins className="w-3 h-3 text-primary" />
        <span>Collateral: <span className="text-primary font-medium">{collateral}</span></span>
        <span className="opacity-40">·</span>
        <span>Backed 1:1 by USDC</span>
      </div>

      {/* ── Polymarket Stats ─────────────────────────────────────────── */}
      <div>
        <h4 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
          <BarChart3 className="w-3 h-3 text-primary" />
          Polymarket Portfolio
        </h4>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard
            label={`Total Balance (${collateral})`}
            value={`$${fmt2(totalBalance)}`}
            icon={DollarSign}
            iconClass="text-primary"
          />
          <StatCard
            label="Available"
            value={`$${fmt2(availableBalance)}`}
            icon={DollarSign}
            iconClass="text-muted-foreground"
          />
          <StatCard
            label="Total P&L"
            value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`}
            icon={totalPnl >= 0 ? TrendingUp : TrendingDown}
            valueClass={totalPnl >= 0 ? 'text-profit' : 'text-loss'}
            iconClass={totalPnl >= 0 ? 'text-profit' : 'text-loss'}
          />
          <StatCard
            label="Today P&L"
            value={`${todayPnl >= 0 ? '+' : ''}$${todayPnl.toFixed(2)}`}
            icon={Activity}
            valueClass={todayPnl >= 0 ? 'text-profit' : 'text-loss'}
            iconClass={todayPnl >= 0 ? 'text-profit' : 'text-loss'}
          />
          <StatCard
            label="Win Rate"
            value={`${winRate.toFixed(1)}%`}
            icon={Target}
            iconClass="text-primary"
          />
          <StatCard
            label="Open Positions"
            value={openPositions}
            icon={Activity}
            iconClass="text-chart-4"
          />
        </div>
      </div>

      {/* ── Crypto Up/Down Stats ─────────────────────────────────────── */}
      <div>
        <h4 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
          <Zap className="w-3 h-3 text-warning" />
          Crypto ↑↓ Trades
        </h4>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard
            label="Open Positions"
            value={cryptoOpenPositions}
            icon={Activity}
            iconClass="text-chart-4"
            badge={cryptoActiveCoins.length > 0 ? cryptoActiveCoins.map(c => c.toUpperCase()).join(', ') : undefined}
          />
          <StatCard
            label="Total Trades"
            value={cryptoTrades}
            icon={BarChart3}
            iconClass="text-primary"
          />
          <StatCard
            label="Wins / Losses"
            value={`${cryptoWins} / ${cryptoLosses}`}
            icon={cryptoWins >= cryptoLosses ? ArrowUp : ArrowDown}
            valueClass={cryptoWins >= cryptoLosses ? 'text-profit' : 'text-loss'}
            iconClass={cryptoWins >= cryptoLosses ? 'text-profit' : 'text-loss'}
          />
          <StatCard
            label="Win Rate"
            value={`${cryptoWinRate.toFixed(1)}%`}
            icon={Target}
            iconClass="text-primary"
          />
          <StatCard
            label="Total P&L"
            value={`${cryptoTotalPnl >= 0 ? '+' : ''}$${cryptoTotalPnl.toFixed(2)}`}
            icon={cryptoTotalPnl >= 0 ? TrendingUp : TrendingDown}
            valueClass={cryptoTotalPnl >= 0 ? 'text-profit' : 'text-loss'}
            iconClass={cryptoTotalPnl >= 0 ? 'text-profit' : 'text-loss'}
          />
          <StatCard
            label="Active Coins"
            value={cryptoActiveCoins.length > 0 ? cryptoActiveCoins.length : 0}
            icon={Zap}
            iconClass="text-warning"
            badge={cryptoActiveCoins.length > 0 ? cryptoActiveCoins.map(c => c.toUpperCase()).join(', ') : 'None'}
          />
        </div>
      </div>
    </div>
  )
}

// ─── Sub-component: StatCard ──────────────────────────────────────────────────
function StatCard({
  label,
  value,
  icon: Icon,
  valueClass = 'text-foreground',
  iconClass = 'text-primary',
  badge,
}: {
  label: string
  value: string | number
  icon: React.ElementType
  valueClass?: string
  iconClass?: string
  badge?: string
}) {
  return (
    <div className="bg-card border border-border rounded-lg p-3 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Icon className={cn('w-3.5 h-3.5', iconClass)} />
        <span className="text-xs text-muted-foreground truncate">{label}</span>
      </div>
      <p className={cn('text-lg font-bold font-mono', valueClass)}>{value}</p>
      {badge && (
        <p className="text-xs text-muted-foreground truncate">{badge}</p>
      )}
    </div>
  )
}

'use client'

import { useState } from 'react'
import { BrainCircuit, Loader2, TrendingUp, TrendingDown, Minus, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PolymarketMarket, CombinedSignal } from '@/lib/types'
import { formatVolume, parseOutcomePrice } from '@/lib/polymarket'

interface MarketCardProps {
  market: PolymarketMarket
  signal?: CombinedSignal
  onAnalyze?: (market: PolymarketMarket) => void
  analyzing?: boolean
  onExecute?: (signal: CombinedSignal) => void
  /** Real-time WebSocket price for YES token — overrides static outcomePrices if provided */
  realtimeYesPrice?: number
}

export function MarketCard({ market, signal, onAnalyze, analyzing, onExecute, realtimeYesPrice }: MarketCardProps) {
  const [expanded, setExpanded] = useState(false)

  // Use real-time WSS price if available, otherwise fall back to Gamma API static price
  const staticYesPrice = parseOutcomePrice(market.outcomePrices)
  const yesPrice = realtimeYesPrice !== undefined && realtimeYesPrice > 0 ? realtimeYesPrice : staticYesPrice
  const noPrice  = yesPrice > 0 ? 1 - yesPrice : 0

  // Handle volume fallback: prefer 24hr, then total volume, then 0
  const rawVolume = market.volume24hr ?? market.volume ?? 0
  const volume = formatVolume(rawVolume)

  const isLive = realtimeYesPrice !== undefined && realtimeYesPrice > 0

  return (
    <div className={cn(
      'bg-card border rounded-lg overflow-hidden transition-all duration-200',
      signal ? 'border-primary/20' : 'border-border hover:border-border/80'
    )}>
      {/* Signal indicator stripe */}
      {signal && (
        <div className={cn(
          'h-0.5',
          signal.direction === 'BUY' ? 'bg-profit' :
          signal.direction === 'SELL' ? 'bg-loss' : 'bg-muted-foreground'
        )} />
      )}

      <div className="p-4">
        {/* Header */}
        <div className="flex items-start gap-3 mb-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground leading-snug line-clamp-2 text-balance">
              {market.question}
            </p>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              {market.category && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                  {market.category}
                </span>
              )}
              <span className="text-xs text-muted-foreground font-mono">{volume} vol/24h</span>
              {isLive && (
                <span className="flex items-center gap-1 text-xs text-profit font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-profit animate-pulse inline-block" />
                  LIVE
                </span>
              )}
            </div>
          </div>

          {signal && <SignalBadge signal={signal} />}
        </div>

        {/* Price bars */}
        <div className="space-y-1.5 mb-3">
          <PriceBar label="YES" price={yesPrice} color="profit" />
          <PriceBar label="NO" price={noPrice} color="loss" />
        </div>

        {/* AI Confidence meter (if signal) */}
        {signal && (
          <div className="mb-4 p-3 bg-gradient-to-r from-primary/5 to-secondary rounded-lg border border-primary/20">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-primary">AI Analysis</span>
              <span className="text-xs font-mono">{signal.analyses.length} Models</span>
            </div>
            {/* Confidence meter */}
            <div className="mb-2">
              <div className="flex items-center justify-between text-xs mb-1">
                <span>Confidence</span>
                <span className={cn('font-bold',
                  signal.confidence >= 80 ? 'text-profit' :
                  signal.confidence >= 65 ? 'text-warning' : 'text-muted-foreground'
                )}>{signal.confidence}%</span>
              </div>
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-primary to-blue-500 rounded-full transition-all"
                     style={{ width: `${signal.confidence}%` }} />
              </div>
            </div>
            {/* Model votes */}
            <div className="space-y-1.5">
              {signal.analyses.map((analysis, i) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="font-mono opacity-80">{analysis.model.slice(0, 8)}</span>
                  <div className="flex items-center gap-1">
                    <div className={cn(
                      'w-1.5 h-1.5 rounded-full',
                      analysis.signal === 'BUY' ? 'bg-profit' :
                      analysis.signal === 'SELL' ? 'bg-loss' : 'bg-muted'
                    )} />
                    <span>{analysis.confidence}%</span>
                  </div>
                </div>
              ))}
            </div>
            {/* Quick rationale */}
            <div className="mt-2 pt-2 border-t border-muted/30">
              <p className="text-xs leading-tight opacity-90">{signal.analyses[0]?.rationale || 'Analyzing...'}</p>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2">
          {!signal && onAnalyze && (
            <button
              onClick={() => onAnalyze(market)}
              disabled={analyzing}
              className="flex-1 flex items-center justify-center gap-2 h-8 rounded-md bg-primary/10 border border-primary/20 text-primary text-xs font-medium hover:bg-primary/20 transition-all disabled:opacity-50"
            >
              {analyzing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <BrainCircuit className="w-3.5 h-3.5" />
              )}
              {analyzing ? 'Analyzing...' : 'Analyze with AI'}
            </button>
          )}

          {signal && signal.confidence >= 75 && onExecute && (
            <button
              onClick={() => onExecute(signal)}
              className={cn(
                'flex-1 h-8 rounded-md text-xs font-semibold transition-all',
                signal.direction === 'BUY'
                  ? 'bg-profit text-foreground hover:bg-profit/90'
                  : 'bg-loss text-foreground hover:bg-loss/90'
              )}
            >
              Execute {signal.direction === 'BUY' ? 'BUY YES' : 'BUY NO'}
            </button>
          )}

          {signal && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="w-8 h-8 rounded-md border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-all"
            >
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function PriceBar({ label, price, color }: { label: string; price: number; color: 'profit' | 'loss' }) {
  const pct = Math.round(price * 100)
  return (
    <div className="flex items-center gap-2">
      <span className={cn(
        'text-xs font-mono w-6 font-semibold',
        color === 'profit' ? 'text-profit' : 'text-loss'
      )}>{label}</span>
      <div className="flex-1 h-4 bg-secondary rounded-sm overflow-hidden relative">
        <div
          className={cn(
            'h-full rounded-sm transition-all duration-300',
            color === 'profit' ? 'bg-profit/25' : 'bg-loss/25'
          )}
          style={{ width: `${pct}%` }}
        />
        <span className={cn(
          'absolute right-1.5 top-0 bottom-0 flex items-center text-xs font-mono font-semibold',
          color === 'profit' ? 'text-profit' : 'text-loss'
        )}>{pct}¢</span>
      </div>
    </div>
  )
}

function SignalBadge({ signal }: { signal: CombinedSignal }) {
  if (signal.direction === 'HOLD') return null
  return (
    <div className={cn(
      'shrink-0 flex items-center gap-1 px-2 py-1 rounded text-xs font-bold',
      signal.direction === 'BUY' ? 'bg-profit/15 text-profit' : 'bg-loss/15 text-loss'
    )}>
      {signal.direction === 'BUY' ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
      {signal.direction}
    </div>
  )
}

// ✅ HAPUS: function SignalIcon — tidak pernah dipakai

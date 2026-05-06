// app/api/crypto-engine/route.ts — NEW FILE (sebelumnya 404)
// BUG FIX #4: Endpoint ini direferensikan di ai-engine.ts tapi tidak exist
//
// Route ini menerima request analisis untuk crypto up/down markets
// dan meneruskannya ke analyzeMarket() dengan context yang lengkap.

import { NextRequest, NextResponse } from 'next/server'
import type { PolymarketMarket } from '@/lib/types'
import { analyzeMarket } from '@/lib/ai-engine'
import { fetchMarketBySlugWithRetry, buildSlug, getCurrentWindowTimestamp, type CryptoCoin, type WindowType } from '@/lib/crypto-markets'

export const runtime = 'nodejs'

// ─── POST /api/crypto-engine ──────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  const startTime = Date.now()

  try {
    const body = await request.json()

    // Support dua mode:
    // Mode 1: Kirim market langsung { market: PolymarketMarket }
    // Mode 2: Kirim coin + window, fetch market otomatis { coin, window }
    let market: PolymarketMarket | null = body.market ?? null

    if (!market && body.coin && body.window) {
      const coin   = body.coin   as CryptoCoin
      const window = body.window as WindowType
      const slug   = buildSlug(coin, window, getCurrentWindowTimestamp(window))

      console.log(`[crypto-engine] Fetching market for ${coin}-${window}: ${slug}`)
      market = await fetchMarketBySlugWithRetry(slug, coin, window)

      if (!market) {
        return NextResponse.json(
          { error: `Market not found for ${coin}-${window}`, slug },
          { status: 404 }
        )
      }
    }

    if (!market || !market.question) {
      return NextResponse.json(
        { error: 'Missing market or coin+window params' },
        { status: 400 }
      )
    }

    console.log(`[crypto-engine] Analyzing: "${market.question.slice(0, 60)}..."`)

    const signal = await analyzeMarket(market)

    const duration = Date.now() - startTime
    console.log(`[crypto-engine] Done in ${duration}ms. Signal: ${signal.direction} ${signal.confidence}%`)

    return NextResponse.json({ signal, duration_ms: duration })

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[crypto-engine] Error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// ─── GET /api/crypto-engine — Health check ────────────────────────────────────
export async function GET() {
  return NextResponse.json({
    status:    'ok',
    endpoint:  'crypto-engine',
    timestamp: Date.now(),
  })
}

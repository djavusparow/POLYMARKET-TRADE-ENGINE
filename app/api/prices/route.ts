import { NextResponse } from 'next/server'
import { fetchMidpointPrices, fetchLastTradePrices } from '@/lib/polymarket'

/**
 * POST /api/prices
 * Body: { tokens: string[] }
 *
 * Mengambil midpoint dan last trade prices untuk token IDs yang diberikan
 * dari Polymarket CLOB (public, no auth required).
 */
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const tokenIds = Array.isArray(body.tokens) ? body.tokens : []

    if (tokenIds.length === 0) {
      return NextResponse.json(
        { error: 'No token IDs provided' },
        { status: 400 }
      )
    }

    if (tokenIds.length > 500) {
      return NextResponse.json(
        { error: 'Maximum 500 token IDs allowed' },
        { status: 400 }
      )
    }

    // Ambil harga secara paralel
    const [midpoints, lastTrades] = await Promise.all([
      fetchMidpointPrices(tokenIds),
      fetchLastTradePrices(tokenIds),
    ])

    const prices: Record<string, { mid: number; last: number }> = {}
    for (const id of tokenIds) {
      prices[id] = {
        mid: midpoints[id] ?? 0,
        last: lastTrades[id] ?? midpoints[id] ?? 0,
      }
    }

    return NextResponse.json({ prices, timestamp: Date.now() })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.error('[/api/prices]', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

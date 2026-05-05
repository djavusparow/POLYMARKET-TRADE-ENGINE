// app/api/markets/route.ts
// FIX: type=trending sekarang gunakan fetchTrendingMarkets (via /events endpoint)
// yang merupakan market paling ramai hari ini — sama dengan tampilan trending
// di polymarket.com. Semua market sudah difilter isMarketTradeable() sehingga
// market dengan harga ekstrem, tidak ada volume, atau sudah closed tidak muncul.

import { NextResponse } from 'next/server'
import {
  serverFetchTopMarkets,
  serverFetchMarkets,
  fetchTrendingMarkets,
} from '@/lib/polymarket'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const type  = searchParams.get('type') ?? 'trending'
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 50)

  try {
    let markets

    if (type === 'trending' || type === 'top') {
      // Trending: ambil via /events sorted by volume24hr — sama dengan
      // halaman utama polymarket.com. Sudah difilter hanya yang tradeable.
      markets = await fetchTrendingMarkets(limit)
    } else {
      // Active: fallback ke /markets sorted by volume
      markets = await serverFetchMarkets(limit)
    }

    return NextResponse.json({
      markets,
      total: markets.length,
      type,
      // Info tambahan untuk debugging
      note: 'All markets are pre-filtered: active, accepting orders, price 3%-97%, volume > $1K',
    })

  } catch (e: unknown) {
    console.error('[api/markets] error:', e)
    return NextResponse.json(
      { error: 'Failed to fetch markets', markets: [], total: 0 },
      { status: 500 }
    )
  }
}

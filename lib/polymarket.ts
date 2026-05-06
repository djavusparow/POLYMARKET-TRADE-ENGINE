// lib/polymarket.ts
// ✅ FIX: parseOutcomePrice sekarang robust — tidak bisa return NaN
// Penyebab utama NaN di seluruh UI: outcomePrices double-encoded JSON string

import type { PolymarketMarket, MarketPrice } from './types'

const GAMMA_API = 'https://gamma-api.polymarket.com'
const CLOB_API  = 'https://clob.polymarket.com'
const DATA_API  = 'https://data-api.polymarket.com'

function safeUUID(): string {
  try { return crypto.randomUUID() } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
}

// ─── Tradeable Market Filter ──────────────────────────────────────────────────
export function isMarketTradeable(market: PolymarketMarket): boolean {
  if (!market) return false
  if (market.closed || market.archived) return false
  if (market.accepting_orders === false) return false
  if (!market.clobTokenIds || market.clobTokenIds.length < 2) return false

  try {
    const yesPrice = parseOutcomePrice(market.outcomePrices)
    if (yesPrice <= 0.03 || yesPrice >= 0.97) return false
  } catch {
    return false
  }

  const vol = market.volume24hr ?? market.volume ?? 0
  if (vol < 1000) return false

  return true
}

function enrichMarketCategory(market: PolymarketMarket, event?: any): PolymarketMarket {
  if (market.category?.toLowerCase() === 'crypto') return market

  const q    = (market.question ?? '').toLowerCase()
  const slug = ((market as any).slug ?? q).toLowerCase()

  if (
    slug.includes('updown') ||
    slug.includes('up-down') ||
    (slug.includes('up') && slug.includes('down'))
  ) {
    const coins = ['btc', 'bitcoin', 'eth', 'ethereum', 'sol', 'solana', 'doge', 'dogecoin', 'xrp']
    if (coins.some(c => q.includes(c))) {
      return { ...market, category: 'Crypto' }
    }
  }

  return market
}

export async function fetchTrendingMarkets(limit = 20): Promise<PolymarketMarket[]> {
  try {
    const fetchLimit = Math.min(limit * 3, 100)
    const params = new URLSearchParams({
      active: 'true', closed: 'false', limit: String(fetchLimit),
      order: 'volume24hr', ascending: 'false',
    })

    const res = await fetch(`${GAMMA_API}/events?${params}`, {
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
    })

    if (!res.ok) return fetchTopVolumeMarkets(limit)

    const events = await res.json()
    if (!Array.isArray(events) || events.length === 0) return fetchTopVolumeMarkets(limit)

    const markets: PolymarketMarket[] = []

    for (const event of events) {
      if (!event.markets || !Array.isArray(event.markets)) continue
      for (const m of event.markets) {
        const enriched: PolymarketMarket = {
          ...m,
          category:   enrichMarketCategory(m, event).category || event.category || event.tags?.[0]?.label || 'Trending',
          volume24hr: m.volume24hr ?? event.volume24hr,
          volume:     m.volume     ?? event.volume,
        }
        if (isMarketTradeable(enriched)) markets.push(enriched)
      }
      if (markets.length >= limit) break
    }

    if (markets.length < limit) {
      const extra = await fetchTopVolumeMarkets(limit - markets.length)
      const existingIds = new Set(markets.map(m => m.id))
      for (const m of extra) {
        if (!existingIds.has(m.id)) markets.push(m)
        if (markets.length >= limit) break
      }
    }

    return markets.sort((a, b) => (b.volume24hr ?? 0) - (a.volume24hr ?? 0)).slice(0, limit)
  } catch (e) {
    console.error('[polymarket] fetchTrendingMarkets error:', e)
    return fetchTopVolumeMarkets(limit)
  }
}

export async function fetchTopVolumeMarkets(limit = 20): Promise<PolymarketMarket[]> {
  try {
    const params = new URLSearchParams({
      active: 'true', closed: 'false', limit: String(Math.min(limit * 2, 100)),
      order: 'volume24hr', ascending: 'false',
    })
    const res = await fetch(`${GAMMA_API}/markets?${params}`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`Gamma API ${res.status}`)
    const data = await res.json()
    return (Array.isArray(data) ? data : []).filter(isMarketTradeable).slice(0, limit)
  } catch (e) {
    console.error('[polymarket] fetchTopVolumeMarkets error:', e)
    return []
  }
}

export async function fetchActiveMarkets(limit = 50): Promise<PolymarketMarket[]> {
  try {
    const params = new URLSearchParams({
      active: 'true', closed: 'false', limit: String(Math.min(limit * 2, 100)),
      order: 'volume24hr', ascending: 'false',
    })
    const res = await fetch(`${GAMMA_API}/markets?${params}`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`Gamma API error: ${res.status}`)
    const data = await res.json()
    return (Array.isArray(data) ? data : []).filter(isMarketTradeable).slice(0, limit)
  } catch (e) {
    console.error('[polymarket] fetchActiveMarkets error:', e)
    return []
  }
}

export async function fetchMarketByConditionId(conditionId: string): Promise<PolymarketMarket | null> {
  try {
    const res = await fetch(
      `${GAMMA_API}/markets?condition_id=${encodeURIComponent(conditionId)}`,
      { cache: 'no-store' }
    )
    if (!res.ok) return null
    const data = await res.json()
    return Array.isArray(data) && data.length > 0 ? data[0] : null
  } catch { return null }
}

export async function fetchTokenPrice(tokenId: string): Promise<MarketPrice | null> {
  try {
    const [bidRes, askRes] = await Promise.all([
      fetch(`${CLOB_API}/price?token_id=${encodeURIComponent(tokenId)}&side=BUY`),
      fetch(`${CLOB_API}/price?token_id=${encodeURIComponent(tokenId)}&side=SELL`),
    ])
    const bid = bidRes.ok ? await bidRes.json() : null
    const ask = askRes.ok ? await askRes.json() : null
    const bidPrice = parseFloat(bid?.price ?? '0')
    const askPrice = parseFloat(ask?.price ?? '0')
    const mid = bidPrice > 0 && askPrice > 0 ? (bidPrice + askPrice) / 2 : bidPrice || askPrice
    return { token_id: tokenId, price: mid, bid: bidPrice, ask: askPrice }
  } catch { return null }
}

export async function fetchMidpointPrices(tokenIds: string[]): Promise<Record<string, number>> {
  if (tokenIds.length === 0) return {}
  try {
    const res = await fetch(`${CLOB_API}/midpoints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokenIds.map((id) => ({ token_id: id }))),
    })
    if (!res.ok) throw new Error(`midpoints fetch failed: ${res.status}`)
    const data = await res.json()
    return data.midpoints ?? {}
  } catch { return {} }
}

export async function fetchLastTradePrices(tokenIds: string[]): Promise<Record<string, number>> {
  if (tokenIds.length === 0) return {}
  try {
    const res = await fetch(`${CLOB_API}/last-trades-prices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokenIds.map((id) => ({ token_id: id }))),
    })
    if (!res.ok) throw new Error(`last-trades-prices failed: ${res.status}`)
    const data = await res.json()
    return data.last_trades ?? {}
  } catch { return {} }
}

export async function fetchMarketBookSummary(tokenId: string) {
  try {
    const res = await fetch(`${CLOB_API}/book?token_id=${encodeURIComponent(tokenId)}`)
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

export async function fetchTickSize(tokenId: string): Promise<string> {
  try {
    const res = await fetch(`${CLOB_API}/tick-size?token_id=${encodeURIComponent(tokenId)}`)
    if (!res.ok) return '0.01'
    const data = await res.json()
    return data?.minimum_tick_size ?? data?.tick_size ?? '0.01'
  } catch { return '0.01' }
}

export async function fetchUserPositions(walletAddress: string) {
  try {
    const res = await fetch(
      `${DATA_API}/positions?user=${walletAddress}&sizeThreshold=.1`,
      { cache: 'no-store' }
    )
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch { return [] }
}

export async function fetchUserTrades(walletAddress: string, limit = 50) {
  try {
    const res = await fetch(
      `${DATA_API}/activity?user=${walletAddress}&limit=${limit}`,
      { cache: 'no-store' }
    )
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch { return [] }
}

export async function serverFetchMarkets(limit = 50): Promise<PolymarketMarket[]> {
  return fetchTrendingMarkets(limit)
}
export async function serverFetchTopMarkets(): Promise<PolymarketMarket[]> {
  return fetchTrendingMarkets(20)
}

export function getYesNoTokenIds(market: PolymarketMarket): { yes: string; no: string } | null {
  const tokens = market.clobTokenIds
  if (!tokens || tokens.length < 2) return null
  return { yes: tokens[0], no: tokens[1] }
}

// ✅ FIX KRITIS: parseOutcomePrice yang robust — tidak bisa return NaN
// outcomePrices dari Gamma API bisa berupa berbagai format:
// 1. '["0.872","0.128"]'       — array string (paling umum)
// 2. '"[\"0.872\",\"0.128\"]"' — double-encoded JSON string
// 3. '[0.872, 0.128]'          — array number
// 4. '{"yes":0.872,"no":0.128}'— object
// 5. '0.872'                   — single float string
export function parseOutcomePrice(outcomePrices: string | null | undefined): number {
  if (!outcomePrices) return 0

  try {
    let raw: any = outcomePrices

    // Handle double-encoded string: '"[...]"' → '[...]'
    if (typeof raw === 'string' && raw.startsWith('"') && raw.endsWith('"')) {
      raw = JSON.parse(raw)
    }

    // Parse JSON
    if (typeof raw === 'string') {
      raw = JSON.parse(raw)
    }

    // Array format: [YES_price, NO_price]
    if (Array.isArray(raw) && raw.length >= 1) {
      const n = parseFloat(String(raw[0]))
      return isNaN(n) ? 0 : Math.max(0, Math.min(1, n))
    }

    // Object format
    if (raw && typeof raw === 'object') {
      const n = parseFloat(raw.yes ?? raw.YES ?? raw.yesPrice ?? 0)
      return isNaN(n) ? 0 : Math.max(0, Math.min(1, n))
    }

    // Scalar
    const n = parseFloat(String(raw))
    return isNaN(n) ? 0 : Math.max(0, Math.min(1, n))
  } catch {
    const n = parseFloat(String(outcomePrices))
    return isNaN(n) ? 0 : Math.max(0, Math.min(1, n))
  }
}

export function formatVolume(vol: number | undefined | null): string {
  if (!vol || isNaN(vol)) return '$0'
  if (vol >= 1_000_000) return `$${(vol / 1_000_000).toFixed(1)}M`
  if (vol >= 1_000)     return `$${(vol / 1_000).toFixed(1)}K`
  return `$${vol.toFixed(0)}`
}

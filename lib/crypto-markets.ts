// lib/crypto-markets.ts
// Updated: Concurrency limit untuk batch fetching, fallback UUID

import type { PolymarketMarket } from './types'

const GAMMA_API = 'https://gamma-api.polymarket.com'

export const CRYPTO_COINS = ['btc', 'eth', 'sol', 'doge', 'xrp'] as const
export type CryptoCoin = typeof CRYPTO_COINS[number]

export const COIN_LABELS: Record<CryptoCoin, string> = {
  btc:  'Bitcoin (BTC)',
  eth:  'Ethereum (ETH)',
  sol:  'Solana (SOL)',
  doge: 'Dogecoin (DOGE)',
  xrp:  'XRP',
}

export const COIN_SYMBOLS: Record<CryptoCoin, string> = {
  btc:  'BTC',
  eth:  'ETH',
  sol:  'SOL',
  doge: 'DOGE',
  xrp:  'XRP',
}

export type WindowType = '5m' | '15m'

export const WINDOW_SECONDS: Record<WindowType, number> = {
  '5m':  300,
  '15m': 900,
}

// ─── Slug Calculator ──────────────────────────────────────────────────────────
export function getCurrentWindowTimestamp(window: WindowType): number {
  const now      = Math.floor(Date.now() / 1000)
  const interval = WINDOW_SECONDS[window]
  return now - (now % interval)
}

export function getNextWindowTimestamp(window: WindowType): number {
  return getCurrentWindowTimestamp(window) + WINDOW_SECONDS[window]
}

export function getSecondsToNextWindow(window: WindowType): number {
  return getNextWindowTimestamp(window) - Math.floor(Date.now() / 1000)
}

export function buildSlug(coin: CryptoCoin, window: WindowType, timestamp?: number): string {
  const ts = timestamp ?? getCurrentWindowTimestamp(window)
  return `${coin}-updown-${window}-${ts}`
}

// ─── Fetch single market by slug ──────────────────────────────────────────────
export async function fetchMarketBySlug(slug: string): Promise<PolymarketMarket | null> {
  try {
    // Try event endpoint first
    const eventRes = await fetch(
      `${GAMMA_API}/events?slug=${encodeURIComponent(slug)}&limit=1`,
      { cache: 'no-store', signal: AbortSignal.timeout(8_000) }
    )

    if (eventRes.ok) {
      const events = await eventRes.json()
      const event  = Array.isArray(events) ? events[0] : events?.events?.[0]
      if (event?.markets?.length > 0) {
        const market = event.markets[0]
        // FIX KRITIS: end_date_iso sering ada di level EVENT, bukan di market child
        // Polymarket UP/DOWN markets: end_date_iso ada di event.end_date_iso
        // atau di event.endDate, atau dihitung dari event.startDate + window
        const endDateIso =
          market.end_date_iso   ??  // dari market langsung jika ada
          event.end_date_iso    ??  // dari event parent (paling umum)
          event.endDate         ??  // alias alternatif
          event.end_date        ??  // alias lain
          null
        return {
          ...market,
          category:     'Crypto',
          description:  event.description ?? market.description,
          end_date_iso: endDateIso,        // selalu override agar tidak null
        } as PolymarketMarket
      }
    }

    // Fallback: markets endpoint
    const marketRes = await fetch(
      `${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}&limit=1`,
      { cache: 'no-store', signal: AbortSignal.timeout(8_000) }
    )

    if (marketRes.ok) {
      const data    = await marketRes.json()
      const markets = Array.isArray(data) ? data : data?.markets ?? []
      return markets[0] ?? null
    }

    return null
  } catch (e) {
    console.error(`[crypto-markets] fetchMarketBySlug error for ${slug}:`, e)
    return null
  }
}

// ─── CryptoMarketInfo ─────────────────────────────────────────────────────────
export interface CryptoMarketInfo {
  coin:           CryptoCoin
  window:         WindowType
  slug:           string
  timestamp:      number
  market:         PolymarketMarket | null
  yesPrice:       number
  noPrice:        number
  volume24hr:     number
  active:         boolean
  secondsLeft:    number
  /** Unix ms dari end_date_iso Polymarket — sumber kebenaran countdown */
  marketExpiryMs: number | null
}

// ─── Helper: chunk array untuk concurrency ────────────────────────────────────
async function chunkedPromiseAll<T, R>(
  items: T[],
  mapper: (item: T) => Promise<R>,
  concurrency = 3
): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency)
    const chunkResults = await Promise.all(chunk.map(mapper))
    results.push(...chunkResults)
  }
  return results
}

// ─── Fetch all active crypto up/down markets ──────────────────────────────────
export async function fetchAllCryptoUpDownMarkets(): Promise<CryptoMarketInfo[]> {
  const fetches: Array<{ coin: CryptoCoin; window: WindowType; slug: string; timestamp: number; secondsLeft: number }> = []

  for (const coin of CRYPTO_COINS) {
    for (const window of ['5m', '15m'] as WindowType[]) {
      const timestamp   = getCurrentWindowTimestamp(window)
      const slug        = buildSlug(coin, window, timestamp)
      const secondsLeft = getSecondsToNextWindow(window)
      fetches.push({ coin, window, slug, timestamp, secondsLeft })
    }
  }

  // ── CONCURRENCY: max 3 request paralel → cegah rate limit ────────────
  const marketResults = await chunkedPromiseAll(
    fetches,
    (f) => fetchMarketBySlug(f.slug),
    3
  )

  const results: CryptoMarketInfo[] = []

  for (let i = 0; i < fetches.length; i++) {
    const f      = fetches[i]
    const market = marketResults[i]

    let yesPrice   = 0.5
    let noPrice    = 0.5
    let volume24hr = 0
    let active     = false

    let marketExpiryMs: number | null = null

    if (market) {
      try {
        const prices = JSON.parse(market.outcomePrices ?? '[0.5, 0.5]')
        yesPrice     = parseFloat(Array.isArray(prices) ? prices[0] : prices.yes ?? 0.5)
        noPrice      = parseFloat(Array.isArray(prices) ? prices[1] : prices.no  ?? 0.5)
      } catch { /* use defaults */ }

      volume24hr = market.volume24hr ?? market.volume ?? 0
      active     = !market.closed && !market.archived && market.accepting_orders !== false

      // Parse end_date_iso → marketExpiryMs (sumber kebenaran countdown)
      if (market.end_date_iso) {
        const parsed = Date.parse(market.end_date_iso)
        if (!isNaN(parsed) && parsed > Date.now()) {
          marketExpiryMs = parsed
        }
      }
    }

    const secondsLeft = marketExpiryMs !== null
      ? Math.max(0, Math.round((marketExpiryMs - Date.now()) / 1000))
      : f.secondsLeft

    results.push({
      coin:           f.coin,
      window:         f.window,
      slug:           f.slug,
      timestamp:      f.timestamp,
      market,
      yesPrice,
      noPrice,
      volume24hr,
      active,
      secondsLeft,
      marketExpiryMs,
    })
  }

  return results
}

// ─── Get Binance real-time price ──────────────────────────────────────────────
export interface CoinPriceData {
  symbol:    string
  price:     number
  change1h:  number | null
  change24h: number | null
  high24h:   number | null
  low24h:    number | null
  volume24h: number | null
}

const BINANCE_SYMBOLS: Record<CryptoCoin, string> = {
  btc:  'BTCUSDT',
  eth:  'ETHUSDT',
  sol:  'SOLUSDT',
  doge: 'DOGEUSDT',
  xrp:  'XRPUSDT',
}

export async function fetchCoinPrice(coin: CryptoCoin): Promise<CoinPriceData | null> {
  try {
    const symbol = BINANCE_SYMBOLS[coin]
    const res    = await fetch(
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
      { cache: 'no-store', signal: AbortSignal.timeout(5_000) }
    )
    if (!res.ok) return null
    const data = await res.json()
    return {
      symbol:    coin.toUpperCase(),
      price:     parseFloat(data.lastPrice),
      change1h:  null, // Binance 24hr endpoint tidak punya 1h
      change24h: parseFloat(data.priceChangePercent),
      high24h:   parseFloat(data.highPrice),
      low24h:    parseFloat(data.lowPrice),
      volume24h: parseFloat(data.quoteVolume),
    }
  } catch { return null }
}

export async function fetchAllCoinPrices(): Promise<Record<CryptoCoin, CoinPriceData | null>> {
  const results = await Promise.all(
    CRYPTO_COINS.map(coin => fetchCoinPrice(coin))
  )
  const out: Partial<Record<CryptoCoin, CoinPriceData | null>> = {}
  CRYPTO_COINS.forEach((coin, i) => { out[coin] = results[i] })
  return out as Record<CryptoCoin, CoinPriceData | null>
}

// lib/crypto-markets.ts
// ✅ PATCH #9: Epoch edge case + slug fallback + buildSlugWithFallback
// secondsLeft SELALU dihitung dari marketExpiryMs (end_date_iso), bukan jam server
// Fallback dengan retry offset jika slug tidak match

import type { PolymarketMarket } from './types'

const GAMMA_API = 'https://gamma-api.polymarket.com'

export const CRYPTO_COINS = ['btc', 'eth', 'sol', 'doge', 'xrp'] as const
export type CryptoCoin = typeof CRYPTO_COINS[number]

export const COIN_LABELS: Record<CryptoCoin, string> = {
  btc:  'Bitcoin (BTC)', eth: 'Ethereum (ETH)', sol: 'Solana (SOL)',
  doge: 'Dogecoin (DOGE)', xrp: 'XRP',
}

export const COIN_SYMBOLS: Record<CryptoCoin, string> = {
  btc: 'BTC', eth: 'ETH', sol: 'SOL', doge: 'DOGE', xrp: 'XRP',
}

export type WindowType = '5m' | '15m'

export const WINDOW_SECONDS: Record<WindowType, number> = {
  '5m':  300,
  '15m': 900,
}

export function getCurrentWindowTimestamp(window: WindowType): number {
  const now = Math.floor(Date.now() / 1000)
  const interval = WINDOW_SECONDS[window]
  return now - (now % interval)
}

export function getNextWindowTimestamp(window: WindowType): number {
  return getCurrentWindowTimestamp(window) + WINDOW_SECONDS[window]
}

// ✅ PATCH #9: getSecondsToNextWindow HANYA fallback, BUKAN primary time source
export function getSecondsToNextWindow(window: WindowType): number {
  const nextTs = getNextWindowTimestamp(window)
  return Math.max(0, nextTs - Math.floor(Date.now() / 1000))
}

export function buildSlug(coin: CryptoCoin, window: WindowType, timestamp?: number): string {
  const ts = timestamp ?? getCurrentWindowTimestamp(window)
  return `${coin}-updown-${window}-${ts}`
}

// ✅ PATCH #9: Generate slug candidates dengan berbagai offset epoch
// Polymarket mungkin pakai window boundary dengan offset berbeda dari UTC epoch
export function buildSlugWithFallback(coin: CryptoCoin, window: WindowType): { slug: string; offsetSeconds: number }[] {
  const now      = Math.floor(Date.now() / 1000)
  const interval = WINDOW_SECONDS[window]
  // Offset 0 = epoch-aligned, -interval = 1 window ke belakang, +interval = 1 window ke depan
  const offsets = [0, -interval, +interval]
  return offsets.map(offset => ({
    offsetSeconds: offset,
    slug: `${coin}-updown-${window}-${now - (now % interval) + offset}`,
  }))
}

export async function fetchMarketBySlug(slug: string): Promise<PolymarketMarket | null> {
  try {
    const eventRes = await fetch(
      `${GAMMA_API}/events?slug=${encodeURIComponent(slug)}&limit=1`,
      { cache: 'no-store', signal: AbortSignal.timeout(8_000) }
    )
    if (eventRes.ok) {
      const events = await eventRes.json()
      const event  = Array.isArray(events) ? events[0] : events?.events?.[0]
      if (event?.markets?.length > 0) {
        const market = event.markets[0]
        // ✅ PATCH: Prioritas end_date_iso: event level > market level
        const endDateIso =
          event.end_date_iso   ??  // ← Prioritas #1: dari event parent
          event.endDate        ??  // ← Alias
          event.end_date       ??  // ← Alias
          market.end_date_iso  ??  // ← Fallback: dari market child
          null
        return {
          ...market,
          category:     'Crypto',
          description:  event.description ?? market.description,
          end_date_iso: endDateIso,
          // ✅ Simpan slug untuk debugging
          market_slug:  market.slug ?? (event as any).slug ?? slug,
        } as PolymarketMarket
      }
    }
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

// ✅ PATCH #9: Fetch dengan retry slug menggunakan offset fallback
export async function fetchMarketBySlugWithRetry(slug: string, coin: CryptoCoin, window: WindowType): Promise<PolymarketMarket | null> {
  // Coba slug utama dulu
  let market = await fetchMarketBySlug(slug)
  if (market) {
    console.log(`[crypto-markets] ✅ Found market with primary slug: ${slug}`)
    return market
  }

  // Retry dengan offset berbeda jika slug tidak match
  const fallbackSlugs = buildSlugWithFallback(coin, window)
  for (const { slug: fallbackSlug, offsetSeconds } of fallbackSlugs) {
    if (fallbackSlug === slug) continue  // skip yang sudah dicoba
    console.log(`[crypto-markets] ⏳ Retry offset ${offsetSeconds}s: ${fallbackSlug}`)
    market = await fetchMarketBySlug(fallbackSlug)
    if (market) {
      console.log(`[crypto-markets] ✅ Found market with offset ${offsetSeconds}s: ${fallbackSlug}`)
      return market
    }
  }

  console.warn(`[crypto-markets] ❌ No market found for ${coin}-${window} after ${fallbackSlugs.length} attempts`)
  return null
}

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
  // ✅ PATCH #9: secondsLeft adalah FALLBACK — marketExpiryMs adalah primary
  secondsLeft:    number
  /** Unix ms dari end_date_iso Polymarket — sumber kebenaran untuk SEMUA countdown */
  marketExpiryMs: number | null
}

async function chunkedPromiseAll<T, R>(items: T[], mapper: (item: T) => Promise<R>, concurrency = 3): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency)
    const chunkResults = await Promise.all(chunk.map(mapper))
    results.push(...chunkResults)
  }
  return results
}

// ✅ PATCH #9: fetchAllCryptoUpDownMarkets dengan retry dan marketExpiryMs
export async function fetchAllCryptoUpDownMarkets(): Promise<CryptoMarketInfo[]> {
  const fetches: Array<{ coin: CryptoCoin; window: WindowType; slug: string; timestamp: number }> = []

  for (const coin of CRYPTO_COINS) {
    for (const window of ['5m', '15m'] as WindowType[]) {
      const timestamp = getCurrentWindowTimestamp(window)
      const slug      = buildSlug(coin, window, timestamp)
      fetches.push({ coin, window, slug, timestamp })
    }
  }

  // Fetch dengan max 3 parallel
  const marketResults = await chunkedPromiseAll(fetches, (f) => fetchMarketBySlugWithRetry(f.slug, f.coin, f.window), 3)

  const results: CryptoMarketInfo[] = []

  for (let i = 0; i < fetches.length; i++) {
    const f      = fetches[i]
    const market = marketResults[i]

    let yesPrice   = 0.5
    let noPrice    = 0.5
    let volume24hr = 0
    let active     = false

    // ✅ PATCH #9: marketExpiryMs SELALU dari end_date_iso Polymarket
    let marketExpiryMs: number | null = null

    if (market) {
      try {
        const prices = JSON.parse(market.outcomePrices ?? '[0.5, 0.5]')
        yesPrice = parseFloat(Array.isArray(prices) ? prices[0] : prices.yes ?? 0.5)
        noPrice  = parseFloat(Array.isArray(prices) ? prices[1] : prices.no  ?? 0.5)
      } catch {}

      volume24hr = market.volume24hr ?? market.volume ?? 0
      active     = !market.closed && !market.archived && market.accepting_orders !== false

      // ✅ Parse end_date_iso → Unix ms
      if (market.end_date_iso) {
        const parsed = Date.parse(market.end_date_iso)
        if (!isNaN(parsed)) {
          if (parsed > Date.now()) {
            marketExpiryMs = parsed
            console.log(`[crypto-markets] ✅ marketExpiryMs ${f.slug}: ${new Date(parsed).toISOString()} (${parsed}ms)`)
          } else {
            console.warn(`[crypto-markets] ⚠️ end_date_iso sudah lewat: ${new Date(parsed).toISOString()} for ${f.slug}`)
          }
        } else {
          console.warn(`[crypto-markets] ⚠️ Invalid end_date_iso: "${market.end_date_iso}" for ${f.slug}`)
        }
      } else {
        console.warn(`[crypto-markets] ⚠️ end_date_iso null untuk ${f.slug}`)
      }
    } else {
      console.warn(`[crypto-markets] ❌ Market null untuk slug: ${f.slug}`)
    }

    // ✅ PATCH #9: secondsLeft DIHITUNG dari marketExpiryMs — BUKAN dari jam server
    // Ini adalah FALLBACK jika marketExpiryMs null (seharusnya tidak terjadi jika Polymarket API respond)
    let secondsLeft: number
    if (marketExpiryMs !== null) {
      secondsLeft = Math.max(0, Math.round((marketExpiryMs - Date.now()) / 1000))
      console.log(`[crypto-markets] ✅ secondsLeft from end_date_iso: ${secondsLeft}s for ${f.slug}`)
    } else {
      secondsLeft = WINDOW_SECONDS[f.window]
      console.warn(`[crypto-markets] ⚠️ secondsLeft FALLBACK (${secondsLeft}s) for ${f.slug} — marketExpiryMs was null`)
    }

    results.push({
      coin: f.coin, window: f.window, slug: f.slug, timestamp: f.timestamp,
      market, yesPrice, noPrice, volume24hr, active,
      secondsLeft,   // ← FALLBACK, bukan primary
      marketExpiryMs,  // ← PRIMARY — harus dipakai di semua tempat
    })
  }

  return results
}

export interface CoinPriceData {
  symbol: string; price: number; change1h: number | null; change24h: number | null
  high24h: number | null; low24h: number | null; volume24h: number | null
}

const BINANCE_SYMBOLS: Record<CryptoCoin, string> = {
  btc: 'BTCUSDT', eth: 'ETHUSDT', sol: 'SOLUSDT', doge: 'DOGEUSDT', xrp: 'XRPUSDT',
}

export async function fetchCoinPrice(coin: CryptoCoin): Promise<CoinPriceData | null> {
  try {
    const symbol = BINANCE_SYMBOLS[coin]
    const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`, { cache: 'no-store', signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return null
    const data = await res.json()
    return {
      symbol: coin.toUpperCase(), price: parseFloat(data.lastPrice),
      change1h: null, change24h: parseFloat(data.priceChangePercent),
      high24h: parseFloat(data.highPrice), low24h: parseFloat(data.lowPrice),
      volume24h: parseFloat(data.quoteVolume),
    }
  } catch { return null }
}

export async function fetchAllCoinPrices(): Promise<Record<CryptoCoin, CoinPriceData | null>> {
  const results = await Promise.all(CRYPTO_COINS.map(coin => fetchCoinPrice(coin)))
  const out: Partial<Record<CryptoCoin, CoinPriceData | null>> = {}
  CRYPTO_COINS.forEach((coin, i) => { out[coin] = results[i] })
  return out as Record<CryptoCoin, CoinPriceData | null>
}

// lib/crypto-markets.ts — PATCHED
// BUG FIX #2: Countdown timer tidak reset setelah 00:00
//
// Root cause: Ketika end_date_iso sudah lewat, marketExpiryMs di-set ke NULL.
// UI tidak punya target waktu → countdown berhenti di 00:00 tanpa refresh.
//
// Fix: Ketika end_date_iso sudah lewat, langsung set marketExpiryMs ke NEXT window boundary
// sehingga UI tahu kapan harus fetch ulang dan countdown berjalan kembali.

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

export function getSecondsToNextWindow(window: WindowType): number {
  const nextTs = getNextWindowTimestamp(window)
  return Math.max(0, nextTs - Math.floor(Date.now() / 1000))
}

export function buildSlug(coin: CryptoCoin, window: WindowType, timestamp?: number): string {
  const ts = timestamp ?? getCurrentWindowTimestamp(window)
  return `${coin}-updown-${window}-${ts}`
}

export function buildSlugWithFallback(coin: CryptoCoin, window: WindowType): { slug: string; offsetSeconds: number }[] {
  const now      = Math.floor(Date.now() / 1000)
  const interval = WINDOW_SECONDS[window]
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
        const endDateIso =
          event.end_date_iso ?? event.endDate ?? event.end_date ??
          market.end_date_iso ?? null
        return {
          ...market,
          category:     'Crypto',
          description:  event.description ?? market.description,
          end_date_iso: endDateIso,
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

export async function fetchMarketBySlugWithRetry(slug: string, coin: CryptoCoin, window: WindowType): Promise<PolymarketMarket | null> {
  let market = await fetchMarketBySlug(slug)
  if (market) {
    console.log(`[crypto-markets] ✅ Found market with primary slug: ${slug}`)
    return market
  }
  const fallbackSlugs = buildSlugWithFallback(coin, window)
  for (const { slug: fallbackSlug, offsetSeconds } of fallbackSlugs) {
    if (fallbackSlug === slug) continue
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
  secondsLeft:    number
  /** Unix ms dari end_date_iso Polymarket — sumber kebenaran untuk countdown */
  marketExpiryMs: number | null
  /** ✅ NEW: Flag bahwa ini adalah estimated expiry (market sudah expire, menunggu slug baru) */
  isEstimatedExpiry?: boolean
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

export async function fetchAllCryptoUpDownMarkets(): Promise<CryptoMarketInfo[]> {
  const fetches: Array<{ coin: CryptoCoin; window: WindowType; slug: string; timestamp: number }> = []

  for (const coin of CRYPTO_COINS) {
    for (const window of ['5m', '15m'] as WindowType[]) {
      const timestamp = getCurrentWindowTimestamp(window)
      const slug      = buildSlug(coin, window, timestamp)
      fetches.push({ coin, window, slug, timestamp })
    }
  }

  const marketResults = await chunkedPromiseAll(fetches, (f) => fetchMarketBySlugWithRetry(f.slug, f.coin, f.window), 3)

  const results: CryptoMarketInfo[] = []

  for (let i = 0; i < fetches.length; i++) {
    const f      = fetches[i]
    const market = marketResults[i]

    let yesPrice   = 0.5
    let noPrice    = 0.5
    let volume24hr = 0
    let active     = false
    let marketExpiryMs: number | null = null
    let isEstimatedExpiry             = false

    if (market) {
      try {
        const prices = JSON.parse(market.outcomePrices ?? '[0.5, 0.5]')
        yesPrice = parseFloat(Array.isArray(prices) ? prices[0] : prices.yes ?? 0.5)
        noPrice  = parseFloat(Array.isArray(prices) ? prices[1] : prices.no  ?? 0.5)
      } catch {}

      volume24hr = market.volume24hr ?? market.volume ?? 0
      active     = !market.closed && !market.archived && market.accepting_orders !== false

      if (market.end_date_iso) {
        const parsed = Date.parse(market.end_date_iso)
        if (!isNaN(parsed)) {
          if (parsed > Date.now()) {
            // ✅ Market masih aktif — gunakan expiry dari Polymarket
            marketExpiryMs = parsed
            console.log(`[crypto-markets] ✅ marketExpiryMs ${f.slug}: ${new Date(parsed).toISOString()}`)
          } else {
            // ✅ FIX #2: Market sudah expire — set ke NEXT window boundary
            // Ini yang menyebabkan countdown 00:00 tidak reset!
            // Sebelumnya: marketExpiryMs = null → UI tidak tahu kapan harus refresh
            // Sesudah fix: marketExpiryMs = next window boundary → countdown berjalan ke depan
            const nextWindowMs = getNextWindowTimestamp(f.window) * 1000
            marketExpiryMs    = nextWindowMs
            isEstimatedExpiry = true
            console.log(
              `[crypto-markets] ⚠️ end_date_iso sudah lewat untuk ${f.slug}. ` +
              `Menggunakan next window boundary: ${new Date(nextWindowMs).toISOString()} ` +
              `(${Math.round((nextWindowMs - Date.now()) / 1000)}s dari sekarang)`
            )
          }
        } else {
          // Invalid date string — gunakan next window boundary sebagai fallback
          const nextWindowMs = getNextWindowTimestamp(f.window) * 1000
          marketExpiryMs    = nextWindowMs
          isEstimatedExpiry = true
          console.warn(`[crypto-markets] ⚠️ Invalid end_date_iso: "${market.end_date_iso}" → fallback ke next window`)
        }
      } else {
        // Tidak ada end_date_iso — gunakan next window boundary
        const nextWindowMs = getNextWindowTimestamp(f.window) * 1000
        marketExpiryMs    = nextWindowMs
        isEstimatedExpiry = true
        console.warn(`[crypto-markets] ⚠️ end_date_iso null untuk ${f.slug} → fallback ke next window`)
      }
    } else {
      // Market tidak ditemukan — gunakan next window boundary
      const nextWindowMs = getNextWindowTimestamp(f.window) * 1000
      marketExpiryMs    = nextWindowMs
      isEstimatedExpiry = true
      console.warn(`[crypto-markets] ❌ Market null untuk ${f.slug} → fallback ke next window`)
    }

    // secondsLeft SELALU dihitung dari marketExpiryMs (sekarang tidak pernah null)
    const secondsLeft = Math.max(0, Math.round((marketExpiryMs! - Date.now()) / 1000))
    console.log(`[crypto-markets] secondsLeft: ${secondsLeft}s for ${f.slug} (isEstimated: ${isEstimatedExpiry})`)

    results.push({
      coin: f.coin, window: f.window, slug: f.slug, timestamp: f.timestamp,
      market, yesPrice, noPrice, volume24hr, active,
      secondsLeft,
      marketExpiryMs,
      isEstimatedExpiry,
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

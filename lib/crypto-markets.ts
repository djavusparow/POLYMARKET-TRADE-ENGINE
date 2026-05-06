// lib/crypto-markets.ts
// ✅ FIX UTAMA:
// 1. fetchMarketBySlug — gunakan endpoint /markets?slug= yang lebih reliable
// 2. parseOutcomePrices — parse outcomePrices dengan benar agar yesPrice tidak NaN
// 3. marketExpiryMs — selalu dari end_date_iso Polymarket (UTC), bukan jam server lokal
// 4. Slug discovery — pakai search keyword jika slug exact tidak match

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

// ✅ FIX: Generate slug candidates — lebih banyak offset untuk toleransi clock skew
export function buildSlugCandidates(coin: CryptoCoin, window: WindowType): string[] {
  const now      = Math.floor(Date.now() / 1000)
  const interval = WINDOW_SECONDS[window]
  const base     = now - (now % interval)
  // Coba 3 window: sekarang, sebelumnya, dan berikutnya
  return [
    `${coin}-updown-${window}-${base}`,
    `${coin}-updown-${window}-${base - interval}`,
    `${coin}-updown-${window}-${base + interval}`,
  ]
}

// ✅ FIX KRITIS: parseOutcomePrices yang robust — ini penyebab utama NaN
// outcomePrices bisa berupa: '"[\"0.5\",\"0.5\"]"', '["0.5","0.5"]', '[0.5,0.5]', '0.5'
export function parseOutcomePricesRaw(raw: string | null | undefined): { yes: number; no: number } {
  if (!raw) return { yes: 0.5, no: 0.5 }

  try {
    // Coba parse langsung
    let parsed = raw
    // Jika string-dalam-string (double encoded), unescape dulu
    if (typeof parsed === 'string' && parsed.startsWith('"')) {
      parsed = JSON.parse(parsed)
    }
    const arr = JSON.parse(parsed as string)
    if (Array.isArray(arr) && arr.length >= 2) {
      const yes = parseFloat(String(arr[0]))
      const no  = parseFloat(String(arr[1]))
      return {
        yes: isNaN(yes) ? 0.5 : Math.max(0.01, Math.min(0.99, yes)),
        no:  isNaN(no)  ? 0.5 : Math.max(0.01, Math.min(0.99, no)),
      }
    }
    // Object format: { yes: 0.5, no: 0.5 }
    if (arr && typeof arr === 'object') {
      const yes = parseFloat(arr.yes ?? arr.YES ?? 0.5)
      const no  = parseFloat(arr.no  ?? arr.NO  ?? 0.5)
      return {
        yes: isNaN(yes) ? 0.5 : yes,
        no:  isNaN(no)  ? 0.5 : no,
      }
    }
  } catch {
    // Mungkin hanya satu angka float
    const n = parseFloat(String(raw))
    if (!isNaN(n)) return { yes: n, no: 1 - n }
  }

  return { yes: 0.5, no: 0.5 }
}

// ✅ FIX: Fetch market dengan multiple strategies
export async function fetchMarketBySlug(slug: string): Promise<PolymarketMarket | null> {
  try {
    // Strategy 1: /events?slug=
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
          end_date_iso: endDateIso,
          market_slug:  market.slug ?? slug,
        } as PolymarketMarket
      }
    }

    // Strategy 2: /markets?slug=
    const marketRes = await fetch(
      `${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}&limit=1`,
      { cache: 'no-store', signal: AbortSignal.timeout(8_000) }
    )
    if (marketRes.ok) {
      const data    = await marketRes.json()
      const markets = Array.isArray(data) ? data : data?.markets ?? []
      if (markets[0]) {
        return { ...markets[0], category: 'Crypto', market_slug: slug }
      }
    }

    return null
  } catch (e) {
    console.error(`[crypto-markets] fetchMarketBySlug error for ${slug}:`, e)
    return null
  }
}

// ✅ FIX: Fetch dengan keyword search sebagai fallback terakhir
async function fetchMarketByKeyword(coin: CryptoCoin, window: WindowType): Promise<PolymarketMarket | null> {
  try {
    const keyword = `${coin.toUpperCase()} up or down in the next ${window}`
    const res = await fetch(
      `${GAMMA_API}/markets?search=${encodeURIComponent(keyword)}&limit=5&active=true`,
      { cache: 'no-store', signal: AbortSignal.timeout(8_000) }
    )
    if (!res.ok) return null
    const data    = await res.json()
    const markets = Array.isArray(data) ? data : data?.markets ?? []
    // Pilih market yang paling relevan (closed=false, accepting_orders=true)
    const active = markets.find((m: any) => !m.closed && !m.archived && m.accepting_orders !== false)
    return active ? { ...active, category: 'Crypto' } : null
  } catch {
    return null
  }
}

export async function fetchMarketBySlugWithRetry(
  primarySlug: string,
  coin: CryptoCoin,
  window: WindowType
): Promise<PolymarketMarket | null> {
  // Coba semua slug candidates
  const candidates = buildSlugCandidates(coin, window)
  // Pastikan primary slug ada di depan
  const slugsToTry = [primarySlug, ...candidates.filter(s => s !== primarySlug)]

  for (const slug of slugsToTry) {
    const market = await fetchMarketBySlug(slug)
    if (market) {
      console.log(`[crypto-markets] ✅ Found: ${slug}`)
      return market
    }
  }

  // Fallback: keyword search
  console.warn(`[crypto-markets] ⚠️ Slug not found, trying keyword search for ${coin}-${window}`)
  const keywordResult = await fetchMarketByKeyword(coin, window)
  if (keywordResult) {
    console.log(`[crypto-markets] ✅ Found via keyword search: ${coin}-${window}`)
    return keywordResult
  }

  console.error(`[crypto-markets] ❌ No market found for ${coin}-${window}`)
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
  /** Unix ms dari end_date_iso Polymarket — PRIMARY time source */
  marketExpiryMs: number | null
}

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

export async function fetchAllCryptoUpDownMarkets(): Promise<CryptoMarketInfo[]> {
  const fetches: Array<{ coin: CryptoCoin; window: WindowType; slug: string; timestamp: number }> = []

  for (const coin of CRYPTO_COINS) {
    for (const window of ['5m', '15m'] as WindowType[]) {
      const timestamp = getCurrentWindowTimestamp(window)
      const slug      = buildSlug(coin, window, timestamp)
      fetches.push({ coin, window, slug, timestamp })
    }
  }

  const marketResults = await chunkedPromiseAll(
    fetches,
    (f) => fetchMarketBySlugWithRetry(f.slug, f.coin, f.window),
    3
  )

  const results: CryptoMarketInfo[] = []

  for (let i = 0; i < fetches.length; i++) {
    const f      = fetches[i]
    const market = marketResults[i]

    // ✅ FIX UTAMA: Gunakan parseOutcomePricesRaw yang robust
    let yesPrice   = 0.5
    let noPrice    = 0.5
    let volume24hr = 0
    let active     = false
    let marketExpiryMs: number | null = null

    if (market) {
      // ✅ FIX: Parse harga dengan benar — tidak lagi NaN
      const prices = parseOutcomePricesRaw(market.outcomePrices)
      yesPrice = prices.yes
      noPrice  = prices.no

      volume24hr = market.volume24hr ?? (market as any).volume ?? 0
      active     = !market.closed && !market.archived && market.accepting_orders !== false

      // ✅ Parse end_date_iso → Unix ms (selalu UTC, tidak ada ambiguitas timezone)
      const rawDate = market.end_date_iso
      if (rawDate) {
        // Pastikan string ISO 8601 valid dengan UTC suffix
        const isoStr = rawDate.endsWith('Z') || rawDate.includes('+') ? rawDate : rawDate + 'Z'
        const parsed = Date.parse(isoStr)
        if (!isNaN(parsed)) {
          if (parsed > Date.now()) {
            marketExpiryMs = parsed
          } else {
            console.warn(`[crypto-markets] ⚠️ end_date_iso sudah lewat untuk ${f.slug}: ${rawDate}`)
          }
        } else {
          console.warn(`[crypto-markets] ⚠️ Invalid end_date_iso: "${rawDate}" untuk ${f.slug}`)
        }
      }
    } else {
      console.warn(`[crypto-markets] ❌ Market null untuk ${f.slug}`)
    }

    // ✅ secondsLeft dari marketExpiryMs (UTC real), bukan dari clock lokal server
    let secondsLeft: number
    if (marketExpiryMs !== null) {
      secondsLeft = Math.max(0, Math.round((marketExpiryMs - Date.now()) / 1000))
    } else {
      // Fallback: sisa waktu dari window boundary lokal
      secondsLeft = getSecondsToNextWindow(f.window)
      console.warn(`[crypto-markets] ⚠️ Fallback secondsLeft: ${secondsLeft}s untuk ${f.slug}`)
    }

    results.push({
      coin: f.coin, window: f.window, slug: f.slug, timestamp: f.timestamp,
      market, yesPrice, noPrice, volume24hr, active,
      secondsLeft,
      marketExpiryMs,
    })
  }

  return results
}

// ─── Binance Price Fetch ───────────────────────────────────────────────────────

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
  btc: 'BTCUSDT', eth: 'ETHUSDT', sol: 'SOLUSDT', doge: 'DOGEUSDT', xrp: 'XRPUSDT',
}

export async function fetchCoinPrice(coin: CryptoCoin): Promise<CoinPriceData | null> {
  try {
    const symbol = BINANCE_SYMBOLS[coin]
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
      { cache: 'no-store', signal: AbortSignal.timeout(5_000) }
    )
    if (!res.ok) return null
    const data = await res.json()
    const price     = parseFloat(data.lastPrice)
    const change24h = parseFloat(data.priceChangePercent)
    const high24h   = parseFloat(data.highPrice)
    const low24h    = parseFloat(data.lowPrice)
    const volume24h = parseFloat(data.quoteVolume)
    // Guard NaN
    return {
      symbol:    coin.toUpperCase(),
      price:     isNaN(price)     ? 0 : price,
      change1h:  null,
      change24h: isNaN(change24h) ? null : change24h,
      high24h:   isNaN(high24h)   ? null : high24h,
      low24h:    isNaN(low24h)    ? null : low24h,
      volume24h: isNaN(volume24h) ? null : volume24h,
    }
  } catch {
    return null
  }
}

export async function fetchAllCoinPrices(): Promise<Record<CryptoCoin, CoinPriceData | null>> {
  const results = await Promise.all(CRYPTO_COINS.map(coin => fetchCoinPrice(coin)))
  const out: Partial<Record<CryptoCoin, CoinPriceData | null>> = {}
  CRYPTO_COINS.forEach((coin, i) => { out[coin] = results[i] })
  return out as Record<CryptoCoin, CoinPriceData | null>
}

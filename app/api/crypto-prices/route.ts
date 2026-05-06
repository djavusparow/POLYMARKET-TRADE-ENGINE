// app/api/crypto-prices/route.ts
// ✅ FIX:
// 1. Import parseOutcomePricesRaw dari crypto-markets (bukan parseOutcomePrice dari polymarket)
// 2. Guard NaN di semua kalkulasi harga sebelum disimpan ke response
// 3. Cache TTL 25 detik
// 4. estimatedYesPrice: Gamma > Binance estimate > 0.5 (default fallback — bukan null)

import { NextRequest, NextResponse } from 'next/server'
import {
  fetchAllCryptoUpDownMarkets,
  fetchAllCoinPrices,
  CRYPTO_COINS,
  type CryptoCoin,
} from '@/lib/crypto-markets'

const CACHE_TTL_MS = 25_000

interface CacheEntry {
  data:      Record<string, any>
  expiresAt: number
}

let priceCache: CacheEntry | null = null

// ✅ FIX: Fungsi ini sekarang selalu return number (bukan null)
// sehingga tidak ada kemungkinan NaN menyebar ke UI
function safeNum(val: unknown, fallback = 0): number {
  const n = Number(val)
  return isNaN(n) || !isFinite(n) ? fallback : n
}

// ✅ Estimasi harga YES token dari posisi Binance dalam range 24h
function estimateYesPriceFromBinance(
  spotPrice: number | null,
  high24h: number | null,
  low24h: number | null
): number {
  if (spotPrice === null || high24h === null || low24h === null) return 0.5
  if (high24h <= low24h) return 0.5
  const rangePosition = (spotPrice - low24h) / (high24h - low24h)
  return Math.max(0.05, Math.min(0.95, rangePosition))
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const coinsParam = searchParams.get('coins')
  const requestedCoins: CryptoCoin[] = coinsParam
    ? (coinsParam.split(',').filter(c => CRYPTO_COINS.includes(c as CryptoCoin)) as CryptoCoin[])
    : [...CRYPTO_COINS]

  // Serve dari cache jika masih segar
  if (priceCache && Date.now() < priceCache.expiresAt) {
    const filteredPrices: Record<string, any> = {}
    for (const coin of requestedCoins) {
      if (priceCache.data[coin]) filteredPrices[coin] = priceCache.data[coin]
    }
    return NextResponse.json({ prices: filteredPrices, timestamp: Date.now(), cached: true })
  }

  try {
    const [binancePrices, polymarketMarkets] = await Promise.all([
      fetchAllCoinPrices(),
      fetchAllCryptoUpDownMarkets(),
    ])

    const allPrices: Record<string, any> = {}

    for (const coin of CRYPTO_COINS) {
      const binance   = binancePrices[coin]
      const market5m  = polymarketMarkets.find(m => m.coin === coin && m.window === '5m')
      const market15m = polymarketMarkets.find(m => m.coin === coin && m.window === '15m')

      // ✅ FIX: yesPrice/noPrice dari crypto-markets sudah di-parse dengan parseOutcomePricesRaw
      // Tidak ada NaN karena parseOutcomePricesRaw selalu return angka valid
      const polyYes5m  = market5m?.yesPrice  && market5m.yesPrice  > 0 && !isNaN(market5m.yesPrice)  ? market5m.yesPrice  : null
      const polyYes15m = market15m?.yesPrice && market15m.yesPrice > 0 && !isNaN(market15m.yesPrice) ? market15m.yesPrice : null

      const binanceEst = estimateYesPriceFromBinance(
        binance?.price ?? null,
        binance?.high24h ?? null,
        binance?.low24h ?? null
      )

      // ✅ FIX: Tidak pernah null — selalu ada fallback ke 0.5
      const yesPrice5m  = polyYes5m  ?? binanceEst
      const yesPrice15m = polyYes15m ?? binanceEst

      // ✅ FIX: noPrice = 1 - yesPrice, tapi jangan sampai NaN atau negatif
      const noPrice5m  = parseFloat((1 - yesPrice5m).toFixed(3))
      const noPrice15m = parseFloat((1 - yesPrice15m).toFixed(3))

      const estimatedYesPrice = polyYes5m ?? polyYes15m ?? binanceEst

      // ✅ FIX: marketExpiryMs & secondsLeft dari Polymarket (UTC)
      const marketExpiryMs5m  = market5m?.marketExpiryMs  ?? null
      const marketExpiryMs15m = market15m?.marketExpiryMs ?? null

      allPrices[coin] = {
        // Binance (spot price display)
        price:    safeNum(binance?.price,     0),
        change24h: safeNum(binance?.change24h, 0),
        high24h:   safeNum(binance?.high24h,   0),
        low24h:    safeNum(binance?.low24h,    0),

        // Polymarket token prices — selalu angka valid, tidak pernah NaN/null
        yesPrice5m,
        noPrice5m,
        yesPrice15m,
        noPrice15m,

        // estimatedYesPrice untuk SL/TP — selalu ada
        estimatedYesPrice,

        // ✅ marketExpiryMs untuk countdown yang akurat di client
        marketExpiryMs5m,
        marketExpiryMs15m,

        // Secondary countdown (fallback jika marketExpiryMs null)
        secondsLeft5m:  market5m?.secondsLeft  ?? 300,
        secondsLeft15m: market15m?.secondsLeft ?? 900,

        // Market active status
        active5m:  market5m?.active  ?? false,
        active15m: market15m?.active ?? false,
      }
    }

    priceCache = { data: allPrices, expiresAt: Date.now() + CACHE_TTL_MS }

    const filteredPrices: Record<string, any> = {}
    for (const coin of requestedCoins) {
      if (allPrices[coin]) filteredPrices[coin] = allPrices[coin]
    }

    return NextResponse.json({ prices: filteredPrices, timestamp: Date.now(), cached: false })

  } catch (e: unknown) {
    console.error('[/api/crypto-prices] Error:', e)

    if (priceCache) {
      const filteredPrices: Record<string, any> = {}
      for (const coin of requestedCoins) {
        if (priceCache.data[coin]) filteredPrices[coin] = priceCache.data[coin]
      }
      return NextResponse.json({ prices: filteredPrices, timestamp: Date.now(), cached: true, stale: true })
    }

    return NextResponse.json({ error: String(e), prices: {} }, { status: 500 })
  }
}

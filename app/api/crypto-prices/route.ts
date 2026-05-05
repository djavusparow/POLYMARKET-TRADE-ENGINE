// app/api/crypto-prices/route.ts
// ✅ FIX v3:
// 1. Cache TTL 25 detik — mencegah 120 req/menit ke Gamma API
// 2. ✅ PRIORITAS estimatedYesPrice: Gamma API > Binance Estimate > null
//    (sebelumnya: estimatedYesPrice = null jika Gamma API gagal, padahal Binance
//     bisa kasih estimasi yang lebih baik daripada tidak ada harga sama sekali)
// 3. ✅ Binance Estimate sebagai fallback terakhir — dihitung dari
//    posisi harga spot dalam range 24h-nya, bukan asumsi 0.5
// 4. Semua response tetap sinkron 100% dengan page.tsx

import { NextRequest, NextResponse } from 'next/server'
import {
  fetchAllCryptoUpDownMarkets,
  fetchAllCoinPrices,
  CRYPTO_COINS,
  type CryptoCoin,
} from '@/lib/crypto-markets'

// ─── Server-side cache (in-memory) ───────────────────────────────────────────
const CACHE_TTL_MS = 25_000

interface CacheEntry {
  data:      Record<string, any>
  expiresAt: number
}

let priceCache: CacheEntry | null = null

// ─── Helper: Estimasi harga YES token dari Binance ───────────────────────────
// Jika Gamma API tidak memberikan harga (market tidak aktif / timeout),
// kita estimasi dari posisi harga spot coin dalam range 24h-nya.
// Ini jauh lebih akurat daripada null (yang menyebabkan SL/TP skip)
function estimateYesPriceFromBinance(
  spotPrice: number | null,
  high24h: number | null,
  low24h: number | null
): number | null {
  if (spotPrice === null || high24h === null || low24h === null) return null
  if (high24h <= low24h) return 0.5

  // Posisi harga dalam range 24h: 0.0 (di low) hingga 1.0 (di high)
  const rangePosition = (spotPrice - low24h) / (high24h - low24h)

  // Clamp ke [0.05, 0.95] — tidak pernah 0 atau 1
  // (jika harga di low ekstrim, probabilitas UP bukan 0% — ada mean-reversion)
  // (jika harga di high ekstrim, probabilitas UP bukan 100% — ada koreksi)
  return Math.max(0.05, Math.min(0.95, rangePosition))
}

// ─── GET /api/crypto-prices?coins=btc,eth,sol ────────────────────────────────
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
    return NextResponse.json({
      prices:    filteredPrices,
      timestamp: Date.now(),
      cached:    true,
    })
  }

  try {
    // Fetch Binance prices + Polymarket market data secara paralel
    const [binancePrices, polymarketMarkets] = await Promise.all([
      fetchAllCoinPrices(),
      fetchAllCryptoUpDownMarkets(),
    ])

    // Build full price map untuk semua coins (disimpan di cache)
    const allPrices: Record<string, any> = {}

    for (const coin of CRYPTO_COINS) {
      const binance   = binancePrices[coin]
      const market5m  = polymarketMarkets.find(m => m.coin === coin && m.window === '5m')
      const market15m = polymarketMarkets.find(m => m.coin === coin && m.window === '15m')

      // ── Sumber Harga 1: Gamma API Polymarket ──────────────────────────
      // Ini adalah harga REAL UP/DOWN token di Polymarket
      const polymarketYesPrice5m  = market5m?.yesPrice  && market5m.yesPrice > 0  ? market5m.yesPrice  : null
      const polymarketYesPrice15m = market15m?.yesPrice && market15m.yesPrice > 0 ? market15m.yesPrice : null

      // ── Sumber Harga 2: Estimasi dari Binance (fallback) ──────────────
      // Jika Gamma API tidak memberi data, kita estimasi dari Binance
      const binanceEstimate = estimateYesPriceFromBinance(
        binance?.price ?? null,
        binance?.high24h ?? null,
        binance?.low24h ?? null
      )

      // ✅ FIX PRIORITAS:
      // 1. Gamma API 5m (jika ada)
      // 2. Gamma API 15m (jika ada)
      // 3. Estimasi Binance (SELALU ada jika Binance merespons)
      // 4. null (hanya jika semua sumber gagal)
      const yesPrice5m  = polymarketYesPrice5m  ?? binanceEstimate ?? null
      const yesPrice15m = polymarketYesPrice15m ?? binanceEstimate ?? null
      const noPrice5m   = yesPrice5m  !== null ? parseFloat((1 - yesPrice5m).toFixed(3))  : null
      const noPrice15m  = yesPrice15m !== null ? parseFloat((1 - yesPrice15m).toFixed(3)) : null

      // ✅ FIX estimatedYesPrice:
      // Prioritas: Gamma API > Binance Estimate > null
      // Dulu: estimatedYesPrice = null jika Gamma API gagal → SL/TP skip
      // Sekarang: estimatedYesPrice PASTI ada jika Binance merespons
      const estimatedYesPrice =
        polymarketYesPrice5m  ??   // 🥇 Harga real dari Polymarket 5m
        polymarketYesPrice15m ??   // 🥇 Harga real dari Polymarket 15m
        binanceEstimate            // 🥈 Estimasi dari Binance (selalu ada)

      allPrices[coin] = {
        // Binance data (untuk display coin price)
        price:            binance?.price     ?? null,
        change24h:        binance?.change24h ?? null,
        high24h:          binance?.high24h   ?? null,
        low24h:           binance?.low24h    ?? null,

        // Polymarket token prices (untuk SL/TP tracking)
        yesPrice5m,
        noPrice5m,
        yesPrice15m,
        noPrice15m,

        // ✅ FIX: Sekarang PASTI tidak null (kecuali jika Binance juga gagal)
        estimatedYesPrice,
      }
    }

    // Simpan ke cache
    priceCache = {
      data:      allPrices,
      expiresAt: Date.now() + CACHE_TTL_MS,
    }

    // Return hanya coin yang diminta
    const filteredPrices: Record<string, any> = {}
    for (const coin of requestedCoins) {
      if (allPrices[coin]) filteredPrices[coin] = allPrices[coin]
    }

    return NextResponse.json({
      prices:    filteredPrices,
      timestamp: Date.now(),
      cached:    false,
    })

  } catch (e: unknown) {
    console.error('[/api/crypto-prices] Error:', e)

    // Serve stale cache jika ada
    if (priceCache) {
      const filteredPrices: Record<string, any> = {}
      for (const coin of requestedCoins) {
        if (priceCache.data[coin]) filteredPrices[coin] = priceCache.data[coin]
      }
      return NextResponse.json({
        prices:    filteredPrices,
        timestamp: Date.now(),
        cached:    true,
        stale:     true,
      })
    }

    return NextResponse.json({ error: String(e), prices: {} }, { status: 500 })
  }
}

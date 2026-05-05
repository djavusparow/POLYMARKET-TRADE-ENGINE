// app/api/trade/crypto-execute/route.ts
// ✅ PATCH: Fix chain validation, token mapping, dan edge cases

import { NextRequest, NextResponse } from 'next/server'
import { ClobClient, Side, OrderType } from '@polymarket/clob-client-v2'
import { ethers } from 'ethers'
import { resolveCredentials } from '@/lib/clob-auth'
import { buildSlug, WINDOW_SECONDS } from '@/lib/crypto-markets'

const CLOB_HOST   = 'https://clob.polymarket.com'
const GAMMA_HOST  = 'https://gamma-api.polymarket.com'
const CHAIN_NAMES: Record<number, string> = {
  137:   'Polygon Mainnet',
  80001: 'Polygon Mumbai',
  80002: 'Polygon Amoy',
}

function safeUUID(): string {
  try { return crypto.randomUUID() } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 6)}`
  }
}

function log(level: 'info' | 'warn' | 'error', msg: string, data?: any): void {
  const prefix = `[crypto-execute]`
  if (data) {
    console[level](prefix, msg, typeof data === 'object' ? JSON.stringify(data, null, 2).slice(0, 400) : data)
  } else {
    console[level](prefix, msg)
  }
}

// ─── Validate Chain ────────────────────────────────────────────────────────────
function validateChain(chain: number): { valid: boolean; error?: string } {
  if (!CHAIN_NAMES[chain]) {
    return {
      valid: false,
      error: `Unsupported chain ID: ${chain}. Supported: ${Object.keys(CHAIN_NAMES).join(', ')}`,
    }
  }
  return { valid: true }
}

// ─── POST /api/trade/crypto-execute ──────────────────────────────────────────
export async function POST(request: NextRequest) {
  const requestId = safeUUID().slice(0, 8)
  log('info', `[${requestId}] Starting crypto up/down trade execution`)

  try {
    const body = await request.json() as any
    const {
      market_id,
      side,        // 'UP' | 'DOWN' — dari trade-engine
      size,        // dalam USDC
      price,       // harga token (0.0-1.0)
      credentials: clientCreds,
      question,
      signal_confidence,
    } = body

    // ─── 1. Basic Validation ────────────────────────────────────────────────
    if (!market_id || !side || !size || !price) {
      return NextResponse.json({
        error: 'Missing required fields: market_id, side, size, price',
        request_id: requestId,
      }, { status: 400 })
    }

    // side normalization: UP → YES (buy YES tokens), DOWN → NO (buy NO tokens)
    // Di Polymarket CLOB:
    //   - BUY YES tokens = speculating price will go UP
    //   - SELL YES tokens = closing a long YES position (same as buying NO)
    // Untuk simplicity: UP/DOWN refers to position direction
    //   UP position = bought YES tokens → sell with Side.SELL (or buy NO)
    //   DOWN position = bought NO tokens → sell with Side.BUY (or buy YES)
    const normalizedSide = side === 'UP' ? 'YES' : side === 'DOWN' ? 'NO' : side

    log('info', `[${requestId}] Input: ${side} → normalized: ${normalizedSide} | $${size} @ ${price} | market=${String(market_id).slice(0, 12)}...`)

    // ─── 2. Resolve Credentials ─────────────────────────────────────────────
    const creds = resolveCredentials(clientCreds)
    if (!creds) {
      return NextResponse.json({
        error: 'Credentials not configured. Please configure API key, secret, passphrase, and private key in Settings.',
        request_id: requestId,
      }, { status: 401 })
    }

    if (!creds.privateKey || creds.privateKey.length < 32) {
      return NextResponse.json({
        error: 'Private key missing or invalid (minimum 32 characters required)',
        request_id: requestId,
      }, { status: 401 })
    }

    // ✅ FIX: Validasi chain dari clientCreds, bukan hardcoded
    const chain = (clientCreds?.chain ?? 137) as number
    const chainCheck = validateChain(chain)
    if (!chainCheck.valid) {
      return NextResponse.json({
        error: chainCheck.error,
        request_id: requestId,
      }, { status: 400 })
    }

    log('info', `[${requestId}] Chain: ${chain} (${CHAIN_NAMES[chain]}) | SignatureType: ${creds.signatureType ?? 2}`)

    // ─── 3. Fetch Market Data dari Gamma ─────────────────────────────────────
    const marketUrl = `${GAMMA_HOST}/markets/${encodeURIComponent(market_id)}`
    log('info', `[${requestId}] Fetching market: ${marketUrl}`)

    const marketRes = await fetch(marketUrl, { cache: 'no-store' })
    if (!marketRes.ok) {
      const errorText = await marketRes.text().catch(() => 'Unknown error')
      log('error', `[${requestId}] Market fetch failed: ${marketRes.status}`)
      return NextResponse.json({
        error: `Market fetch failed: ${marketRes.status}`,
        details: errorText.slice(0, 300),
        request_id: requestId,
      }, { status: 500 })
    }

    const market = await marketRes.json()
    log('info', `[${requestId}] Market: "${market.question?.slice(0, 50)}..." | closed=${market.closed} | archived=${market.archived} | neg_risk=${market.neg_risk}`)

    // ─── 4. Market Status Validation ─────────────────────────────────────────
    if (market.closed || market.archived) {
      return NextResponse.json({
        error: 'Market is closed or archived — order cannot be placed',
        request_id: requestId,
      }, { status: 400 })
    }

    if (market.accepting_orders === false) {
      return NextResponse.json({
        error: 'Market is not accepting orders at this time',
        request_id: requestId,
      }, { status: 400 })
    }

    // ✅ FIX: Cek apakah market accept_orders_until sudah lewat
    if (market.accepting_order_timestamp) {
      const acceptUntil = parseInt(market.accepting_order_timestamp)
      if (!isNaN(acceptUntil) && Date.now() > acceptUntil * 1000) {
        return NextResponse.json({
          error: 'Market order acceptance window has closed',
          request_id: requestId,
        }, { status: 400 })
      }
    }

    // ─── 5. Parse Token IDs (handle neg_risk) ─────────────────────────────────
    let tokenIdsRaw = market.clobTokenIds
    if (typeof tokenIdsRaw === 'string') {
      try { tokenIdsRaw = JSON.parse(tokenIdsRaw) } catch { tokenIdsRaw = [] }
    }
    const tokenIds = Array.isArray(tokenIdsRaw) ? tokenIdsRaw : []

    if (tokenIds.length < 2) {
      return NextResponse.json({
        error: 'Insufficient token IDs (need at least 2 for YES/NO)',
        token_ids: tokenIds,
        request_id: requestId,
      }, { status: 400 })
    }

    // 🔴 neg_risk: YES = token[1], NO = token[0] (terbalik dari normal)
    // Dalam neg_risk markets, "YES" position di-risk menjadi 0 (bukan 1)
    const isNegRisk = Boolean(market.neg_risk)
    let tokenIdStr: string

    if (isNegRisk) {
      // Neg risk: token[0] = NO, token[1] = YES
      tokenIdStr = normalizedSide === 'YES' ? String(tokenIds[1]) : String(tokenIds[0])
      log('info', `[${requestId}] NEG_RISK market — token[${normalizedSide === 'YES' ? 1 : 0}] = ${tokenIdStr}`)
    } else {
      // Normal: YES = token[0], NO = token[1]
      tokenIdStr = normalizedSide === 'YES' ? String(tokenIds[0]) : String(tokenIds[1])
    }

    log('info', `[${requestId}] Token IDs: [${tokenIds.join(', ')}] | negRisk=${isNegRisk} | ${normalizedSide} → token=${tokenIdStr}`)

    // ─── 6. Tick Size & Price Clamping ───────────────────────────────────────
    let tickSize = parseFloat(market.minimum_tick_size ?? '0.01')
    if (isNaN(tickSize) || tickSize <= 0) tickSize = 0.01

    let rawPrice = Number(price)
    const minPrice = Math.max(0.01, tickSize)
    const maxPrice = Math.min(0.99, 1 - tickSize)
    rawPrice = Math.max(minPrice, Math.min(maxPrice, rawPrice))

    const decimals = tickSize >= 0.1 ? 1 : tickSize >= 0.01 ? 2 : tickSize >= 0.001 ? 3 : 4
    const clampedPrice = parseFloat((Math.round(rawPrice / tickSize) * tickSize).toFixed(decimals))

    // ✅ FIX: Extreme price check dengan log yang lebih informatif
    if (clampedPrice <= 0.03) {
      log('warn', `[${requestId}] Price ${(clampedPrice*100).toFixed(0)}% is extremely low — market near resolution`)
    }
    if (clampedPrice >= 0.97) {
      log('warn', `[${requestId}] Price ${(clampedPrice*100).toFixed(0)}% is extremely high — market near resolution`)
    }

    // Hard reject extreme prices (market resolution imminent)
    if (clampedPrice <= 0.01 || clampedPrice >= 0.99) {
      return NextResponse.json({
        error: `Price ${(clampedPrice*100).toFixed(0)}% too extreme — market at or near resolution`,
        clamped_price: clampedPrice,
        request_id: requestId,
      }, { status: 400 })
    }

    log('info', `[${requestId}] Price: raw=${price} → clamped=${clampedPrice}`)

    // ─── 7. Minimum Order Size ────────────────────────────────────────────────
    const minOrderSize = parseFloat(market.minimum_order_size ?? '1')
    const orderSize = Number(size)
    if (orderSize < minOrderSize) {
      return NextResponse.json({
        error: `Size $${orderSize.toFixed(2)} below minimum $${minOrderSize.toFixed(2)} USDC`,
        min_order_size: minOrderSize,
        request_id: requestId,
      }, { status: 400 })
    }

    // ─── 8. Build CLOB Client V2 ───────────────────────────────────────────────
    const pk = creds.privateKey.startsWith('0x') ? creds.privateKey : `0x${creds.privateKey}`
    const signer = new ethers.Wallet(pk)

    const derivedAddress = signer.address.toLowerCase()
    const funderAddress = (creds.funderAddress ?? '').toLowerCase()
    if (funderAddress && derivedAddress !== funderAddress) {
      log('warn', `[${requestId}] PK address ${derivedAddress} != funder ${funderAddress} (acceptable for proxy wallets)`)
    }

    // ✅ FIX: Pakai chain dari validated clientCreds
    const clobClient = new ClobClient({
      host:   CLOB_HOST,
      chain,  // ← Pakai chain yang sudah divalidasi
      signer,
      creds: {
        key:        creds.apiKey,
        secret:     creds.apiSecret,
        passphrase: creds.apiPassphrase,
      },
      signatureType: creds.signatureType ?? 2,
      funderAddress: creds.funderAddress ?? derivedAddress,
    })

    // ─── 9. Create Order ─────────────────────────────────────────────────────
    // normalizedSide 'YES' → Side.BUY (beli YES tokens)
    // normalizedSide 'NO'  → Side.SELL (beli NO tokens / sell YES tokens)
    const tradeSide = normalizedSide === 'YES' ? Side.BUY : Side.SELL

    const orderParams: any = {
      tokenID: tokenIdStr,
      price:   clampedPrice,
      side:    tradeSide,
      size:    orderSize,
    }

    if (creds.builderCode) {
      orderParams.builderCode = creds.builderCode
    }

    if (isNegRisk) {
      orderParams.negRisk = true
    }

    log('info', `[${requestId}] Order: ${tradeSide === Side.BUY ? 'BUY' : 'SELL'} | token=${tokenIdStr} | price=${clampedPrice} | size=${orderSize}`)

    const signedOrder = await clobClient.createOrder(orderParams)
    log('info', `[${requestId}] Order signed: id=${signedOrder?.orderID || signedOrder?.id || 'unsigned'}`)

    // ─── 10. Submit Order ────────────────────────────────────────────────────
    log('info', `[${requestId}] Submitting to CLOB...`)
    const orderData = await clobClient.postOrder(signedOrder, OrderType.GTC)
    log('info', `[${requestId}] CLOB response:`, JSON.stringify(orderData).slice(0, 200))

    // ─── 11. Success Detection ────────────────────────────────────────────────
    const isSuccess =
      orderData?.success === true ||
      orderData?.success === 'true' ||
      Boolean(orderData?.orderID) ||
      Boolean(orderData?.id)

    if (!isSuccess) {
      const errorMsg =
        orderData?.errorMsg ||
        orderData?.error ||
        orderData?.message ||
        'Order rejected by CLOB'
      log('error', `[${requestId}] Order rejected:`, orderData)
      return NextResponse.json({
        error:         errorMsg,
        details:        orderData,
        signed_order_id: signedOrder?.orderID || null,
        request_id:     requestId,
      }, { status: 400 })
    }

    // ─── 12. Return Success ───────────────────────────────────────────────────
    const finalOrderId =
      orderData?.orderID ||
      orderData?.id ||
      signedOrder?.orderID ||
      safeUUID()

    log('info', `[${requestId}] ✅ SUCCESS: orderId=${finalOrderId}`)

    return NextResponse.json({
      success:           true,
      order_id:          finalOrderId,
      token_id:          tokenIdStr,
      token_ids:         tokenIds,
      condition_id:      market.condition_id ?? '',
      price:             clampedPrice,
      size:              orderSize,
      side:              normalizedSide,
      market_id:         market_id,
      neg_risk:          isNegRisk,
      builder_code:      creds.builderCode || null,
      status:            orderData?.status ?? 'live',
      request_id:        requestId,
      question:          question || market.question,
      signal_confidence: signal_confidence ?? null,
      timestamp:         Date.now(),
    })

  } catch (e: unknown) {
    const msg   = e instanceof Error ? e.message : String(e)
    const stack = e instanceof Error ? e.stack : undefined
    log('error', `[${requestId}] ERROR: ${msg}`, { stack: stack?.slice(0, 300) })
    return NextResponse.json({
      error:     msg,
      request_id: requestId,
    }, { status: 500 })
  }
}

// ─── GET — Health check ──────────────────────────────────────────────────────
export async function GET() {
  return NextResponse.json({
    status:   'ok',
    endpoint: 'crypto-execute',
    version:  'CLOB V2 patched',
    timestamp: Date.now(),
  })
}

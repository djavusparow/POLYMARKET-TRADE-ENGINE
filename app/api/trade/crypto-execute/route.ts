// app/api/trade/crypto-execute/route.ts
// CLOB V2 — Full Auto Trade untuk Crypto Up/Down
// Mekanisme SERUPADengan app/api/trade/execute

import { NextRequest, NextResponse } from 'next/server'
import { ClobClient, Side, OrderType } from '@polymarket/clob-client-v2'
import { ethers } from 'ethers'
import { resolveCredentials } from '@/lib/clob-auth'

const CLOB_HOST  = 'https://clob.polymarket.com'
const GAMMA_HOST = 'https://gamma-api.polymarket.com'
const CHAIN_ID   = 137

function safeUUID(): string {
  try { return crypto.randomUUID() } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 6)}`
  }
}

function log(level: 'info' | 'warn' | 'error', msg: string, data?: any): void {
  const prefix = `[crypto-execute] [${level.toUpperCase()}]`
  if (data) {
    console[level](prefix, msg, typeof data === 'object' ? JSON.stringify(data, null, 2).slice(0, 400) : data)
  } else {
    console[level](prefix, msg)
  }
}

// ─── POST /api/trade/crypto-execute ──────────────────────────────────────────
export async function POST(request: NextRequest) {
  const requestId = safeUUID().slice(0, 8)
  log('info', `[${requestId}] Starting crypto up/down trade execution`)

  try {
    const body = await request.json() as any
    const {
      market_id,
      side,       // 'UP' | 'DOWN' — dari trade-engine
      size,       // dalam USDC
      price,      // harga token (0.0-1.0)
      credentials: clientCreds,
      // Optional
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

    // side normalization: UP=DOWN → BUY, DOWN → SELL
    // Di Polymarket: UP = YES tokens (BUY), DOWN = NO tokens (SELL)
    const normalizedSide = side === 'UP' ? 'YES' : side === 'DOWN' ? 'NO' : side

    log('info', `[${requestId}] Request: ${side} (normalized: ${normalizedSide}) $${size} @ ${price} | market=${String(market_id).slice(0, 12)}...`)

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

    log('info', `[${requestId}] Chain: Polygon (137) | SignatureType: ${creds.signatureType ?? 2}`)

    // ─── 3. Fetch Market Data dari Gamma ─────────────────────────────────────
    // ✅ Pakai Gamma (sama seperti execute) karena lebih reliable untuk market info
    const marketUrl = `${GAMMA_HOST}/markets/${encodeURIComponent(market_id)}`
    log('info', `[${requestId}] Fetching market from Gamma: ${marketUrl}`)

    const marketRes = await fetch(marketUrl, { cache: 'no-store' })
    if (!marketRes.ok) {
      const errorText = await marketRes.text().catch(() => 'Unknown error')
      log('error', `[${requestId}] Market fetch failed: ${marketRes.status}`, { errorText: errorText.slice(0, 200) })
      return NextResponse.json({
        error: `Market fetch failed: ${marketRes.status}`,
        details: errorText.slice(0, 300),
        request_id: requestId,
      }, { status: 500 })
    }

    const market = await marketRes.json()
    log('info', `[${requestId}] Market: "${market.question?.slice(0, 50)}..." | closed=${market.closed} | archived=${market.archived}`)

    if (market.closed || market.archived) {
      return NextResponse.json({
        error: 'Market is closed or archived',
        request_id: requestId,
      }, { status: 400 })
    }

    if (market.accepting_orders === false) {
      return NextResponse.json({
        error: 'Market is not accepting orders at this time',
        request_id: requestId,
      }, { status: 400 })
    }

    // ─── 4. Parse Token IDs (handle neg_risk) ─────────────────────────────────
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

    // 🔴 Handle neg_risk: YES = token[1], NO = token[0] (terbalik dari normal)
    const isNegRisk = Boolean(market.neg_risk)
    let tokenIdStr: string

    if (isNegRisk) {
      // Neg risk: token[0] = NO, token[1] = YES
      tokenIdStr = normalizedSide === 'YES' ? String(tokenIds[1]) : String(tokenIds[0])
      log('info', `[${requestId}] NEG_RISK market — using token[${normalizedSide === 'YES' ? 1 : 0}] = ${tokenIdStr}`)
    } else {
      // Normal: YES = token[0], NO = token[1]
      tokenIdStr = normalizedSide === 'YES' ? String(tokenIds[0]) : String(tokenIds[1])
    }

    log('info', `[${requestId}] Token IDs: [${tokenIds.join(', ')}] | negRisk=${isNegRisk} | selected=${tokenIdStr}`)

    // ─── 5. Tick Size & Price Clamping (sama seperti execute) ─────────────────
    let tickSize = parseFloat(market.minimum_tick_size ?? '0.01')
    if (isNaN(tickSize) || tickSize <= 0) tickSize = 0.01

    let rawPrice = Number(price)
    const minPrice = Math.max(0.01, tickSize)
    const maxPrice = Math.min(0.99, 1 - tickSize)
    rawPrice = Math.max(minPrice, Math.min(maxPrice, rawPrice))

    const decimals = tickSize >= 0.1 ? 1 : tickSize >= 0.01 ? 2 : tickSize >= 0.001 ? 3 : 4
    const clampedPrice = parseFloat((Math.round(rawPrice / tickSize) * tickSize).toFixed(decimals))

    if (clampedPrice <= 0.03 || clampedPrice >= 0.97) {
      return NextResponse.json({
        error: `Price too extreme (${(clampedPrice * 100).toFixed(0)}%) — market near resolution`,
        clamped_price: clampedPrice,
        request_id: requestId,
      }, { status: 400 })
    }

    log('info', `[${requestId}] Price: raw=${price} → clamped=${clampedPrice} (tick=${tickSize}, ${decimals} decimals)`)

    // ─── 6. Minimum Order Size ────────────────────────────────────────────────
    const minOrderSize = parseFloat(market.minimum_order_size ?? '1')
    const orderSize = Number(size)
    if (orderSize < minOrderSize) {
      return NextResponse.json({
        error: `Size $${orderSize.toFixed(2)} below minimum $${minOrderSize.toFixed(2)} USDC`,
        min_order_size: minOrderSize,
        request_id: requestId,
      }, { status: 400 })
    }

    // ─── 7. Build CLOB Client V2 (sama seperti execute) ──────────────────────
    const pk = creds.privateKey.startsWith('0x') ? creds.privateKey : `0x${creds.privateKey}`
    const signer = new ethers.Wallet(pk)

    // Validate derived address vs funder
    const derivedAddress = signer.address.toLowerCase()
    const funderAddress  = (creds.funderAddress ?? '').toLowerCase()
    if (funderAddress && derivedAddress !== funderAddress) {
      log('warn', `[${requestId}] Private key address ${derivedAddress} != funder address ${funderAddress}`)
    }

    const clobClient = new ClobClient({
      host:   CLOB_HOST,
      chain:  CHAIN_ID,
      signer,
      creds: {
        key:        creds.apiKey,
        secret:     creds.apiSecret,
        passphrase: creds.apiPassphrase,
      },
      signatureType: creds.signatureType ?? 2,
      funderAddress: creds.funderAddress ?? derivedAddress,
    })

    // ─── 8. Create Order ──────────────────────────────────────────────────────
    // UP/BUY → Side.BUY, DOWN/SELL → Side.SELL
    const tradeSide = normalizedSide === 'YES' ? Side.BUY : Side.SELL

    const orderParams: any = {
      tokenID: tokenIdStr,
      price:   clampedPrice,
      side:    tradeSide,
      size:    orderSize,
    }

    // Builder attribution
    if (creds.builderCode) {
      orderParams.builderCode = creds.builderCode
      log('info', `[${requestId}] Builder code: ${creds.builderCode}`)
    }

    // Neg risk flag
    if (isNegRisk) {
      orderParams.negRisk = true
    }

    log('info', `[${requestId}] Creating order:`, {
      tokenID: tokenIdStr,
      price:   clampedPrice,
      side:    tradeSide === Side.BUY ? 'BUY' : 'SELL',
      size:    orderSize,
      negRisk: isNegRisk,
    })

    const signedOrder = await clobClient.createOrder(orderParams)
    log('info', `[${requestId}] Order signed:`, {
      orderId: signedOrder?.orderID || signedOrder?.id || 'unsigned',
      salt:    signedOrder?.salt?.toString().slice(0, 10) || 'unknown',
      maker:   signedOrder?.maker?.slice(0, 10) || 'unknown',
    })

    // ─── 9. Submit Order via CLOB V2 ─────────────────────────────────────────
    log('info', `[${requestId}] Submitting order to CLOB...`)
    const orderData = await clobClient.postOrder(signedOrder, OrderType.GTC)
    log('info', `[${requestId}] CLOB response:`, orderData)

    // ─── 10. Success Detection ─────────────────────────────────────────────────
    const isSuccess = orderData.success === true ||
                      orderData.success === 'true' ||
                      Boolean(orderData.orderID) ||
                      Boolean(orderData.id)

    if (!isSuccess) {
      const errorMsg = orderData.errorMsg ||
                       orderData.error ||
                       orderData.message ||
                       'Order rejected by CLOB (no specific error)'
      log('error', `[${requestId}] Order rejected:`, orderData)
      return NextResponse.json({
        error:    errorMsg,
        details:  orderData,
        signed_order_id: signedOrder?.orderID || null,
        request_id: requestId,
      }, { status: 400 })
    }

    // ─── 11. Return Success ───────────────────────────────────────────────────
    const finalOrderId = orderData.orderID ||
                         orderData.id ||
                         signedOrder?.orderID ||
                         safeUUID()

    log('info', `[${requestId}] ✅ Order submitted: ${finalOrderId}`)

    return NextResponse.json({
      success:      true,
      order_id:     finalOrderId,
      token_id:     tokenIdStr,
      token_ids:    tokenIds,
      condition_id: market.condition_id ?? '',
      price:        clampedPrice,
      size:         orderSize,
      side:         normalizedSide,
      market_id:    market_id,
      neg_risk:     isNegRisk,
      builder_code: creds.builderCode || null,
      status:       orderData.status ?? 'live',
      request_id:   requestId,
      // Extra info untuk tracking
      question:     question || market.question,
      signal_confidence: signal_confidence ?? null,
      timestamp:    Date.now(),
    })

  } catch (e: unknown) {
    const msg   = e instanceof Error ? e.message : String(e)
    const stack = e instanceof Error ? e.stack : undefined
    log('error', `[${requestId}] Unhandled error: ${msg}`, { stack: stack?.slice(0, 300) })
    return NextResponse.json({
      error:     msg,
      request_id: requestId,
    }, { status: 500 })
  }
}

// ─── GET /api/trade/crypto-execute — Health check ──────────────────────────────
export async function GET() {
  return NextResponse.json({
    status:    'ok',
    endpoint:  'crypto-execute',
    clob_host: CLOB_HOST,
    gamma_host: GAMMA_HOST,
    chain:     CHAIN_ID,
    version:   'CLOB V2',
    timestamp: Date.now(),
  })
}
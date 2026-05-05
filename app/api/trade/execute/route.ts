// app/api/trade/execute/route.ts
// CLOB V2 Migration — May 2026
// Menggunakan @polymarket/clob-client-v2 SDK
// Constructor: options object, chain = 137 (Polygon Mainnet)
// Fitur: neg_risk detection, chain validation, multi-level UUID fallback

import { NextResponse } from 'next/server'
import { ClobClient, Side, OrderType } from '@polymarket/clob-client-v2'
import { ethers } from 'ethers'
import { resolveCredentials } from '@/lib/clob-auth'

const CLOB_HOST   = 'https://clob.polymarket.com'
const GAMMA_HOST  = 'https://gamma-api.polymarket.com'
const CHAIN_NAMES: Record<number, string> = {
  137:   'Polygon Mainnet',
  80001: 'Polygon Mumbai',
  80002: 'Polygon Amoy',
}

// ─── Safe UUID (fallback untuk runtime yang tidak punya crypto.randomUUID) ─────
function safeUUID(): string {
  try { return crypto.randomUUID() } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 6)}`
  }
}

// ─── Validasi Chain ───────────────────────────────────────────────────────────
function validateChain(chain: number): { valid: boolean; error?: string } {
  if (!CHAIN_NAMES[chain]) {
    return {
      valid: false,
      error: `Unsupported chain ID: ${chain}. Supported chains: ${Object.keys(CHAIN_NAMES).join(', ')}`,
    }
  }
  return { valid: true }
}

// ─── Logging Helper ───────────────────────────────────────────────────────────
function log(level: 'info' | 'warn' | 'error', msg: string, data?: any): void {
  const prefix = `[api/execute] [${level.toUpperCase()}]`
  if (data) {
    console[level](prefix, msg, JSON.stringify(data, null, 2))
  } else {
    console[level](prefix, msg)
  }
}

// ─── POST /api/trade/execute ─────────────────────────────────────────────────
export async function POST(request: Request) {
  const requestId = safeUUID().slice(0, 8)
  log('info', `[${requestId}] Starting trade execution request`)

  try {
    const body = await request.json() as any
    const {
      market_id,
      side,
      size,
      price,
      credentials: clientCreds,
      // Optional dari trade-engine (untuk logging)
      question,
      signal_confidence,
    } = body

    if (!market_id || !side || !size || !price) {
      return NextResponse.json({
        error: 'Missing required fields: market_id, side, size, price',
        request_id: requestId,
      }, { status: 400 })
    }

    log('info', `[${requestId}] Request: ${side} $${size} @ ${price} | market=${market_id.slice(0, 12)}... | ${question?.slice(0, 40) || ''}`)

    // ────────────────────────────────────────────────────────────────────
    // 1. RESOLVE CREDENTIALS
    // ────────────────────────────────────────────────────────────────────
    const creds = resolveCredentials(clientCreds)
    if (!creds) {
      return NextResponse.json({
        error: 'Credentials not configured. Please configure API key, secret, passphrase, and private key.',
        request_id: requestId,
      }, { status: 401 })
    }

    if (!creds.privateKey || creds.privateKey.length < 32) {
      return NextResponse.json({
        error: 'Private key missing or invalid (minimum 32 characters required)',
        request_id: requestId,
      }, { status: 401 })
    }

    // ✅ PERBAIKAN: Chain dari clientCreds (input proxy/user), bukan dari creds hasil resolve
    const chain = (clientCreds?.chain ?? 137) as number
    const chainCheck = validateChain(chain)
    if (!chainCheck.valid) {
      return NextResponse.json({
        error: chainCheck.error,
        request_id: requestId,
      }, { status: 400 })
    }

    log('info', `[${requestId}] Chain: ${chain} (${CHAIN_NAMES[chain]}) | SignatureType: ${creds.signatureType ?? 2}`)

    // ────────────────────────────────────────────────────────────────────
    // 2. FETCH MARKET DATA
    // ────────────────────────────────────────────────────────────────────
    const marketUrl = `${GAMMA_HOST}/markets/${encodeURIComponent(market_id)}`
    log('info', `[${requestId}] Fetching market: ${marketUrl}`)

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

    // ────────────────────────────────────────────────────────────────────
    // 3. PARSE TOKEN IDs (handle neg_risk)
    // ────────────────────────────────────────────────────────────────────
    let tokenIdsRaw = market.clobTokenIds
    if (typeof tokenIdsRaw === 'string') {
      try { tokenIdsRaw = JSON.parse(tokenIdsRaw) } catch { tokenIdsRaw = [] }
    }
    let tokenIds = Array.isArray(tokenIdsRaw) ? tokenIdsRaw : []

    if (tokenIds.length < 2) {
      return NextResponse.json({
        error: 'Insufficient token IDs (need at least 2 for YES/NO)',
        token_ids: tokenIds,
        request_id: requestId,
      }, { status: 400 })
    }

    // 🔴 Handle neg_risk market: token ID terbalik (YES=token[1], NO=token[0])
    const isNegRisk = Boolean(market.neg_risk)
    let tokenIdStr: string
    if (isNegRisk) {
      // Neg risk: token[0] = NO, token[1] = YES
      tokenIdStr = side === 'YES' ? String(tokenIds[1]) : String(tokenIds[0])
      log('info', `[${requestId}] NEG_RISK market detected — swapped token IDs. Using token[${side === 'YES' ? 1 : 0}]`)
    } else {
      tokenIdStr = side === 'YES' ? String(tokenIds[0]) : String(tokenIds[1])
    }

    log('info', `[${requestId}] Token IDs: [${tokenIds.join(', ')}] | negRisk=${isNegRisk} | selected=${tokenIdStr}`)

    // ────────────────────────────────────────────────────────────────────
    // 4. TICK SIZE & PRICE CLAMPING
    // ────────────────────────────────────────────────────────────────────
    let tickSize = parseFloat(market.minimum_tick_size ?? '0.01')
    if (isNaN(tickSize) || tickSize <= 0) tickSize = 0.01

    let rawPrice = Number(price)
    // Clamp ke range yang wajar
    const minPrice = Math.max(0.01, tickSize)
    const maxPrice = Math.min(0.99, 1 - tickSize)
    rawPrice = Math.max(minPrice, Math.min(maxPrice, rawPrice))

    // Round ke tick size terdekat
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

    // ────────────────────────────────────────────────────────────────────
    // 5. MINIMUM ORDER SIZE
    // ────────────────────────────────────────────────────────────────────
    const minOrderSize = parseFloat(market.minimum_order_size ?? '1')
    const orderSize = Number(size)
    if (orderSize < minOrderSize) {
      return NextResponse.json({
        error: `Size $${orderSize.toFixed(2)} below minimum $${minOrderSize.toFixed(2)} USDC`,
        min_order_size: minOrderSize,
        request_id: requestId,
      }, { status: 400 })
    }

    // ────────────────────────────────────────────────────────────────────
    // 6. BUILD CLOB CLIENT V2
    // ────────────────────────────────────────────────────────────────────
    const pk = creds.privateKey.startsWith('0x') ? creds.privateKey : `0x${creds.privateKey}`
    const signer = new ethers.Wallet(pk)

    // Validasi address dari private key cocok dengan funder address
    const derivedAddress = signer.address.toLowerCase()
    const funderAddress  = (creds.funderAddress ?? '').toLowerCase()
    if (funderAddress && derivedAddress !== funderAddress) {
      log('warn', `[${requestId}] Private key address ${derivedAddress} != funder address ${funderAddress}`)
      // Ini hanya warning — jangan block karena proxy wallet bisa berbeda
    }

    const clobClient = new ClobClient({
      host:   CLOB_HOST,
      chain,  // ← Pakai chain dari clientCreds, bukan dari creds hasil resolve
      signer,
      creds: {
        key:        creds.apiKey,
        secret:     creds.apiSecret,
        passphrase: creds.apiPassphrase,
      },
      signatureType: creds.signatureType ?? 2,      // Default: Gnosis Safe
      funderAddress: creds.funderAddress ?? derivedAddress,
    })

    const tradeSide = side === 'YES' ? Side.BUY : Side.SELL

    // ────────────────────────────────────────────────────────────────────
    // 7. CREATE ORDER V2
    // ────────────────────────────────────────────────────────────────────
    const orderParams: any = {
      tokenID: tokenIdStr,
      price:   clampedPrice,
      side:    tradeSide,
      size:    orderSize,
    }

    // Builder attribution (optional — untuk tracking referal)
    if (creds.builderCode) {
      orderParams.builderCode = creds.builderCode
      log('info', `[${requestId}] Builder code: ${creds.builderCode}`)
    }

    // Neg risk flag (jika diperlukan SDK V2)
    if (isNegRisk) {
      orderParams.negRisk = true
    }

    log('info', `[${requestId}] Creating order:`, {
      tokenID: tokenIdStr,
      price: clampedPrice,
      side: tradeSide === Side.BUY ? 'BUY' : 'SELL',
      size: orderSize,
      negRisk: isNegRisk,
    })

    const signedOrder = await clobClient.createOrder(orderParams)

    log('info', `[${requestId}] Order signed successfully`, {
      orderId: signedOrder?.orderID || signedOrder?.id || 'unsigned',
      salt:    signedOrder?.salt?.toString().slice(0, 10) || 'unknown',
      maker:   signedOrder?.maker?.slice(0, 10) || 'unknown',
    })

    // ────────────────────────────────────────────────────────────────────
    // 8. SUBMIT ORDER VIA CLOB V2
    // ────────────────────────────────────────────────────────────────────
    log('info', `[${requestId}] Submitting order to CLOB...`)

    const orderData = await clobClient.postOrder(signedOrder, OrderType.GTC)

    log('info', `[${requestId}] CLOB response:`, orderData)

    // ✅ Multi-level success detection
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
        error: errorMsg,
        details: orderData,
        signed_order_id: signedOrder?.orderID || null,
        request_id: requestId,
      }, { status: 400 })
    }

    // ────────────────────────────────────────────────────────────────────
    // 9. RETURN SUCCESS RESPONSE
    // ────────────────────────────────────────────────────────────────────
    const finalOrderId = orderData.orderID ||
                         orderData.id ||
                         signedOrder?.orderID ||
                         safeUUID()

    log('info', `[${requestId}] ✅ Order submitted successfully: ${finalOrderId}`)

    return NextResponse.json({
      success:      true,
      order_id:     finalOrderId,
      token_id:     tokenIdStr,
      token_ids:    tokenIds,
      condition_id: market.condition_id ?? '',
      price:        clampedPrice,
      size:         orderSize,
      side:         side,
      market_id,
      neg_risk:     isNegRisk,
      builder_code: creds.builderCode || null,
      status:       orderData.status ?? 'live',
      request_id:   requestId,
    })

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    const stack = e instanceof Error ? e.stack : undefined
    log('error', `[${requestId}] Unhandled error: ${msg}`, { stack: stack?.slice(0, 300) })
    return NextResponse.json({
      error: msg,
      request_id: requestId,
    }, { status: 500 })
  }
}

// ─── GET /api/trade/execute — Health check ────────────────────────────────────
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    clob_host: CLOB_HOST,
    gamma_host: GAMMA_HOST,
    supported_chains: CHAIN_NAMES,
    version: 'CLOB V2',
    timestamp: Date.now(),
  })
}

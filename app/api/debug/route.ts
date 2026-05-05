// app/api/debug/route.ts — CLOB V2 version

import { NextResponse } from 'next/server'
import { resolveCredentials, buildClobHeaders } from '@/lib/clob-auth'

const CLOB_HOST = 'https://clob.polymarket.com'

export async function GET() {
  const results: Record<string, any> = {}

  const creds = resolveCredentials()
  if (!creds) return NextResponse.json({ error: 'No credentials' })

  // Derive signer address
  let signerAddress = 'unknown'
  try {
    const { secp256k1 } = await import('@noble/curves/secp256k1')
    const { keccak_256 } = await import('@noble/hashes/sha3')
    const pk        = creds.privateKey.startsWith('0x') ? creds.privateKey.slice(2) : creds.privateKey
    const pubKey    = secp256k1.getPublicKey(pk, false)
    const pubBytes  = pubKey.slice(1)
    const hash      = keccak_256(pubBytes)
    const addrBytes = hash.slice(12)
    signerAddress = '0x' + Array.from(addrBytes).map((b: number) => b.toString(16).padStart(2, '0')).join('')
  } catch(e) {
    signerAddress = 'error: ' + String(e)
  }

  results.credentials = {
    hasPrivateKey:   !!creds.privateKey,
    hasApiKey:       !!creds.apiKey,
    apiKeyPrefix:    creds.apiKey?.slice(0, 8),
    funderAddress:   creds.funderAddress,
    signerAddress,
    signatureType:   creds.signatureType,
    hasBuilderCode:  !!creds.builderCode,
    builderCode:     creds.builderCode?.slice(0, 10) + '...',
  }

  // 1. CLOB V2 connectivity
  try {
    const res = await fetch(`${CLOB_HOST}/ok`)
    results.clobConnection = { status: res.status, body: await res.text() }
  } catch(e) { results.clobConnection = { error: String(e) } }

  // 2. Auth test - GET /data/orders
  try {
    const path    = '/data/orders?maker=' + creds.funderAddress
    const headers = await buildClobHeaders(creds, 'GET', path, '')
    const res     = await fetch(`${CLOB_HOST}${path}`, { method: 'GET', headers })
    const text    = await res.text()
    results.ordersTest = { status: res.status, ok: res.ok, body: text.slice(0, 300) }
  } catch(e) { results.ordersTest = { error: String(e) } }

  // 3. SDK V2 order test
  try {
    const { ClobClient, Side, OrderType } = await import('@polymarket/clob-client-v2')
    const { ethers } = await import('ethers')

    const pk     = creds.privateKey.startsWith('0x') ? creds.privateKey : `0x${creds.privateKey}`
    const signer = new ethers.Wallet(pk)

    // V2 constructor: options object
    const client = new ClobClient({
      host:          CLOB_HOST,
      chain:         137,
      signer,
      creds: {
        key:        creds.apiKey,
        secret:     creds.apiSecret,
        passphrase: creds.apiPassphrase,
      },
      signatureType: creds.signatureType,
      funderAddress: creds.funderAddress,
    })

    const TOKEN_ID = '49500299856831034491021962156746701298730459370557900271970866855042624695770'

    const orderParams: any = {
      tokenID: TOKEN_ID,
      price:   0.5,
      side:    Side.BUY,
      size:    10,
    }
    if (creds.builderCode) orderParams.builderCode = creds.builderCode

    const order = await client.createOrder(orderParams)

    results.orderStructure = {
      salt:          (order as any).salt,
      maker:         (order as any).maker,
      signer:        (order as any).signer,
      tokenId:       (order as any).tokenId,
      makerAmount:   (order as any).makerAmount,
      takerAmount:   (order as any).takerAmount,
      side:          (order as any).side,
      signatureType: (order as any).signatureType,
      timestamp:     (order as any).timestamp,   // NEW in V2
      metadata:      (order as any).metadata,    // NEW in V2
      builder:       (order as any).builder,     // NEW in V2 (builderCode)
      signature:     (order as any).signature?.slice(0, 20) + '...',
      // V2 REMOVED fields (should not appear):
      _v2_removed_fields_check: {
        taker_exists:      'taker' in (order as any),
        expiration_exists: 'expiration' in (order as any),
        nonce_exists:      'nonce' in (order as any),
        feeRateBps_exists: 'feeRateBps' in (order as any),
      }
    }

    // Submit test
    try {
      const result = await client.postOrder(order, OrderType.GTC)
      results.submitTest = {
        success:  result.success,
        orderID:  result.orderID,
        status:   result.status,
        errorMsg: result.errorMsg,
        raw:      JSON.stringify(result),
      }
    } catch(submitErr: any) {
      results.submitTest = {
        error:    submitErr?.message ?? String(submitErr),
        response: submitErr?.response?.data ?? null,
        status:   submitErr?.response?.status ?? null,
      }
    }

  } catch(e: any) {
    results.sdkV2Test = { error: e?.message ?? String(e), stack: e?.stack?.slice(0, 300) }
  }

  return NextResponse.json(results)
}

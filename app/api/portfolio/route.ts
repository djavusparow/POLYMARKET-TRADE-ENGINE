// app/api/portfolio/route.ts
// CLOB V2 Update — April 28, 2026
// - Collateral token: USDC.e → pUSD (0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB)
// - Sumber balance: CLOB V2 /balance endpoint (primary) → on-chain pUSD (fallback)

import { NextRequest, NextResponse } from 'next/server'
import { resolveCredentials, buildClobHeaders } from '@/lib/clob-auth'
import type { ClobCreds } from '@/lib/clob-auth'

const CLOB_HOST = 'https://clob.polymarket.com'

// ─── Contract Addresses ───────────────────────────────────────────────────────
// V2: pUSD menggantikan USDC.e sebagai collateral token
const PUSD_CONTRACT   = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB' // pUSD (6 desimal)
const USDC_CONTRACT   = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' // Native USDC (fallback cek)

// ─── RPC Endpoints ────────────────────────────────────────────────────────────
const DEFAULT_RPC_ENDPOINTS = [
  process.env.POLYGON_RPC_URL,
  'https://polygon-rpc.com',
  'https://rpc.ankr.com/polygon',
  'https://polygon.llamarpc.com',
].filter(Boolean) as string[]

// ─── Method 1: CLOB V2 Balance API ───────────────────────────────────────────
// Cara termudah dan paling akurat — langsung dari CLOB yang tahu saldo trading
async function fetchClobBalance(creds: ClobCreds): Promise<number | null> {
  try {
    // Coba endpoint balance CLOB V2
    const endpoints = [
      `/balance?user=${creds.funderAddress}`,
      `/data/balance?user=${creds.funderAddress}`,
    ]

    for (const path of endpoints) {
      try {
        const headers = await buildClobHeaders(creds, 'GET', path, '')
        const res     = await fetch(`${CLOB_HOST}${path}`, {
          method:  'GET',
          headers,
          signal:  AbortSignal.timeout(8_000),
        })

        if (!res.ok) {
          console.log(`[Portfolio] CLOB ${path} → ${res.status}`)
          continue
        }

        const data = await res.json()
        console.log(`[Portfolio] CLOB balance response (${path}):`, JSON.stringify(data).slice(0, 200))

        // Format respons bisa berupa: number, string, { balance: ... }, { USDC: ... }, { pUSD: ... }
        if (typeof data === 'number') return data
        if (typeof data === 'string') return parseFloat(data) || null

        const val =
          data?.balance   ??
          data?.pUSD      ??
          data?.usdc      ??
          data?.USDC      ??
          data?.amount    ??
          null

        if (val !== null && val !== undefined) {
          const num = typeof val === 'string' ? parseFloat(val) : Number(val)
          // CLOB kadang return dalam unit 6-desimal (microUSDC) — deteksi dan konversi
          if (num > 1_000_000) return num / 1_000_000
          return isNaN(num) ? null : num
        }
      } catch (e) {
        console.log(`[Portfolio] CLOB ${path} error:`, (e as Error).message)
      }
    }
    return null
  } catch (e) {
    console.warn('[Portfolio] fetchClobBalance error:', (e as Error).message)
    return null
  }
}

// ─── Method 2: On-Chain pUSD Balance via ERC-20 balanceOf ─────────────────────
// Fallback jika CLOB API tidak merespons
function buildBalanceOfPayload(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, '')
  return '0x70a08231' + clean.padStart(64, '0')
}

async function tryRpcBalance(rpcUrl: string, address: string, contractAddress: string): Promise<number | null> {
  try {
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method:  'eth_call',
        params:  [{ to: contractAddress, data: buildBalanceOfPayload(address) }, 'latest'],
        id:      1,
      }),
      signal: AbortSignal.timeout(8_000),
    })

    if (!resp.ok) return null
    const json = await resp.json()
    if (json.error) return null

    const hexBalance = json.result as string
    if (!hexBalance || hexBalance === '0x') return 0
    return Number(BigInt(hexBalance)) / 1_000_000 // pUSD & USDC sama-sama 6 desimal
  } catch {
    return null
  }
}

async function fetchOnChainBalance(address: string): Promise<number | null> {
  // Coba pUSD dulu, lalu native USDC sebagai tambahan
  for (const rpc of DEFAULT_RPC_ENDPOINTS) {
    // pUSD balance
    const pusd = await tryRpcBalance(rpc, address, PUSD_CONTRACT)
    if (pusd !== null) {
      console.log(`[Portfolio] On-chain pUSD balance via ${rpc}: $${pusd}`)
      // Juga cek native USDC untuk total display
      const usdc = await tryRpcBalance(rpc, address, USDC_CONTRACT) ?? 0
      return pusd + usdc
    }
  }
  return null
}

// ─── GET /api/portfolio ────────────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  try {
    // 1. Resolve credentials
    const credsHeader = request.headers.get('X-Clob-Creds')
    let clientCreds: Partial<ClobCreds> | undefined
    if (credsHeader) {
      try { clientCreds = JSON.parse(credsHeader) } catch { /* ignore */ }
    }
    const creds = resolveCredentials(clientCreds)

    if (!creds?.funderAddress) {
      return NextResponse.json(
        { configured: false, error: 'No proxy wallet address supplied' },
        { status: 400 }
      )
    }

    console.log(`[Portfolio] Fetching balance for: ${creds.funderAddress}`)

    // 2. Coba CLOB V2 API dulu (paling akurat)
    let balance: number | null = null
    let method = 'unknown'

    balance = await fetchClobBalance(creds)
    if (balance !== null) {
      method = 'clob-v2-api'
    } else {
      // 3. Fallback ke on-chain pUSD balance
      console.log('[Portfolio] CLOB API failed, trying on-chain pUSD...')
      balance = await fetchOnChainBalance(creds.funderAddress)
      if (balance !== null) {
        method = 'on-chain-pusd'
      }
    }

    // 4. Jika semua gagal
    if (balance === null) {
      console.error('[Portfolio] All balance fetch methods failed')
      return NextResponse.json(
        {
          configured: true,
          balance: 0,
          error: 'Could not fetch balance — check Polygon RPC connectivity',
          method: 'failed',
        },
        { status: 200 } // return 200 agar UI tidak crash, tapi tampilkan 0
      )
    }

    const stats = {
      total_balance:     balance,
      available_balance: balance,
      total_value:       balance,
      total_pnl:         0,
      total_pnl_pct:     0,
      today_pnl:         0,
      today_trades:      0,
      win_rate:          0,
      open_positions:    0,
    }

    return NextResponse.json({
      configured: true,
      balance,
      stats,
      collateral: 'pUSD',  // informasi bahwa ini sudah V2
      timestamp:  new Date().toISOString(),
      method,
    })

  } catch (error: any) {
    console.error('[Portfolio] Global Error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch balance', details: error.message },
      { status: 500 }
    )
  }
}

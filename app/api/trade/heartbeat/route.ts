// app/api/trade/heartbeat/route.ts
// CLOB V2 — heartbeat endpoint unchanged

import { NextResponse } from 'next/server'
import { buildClobHeaders, resolveCredentials } from '@/lib/clob-auth'

const CLOB_HOST = 'https://clob.polymarket.com'

export async function POST(request: Request) {
  let clientCreds: any
  try {
    const raw = await request.text()
    if (raw.trim()) clientCreds = JSON.parse(raw)
  } catch { /* ignore */ }

  const creds = resolveCredentials(clientCreds)
  if (!creds) {
    return NextResponse.json({ error: 'No credentials configured' }, { status: 401 })
  }

  try {
    const path    = '/heartbeats'
    const headers = await buildClobHeaders(creds, 'POST', path, '')
    const res     = await fetch(`${CLOB_HOST}${path}`, {
      method: 'POST',
      headers,
    })

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: `Heartbeat failed: ${text}`, status: res.status }, { status: res.status })
    }

    return NextResponse.json({ success: true, timestamp: Date.now() })
  } catch (e: unknown) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

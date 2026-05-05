// app/api/health/route.ts
// Health check endpoint untuk Fly.io monitoring
import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    uptime:    process.uptime(),
  })
}

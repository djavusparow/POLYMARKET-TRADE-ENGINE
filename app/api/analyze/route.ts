import { NextRequest, NextResponse } from 'next/server'
import type { PolymarketMarket } from '@/lib/types'
import { analyzeMarket } from '@/lib/ai-engine'

export const runtime = 'nodejs' // Opsional, tapi pastikan menggunakan Node.js runtime untuk fetch

export async function POST(request: NextRequest) {
  const startTime = Date.now()
  console.log('[api/analyze] Request received at', new Date().toISOString())
  
  try {
    // 1. Parse Body dengan aman
    let body: any
    try {
      const text = await request.text()
      if (!text) {
        console.warn('[api/analyze] Empty request body')
        return NextResponse.json({ error: 'Empty request body' }, { status: 400 })
      }
      body = JSON.parse(text)
    } catch (parseError) {
      console.error('[api/analyze] Invalid JSON body:', parseError)
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    console.log('[api/analyze] Body keys:', Object.keys(body))
    
    const market: PolymarketMarket = body.market
    
    // 2. Validasi Input
    if (!market || !market.question) {
  console.warn('[api/analyze] Invalid market data', {
    hasMarket: !!market,
    hasQuestion: !!market?.question,
  })
  return NextResponse.json({ error: 'Invalid market data: Missing market or question' }, { status: 400 })
}

    console.log(`[api/analyze] Processing market: "${market.question.slice(0, 50)}..."`)
    
    // 3. Panggil Engine AI
    console.log('[api/analyze] Calling analyzeMarket...')
    const signal = await analyzeMarket(market)
    
    const duration = Date.now() - startTime
    console.log(`[api/analyze] Done in ${duration}ms. Confidence: ${signal.confidence}, Analyses: ${signal.analyses.length}`)
    
    return NextResponse.json({ signal })
    
  } catch (e: unknown) {
    const duration = Date.now() - startTime
    console.error(`[api/analyze] Error after ${duration}ms:`, e)
    
    const errorMessage = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json(
      { error: 'Analysis failed', details: errorMessage }, 
      { status: 500 }
    )
  }
}

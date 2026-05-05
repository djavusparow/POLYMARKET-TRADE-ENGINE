// app/api/crypto-signals/route.ts
// ✅ FIX v3:
// - You.com: model='smart', header='X-API-Key' (bukan Bearer), bukan 'gpt-4o-mini'
// - Tavily: dipakai sebagai NEWS ENRICHER bukan AI analyst (inject ke prompt LLM lain)
// - Gemini: update ke gemini-2.5-flash
// - Blackbox: ditambahkan sebagai provider LLM ke-5
// Analisis AI khusus untuk market BTC/ETH/SOL/DOGE/XRP Up/Down 5m & 15m

import { NextResponse } from 'next/server'
import {
  fetchAllCryptoUpDownMarkets,
  fetchAllCoinPrices,
  COIN_LABELS,
  COIN_SYMBOLS,
  type CryptoMarketInfo,
  type CryptoCoin,
} from '@/lib/crypto-markets'
import {
  buildUpDownPrompt,
  calcBiasScore,
  calcLiqScore,
  calcFundScore,
  calcSpreadScore,
  calcCompositeScore,
  type UpDownExtraData,
  type UpDownPromptParams,
} from '@/lib/ai-prompts'

// ─── Environment Variables ────────────────────────────────────────────────────
const YOUCOM_API_KEY      = process.env.YOUCOM_API_KEY      || ''
const TAVILY_API_KEY      = process.env.TAVILY_API_KEY      || ''
const GEMINI_API_KEY      = process.env.GEMINI_API_KEY      || ''
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY      || ''
const GROQ_API_KEY        = process.env.GROQ_API_KEY        || ''
const BLACKBOX_API_KEY    = process.env.BLACKBOX_API_KEY    || ''
const BLACKBOX_CUSTOMER_ID = process.env.BLACKBOX_CUSTOMER_ID || ''
const COINGLASS_API_KEY   = process.env.COINGLASS_API_KEY   || ''

// ─── Rate Limit Config ────────────────────────────────────────────────────────
const RATE_LIMIT_DELAYS: Record<string, { delayMs: number; maxRetries: number }> = {
  gemini:   { delayMs: 2_000, maxRetries: 3 },
  groq:     { delayMs: 1_500, maxRetries: 3 },
  youcom:   { delayMs: 1_000, maxRetries: 2 },
  openai:   { delayMs: 500,   maxRetries: 2 },
  blackbox: { delayMs: 1_000, maxRetries: 2 },
}

// ─── LLM Provider Config ──────────────────────────────────────────────────────
// Tavily DIHAPUS dari sini — dipakai sebagai news enricher (lihat fetchTavilyContext)
const LLM_PROVIDERS = [
  {
    name:     'youcom',
    type:     'youcom' as const,
    endpoint: 'https://api.you.com/v1/chat/completions',
    // ✅ FIX: model valid You.com adalah 'smart' atau 'research'
    model:    'smart',
    key:      YOUCOM_API_KEY,
    weight:   1.5,
  },
  {
    name:     'gemini',
    type:     'gemini' as const,
    // ✅ FIX: Update ke gemini-2.5-flash
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    model:    'gemini-2.5-flash',
    key:      GEMINI_API_KEY,
    weight:   1.4,
  },
  {
    name:     'openai',
    type:     'chat' as const,
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model:    'gpt-4o-mini',
    key:      OPENAI_API_KEY,
    weight:   1.2,
  },
  {
    name:     'groq',
    type:     'chat' as const,
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    model:    'llama-3.3-70b-versatile',
    key:      GROQ_API_KEY,
    weight:   1.0,
  },
  {
    name:     'blackbox',
    type:     'chat' as const,
    endpoint: 'https://api.blackbox.ai/chat/completions',
    // ✅ PERTAHANKAN: format ini yang terbukti jalan dan membaca credit
    model:    'blackboxai/anthropic/claude-sonnet-4.5',
    key:      BLACKBOX_API_KEY,
    weight:   1.0,
  },
].filter(p => p.key)

// ─── Logging Helper ───────────────────────────────────────────────────────────
function log(level: 'info' | 'warn' | 'error', msg: string, data?: any): void {
  const prefix = `[crypto-signals]`
  if (data) {
    console[level](prefix, msg, typeof data === 'object' ? JSON.stringify(data).slice(0, 300) : data)
  } else {
    console[level](prefix, msg)
  }
}

// ─── Fetch Binance Order Book ─────────────────────────────────────────────────
async function fetchBinanceDepth(symbol: string): Promise<{
  bidAskRatio: number; spreadPct: number; bidVolume: number; askVolume: number
} | null> {
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=20`,
      { signal: AbortSignal.timeout(5_000) }
    )
    if (!res.ok) return null
    const data = await res.json()
    const totalBid = data.bids.reduce((s: number, b: string[]) => s + parseFloat(b[1]), 0)
    const totalAsk = data.asks.reduce((s: number, a: string[]) => s + parseFloat(a[1]), 0)
    const bestBid  = parseFloat(data.bids[0][0])
    const bestAsk  = parseFloat(data.asks[0][0])
    const spread   = ((bestAsk - bestBid) / bestBid) * 100
    return { bidAskRatio: totalBid / totalAsk, spreadPct: spread, bidVolume: totalBid, askVolume: totalAsk }
  } catch { return null }
}

// ─── Fetch Funding Rate ───────────────────────────────────────────────────────
async function fetchFundingRate(symbol: string): Promise<{
  rate: number; nextFundingMs: number
} | null> {
  try {
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`,
      { signal: AbortSignal.timeout(5_000) }
    )
    if (!res.ok) return null
    const data = await res.json()
    if (!data?.[0]) return null
    return { rate: parseFloat(data[0].fundingRate), nextFundingMs: (data[0].fundingTime ?? Date.now() + 28_800_000) - Date.now() }
  } catch { return null }
}

// ─── Fetch Fear & Greed ──────────────────────────────────────────────────────
async function fetchFearGreed(): Promise<{ value: number; classification: string } | null> {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1', { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return null
    const data = await res.json()
    const item = data?.data?.[0]
    return item ? { value: parseInt(item.value), classification: item.value_classification } : null
  } catch { return null }
}

// ─── Fetch CoinGecko Global ──────────────────────────────────────────────────
async function fetchGlobalMarketData(): Promise<{
  btcDominance: number; totalMarketCap: number; totalVolume: number
} | null> {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/global', { signal: AbortSignal.timeout(6_000) })
    if (!res.ok) return null
    const d = (await res.json())?.data
    return d ? { btcDominance: d.market_cap_percentage?.btc ?? 0, totalMarketCap: d.total_market_cap?.usd ?? 0, totalVolume: d.total_volume?.usd ?? 0 } : null
  } catch { return null }
}

// ─── Fetch Liquidation Data ──────────────────────────────────────────────────
const COINGLASS_SYMBOL_MAP: Record<CryptoCoin, string> = { btc: 'BTC', eth: 'ETH', sol: 'SOL', doge: 'DOGE', xrp: 'XRP' }

async function fetchLiqData(coin: CryptoCoin): Promise<{
  longLiqUsd: number; shortLiqUsd: number; imbalance: number
} | null> {
  if (!COINGLASS_API_KEY) return null
  try {
    const symbol = COINGLASS_SYMBOL_MAP[coin]
    const res = await fetch(
      `https://api.coinglass.com/api/v1/liquidation?symbol=${symbol}&timeType=1h`,
      { headers: { 'coinglassSecret': COINGLASS_API_KEY }, signal: AbortSignal.timeout(5_000) }
    )
    if (!res.ok) return null
    const data = await res.json()
    const long  = data.data?.long?.reduce?.((s: number, v: any) => s + (v.amountUsd ?? 0), 0) ?? 0
    const short = data.data?.short?.reduce?.((s: number, v: any) => s + (v.amountUsd ?? 0), 0) ?? 0
    const total = long + short
    return { longLiqUsd: long, shortLiqUsd: short, imbalance: total > 0 ? (long - short) / total : 0 }
  } catch { return null }
}

const BINANCE_FUTURES_MAP: Record<CryptoCoin, string> = { btc: 'BTCUSDT', eth: 'ETHUSDT', sol: 'SOLUSDT', doge: 'DOGEUSDT', xrp: 'XRPUSDT' }

// ─── Build extra data ────────────────────────────────────────────────────────
async function buildExtraData(coin: CryptoCoin): Promise<UpDownExtraData | null> {
  const symbol = BINANCE_FUTURES_MAP[coin]
  const [depth, funding, liq] = await Promise.all([
    fetchBinanceDepth(symbol), fetchFundingRate(symbol), fetchLiqData(coin),
  ])
  if (!depth && !funding && !liq) return null
  return {
    bidAskRatio:   depth?.bidAskRatio  ?? 1.0,
    spreadPct:     depth?.spreadPct    ?? 0.05,
    bidVolume:     depth?.bidVolume    ?? 0,
    askVolume:     depth?.askVolume    ?? 0,
    longLiqUsd:    liq?.longLiqUsd    ?? 0,
    shortLiqUsd:   liq?.shortLiqUsd   ?? 0,
    liqImbalance:  liq?.imbalance     ?? 0,
    fundingRate:   funding?.rate      ?? 0,
    nextFundingMs: funding?.nextFundingMs ?? 28_800_000,
    biasScore:     calcBiasScore(depth?.bidAskRatio ?? 1.0),
    liqScore:      calcLiqScore(liq?.imbalance ?? 0),
    fundScore:     calcFundScore(funding?.rate ?? 0),
    spreadScore:   calcSpreadScore(depth?.spreadPct ?? 0.05),
  }
}

// ─── Tavily sebagai NEWS ENRICHER (bukan AI analyst) ─────────────────────────
// Hasilnya di-inject ke dalam prompt sebagai context tambahan untuk LLM lain
async function fetchTavilyContext(coin: string, window: string): Promise<string> {
  if (!TAVILY_API_KEY) return ''
  try {
    const query = `${coin} cryptocurrency price prediction ${window} short term market signal`
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        search_depth:        'basic',
        include_answer:      true,
        max_results:         3,
        include_raw_content: false,
      }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      log('warn', `[tavily-news] HTTP ${res.status} — skipping`)
      return ''
    }

    const data = await res.json()
    const parts: string[] = []
    if (data?.answer) parts.push(`Web Summary: ${data.answer}`)
    if (Array.isArray(data?.results)) {
      data.results.slice(0, 3).forEach((r: any) => {
        if (r.title && r.snippet) parts.push(`- ${r.title}: ${r.snippet.slice(0, 120)}`)
      })
    }
    const result = parts.join('\n')
    if (!result.trim()) return ''
    log('info', `[tavily-news] ✅ Got context for ${coin} ${window}`)
    return `\n\nWEB CONTEXT (Tavily):\n${result}`
  } catch (e) {
    log('warn', `[tavily-news] Error: ${e instanceof Error ? e.message : 'timeout'}`)
    return ''
  }
}

// ─── Universal text-to-signal parser ─────────────────────────────────────────
function parseSignalFromText(text: string, providerName: string): any | null {
  if (!text.trim()) return null
  let jsonStr = text.trim()
  const fenced = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fenced) jsonStr = fenced[1]
  const first = jsonStr.indexOf('{')
  const last  = jsonStr.lastIndexOf('}')
  if (first !== -1 && last !== -1) jsonStr = jsonStr.substring(first, last + 1)
  try {
    const parsed = JSON.parse(jsonStr)
    if (!parsed.signal || !['BUY', 'SELL', 'HOLD'].includes(parsed.signal)) return null
    if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 100) return null
    return parsed
  } catch {
    const signal = text.match(/"signal"\s*:\s*"(BUY|SELL|HOLD)"/i)?.[1]
    const confidence = parseFloat(text.match(/"confidence"\s*:\s*(\d+)/i)?.[1] ?? '')
    if (!signal || isNaN(confidence)) return null
    return { signal, confidence }
  }
}

// ─── Call You.com ─────────────────────────────────────────────────────────────
// ✅ FIX: model='smart', header='X-API-Key'
async function callYouCom(provider: typeof LLM_PROVIDERS[number], prompt: string): Promise<any | null> {
  if (!provider.key) return null
  const config = RATE_LIMIT_DELAYS.youcom

  for (let attempt = 0; attempt < config.maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, config.delayMs))
    }
    try {
      log('info', `[youcom] Attempt ${attempt + 1} / ${config.maxRetries}...`)
      const res = await fetch(provider.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // ✅ FIX: You.com menggunakan X-API-Key bukan Authorization Bearer
          'X-API-Key': provider.key,
        },
        body: JSON.stringify({
          // ✅ FIX: 'smart' adalah model valid You.com
          model: 'smart',
          messages: [
            { role: 'system', content: prompt },
            { role: 'user',   content: 'Analyze this market and provide your trading signal as JSON.' },
          ],
          temperature: 0.3,
          max_tokens:  800,
        }),
        signal: AbortSignal.timeout(60_000),
      })

      if (res.status === 401 || res.status === 403) {
        log('warn', `[youcom] HTTP ${res.status} — API key invalid`)
        return null
      }
      if (res.status === 404) {
        log('warn', `[youcom] HTTP 404 — endpoint not found`)
        return null
      }
      if (res.status === 429) {
        log('warn', `[youcom] HTTP 429 (attempt ${attempt + 1}) — rate limited`)
        continue
      }
      if (!res.ok) {
        const txt = await res.text()
        log('warn', `[youcom] HTTP ${res.status}: ${txt.slice(0, 150)}`)
        continue
      }

      const data = await res.json()
      const raw  = data?.choices?.[0]?.message?.content ?? ''
      if (!raw) { log('warn', '[youcom] Empty response'); continue }

      const parsed = parseSignalFromText(raw, 'youcom')
      if (!parsed) { log('warn', '[youcom] Could not parse response'); continue }

      log('info', `[youcom] ✅ ${parsed.signal} conf:${parsed.confidence}`)
      return { ...parsed, provider: 'youcom', weight: provider.weight }
    } catch (e) {
      log('warn', `[youcom] error: ${e instanceof Error ? e.message : 'timeout'}`)
      continue
    }
  }

  log('warn', '[youcom] ❌ All retries failed')
  return null
}

// ─── Call Gemini ──────────────────────────────────────────────────────────────
// ✅ FIX: update ke gemini-2.5-flash, delay lebih panjang untuk free tier
async function callGemini(provider: typeof LLM_PROVIDERS[number], prompt: string): Promise<any | null> {
  if (!provider.key) return null

  const delays = [0, 15_000, 30_000]

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      log('info', `[gemini] Waiting ${delays[attempt] / 1000}s before retry ${attempt + 1}/3...`)
      await new Promise(r => setTimeout(r, delays[attempt]))
    }

    try {
      const url = `${provider.endpoint}?key=${provider.key}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt.slice(0, 2000) }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 600 },
        }),
        signal: AbortSignal.timeout(20_000),
      })

      if (res.status === 429) {
        log('warn', `[gemini] HTTP 429 (attempt ${attempt + 1}) — rate limited`)
        if (attempt >= 2) { log('warn', '[gemini] ❌ All retries exhausted'); return null }
        continue
      }

      if (!res.ok) {
        const txt = await res.text()
        log('warn', `[gemini] HTTP ${res.status}: ${txt.slice(0, 150)} — skipping`)
        return null
      }

      const data = await res.json()
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
      if (!text) return null

      const parsed = parseSignalFromText(text, 'gemini')
      if (!parsed) return null

      log('info', `[gemini] ✅ ${parsed.signal} conf:${parsed.confidence}`)
      return { ...parsed, provider: 'gemini', weight: provider.weight }
    } catch (e) {
      log('warn', `[gemini] error: ${e instanceof Error ? e.message : 'timeout'}`)
      if (attempt >= 2) return null
    }
  }

  return null
}

// ─── Call Blackbox ────────────────────────────────────────────────────────────
async function callBlackbox(provider: typeof LLM_PROVIDERS[number], prompt: string): Promise<any | null> {
  if (!provider.key) return null
  const config = RATE_LIMIT_DELAYS.blackbox

  for (let attempt = 0; attempt < config.maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, config.delayMs * Math.pow(2, attempt)))
    }
    try {
      log('info', `[blackbox] Attempt ${attempt + 1}...`)
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.key}`,
      }
      if (BLACKBOX_CUSTOMER_ID) {
        headers['customerId'] = BLACKBOX_CUSTOMER_ID
        headers['anthropic-version'] = '2023-06-01'
      }

      const res = await fetch(provider.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model:    provider.model,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user',   content: 'Analyze this market and provide your trading signal as JSON.' },
          ],
          temperature: 0.3,
          max_tokens:  800,
        }),
        signal: AbortSignal.timeout(45_000),
      })

      if (res.status === 429) { log('warn', `[blackbox] HTTP 429 (attempt ${attempt + 1})`); continue }
      if (!res.ok) {
        const txt = await res.text()
        log('warn', `[blackbox] HTTP ${res.status}: ${txt.slice(0, 150)}`)
        return null
      }

      const data   = await res.json()
      const raw    = data?.choices?.[0]?.message?.content ?? ''
      const parsed = parseSignalFromText(raw, 'blackbox')
      if (!parsed) { log('warn', '[blackbox] Could not parse response'); return null }

      log('info', `[blackbox] ✅ ${parsed.signal} conf:${parsed.confidence}`)
      return { ...parsed, provider: 'blackbox', weight: provider.weight }
    } catch (e) {
      log('warn', `[blackbox] error: ${e instanceof Error ? e.message : 'timeout'}`)
      continue
    }
  }
  return null
}

// ─── Call AI (OpenAI-compatible) ─────────────────────────────────────────────
async function callAI(provider: typeof LLM_PROVIDERS[number], prompt: string): Promise<any | null> {
  if (!provider.key) return null

  if (provider.name === 'gemini')   return callGemini(provider, prompt)
  if (provider.name === 'youcom')   return callYouCom(provider, prompt)
  if (provider.name === 'blackbox') return callBlackbox(provider, prompt)

  // OpenAI-compatible (openai, groq)
  const config = RATE_LIMIT_DELAYS[provider.name] ?? RATE_LIMIT_DELAYS.openai

  for (let attempt = 0; attempt < config.maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = config.delayMs * Math.pow(2, attempt)
      await new Promise(r => setTimeout(r, delay))
    }
    try {
      log('info', `[${provider.name}] Calling ${(provider as any).model}...`)
      const res = await fetch(provider.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${provider.key}`,
        },
        body: JSON.stringify({
          model:    (provider as any).model,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user',   content: 'Analyze this market and provide your trading signal as JSON.' },
          ],
          temperature: 0.3,
          max_tokens:  800,
        }),
        signal: AbortSignal.timeout(30_000),
      })
      if (res.status === 429) { log('warn', `${provider.name} HTTP 429 (attempt ${attempt + 1})`); continue }
      if (!res.ok) { log('warn', `${provider.name} HTTP ${res.status}`); return null }
      const data   = await res.json()
      const raw    = data?.choices?.[0]?.message?.content ?? ''
      const parsed = parseSignalFromText(raw, provider.name)
      if (!parsed) return null
      log('info', `${provider.name} ✅ ${parsed.signal} conf:${parsed.confidence}`)
      return { ...parsed, provider: provider.name, weight: provider.weight }
    } catch (e: unknown) { log('warn', `${provider.name} error: ${e instanceof Error ? e.message : 'timeout'}`); continue }
  }
  return null
}

// ─── Weighted Ensemble ────────────────────────────────────────────────────────
function weightedEnsembleUpDown(results: any[]): {
  direction: 'BUY' | 'SELL' | 'HOLD'
  confidence: number
  recommendedSide: 'YES' | 'NO'
  avgEdge: number
  compositeScore: number | null
} {
  const valid = results.filter(Boolean)
  if (valid.length === 0) {
    return { direction: 'HOLD', confidence: 0, recommendedSide: 'YES', avgEdge: 0, compositeScore: null }
  }

  let buyScore = 0, sellScore = 0, totalWeight = 0
  for (const r of valid) {
    const weight = (r.weight ?? 1.0) * (r.confidence / 100)
    if (r.signal === 'BUY')  buyScore  += weight
    if (r.signal === 'SELL') sellScore += weight
    totalWeight += weight
  }

  const dominantScore  = Math.max(buyScore, sellScore)
  const totalScore     = buyScore + sellScore
  const consensusRatio = totalScore > 0 ? dominantScore / totalScore : 0

  const edgeValues = valid.map(r => r.edge).filter((e: any) => typeof e === 'number' && !isNaN(e))
  const avgEdge    = edgeValues.length > 0
    ? edgeValues.reduce((s: number, e: number) => s + Math.abs(e), 0) / edgeValues.length
    : 0

  const avgConf      = valid.reduce((s: number, r: any) => s + r.confidence, 0) / valid.length
  const weightedConf = Math.round(totalWeight > 0 ? (dominantScore / totalWeight) * 100 : avgConf)
  const MIN_EDGE     = 0.08

  log('info', `[ensemble] buy:${buyScore.toFixed(2)} sell:${sellScore.toFixed(2)} consensus:${(consensusRatio*100).toFixed(0)}% avgEdge:${(avgEdge*100).toFixed(1)}%`)

  if (buyScore > sellScore && consensusRatio > 0.55) {
    if (avgEdge < MIN_EDGE) {
      log('info', `[ensemble] BUY filtered: edge ${(avgEdge*100).toFixed(1)}% < ${(MIN_EDGE*100).toFixed(0)}% → HOLD`)
      return { direction: 'HOLD', confidence: Math.round(weightedConf * 0.6), recommendedSide: 'YES', avgEdge, compositeScore: null }
    }
    return { direction: 'BUY', confidence: weightedConf, recommendedSide: 'YES', avgEdge, compositeScore: null }
  }

  if (sellScore > buyScore && consensusRatio > 0.55) {
    if (avgEdge < MIN_EDGE) {
      log('info', `[ensemble] SELL filtered: edge ${(avgEdge*100).toFixed(1)}% < ${(MIN_EDGE*100).toFixed(0)}% → HOLD`)
      return { direction: 'HOLD', confidence: Math.round(weightedConf * 0.6), recommendedSide: 'NO', avgEdge, compositeScore: null }
    }
    return { direction: 'SELL', confidence: weightedConf, recommendedSide: 'NO', avgEdge, compositeScore: null }
  }

  return { direction: 'HOLD', confidence: Math.round(weightedConf * 0.5), recommendedSide: 'YES', avgEdge, compositeScore: null }
}

// ─── Analyze single market (SEQUENTIAL providers) ─────────────────────────────
async function analyzeUpDownMarket(
  info: CryptoMarketInfo,
  coinPrices: Awaited<ReturnType<typeof fetchAllCoinPrices>>,
  fearGreed:  Awaited<ReturnType<typeof fetchFearGreed>>,
  globalData: Awaited<ReturnType<typeof fetchGlobalMarketData>>
): Promise<any> {
  const priceData = coinPrices[info.coin]
  const price     = priceData?.price ?? 0

  log('info', `Fetching extra data for ${info.coin} ${info.window}...`)

  // Fetch extra data + Tavily news context secara paralel
  const [extraData, tavilyContext] = await Promise.all([
    buildExtraData(info.coin),
    fetchTavilyContext(COIN_SYMBOLS[info.coin], info.window),
  ])

  if (extraData) {
    log('info', `Extra data OK: bias=${extraData.biasScore.toFixed(2)} liq=${extraData.liqScore.toFixed(2)} fund=${extraData.fundScore.toFixed(2)} spread=${extraData.spreadScore.toFixed(2)}`)
  } else {
    log('warn', 'No extra data available — using basic prompt fallback')
  }

  const promptParams: UpDownPromptParams = {
    coin:          info.coin,
    coinSymbol:    COIN_SYMBOLS[info.coin],
    coinLabel:     COIN_LABELS[info.coin],
    window:        info.window,
    currentPrice:  price,
    change24h:     priceData?.change24h ?? null,
    high24h:       priceData?.high24h   ?? null,
    low24h:        priceData?.low24h    ?? null,
    volume24h:     priceData?.volume24h ?? null,
    yesPrice:      info.yesPrice,
    noPrice:       info.noPrice,
    fearGreedValue:  fearGreed?.value ?? null,
    fearGreedLabel:  fearGreed?.classification ?? null,
    btcDominance:    globalData?.btcDominance ?? null,
    secondsLeft:     info.secondsLeft,
    // Inject Tavily context sebagai newsContext ke dalam prompt
    newsContext:     tavilyContext || undefined,
    extraData:       extraData ?? undefined,
  }

  const prompt = buildUpDownPrompt(promptParams)

  // ✅ Panggil LLM provider SEQUENTIAL dengan delay antar provider
  const results: any[] = []
  let successCount = 0
  let failCount    = 0

  for (const provider of LLM_PROVIDERS) {
    // Delay 1.5 detik antar provider untuk menghindari rate limit
    if (results.length > 0) {
      await new Promise(r => setTimeout(r, 1_500))
    }
    const result = await callAI(provider, prompt)
    if (result) {
      results.push(result)
      successCount++
    } else {
      failCount++
    }
  }

  if (results.length === 0) {
    return {
      coin:      info.coin,
      coinLabel: COIN_LABELS[info.coin],
      window:    info.window,
      slug:      info.slug,
      signal:    'HOLD',
      confidence: 0,
      error:     'No AI providers available or all returned no result',
      extraData: extraData ? { compositeScore: calcCompositeScore(extraData), ...extraData } : null,
    }
  }

  log('info', `[${info.coin} ${info.window}] Providers: ${successCount} success, ${failCount} failed`)

  const ensemble    = weightedEnsembleUpDown(results)
  const bestAnalysis = results[0]

  return {
    coin:            info.coin,
    coinLabel:       COIN_LABELS[info.coin],
    window:          info.window,
    slug:            info.slug,
    market_id:       info.market?.id ?? null,
    signal:          ensemble.direction,
    confidence:      ensemble.confidence,
    recommendedSide: ensemble.recommendedSide,
    yesPrice:        info.yesPrice,
    noPrice:         info.noPrice,
    currentPrice:    price,
    change24h:       priceData?.change24h ?? null,
    secondsLeft:     info.secondsLeft,
    // ✅ FIX: marketExpiryMs adalah Unix ms dari end_date_iso Polymarket — sumber kebenaran countdown
    marketExpiryMs:  info.marketExpiryMs ?? null,
    edge:            ensemble.avgEdge,
    rationale:       bestAnalysis?.rationale ?? '',
    keyRisk:         bestAnalysis?.keyRisk   ?? '',
    analyses:        results.length,
    providers:       results.map(r => ({ name: r.provider, signal: r.signal, confidence: r.confidence })),
    extraData: extraData ? {
      compositeScore: calcCompositeScore(extraData),
      biasScore:   extraData.biasScore,
      liqScore:    extraData.liqScore,
      fundScore:   extraData.fundScore,
      spreadScore: extraData.spreadScore,
    } : null,
    timestamp: Date.now(),
    active:    info.active,
  }
}

// ─── GET /api/crypto-signals ──────────────────────────────────────────────────
export async function GET() {
  const startTime = Date.now()
  log('info', `Starting crypto-signals analysis... LLM providers active: ${LLM_PROVIDERS.length}`)
  if (TAVILY_API_KEY) log('info', 'Tavily: active as news enricher (not LLM analyst)')

  try {
    const [markets, coinPrices, fearGreed, globalData] = await Promise.all([
      fetchAllCryptoUpDownMarkets(),
      fetchAllCoinPrices(),
      fetchFearGreed(),
      fetchGlobalMarketData(),
    ])

    log('info', `Data fetched: ${markets.length} markets, ${Object.values(coinPrices).filter(Boolean).length} coin prices`)

    const activeMarkets = markets.filter(m => m.active && m.market !== null)

    if (activeMarkets.length === 0) {
      log('info', 'No active up/down markets found')
      return NextResponse.json({
        signals:     [],
        message:     'No active up/down markets found. Markets may be between windows.',
        activeCount: 0,
        timestamp:   Date.now(),
        elapsedMs:   Date.now() - startTime,
      })
    }

    log('info', `Analyzing ${activeMarkets.length} active markets with ${LLM_PROVIDERS.length} LLM providers...`)

    // Sequential analysis — 2 detik antar market untuk menghindari rate limit
    const signals: any[] = []
    for (let i = 0; i < activeMarkets.length; i++) {
      const market = activeMarkets[i]
      const sig    = await analyzeUpDownMarket(market, coinPrices, fearGreed, globalData)
      signals.push(sig)
      log('info', `Progress: ${i + 1}/${activeMarkets.length} markets analyzed`)
      if (i < activeMarkets.length - 1) {
        await new Promise(r => setTimeout(r, 2_000))
      }
    }

    signals.sort((a, b) => {
      if (a.signal === 'HOLD' && b.signal !== 'HOLD') return 1
      if (a.signal !== 'HOLD' && b.signal === 'HOLD') return -1
      return b.confidence - a.confidence
    })

    const elapsed = Date.now() - startTime
    log('info', `Done in ${elapsed}ms. Signals: ${signals.filter(s => s.signal !== 'HOLD').length} actionable`)

    return NextResponse.json({
      signals,
      summary: {
        total:      activeMarkets.length,
        actionable: signals.filter(s => s.signal !== 'HOLD').length,
        bulls:      signals.filter(s => s.signal === 'BUY').length,
        bears:      signals.filter(s => s.signal === 'SELL').length,
        holds:      signals.filter(s => s.signal === 'HOLD').length,
      },
      fearGreed: fearGreed ? { value: fearGreed.value, classification: fearGreed.classification } : null,
      globalData: globalData ? {
        btcDominance:   globalData.btcDominance.toFixed(1) + '%',
        totalMarketCap: '$' + (globalData.totalMarketCap / 1e12).toFixed(2) + 'T',
      } : null,
      activeCount: activeMarkets.length,
      providers:   LLM_PROVIDERS.map(p => p.name),
      timestamp:   Date.now(),
      elapsedMs:   elapsed,
    })

  } catch (e: unknown) {
    log('error', `Error: ${e instanceof Error ? e.message : String(e)}`)
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), timestamp: Date.now() }, { status: 500 })
  }
}
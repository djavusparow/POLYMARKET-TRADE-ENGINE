// lib/ai-engine.ts
// ✅ FIX v3:
// - You.com: model 'smart', header 'X-API-Key' (bukan Bearer)
// - Tavily: dipakai sebagai NEWS ENRICHER, bukan AI analyst
// - Gemini: update ke gemini-2.5-flash
// - Blackbox: model 'blackboxai/anthropic/claude-sonnet-4.5' (sudah terbukti jalan)

import type {
  PolymarketMarket,
  AIAnalysis,
  CombinedSignal,
  AIModel,
  SignalDirection,
} from './types'
import { parseOutcomePrice } from './polymarket'
import { selectPromptForMarket, detectMarketCategory } from './ai-prompts'

// ─── ENVIRONMENT VARIABLES ────────────────────────────────────────────────────
const NEWS_API_KEY          = process.env.NEWSAPI_KEY            || ''
const BLACKBOX_API_KEY      = process.env.BLACKBOX_API_KEY       || ''
const BLACKBOX_CUSTOMER_ID  = process.env.BLACKBOX_CUSTOMER_ID   || ''
const OPENAI_API_KEY        = process.env.OPENAI_API_KEY         || ''
const GROQ_API_KEY          = process.env.GROQ_API_KEY           || ''
const YOUCOM_API_KEY        = process.env.YOUCOM_API_KEY         || ''
const TAVILY_API_KEY        = process.env.TAVILY_API_KEY         || ''
const GEMINI_API_KEY        = process.env.GEMINI_API_KEY         || ''

// ─── RATE LIMIT CONFIG ────────────────────────────────────────────────────────
const RATE_LIMITS: Record<string, { maxConcurrent: number; delayMs: number; maxRetries: number }> = {
  gemini:  { maxConcurrent: 1, delayMs: 2_000, maxRetries: 3 },
  groq:    { maxConcurrent: 2, delayMs: 1_500, maxRetries: 3 },
  youcom:  { maxConcurrent: 2, delayMs: 1_000, maxRetries: 2 },
  openai:  { maxConcurrent: 3, delayMs: 500,   maxRetries: 2 },
  blackbox:{ maxConcurrent: 2, delayMs: 1_000, maxRetries: 2 },
}

// ─── LLM PROVIDERS (semua OpenAI-compatible chat, TIDAK termasuk Tavily) ──────
// Tavily dipisah sebagai news enricher (lihat fetchTavilyNews)
const LLM_PROVIDERS = [
  {
    name:      'youcom' as AIModel,
    endpoint:  'https://api.you.com/v1/chat/completions',
    // ✅ FIX: You.com model yang valid adalah 'smart' atau 'research'
    model:     'smart',
    // ✅ FIX: You.com pakai header 'X-API-Key', bukan 'Authorization: Bearer'
    keyHeader: 'X-API-Key',
    keyPrefix: '',
    key:       YOUCOM_API_KEY,
    weight:    1.5,
    timeout:   60_000,
  },
  {
    name:      'gemini' as AIModel,
    // ✅ FIX: Update ke gemini-2.5-flash (lebih stabil, lebih murah, lebih pintar)
    endpoint:  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    model:     'gemini-2.5-flash',
    keyHeader: 'x-goog-api-key',
    keyPrefix: '',
    key:       GEMINI_API_KEY,
    weight:    1.4,
    timeout:   45_000,
  },
  {
    name:      'openai' as AIModel,
    endpoint:  'https://api.openai.com/v1/chat/completions',
    model:     'gpt-4o-mini',
    keyHeader: 'Authorization',
    keyPrefix: 'Bearer ',
    key:       OPENAI_API_KEY,
    weight:    1.2,
    timeout:   45_000,
  },
  {
    name:      'groq' as AIModel,
    endpoint:  'https://api.groq.com/openai/v1/chat/completions',
    model:     'llama-3.3-70b-versatile',
    keyHeader: 'Authorization',
    keyPrefix: 'Bearer ',
    key:       GROQ_API_KEY,
    weight:    1.0,
    timeout:   30_000,
  },
  {
    name:      'blackbox' as AIModel,
    endpoint:  'https://api.blackbox.ai/chat/completions',
    // ✅ PERTAHANKAN: format ini yang terbukti jalan dan membaca credit
    model:     'blackboxai/anthropic/claude-sonnet-4.5',
    keyHeader: 'Authorization',
    keyPrefix: 'Bearer ',
    key:       BLACKBOX_API_KEY,
    weight:    1.0,
    timeout:   45_000,
  },
] as const

type Provider = typeof LLM_PROVIDERS[number]

// ─── MINIMUM EDGE THRESHOLD ──────────────────────────────────────────────────
const MIN_EDGE_BY_CATEGORY: Record<string, number> = {
  crypto:          0.12,
  political:       0.15,
  general:         0.10,
  'crypto-updown': 0.05,
}

// ─── Safe UUID ────────────────────────────────────────────────────────────────
function safeUUID(): string {
  try { return crypto.randomUUID() } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
}

// ─── NEWS FETCHING via NewsAPI ────────────────────────────────────────────────
async function fetchNews(query: string): Promise<string> {
  if (!NEWS_API_KEY) return ''
  try {
    const controller = new AbortController()
    const timeoutId  = setTimeout(() => controller.abort(), 10_000)
    const res = await fetch(
      `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&language=en&pageSize=3&apiKey=${NEWS_API_KEY}`,
      { signal: controller.signal }
    )
    clearTimeout(timeoutId)
    if (!res.ok) return ''
    const data = await res.json()
    if (!data.articles?.length) return ''
    const recent = data.articles
      .slice(0, 3)
      .map((a: any) => `- ${a.title} (${a.source?.name || 'Unknown'}, ${a.publishedAt?.slice(0, 10)})`)
      .join('\n')
    return `\n\nLATEST NEWS (last 48h):\n${recent}`
  } catch {
    return ''
  }
}

// ─── NEWS FETCHING via Tavily (sebagai enricher, bukan analyst) ───────────────
// Tavily dipakai HANYA untuk mengambil berita/konteks terbaru,
// hasilnya di-pass ke LLM lain sebagai context tambahan dalam prompt.
async function fetchTavilyNews(query: string): Promise<string> {
  if (!TAVILY_API_KEY) return ''
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query:               query.slice(0, 300),
        search_depth:        'basic',
        include_answer:      true,
        max_results:         3,
        include_raw_content: false,
      }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      console.log(`[fetchTavilyNews] HTTP ${res.status} — skipping`)
      return ''
    }

    const data = await res.json()

    // Gabungkan answer + snippet dari results
    const parts: string[] = []
    if (data?.answer) parts.push(`Summary: ${data.answer}`)
    if (Array.isArray(data?.results)) {
      data.results.slice(0, 3).forEach((r: any) => {
        if (r.title && r.snippet) parts.push(`- ${r.title}: ${r.snippet}`)
      })
    }

    const result = parts.join('\n')
    if (!result.trim()) return ''
    return `\n\nTAVILY WEB CONTEXT:\n${result}`
  } catch {
    return ''
  }
}

// ─── Universal text-to-AIAnalysis parser ──────────────────────────────────────
function parseSignalFromText(text: string, modelName: AIModel): AIAnalysis | null {
  if (!text.trim()) return null

  let jsonStr = text.trim()
  const fencedJson = jsonStr.match(/```json\s*([\s\S]*?)\s*```/)
  if (fencedJson) jsonStr = fencedJson[1]
  else {
    const first = jsonStr.indexOf('{')
    const last  = jsonStr.lastIndexOf('}')
    if (first !== -1 && last !== -1 && last > first) {
      jsonStr = jsonStr.substring(first, last + 1)
    }
  }

  let parsed: any
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    const fallback = (key: string) => {
      const m = text.match(new RegExp(`"${key}"\\s*:\\s*"?([^",}\\n]+)"?`, 'i'))
      return m ? m[1].trim() : undefined
    }
    const signal = fallback('signal') as SignalDirection | undefined
    const confidence = Number(fallback('confidence'))
    if (!signal || !['BUY', 'SELL', 'HOLD'].includes(signal) || isNaN(confidence)) return null
    parsed = { signal, confidence }
  }

  if (!parsed.signal || !['BUY', 'SELL', 'HOLD'].includes(parsed.signal)) return null
  if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 100) return null

  return {
    model:       modelName,
    signal:      parsed.signal as SignalDirection,
    confidence:  parsed.confidence,
    rationale:   String(parsed.rationale || ''),
    targetPrice: Number(parsed.targetPrice ?? parsed.target_price ?? 0.5),
    stopLoss:    Number(parsed.stopLoss ?? parsed.stop_loss_pct ?? 0.3),
    takeProfit:  Number(parsed.takeProfit ?? parsed.take_profit_pct ?? 0.8),
    timestamp:   Date.now(),
  } as AIAnalysis
}

// ─── Call Gemini API — dengan retry untuk 429 ─────────────────────────────────
async function callGemini(
  provider: Provider,
  systemPrompt: string,
  userContext: string
): Promise<AIAnalysis | null> {
  if (!provider.key?.trim()) return null

  const rateConfig = RATE_LIMITS.gemini

  for (let attempt = 0; attempt < rateConfig.maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = rateConfig.delayMs * Math.pow(2, attempt)
      console.log(`[callGemini] Retry ${attempt + 1}/${rateConfig.maxRetries} after ${delay}ms...`)
      await new Promise(r => setTimeout(r, delay))
    }

    try {
      const url = `${provider.endpoint}?key=${provider.key}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{ text: `${systemPrompt}\n\n${userContext}` }],
          }],
          generationConfig: {
            temperature:     0.3,
            maxOutputTokens: 800,
          },
        }),
        signal: AbortSignal.timeout(provider.timeout),
      })

      if (res.status === 429) {
        console.log(`[callGemini] HTTP 429 (attempt ${attempt + 1}) — rate limited`)
        continue
      }

      if (!res.ok) {
        const txt = await res.text()
        console.error(`[callGemini] HTTP ${res.status}: ${txt.slice(0, 150)}`)
        return null
      }
      const data = await res.json()
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
      return parseSignalFromText(text, 'gemini' as AIModel)
    } catch {
      continue
    }
  }

  console.log('[callGemini] ❌ All retries exhausted')
  return null
}

// ─── Call You.com API ─────────────────────────────────────────────────────────
// ✅ FIX: model='smart', header='X-API-Key' (bukan Bearer)
async function callYouCom(
  provider: Provider,
  systemPrompt: string,
  userContext: string
): Promise<AIAnalysis | null> {
  if (!provider.key?.trim()) return null

  const rateConfig = RATE_LIMITS.youcom

  for (let attempt = 0; attempt < rateConfig.maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, rateConfig.delayMs))
    }

    try {
      console.log(`[callYouCom] → ${provider.endpoint} (attempt ${attempt + 1})`)
      const res = await fetch(provider.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // ✅ FIX: You.com menggunakan X-API-Key, bukan Authorization: Bearer
          'X-API-Key': provider.key,
        },
        body: JSON.stringify({
          // ✅ FIX: model 'smart' adalah model valid You.com
          model: 'smart',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userContext },
          ],
          temperature: 0.3,
          max_tokens:  800,
        }),
        signal: AbortSignal.timeout(provider.timeout),
      })

      if (res.status === 401 || res.status === 403) {
        console.log(`[callYouCom] ❌ HTTP ${res.status} — API key invalid atau tidak aktif`)
        return null
      }

      if (res.status === 404) {
        console.log(`[callYouCom] ❌ HTTP 404 — endpoint tidak ditemukan`)
        return null
      }

      if (res.status === 429) {
        console.log(`[callYouCom] HTTP 429 (attempt ${attempt + 1}) — rate limited`)
        continue
      }

      if (!res.ok) {
        const txt = await res.text()
        console.log(`[callYouCom] HTTP ${res.status}: ${txt.slice(0, 150)}`)
        return null
      }

      const data = await res.json()
      const raw = data?.choices?.[0]?.message?.content ?? ''
      if (!raw) {
        console.log('[callYouCom] Empty response content')
        return null
      }
      return parseSignalFromText(raw, 'youcom' as AIModel)
    } catch (e) {
      console.log(`[callYouCom] error: ${e}`)
      continue
    }
  }

  console.log('[callYouCom] ❌ All retries exhausted')
  return null
}

// ─── Call LLM (OpenAI-compatible: openai, groq, blackbox) ────────────────────
async function callLLM(
  provider: Provider,
  systemPrompt: string,
  userContext: string
): Promise<AIAnalysis | null> {
  if (!provider.key?.trim()) return null

  // Rute ke handler spesifik
  if (provider.name === 'gemini') return callGemini(provider, systemPrompt, userContext)
  if (provider.name === 'youcom') return callYouCom(provider, systemPrompt, userContext)

  // OpenAI-compatible (openai, groq, blackbox)
  const rateConfig = RATE_LIMITS[provider.name] ?? RATE_LIMITS.openai

  for (let attempt = 0; attempt < rateConfig.maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = rateConfig.delayMs * Math.pow(2, attempt)
      await new Promise(r => setTimeout(r, delay))
    }

    try {
      console.log(`[callLLM] ${provider.name} → ${provider.model}`)

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        [provider.keyHeader]: `${provider.keyPrefix}${provider.key}`,
      }

      if (provider.name === 'blackbox' && BLACKBOX_CUSTOMER_ID) {
        headers['customerId'] = BLACKBOX_CUSTOMER_ID
        headers['anthropic-version'] = '2023-06-01'
      }

      const res = await fetch(provider.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: provider.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userContext },
          ],
          temperature: 0.3,
          max_tokens:  800,
        }),
        signal: AbortSignal.timeout(provider.timeout),
      })

      if (res.status === 429) {
        console.log(`[${provider.name}] HTTP 429 (attempt ${attempt + 1})`)
        continue
      }

      if (!res.ok) {
        const txt = await res.text()
        console.error(`[${provider.name}] ❌ HTTP ${res.status}: ${txt.slice(0, 150)}`)
        return null
      }

      const data = await res.json()
      const raw = data?.choices?.[0]?.message?.content ?? ''
      return parseSignalFromText(raw, provider.name as AIModel)
    } catch (err) {
      console.error(`[${provider.name}] ❌ Error:`, err)
      continue
    }
  }

  console.log(`[${provider.name}] ❌ All retries exhausted`)
  return null
}

// ─── WEIGHTED ENSEMBLE LOGIC ──────────────────────────────────────────────────
function weightedEnsemble(
  analyses: AIAnalysis[],
  marketPrice: number,
  category: string
): { direction: SignalDirection; confidence: number; recommendedSide: 'YES' | 'NO'; avgEdge: number } {
  const valid = analyses.filter(a => a.confidence > 0)
  if (!valid.length) return { direction: 'HOLD', confidence: 0, recommendedSide: 'YES', avgEdge: 0 }

  const providerWeights: Record<string, number> = {}
  LLM_PROVIDERS.forEach(p => { providerWeights[p.name] = p.weight })

  let buyScore    = 0
  let sellScore   = 0
  let totalWeight = 0

  for (const a of valid) {
    const weight = (providerWeights[a.model] ?? 1.0) * (a.confidence / 100)
    if (a.signal === 'BUY')  buyScore  += weight
    if (a.signal === 'SELL') sellScore += weight
    totalWeight += weight
  }

  const avgConf       = valid.reduce((s, a) => s + a.confidence, 0) / valid.length
  const dominantScore = Math.max(buyScore, sellScore)
  const totalScore    = buyScore + sellScore

  const edgeValues = valid
    .map(a => (a as any)._edge)
    .filter((e: any) => typeof e === 'number' && !isNaN(e))
  const avgEdge = edgeValues.length > 0
    ? edgeValues.reduce((s: number, e: number) => s + Math.abs(e), 0) / edgeValues.length
    : 0

  const minEdge        = MIN_EDGE_BY_CATEGORY[category] ?? 0.10
  const consensusRatio = totalScore > 0 ? dominantScore / totalScore : 0
  const weightedConf   = Math.round(totalWeight > 0 ? (dominantScore / totalWeight) * 100 : avgConf)

  console.log(`[ensemble] buy:${buyScore.toFixed(2)} sell:${sellScore.toFixed(2)} consensus:${(consensusRatio*100).toFixed(0)}% avgEdge:${avgEdge.toFixed(3)} minEdge:${minEdge}`)

  if (buyScore > sellScore && consensusRatio > 0.55) {
    if (edgeValues.length > 0 && avgEdge < minEdge) {
      console.log(`[ensemble] BUY filtered: avgEdge ${avgEdge.toFixed(3)} < minEdge ${minEdge}`)
      return { direction: 'HOLD', confidence: Math.round(weightedConf * 0.6), recommendedSide: 'YES', avgEdge }
    }
    return { direction: 'BUY', confidence: weightedConf, recommendedSide: 'YES', avgEdge }
  }

  if (sellScore > buyScore && consensusRatio > 0.55) {
    if (edgeValues.length > 0 && avgEdge < minEdge) {
      console.log(`[ensemble] SELL filtered: avgEdge ${avgEdge.toFixed(3)} < minEdge ${minEdge}`)
      return { direction: 'HOLD', confidence: Math.round(weightedConf * 0.6), recommendedSide: 'NO', avgEdge }
    }
    return { direction: 'SELL', confidence: weightedConf, recommendedSide: 'NO', avgEdge }
  }

  return { direction: 'HOLD', confidence: Math.round(weightedConf * 0.5), recommendedSide: 'YES', avgEdge }
}

// ─── DEFAULT SIGNAL ───────────────────────────────────────────────────────────
function getDefaultSignal(market: PolymarketMarket, yesPrice: number): CombinedSignal {
  return {
    market_id:       market.id,
    question:        market.question,
    direction:       'HOLD',
    confidence:      0,
    analyses:        [],
    yesPrice,
    noPrice:         1 - yesPrice,
    recommendedSide: 'YES',
    timestamp:       Date.now(),
  }
}

// ─── MAIN ANALYSIS FUNCTION ───────────────────────────────────────────────────
export async function analyzeMarket(market: PolymarketMarket): Promise<CombinedSignal> {
  const startTime = Date.now()
  console.log(`[analyzeMarket] Starting: ${market.question.slice(0, 60)}...`)

  const yesPrice = parseOutcomePrice(market.outcomePrices)
  const category = detectMarketCategory(market.question, market.category)

  if (yesPrice <= 0.04 || yesPrice >= 0.96) {
    console.log(`[analyzeMarket] SKIP: price extreme ${(yesPrice*100).toFixed(0)}%`)
    return getDefaultSignal(market, yesPrice)
  }

  // SKIP crypto up/down — ditangani /api/crypto-signals
  if (category === 'crypto-updown') {
    console.log(`[analyzeMarket] SKIP: crypto-updown (use /api/crypto-signals instead)`)
    return getDefaultSignal(market, yesPrice)
  }

  try {
    // 1. Fetch berita dari NewsAPI + Tavily secara paralel (keduanya sebagai context)
    const [newsApiContext, tavilyContext] = await Promise.all([
      fetchNews(market.question),
      fetchTavilyNews(market.question),
    ])
    const combinedNews = [newsApiContext, tavilyContext].filter(Boolean).join('\n')

    // 2. Siapkan provider aktif (hanya LLM, tidak termasuk Tavily)
    const activeProviders = [...LLM_PROVIDERS].filter(p => p.key?.trim())
    if (activeProviders.length === 0) {
      console.error('[analyzeMarket] ❌ No API keys configured!')
      return getDefaultSignal(market, yesPrice)
    }

    console.log(`[analyzeMarket] LLM Providers: ${activeProviders.map(p => p.name).join(', ')} | Category: ${category}`)
    if (combinedNews) console.log(`[analyzeMarket] News context: ${combinedNews.slice(0, 80)}...`)

    // 3. Build system prompt — inject Tavily + NewsAPI context
    const systemPrompt = selectPromptForMarket({
      question:    market.question,
      yesPrice,
      noPrice:     1 - yesPrice,
      volume24hr:  market.volume24hr,
      liquidity:   market.liquidity,
      endDate:     market.end_date_iso,
      category:    market.category,
      description: market.description,
    })

    // 4. Build user context — tambahkan combined news
    const userContext = `Market ID: ${market.id}
Category: ${category}
Current YES: ${(yesPrice * 100).toFixed(1)}% | NO: ${((1-yesPrice) * 100).toFixed(1)}%
24h Volume: $${(market.volume24hr || 0).toLocaleString()}
Liquidity: $${(market.liquidity || 0).toLocaleString()}
${market.end_date_iso ? `Days to Resolution: ${Math.ceil((new Date(market.end_date_iso).getTime() - Date.now()) / 86400000)}` : ''}
${market.description ? `Context: ${market.description.slice(0, 200)}` : ''}
${combinedNews}

Respond ONLY with the JSON format specified in your instructions.`

    // 5. Jalankan LLM SEQUENTIAL dengan delay untuk menghindari rate limit
    const analyses: AIAnalysis[] = []
    for (const provider of activeProviders) {
      await new Promise(r => setTimeout(r, 500))
      const result = await callLLM(provider, systemPrompt, userContext)
      if (result) {
        analyses.push(result)
        console.log(`[analyzeMarket] ✅ ${provider.name}: ${result.signal} ${result.confidence}%`)
      } else {
        console.log(`[analyzeMarket] ❌ ${provider.name}: no result`)
      }
    }

    console.log(`[analyzeMarket] Done in ${Date.now() - startTime}ms. Success: ${analyses.length}/${activeProviders.length}`)

    if (analyses.length === 0) return getDefaultSignal(market, yesPrice)

    // 6. Weighted ensemble + edge filter
    const ensembleResult = weightedEnsemble(analyses, yesPrice, category)

    return {
      market_id:       market.id,
      question:        market.question,
      direction:       ensembleResult.direction,
      confidence:      ensembleResult.confidence,
      analyses,
      yesPrice,
      noPrice:         1 - yesPrice,
      recommendedSide: ensembleResult.recommendedSide,
      timestamp:       Date.now(),
    }

  } catch (e) {
    console.error('[analyzeMarket] ERROR:', e)
    return getDefaultSignal(market, yesPrice)
  }
}

// ─── BATCH ANALYSIS ───────────────────────────────────────────────────────────
export async function analyzeMarketsBatch(
  markets: PolymarketMarket[]
): Promise<CombinedSignal[]> {
  const signals: CombinedSignal[] = []
  const CONCURRENCY = 1 // Sequential untuk menghindari rate limit

  for (let i = 0; i < markets.length; i += CONCURRENCY) {
    const batch = markets.slice(i, i + CONCURRENCY)
    for (const market of batch) {
      const signal = await analyzeMarket(market)
      signals.push(signal)
      const pct = Math.round(((i + 1) / markets.length) * 100)
      console.log(`[batch] Progress: ${pct}%`)
      await new Promise(r => setTimeout(r, 2_000))
    }
  }

  return signals.sort((a, b) => b.confidence - a.confidence)
}
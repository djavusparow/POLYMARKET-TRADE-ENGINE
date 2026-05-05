// app/api/crypto-signals/route.ts
// ✅ PATCH #5: secondsLeft dihitung dari marketExpiryMs + Parallel AI execution
// ✅ FIX: sequential provider → parallel chunk
// ✅ FIX: secondsLeft source: marketExpiryMs instead of info.secondsLeft

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
  calcBiasScore, calcLiqScore, calcFundScore, calcSpreadScore, calcCompositeScore,
  type UpDownExtraData, type UpDownPromptParams,
} from '@/lib/ai-prompts'

const YOUCOM_API_KEY       = process.env.YOUCOM_API_KEY      || ''
const TAVILY_API_KEY       = process.env.TAVILY_API_KEY      || ''
const GEMINI_API_KEY       = process.env.GEMINI_API_KEY      || ''
const OPENAI_API_KEY       = process.env.OPENAI_API_KEY      || ''
const GROQ_API_KEY         = process.env.GROQ_API_KEY        || ''
const BLACKBOX_API_KEY     = process.env.BLACKBOX_API_KEY    || ''
const BLACKBOX_CUSTOMER_ID  = process.env.BLACKBOX_CUSTOMER_ID || ''
const COINGLASS_API_KEY    = process.env.COINGLASS_API_KEY   || ''

const RATE_LIMIT_DELAYS: Record<string, { delayMs: number; maxRetries: number }> = {
  gemini: { delayMs: 2_000, maxRetries: 3 }, groq: { delayMs: 1_000, maxRetries: 3 },
  youcom: { delayMs: 500, maxRetries: 2 }, openai: { delayMs: 500, maxRetries: 2 },
  blackbox: { delayMs: 1_000, maxRetries: 2 },
}

const LLM_PROVIDERS = [
  { name: 'youcom', type: 'youcom' as const, endpoint: 'https://api.you.com/v1/chat/completions', model: 'smart', key: YOUCOM_API_KEY, weight: 1.5 },
  { name: 'gemini', type: 'gemini' as const, endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', model: 'gemini-2.5-flash', key: GEMINI_API_KEY, weight: 1.4 },
  { name: 'openai', type: 'chat' as const, endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', key: OPENAI_API_KEY, weight: 1.2 },
  { name: 'groq', type: 'chat' as const, endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile', key: GROQ_API_KEY, weight: 1.0 },
  { name: 'blackbox', type: 'chat' as const, endpoint: 'https://api.blackbox.ai/chat/completions', model: 'blackboxai/anthropic/claude-sonnet-4.5', key: BLACKBOX_API_KEY, weight: 1.0 },
].filter(p => p.key)

// ✅ PATCH #5: Concurrency config untuk parallel execution
const MAX_PARALLEL_MARKETS   = 3   // Max markets parallel
const MAX_PARALLEL_PROVIDERS = 3   // Max providers parallel per market

function log(level: 'info'|'warn'|'error', msg: string, data?: any): void {
  if (data) console[level]('[crypto-signals]', msg, typeof data === 'object' ? JSON.stringify(data).slice(0, 300) : data)
  else console[level]('[crypto-signals]', msg)
}

async function fetchBinanceDepth(symbol: string) {
  try {
    const res = await fetch(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=20`, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return null
    const data = await res.json()
    const totalBid = data.bids.reduce((s: number, b: string[]) => s + parseFloat(b[1]), 0)
    const totalAsk = data.asks.reduce((s: number, a: string[]) => s + parseFloat(a[1]), 0)
    const spread = ((parseFloat(data.asks[0][0]) - parseFloat(data.bids[0][0])) / parseFloat(data.bids[0][0])) * 100
    return { bidAskRatio: totalBid/totalAsk, spreadPct: spread, bidVolume: totalBid, askVolume: totalAsk }
  } catch { return null }
}

async function fetchFundingRate(symbol: string) {
  try {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return null
    const data = await res.json()
    if (!data?.[0]) return null
    return { rate: parseFloat(data[0].fundingRate), nextFundingMs: (data[0].fundingTime ?? Date.now()+28_800_000)-Date.now() }
  } catch { return null }
}

async function fetchFearGreed() {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1', { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return null
    const item = (await res.json())?.data?.[0]
    return item ? { value: parseInt(item.value), classification: item.value_classification } : null
  } catch { return null }
}

async function fetchGlobalMarketData() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/global', { signal: AbortSignal.timeout(6_000) })
    if (!res.ok) return null
    const d = (await res.json())?.data
    return d ? { btcDominance: d.market_cap_percentage?.btc ?? 0, totalMarketCap: d.total_market_cap?.usd ?? 0, totalVolume: d.total_volume?.usd ?? 0 } : null
  } catch { return null }
}

const COINGLASS_SYMBOL_MAP: Record<CryptoCoin, string> = { btc:'BTC', eth:'ETH', sol:'SOL', doge:'DOGE', xrp:'XRP' }
async function fetchLiqData(coin: CryptoCoin) {
  if (!COINGLASS_API_KEY) return null
  try {
    const res = await fetch(`https://api.coinglass.com/api/v1/liquidation?symbol=${COINGLASS_SYMBOL_MAP[coin]}&timeType=1h`, { headers: { coinglassSecret: COINGLASS_API_KEY }, signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return null
    const data = await res.json()
    const long = data.data?.long?.reduce?.((s: number, v: any) => s+(v.amountUsd??0), 0) ?? 0
    const short = data.data?.short?.reduce?.((s: number, v: any) => s+(v.amountUsd??0), 0) ?? 0
    return { longLiqUsd: long, shortLiqUsd: short, imbalance: (long+short)>0 ? (long-short)/(long+short) : 0 }
  } catch { return null }
}

const BINANCE_FUTURES_MAP: Record<CryptoCoin, string> = { btc:'BTCUSDT', eth:'ETHUSDT', sol:'SOLUSDT', doge:'DOGEUSDT', xrp:'XRPUSDT' }

async function buildExtraData(coin: CryptoCoin): Promise<UpDownExtraData | null> {
  const symbol = BINANCE_FUTURES_MAP[coin]
  const [depth, funding, liq] = await Promise.all([fetchBinanceDepth(symbol), fetchFundingRate(symbol), fetchLiqData(coin)])
  if (!depth && !funding && !liq) return null
  return {
    bidAskRatio: depth?.bidAskRatio ?? 1.0, spreadPct: depth?.spreadPct ?? 0.05,
    bidVolume: depth?.bidVolume ?? 0, askVolume: depth?.askVolume ?? 0,
    longLiqUsd: liq?.longLiqUsd ?? 0, shortLiqUsd: liq?.shortLiqUsd ?? 0, liqImbalance: liq?.imbalance ?? 0,
    fundingRate: funding?.rate ?? 0, nextFundingMs: funding?.nextFundingMs ?? 28_800_000,
    biasScore: calcBiasScore(depth?.bidAskRatio ?? 1.0), liqScore: calcLiqScore(liq?.imbalance ?? 0),
    fundScore: calcFundScore(funding?.rate ?? 0), spreadScore: calcSpreadScore(depth?.spreadPct ?? 0.05),
  }
}

async function fetchTavilyContext(coin: string, window: string): Promise<string> {
  if (!TAVILY_API_KEY) return ''
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TAVILY_API_KEY}` },
      body: JSON.stringify({ query: `${coin} crypto ${window} short term`, search_depth: 'basic', include_answer: true, max_results: 3 }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return ''
    const data = await res.json()
    const parts: string[] = []
    if (data?.answer) parts.push(`Web: ${data.answer}`)
    if (Array.isArray(data?.results)) data.results.slice(0,3).forEach((r: any) => { if (r.title) parts.push(`- ${r.title}: ${r.snippet?.slice(0,100)}`) })
    return parts.length > 0 ? '\n\nWEB CONTEXT:\n' + parts.join('\n') : ''
  } catch { return '' }
}

function parseSignalFromText(text: string): any | null {
  if (!text.trim()) return null
  let jsonStr = text.trim()
  const fenced = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fenced) jsonStr = fenced[1]
  const first = jsonStr.indexOf('{'), last = jsonStr.lastIndexOf('}')
  if (first !== -1 && last !== -1) jsonStr = jsonStr.substring(first, last+1)
  try {
    const p = JSON.parse(jsonStr)
    if (!p.signal || !['BUY','SELL','HOLD'].includes(p.signal)) return null
    if (typeof p.confidence !== 'number' || p.confidence < 0 || p.confidence > 100) return null
    return p
  } catch {
    const sig = text.match(/"signal"\s*:\s*"(BUY|SELL|HOLD)"/i)?.[1]
    const conf = parseFloat(text.match(/"confidence"\s*:\s*(\d+)/i)?.[1] ?? '')
    return sig && !isNaN(conf) ? { signal: sig, confidence: conf } : null
  }
}

async function callYouCom(p: typeof LLM_PROVIDERS[number], prompt: string): Promise<any|null> {
  if (!p.key) return null
  for (let a=0; a<2; a++) {
    if (a>0) await new Promise(r=>setTimeout(r, 500))
    try {
      const res = await fetch(p.endpoint, {
        method:'POST', headers:{'Content-Type':'application/json','X-API-Key':p.key},
        body:JSON.stringify({model:'smart', messages:[{role:'system',content:prompt},{role:'user',content:'Analyze and respond with JSON.'}], temperature:0.3, max_tokens:800}),
        signal:AbortSignal.timeout(60_000),
      })
      if (res.status===429) continue; if (!res.ok) continue
      const raw = (await res.json())?.choices?.[0]?.message?.content ?? ''
      const parsed = parseSignalFromText(raw)
      return parsed ? {...parsed, provider:'youcom', weight:p.weight} : null
    } catch { continue }
  }
  return null
}

async function callGemini(p: typeof LLM_PROVIDERS[number], prompt: string): Promise<any|null> {
  if (!p.key) return null
  for (let a=0; a<3; a++) {
    if (a>0) await new Promise(r=>setTimeout(r, [0,15_000,30_000][a]))
    try {
      const res = await fetch(`${p.endpoint}?key=${p.key}`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt.slice(0,2000)}]}], generationConfig:{temperature:0.3, maxOutputTokens:600}}),
        signal:AbortSignal.timeout(20_000),
      })
      if (res.status===429) { if (a>=2) return null; continue }
      if (!res.ok) return null
      const text = (await res.json())?.candidates?.[0]?.content?.parts?.[0]?.text || ''
      const parsed = parseSignalFromText(text)
      return parsed ? {...parsed, provider:'gemini', weight:p.weight} : null
    } catch { if (a>=2) return null }
  }
  return null
}

async function callBlackbox(p: typeof LLM_PROVIDERS[number], prompt: string): Promise<any|null> {
  if (!p.key) return null
  for (let a=0; a<2; a++) {
    if (a>0) await new Promise(r=>setTimeout(r, 1000*Math.pow(2,a)))
    try {
      const h: Record<string,string> = {'Content-Type':'application/json','Authorization':`Bearer ${p.key}`}
      if (BLACKBOX_CUSTOMER_ID) { h['customerId']=BLACKBOX_CUSTOMER_ID; h['anthropic-version']='2023-06-01' }
      const res = await fetch(p.endpoint, {
        method:'POST', headers:h,
        body:JSON.stringify({model:p.model, messages:[{role:'system',content:prompt},{role:'user',content:'Analyze and respond with JSON.'}], temperature:0.3, max_tokens:800}),
        signal:AbortSignal.timeout(45_000),
      })
      if (res.status===429) continue; if (!res.ok) return null
      const raw = (await res.json())?.choices?.[0]?.message?.content ?? ''
      const parsed = parseSignalFromText(raw)
      return parsed ? {...parsed, provider:'blackbox', weight:p.weight} : null
    } catch { continue }
  }
  return null
}

async function callAI(p: typeof LLM_PROVIDERS[number], prompt: string): Promise<any|null> {
  if (!p.key) return null
  if (p.name==='gemini') return callGemini(p,prompt)
  if (p.name==='youcom') return callYouCom(p,prompt)
  if (p.name==='blackbox') return callBlackbox(p,prompt)
  const c = RATE_LIMIT_DELAYS[p.name] ?? RATE_LIMIT_DELAYS.openai
  for (let a=0; a<c.maxRetries; a++) {
    if (a>0) await new Promise(r=>setTimeout(r, c.delayMs*Math.pow(2,a)))
    try {
      const res = await fetch(p.endpoint, {
        method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${p.key}`},
        body:JSON.stringify({model:(p as any).model, messages:[{role:'system',content:prompt},{role:'user',content:'Analyze and respond with JSON.'}], temperature:0.3, max_tokens:800}),
        signal:AbortSignal.timeout(30_000),
      })
      if (res.status===429) continue; if (!res.ok) continue
      const raw = (await res.json())?.choices?.[0]?.message?.content ?? ''
      const parsed = parseSignalFromText(raw)
      return parsed ? {...parsed, provider:p.name, weight:p.weight} : null
    } catch { continue }
  }
  return null
}

function weightedEnsembleUpDown(results: any[]): { direction:'BUY'|'SELL'|'HOLD'; confidence:number; recommendedSide:'YES'|'NO'; avgEdge:number } {
  const valid = results.filter(Boolean)
  if (valid.length===0) return { direction:'HOLD', confidence:0, recommendedSide:'YES', avgEdge:0 }
  let buy=0, sell=0, tw=0
  for (const r of valid) { const w=(r.weight??1)*(r.confidence/100); if(r.signal==='BUY') buy+=w; if(r.signal==='SELL') sell+=w; tw+=w }
  const ds=Math.max(buy,sell), ts=buy+sell, cr=ts>0?ds/ts:0
  const ev=valid.map(r=>r.edge).filter((e:any)=>typeof e==='number'&&!isNaN(e))
  const ae=ev.length>0?ev.reduce((s:number,e:number)=>s+Math.abs(e),0)/ev.length:0
  const ac=valid.reduce((s:number,r:any)=>s+r.confidence,0)/valid.length
  const wc=Math.round(tw>0?(ds/tw)*100:ac)
  if (buy>sell&&cr>0.55) return ae<0.08 ? { direction:'HOLD', confidence:Math.round(wc*0.6), recommendedSide:'YES', avgEdge:ae } : { direction:'BUY', confidence:wc, recommendedSide:'YES', avgEdge:ae }
  if (sell>buy&&cr>0.55) return ae<0.08 ? { direction:'HOLD', confidence:Math.round(wc*0.6), recommendedSide:'NO', avgEdge:ae } : { direction:'SELL', confidence:wc, recommendedSide:'NO', avgEdge:ae }
  return { direction:'HOLD', confidence:Math.round(wc*0.5), recommendedSide:'YES', avgEdge:ae }
}

// ✅ PATCH #5: Analyze single market — parallel providers + secondsLeft from marketExpiryMs
async function analyzeUpDownMarket(info: CryptoMarketInfo, coinPrices: any, fearGreed: any, globalData: any): Promise<any> {
  const pd = coinPrices[info.coin]; const price = pd?.price ?? 0
  const [extraData, tavilyContext] = await Promise.all([buildExtraData(info.coin), fetchTavilyContext(COIN_SYMBOLS[info.coin], info.window)])

  // ✅ PATCH #5: secondsLeft DIHITUNG dari marketExpiryMs (end_date_iso Polymarket)
  // BUKAN dari info.secondsLeft (yang berasal dari jam server lokal)
  const secondsLeft = info.marketExpiryMs !== null
    ? Math.max(0, Math.round((info.marketExpiryMs - Date.now()) / 1000))
    : info.secondsLeft

  const pp: UpDownPromptParams = {
    coin: info.coin, coinSymbol: COIN_SYMBOLS[info.coin], coinLabel: COIN_LABELS[info.coin],
    window: info.window, currentPrice: price,
    change24h: pd?.change24h??null, high24h: pd?.high24h??null, low24h: pd?.low24h??null, volume24h: pd?.volume24h??null,
    yesPrice: info.yesPrice, noPrice: info.noPrice,
    fearGreedValue: fearGreed?.value??null, fearGreedLabel: fearGreed?.classification??null,
    btcDominance: globalData?.btcDominance??null,
    secondsLeft, newsContext: tavilyContext||undefined, extraData: extraData??undefined,
  }
  const prompt = buildUpDownPrompt(pp)

  // ✅ PATCH #5: Providers dipanggil PARALLEL dalam chunk, bukan sequential
  // Chunk 1: youcom + gemini + openai (parallel)
  // Chunk 2: groq + blackbox (parallel)
  // Delay 2 detik antar chunk untuk avoid rate limit
  const chunks: typeof LLM_PROVIDERS[] = []
  for (let i=0; i<LLM_PROVIDERS.length; i+=MAX_PARALLEL_PROVIDERS) {
    chunks.push(LLM_PROVIDERS.slice(i, i+MAX_PARALLEL_PROVIDERS))
  }

  const results: any[] = []
  for (const ch of chunks) {
    // Semua provider dalam chunk dipanggil PARALLEL
    const chunkResults = await Promise.all(ch.map(p => callAI(p, prompt)))
    for (const r of chunkResults) { if (r) results.push(r) }
    // Delay antar chunk
    if (chunks.indexOf(ch) < chunks.length-1) {
      await new Promise(r => setTimeout(r, 2_000))
    }
  }

  if (results.length===0) {
    return {
      coin:info.coin, coinLabel:COIN_LABELS[info.coin], window:info.window, slug:info.slug,
      signal:'HOLD', confidence:0, error:'No AI providers available',
      extraData: extraData?{compositeScore:calcCompositeScore(extraData),...extraData}:null,
    }
  }

  log('info', `[${info.coin} ${info.window}] ${results.length}/${LLM_PROVIDERS.length} providers success`)

  const ensemble = weightedEnsembleUpDown(results)
  const best = results[0]

  return {
    coin:info.coin, coinLabel:COIN_LABELS[info.coin], window:info.window, slug:info.slug,
    market_id: info.market?.id??null,
    signal:ensemble.direction, confidence:ensemble.confidence, recommendedSide:ensemble.recommendedSide,
    yesPrice:info.yesPrice, noPrice:info.noPrice,
    currentPrice:price, change24h:pd?.change24h??null,
    // ✅ PATCH #5: secondsLeft SELALU dari marketExpiryMs
    secondsLeft,
    // ✅ marketExpiryMs dikirim untuk page.tsx countdown sync
    marketExpiryMs: info.marketExpiryMs,
    edge:ensemble.avgEdge,
    rationale:best?.rationale??'', keyRisk:best?.keyRisk??'',
    analyses:results.length,
    providers:results.map(r=>({name:r.provider,signal:r.signal,confidence:r.confidence})),
    extraData:extraData?{compositeScore:calcCompositeScore(extraData),...extraData}:null,
    timestamp:Date.now(), active:info.active,
  }
}

// ✅ PATCH #5: Helper parallel chunk processor
async function processInChunks<T,R>(items: T[], processor: (item:T)=>Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = []
  for (let i=0; i<items.length; i+=concurrency) {
    const chunk = items.slice(i, i+concurrency)
    results.push(...(await Promise.all(chunk.map(processor))))
  }
  return results
}

// ─── GET /api/crypto-signals ──────────────────────────────────────────────────
export async function GET() {
  const st = Date.now()
  log('info', `🚀 PARALLEL analysis — providers:${LLM_PROVIDERS.length} maxMarkets:${MAX_PARALLEL_MARKETS} maxProviders:${MAX_PARALLEL_PROVIDERS}`)

  try {
    const [markets, coinPrices, fearGreed, globalData] = await Promise.all([
      fetchAllCryptoUpDownMarkets(), fetchAllCoinPrices(), fetchFearGreed(), fetchGlobalMarketData(),
    ])

    log('info', `Data fetched in ${Date.now()-st}ms: ${markets.length} markets`)
    const activeMarkets = markets.filter(m=>m.active&&m.market!==null)

    if (activeMarkets.length===0) {
      return NextResponse.json({ signals:[], message:'No active markets', activeCount:0, timestamp:Date.now(), elapsedMs:Date.now()-st })
    }

    log('info', `Analyzing ${activeMarkets.length} markets in chunks of ${MAX_PARALLEL_MARKETS} (parallel)...`)

    // ✅ PATCH #5: Market analysis PARALLEL (bukan sequential)
    const signals = await processInChunks(activeMarkets, (m)=>analyzeUpDownMarket(m,coinPrices,fearGreed,globalData), MAX_PARALLEL_MARKETS)

    signals.sort((a,b)=>{if(a.signal==='HOLD'&&b.signal!=='HOLD')return 1; if(a.signal!=='HOLD'&&b.signal==='HOLD')return -1; return b.confidence-a.confidence})

    const elapsed = Date.now()-st
    log('info', `✅ Done in ${elapsed}ms (parallel). ${signals.filter(s=>s.signal!=='HOLD').length} actionable`)

    return NextResponse.json({
      signals,
      summary: {
        total:activeMarkets.length,
        actionable:signals.filter(s=>s.signal!=='HOLD').length,
        bulls:signals.filter(s=>s.signal==='BUY').length,
        bears:signals.filter(s=>s.signal==='SELL').length,
        holds:signals.filter(s=>s.signal==='HOLD').length,
      },
      fearGreed: fearGreed ? { value:fearGreed.value, classification:fearGreed.classification } : null,
      globalData: globalData ? { btcDominance:globalData.btcDominance.toFixed(1)+'%', totalMarketCap:'$'+(globalData.totalMarketCap/1e12).toFixed(2)+'T' } : null,
      activeCount: activeMarkets.length, providers:LLM_PROVIDERS.map(p=>p.name), timestamp:Date.now(), elapsedMs:elapsed,
    })

  } catch (e: unknown) {
    return NextResponse.json({ error: String(e), timestamp: Date.now() }, { status: 500 })
  }
}

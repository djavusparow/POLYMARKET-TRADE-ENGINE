// lib/ai-prompts.ts
// ✅ UPDATED: Safety guard untuk extreme prices, trap detection
// ✅ Semua fungsi diexport dengan benar

import type { CryptoCoin } from './crypto-markets'

// ─── Category Detection ───────────────────────────────────────────────────────
export function detectMarketCategory(
  question: string,
  category?: string
): 'crypto-updown' | 'crypto' | 'political' | 'general' {
  const q = question.toLowerCase()
  const c = (category ?? '').toLowerCase()

  // Deteksi up/down market dulu (paling spesifik)
  if (
    (q.includes('up or down') || q.includes('updown') || q.includes('higher or lower') ||
     q.includes('above or below') || q.includes('price up') || q.includes('price down') ||
     /will .+(be|close|end|finish).+(higher|lower|above|below|up|down)/i.test(q)) &&
    (q.includes('btc') || q.includes('bitcoin') || q.includes('eth') || q.includes('ethereum') ||
     q.includes('sol') || q.includes('doge') || q.includes('xrp') || q.includes('solana'))
  ) return 'crypto-updown'

  if (
    q.includes('bitcoin') || q.includes(' btc') || q.includes('ethereum') ||
    q.includes(' eth ') || q.includes('crypto') || q.includes('doge') ||
    q.includes(' xrp') || q.includes('solana') || c.includes('crypto')
  ) return 'crypto'

  if (
    q.includes('president') || q.includes('election') || q.includes('senate') ||
    q.includes('congress') || q.includes('vote') || q.includes('democrat') ||
    q.includes('republican') || c.includes('politics') || c.includes('election')
  ) return 'political'

  return 'general'
}

// ─── Up/Down Extra Data Type ──────────────────────────────────────────────────
export interface UpDownExtraData {
  bidAskRatio:    number
  spreadPct:      number
  bidVolume:      number
  askVolume:      number
  longLiqUsd:     number
  shortLiqUsd:    number
  liqImbalance:   number
  fundingRate:    number
  nextFundingMs:  number
  biasScore:      number
  liqScore:       number
  fundScore:      number
  spreadScore:    number
}

// ─── Parameters untuk buildUpDownPrompt ───────────────────────────────────────
export interface UpDownPromptParams {
  coin:          CryptoCoin
  coinSymbol:    string
  coinLabel:     string
  window:        '5m' | '15m'
  currentPrice:  number
  change24h:     number | null
  high24h:       number | null
  low24h:        number | null
  volume24h:     number | null
  yesPrice:      number
  noPrice:       number
  fearGreedValue:  number | null
  fearGreedLabel:  string | null
  btcDominance:    number | null
  secondsLeft:     number
  newsContext?:    string
  extraData?:     UpDownExtraData
}

// ─── 1. CRYPTO UP/DOWN PROMPT ─────────────────────────────────────────────────
export function buildUpDownPrompt(params: UpDownPromptParams): string {
  const {
    coinSymbol, coinLabel, window, currentPrice,
    change24h, high24h, low24h, volume24h,
    yesPrice, noPrice, fearGreedValue, fearGreedLabel,
    btcDominance, secondsLeft, newsContext, extraData,
  } = params

  const minutesLeft = Math.ceil(secondsLeft / 60)
  const upPct       = (yesPrice * 100).toFixed(1)
  const downPct     = (noPrice  * 100).toFixed(1)
  const position    = (high24h && low24h && high24h > low24h)
    ? (((currentPrice - low24h) / (high24h - low24h)) * 100).toFixed(1)
    : null
  const priceFormatted = currentPrice > 100
    ? currentPrice.toLocaleString('en', { maximumFractionDigits: 2 })
    : currentPrice.toLocaleString('en', { maximumFractionDigits: 6 })

  // ── Safety Guard — Deteksi harga extreme ──────────────────────────────
  const isUpExtremeCheap  = yesPrice < 0.10
  const isDownExtremeCheap = noPrice < 0.10
  const extremeWarning = isUpExtremeCheap
    ? '\n⚠️ ⚠️ ⚠️ CRITICAL WARNING: UP price is EXTREMELY LOW (' + upPct + '%). ' +
      'Historically, buying UP below 10c in 5m/15m windows has a WIN RATE < 25%. ' +
      'The market is pricing near-certain DOWN. Only recommend BUY UP if you have ' +
      'EXTREMELY strong evidence (compositeScore > 0.85, news catalyst, massive short liquidation). ' +
      'Otherwise, this is likely a TRAP. Default to HOLD or SELL (DOWN).\n'
    : isDownExtremeCheap
    ? '\n⚠️ ⚠️ ⚠️ CRITICAL WARNING: DOWN price is EXTREMELY LOW (' + downPct + '%). ' +
      'Buying DOWN below 10c is high-risk. Only recommend if compositeScore < 0.20. ' +
      'Default to HOLD if uncertain.\n'
    : ''

  const confidencePenalty = isUpExtremeCheap || isDownExtremeCheap
    ? '\nCONFIDENCE PENALTY: Reduce your confidence by 20% due to extreme price. ' +
      'Minimum confidence for any signal at extreme prices: 85%.\n'
    : ''

  // ── Build order book section ──────────────────────────────────────────
  const obSection = extraData
    ? (
      '\n## ORDER BOOK (Binance Spot — top 20 levels):\n' +
      'Bid/Ask Ratio: ' + extraData.bidAskRatio.toFixed(2) +
        (extraData.bidAskRatio > 1.3 ? ' → STRONG BUYING PRESSURE'  :
         extraData.bidAskRatio > 1.1 ? ' → MILD BUYING PRESSURE'    :
         extraData.bidAskRatio > 0.9 ? ' → BALANCED'                :
         extraData.bidAskRatio > 0.7 ? ' → MILD SELLING PRESSURE'  :
         ' → STRONG SELLING PRESSURE') + '\n' +
      'Total Bid Volume: ' + extraData.bidVolume.toFixed(2) + ' ' + coinSymbol + '\n' +
      'Total Ask Volume: ' + extraData.askVolume.toFixed(2) + ' ' + coinSymbol + '\n' +
      'Spread: ' + extraData.spreadPct.toFixed(3) + '% — ' +
        (extraData.spreadPct < 0.01 ? 'EXTREMELY TIGHT (very liquid)' :
         extraData.spreadPct < 0.05 ? 'TIGHT (liquid)'                :
         extraData.spreadPct < 0.10 ? 'MODERATE'                       :
         'WIDE (illiquid — be cautious)') + '\n' +
      'Bias Score (0-1, 0.5=neutral): ' + extraData.biasScore.toFixed(3) + '\n'
    )
    : ''

  // ── Build liquidation section ─────────────────────────────────────────
  const liqSection = extraData
    ? (
      '\n## LIQUIDATION DATA (1h — Coinglass):\n' +
      'Long Liquidations: $' + (extraData.longLiqUsd / 1e6).toFixed(2) + 'M\n' +
      'Short Liquidations: $' + (extraData.shortLiqUsd / 1e6).toFixed(2) + 'M\n' +
      'Imbalance: ' + (extraData.liqImbalance > 0 ? '+' : '') + extraData.liqImbalance.toFixed(3) +
        (extraData.liqImbalance > 0.3  ? ' → HEAVY LONG LIQUIDATIONS = bearish cascade risk'  :
         extraData.liqImbalance > 0.1  ? ' → MORE LONG LIQUIDATIONS = slight bearish pressure'  :
         extraData.liqImbalance > -0.1 ? ' → BALANCED — no cascade signal'                     :
         extraData.liqImbalance > -0.3 ? ' → MORE SHORT LIQUIDATIONS = slight bullish pressure' :
         ' → HEAVY SHORT LIQUIDATIONS = bullish cascade risk') + '\n' +
      'Liq Score (0-1, 0.5=neutral): ' + extraData.liqScore.toFixed(3) + '\n'
    )
    : ''

  // ── Build funding rate section ────────────────────────────────────────
  const fundSection = extraData
    ? (
      '\n## FUNDING RATE (Binance Perpetual Futures):\n' +
      'Current Rate: ' + (extraData.fundingRate * 100).toFixed(4) + '% — ' +
        (extraData.fundingRate > 0.05  ? 'EXTREME POSITIVE → longs VERY overcrowded → SHORT BIAS'  :
         extraData.fundingRate > 0.01  ? 'POSITIVE → longs paying shorts → mild SHORT BIAS'         :
         extraData.fundingRate > -0.01 ? 'NEUTRAL → no funding pressure'                            :
         extraData.fundingRate > -0.05 ? 'NEGATIVE → shorts paying longs → mild LONG BIAS'        :
         'EXTREME NEGATIVE → shorts VERY overcrowded → LONG BIAS') + '\n' +
      'Next Funding In: ' + Math.max(0, Math.floor(extraData.nextFundingMs / 60000)) + ' min\n' +
      'Fund Score (0-1, 0.5=neutral): ' + extraData.fundScore.toFixed(3) + '\n'
    )
    : ''

  // ── Build composite score ─────────────────────────────────────────────
  const compositeScoreExtra = extraData
    ? (extraData.biasScore   * 0.40) +
      (extraData.liqScore    * 0.30) +
      (extraData.fundScore   * 0.20) +
      (extraData.spreadScore * 0.10)
    : null

  const compositeSection = extraData && compositeScoreExtra !== null
    ? (
      '\n## COMPOSITE SIGNAL CALCULATOR:\n' +
      'Formula: compositeScore = (biasScore × 0.40) + (liqScore × 0.30) + (fundScore × 0.20) + (spreadScore × 0.10)\n' +
      '  biasScore   (' + extraData.biasScore.toFixed(3)   + ') × 0.40 = ' + (extraData.biasScore   * 0.40).toFixed(3) + '\n' +
      '  liqScore    (' + extraData.liqScore.toFixed(3)    + ') × 0.30 = ' + (extraData.liqScore    * 0.30).toFixed(3) + '\n' +
      '  fundScore   (' + extraData.fundScore.toFixed(3)   + ') × 0.20 = ' + (extraData.fundScore   * 0.20).toFixed(3) + '\n' +
      '  spreadScore (' + extraData.spreadScore.toFixed(3) + ') × 0.10 = ' + (extraData.spreadScore * 0.10).toFixed(3) + '\n' +
      'compositeScore = ' + compositeScoreExtra.toFixed(3) + '\n\n' +
      'INTERPRETATION:\n' +
      '  compositeScore > 0.60 → BULLISH bias (lean UP)\n' +
      '  compositeScore 0.40-0.60 → NEUTRAL (no directional edge)\n' +
      '  compositeScore < 0.40 → BEARISH bias (lean DOWN)\n'
    )
    : ''

  return (
    'You are an expert crypto quantitative trader specializing in ultra-short-term binary prediction markets.\n' +
    'Task: Predict if ' + coinSymbol + ' will be HIGHER or LOWER at the close of this ' + window + ' window.\n' +
    'You ONLY analyze the data provided below. Do NOT guess or fabricate data you cannot see.\n\n' +

    extremeWarning +
    confidencePenalty +

    '## LIVE MARKET DATA:\n' +
    'Asset: ' + coinLabel + ' (' + coinSymbol + ')\n' +
    'Current Price: $' + priceFormatted + '\n' +
    '24h Change: ' + (change24h !== null ? change24h.toFixed(2) + '%' : 'N/A') + '\n' +
    '24h High: $' + (high24h ? high24h.toLocaleString('en', { maximumFractionDigits: 2 }) : 'N/A') + '\n' +
    '24h Low: $'  + (low24h  ? low24h.toLocaleString('en',  { maximumFractionDigits: 2 }) : 'N/A') + '\n' +
    (position ? 'Price in 24h range: ' + position + '% (0%=at 24h low, 100%=at 24h high)\n' : '') +
    '24h Volume: $' + (volume24h ? (volume24h / 1e9).toFixed(2) + 'B' : 'N/A') + '\n\n' +

    obSection +
    liqSection +
    fundSection +

    '## POLYMARKET ' + window.toUpperCase() + ' BINARY MARKET:\n' +
    'Question: Will ' + coinSymbol + ' close HIGHER than open in this ' + window + ' window?\n' +
    'UP (YES) Price:  ' + yesPrice.toFixed(3) + ' (' + upPct + '% probability)\n' +
    'DOWN (NO) Price: ' + noPrice.toFixed(3)  + ' (' + downPct + '% probability)\n' +
    'Time left in window: ' + minutesLeft + ' minute(s) (' + secondsLeft + 's)\n\n' +

    '## SENTIMENT & MACRO:\n' +
    (fearGreedValue !== null && fearGreedLabel
      ? 'Crypto Fear & Greed Index: ' + fearGreedValue + '/100 (' + fearGreedLabel + ') — ' +
        (fearGreedValue < 25 ? 'EXTREME FEAR: contrarian bullish signal (weight 15%)'  :
         fearGreedValue < 45 ? 'FEAR: slight bearish sentiment'            :
         fearGreedValue < 55 ? 'NEUTRAL: follow quantitative signals'                  :
         fearGreedValue < 75 ? 'GREED: slight bullish but reversal risk (weight 15%)' :
         'EXTREME GREED: local top risk (weight 15%)') + '\n'
      : '') +
    (btcDominance
      ? 'BTC Dominance: ' + btcDominance.toFixed(1) + '% — ' +
        (btcDominance > 60 ? 'high dominance: BTC leading, alts may lag'  :
         btcDominance > 50 ? 'moderate dominance: mixed for alts' :
         'low dominance: alt season territory') + '\n'
      : '') + '\n' +

    compositeSection +

    '## ANALYSIS FRAMEWORK:\n\n' +
    '### A. QUANTITATIVE SIGNALS (primary)\n' +
    '1. Order Book bias (bidAskRatio, biasScore)\n' +
    '2. Liquidation imbalance\n' +
    '3. Funding rate\n' +
    '4. 24h range position\n' +
    '5. compositeScore\n\n' +
    '### B. SENTIMENT OVERLAY (secondary — only if extreme)\n' +
    '1. Fear & Greed: Only matters when EXTREME (<25 or >75)\n' +
    '2. BTC Dominance\n' +
    '3. 24h trend direction\n\n' +
    '### C. TIME DECAY LOGIC\n' +
    '- ' + minutesLeft + ' min remaining in ' + window + ' window\n' +
    (minutesLeft <= 1
      ? '- CRITICAL: <1 min left — only trade if VERY confident (>85%)\n'
      : minutesLeft <= 3
      ? '- LATE: 1-3 min left — momentum matters more (confidence >75%)\n'
      : minutesLeft <= 7
      ? '- MID: 3-7 min left — both momentum and mean reversion\n'
      : '- EARLY: >7 min left — mean reversion tendency stronger\n') +
    '- Mean reversion fact: In 5-15m windows, price near 24h extremes reverts ~55% of the time\n\n' +

    (newsContext ? '## RECENT NEWS:\n' + newsContext + '\n\n' : '') +

    '## DECISION RULES FOR ' + window.toUpperCase() + ' UP/DOWN:\n\n' +

    '### CRITICAL SAFETY RULES (OVERRIDE ALL OTHER RULES):\n' +
    '1. If YES (UP) price < 0.10 (< 10%): Signal must be SELL (DOWN) or HOLD. NEVER BUY UP.\n' +
    '2. If NO (DOWN) price < 0.10 (< 10%) i.e. YES price > 0.90: Signal must be BUY (UP) or HOLD. NEVER BUY DOWN.\n' +
    '3. If confidence < 85% at any extreme price → FORCE HOLD.\n' +
    '4. If conflicting signals across providers → FORCE HOLD.\n\n' +

    'TRUE PROBABILITY CALCULATION:\n' +
    '  baseProb = market implied probability (' + upPct + '%)\n' +
    (extraData && compositeScoreExtra !== null
      ? '  compositeScore = ' + compositeScoreExtra.toFixed(3) + '\n' +
        '  if compositeScore > 0.60 → adjust UP prob by +(compositeScore - 0.50) × 30%\n' +
        '  if compositeScore < 0.40 → adjust UP prob by -(0.50 - compositeScore) × 30%\n' +
        '  if 0.40 ≤ compositeScore ≤ 0.60 → minimal adjustment (±2%)\n'
      : '  No order book data — rely on range position + sentiment only\n') +
    '  Fear/Greed extreme adjustment: ±5% if FG <25 or >75\n\n' +

    'EDGE = trueProbability - marketImpliedProbability\n\n' +

    'SIGNAL RULES:\n' +
    '  BUY YES (UP):   edge > 8% AND confidence > ' +
      (minutesLeft <= 2 ? '85' : minutesLeft <= 5 ? '75' : '65') + '%\n' +
    '  BUY NO (DOWN):  edge < -8% AND confidence > ' +
      (minutesLeft <= 2 ? '85' : minutesLeft <= 5 ? '75' : '65') + '%\n' +
    '  HOLD:           edge < 8% OR conflicting signals OR spread too wide\n\n' +

    '### TRAP AVOIDANCE:\n' +
    '- If UP=4c and DOWN=96c, and you feel tempted to BUY UP: STOP. This is a classic value trap.\n' +
    '- If multiple providers disagree → HOLD. Safety over greed.\n' +
    '- If compositeScore is neutral (0.4-0.6) at extreme prices → HOLD.\n\n' +

    'CRITICAL RULE: Do NOT fabricate data. Reduce confidence by 15% if data is missing.\n\n' +

    'Respond ONLY with valid JSON (no markdown, no extra text):\n' +
    '{"signal":"BUY" or "SELL" or "HOLD",' +
    '"confidence":0-100,' +
    '"trueYesProbability":0.0-1.0,' +
    '"edge":0.0,' +
    '"recommendedSide":"YES" or "NO",' +
    '"targetPrice":0.0,' +
    '"stopLoss":0.0,' +
    '"takeProfit":0.0,' +
    '"rationale":"2-3 sentences referencing specific data points",' +
    '"keyRisk":"1 sentence on biggest risk",' +
    '"timeHorizon":"ultra_short" or "short"}'
  )
}

// ─── 2. CRYPTO GENERAL PROMPT ─────────────────────────────────────────────────
export function buildCryptoPrompt(market: {
  question: string
  yesPrice: number
  noPrice: number
  volume24hr: number
  endDate?: string
}): string {
  const prob = (market.yesPrice * 100).toFixed(1)
  const daysToExpiry = market.endDate
    ? Math.ceil((new Date(market.endDate).getTime() - Date.now()) / 86400000)
    : null

  return (
    'You are a crypto market expert and prediction market trader.\n' +
    'Analyze this crypto Polymarket question using technicals and fundamentals.\n\n' +
    '## MARKET:\n' +
    'Question: "' + market.question + '"\n' +
    'YES Price: ' + market.yesPrice.toFixed(3) + ' (' + prob + '% probability)\n' +
    '24h Volume: $' + (market.volume24hr || 0).toLocaleString() + '\n' +
    (daysToExpiry !== null ? 'Days to Resolution: ' + daysToExpiry + '\n' : '') +
    '\nEDGE RULES: Minimum edge 15%. Minimum confidence 70%.\n\n' +
    'Respond ONLY with valid JSON:\n' +
    '{"signal":"BUY" or "SELL" or "HOLD","confidence":0-100,"trueYesProbability":0.0-1.0,"edge":0.0,"recommendedSide":"YES" or "NO","targetPrice":0.0,"stopLoss":0.0,"takeProfit":0.0,"rationale":"2-3 sentences","keyRisk":"1 sentence","timeHorizon":"short" or "medium" or "long"}'
  )
}

// ─── 3. POLITICAL PROMPT ──────────────────────────────────────────────────────
export function buildPoliticalPrompt(market: {
  question: string
  yesPrice: number
  noPrice: number
  volume24hr: number
  endDate?: string
}): string {
  const prob = (market.yesPrice * 100).toFixed(1)
  return (
    'You are a political analyst and prediction market expert.\n\n' +
    '## MARKET:\n' +
    'Question: "' + market.question + '"\n' +
    'YES Price: ' + market.yesPrice.toFixed(3) + ' (' + prob + '% probability)\n' +
    '24h Volume: $' + (market.volume24hr || 0).toLocaleString() + '\n\n' +
    'STRICT RULES: Minimum edge 15%. Minimum confidence 75%. Election >6 months: HOLD.\n\n' +
    'Respond ONLY with valid JSON:\n' +
    '{"signal":"BUY" or "SELL" or "HOLD","confidence":0-100,"trueYesProbability":0.0-1.0,"edge":0.0,"recommendedSide":"YES" or "NO","targetPrice":0.0,"stopLoss":0.0,"takeProfit":0.0,"rationale":"2-3 sentences","keyRisk":"1 sentence","timeHorizon":"short" or "medium" or "long"}'
  )
}

// ─── 4. GENERAL MARKET PROMPT ─────────────────────────────────────────────────
export function buildGeneralPrompt(market: {
  question:    string
  yesPrice:    number
  noPrice:     number
  volume24hr:  number
  liquidity?:  number
  endDate?:    string
  description?: string
}): string {
  const prob   = (market.yesPrice * 100).toFixed(1)
  const spread = Math.abs(market.yesPrice - (1 - market.noPrice)) * 100
  const daysToExpiry = market.endDate
    ? Math.ceil((new Date(market.endDate).getTime() - Date.now()) / 86400000)
    : null

  return (
    'You are an expert prediction market trader specializing in Polymarket.\n' +
    'Find MISPRICED markets where the current probability is WRONG based on evidence.\n\n' +
    '## MARKET:\n' +
    'Question: "' + market.question + '"\n' +
    'YES Price: ' + market.yesPrice.toFixed(3) + ' (' + prob + '% implied probability)\n' +
    'Spread: ' + spread.toFixed(2) + '%\n' +
    '24h Volume: $' + (market.volume24hr || 0).toLocaleString() + '\n' +
    (daysToExpiry !== null ? 'Days to Resolution: ' + daysToExpiry + '\n' : '') +
    (market.description ? 'Context: ' + market.description.slice(0, 200) + '\n' : '') +
    '\nRULES: BUY/SELL only if edge>10% AND confidence>70% AND spread<5%. Otherwise HOLD.\n\n' +
    'Respond ONLY with valid JSON:\n' +
    '{"signal":"BUY" or "SELL" or "HOLD","confidence":0-100,"trueYesProbability":0.0-1.0,"edge":0.0,"recommendedSide":"YES" or "NO","targetPrice":0.0,"stopLoss":0.0,"takeProfit":0.0,"rationale":"2-3 sentences","keyRisk":"1 sentence","timeHorizon":"short" or "medium" or "long"}'
  )
}

// ─── 5. SELECTOR ──────────────────────────────────────────────────────────────
export function selectPromptForMarket(market: {
  question:    string
  yesPrice:    number
  noPrice:     number
  volume24hr?: number
  liquidity?:  number
  endDate?:    string
  category?:   string
  description?: string
  updownExtraData?: UpDownExtraData
  updownParams?: UpDownPromptParams
}): string {
  const category = detectMarketCategory(market.question, market.category)
  const base = {
    question:    market.question,
    yesPrice:    market.yesPrice,
    noPrice:     market.noPrice,
    volume24hr:  market.volume24hr ?? 0,
    liquidity:   market.liquidity  ?? 0,
    endDate:     market.endDate,
    description: market.description,
  }

  if (category === 'crypto-updown') {
    if (market.updownParams && market.updownExtraData) {
      return buildUpDownPrompt({
        ...market.updownParams,
        extraData: market.updownExtraData,
      })
    }
    if (market.updownParams) {
      return buildUpDownPrompt(market.updownParams)
    }
    console.warn('[selectPromptForMarket] ⚠️ crypto-updown detected but no updownParams — falling back to crypto prompt')
    return buildCryptoPrompt(base)
  }

  if (category === 'crypto')        return buildCryptoPrompt(base)
  if (category === 'political')     return buildPoliticalPrompt(base)
  return buildGeneralPrompt(base)
}

// ─── 6. NORMALIZE HELPERS ─────────────────────────────────────────────────────
/** Hitung bias score dari bid/ask ratio (0-1, 0.5=neutral) */
export function calcBiasScore(bidAskRatio: number): number {
  return Math.max(0, Math.min(1, 0.5 + (bidAskRatio - 1) * 0.5))
}

/** Hitung liquidation score dari imbalance (0-1, 0.5=neutral) */
export function calcLiqScore(imbalance: number): number {
  return Math.max(0, Math.min(1, 0.5 - imbalance * 0.5))
}

/** Hitung funding rate score (0-1, 0.5=neutral) */
export function calcFundScore(fundingRate: number): number {
  return Math.max(0, Math.min(1, 0.5 - fundingRate * 5))
}

/** Hitung spread score (0-1, 1=sempit/baik) */
export function calcSpreadScore(spreadPct: number): number {
  return Math.max(0, Math.min(1, 1 - spreadPct * 10))
}

/** Hitung composite score dari semua komponen */
export function calcCompositeScore(data: UpDownExtraData): number {
  return (
    data.biasScore   * 0.40 +
    data.liqScore    * 0.30 +
    data.fundScore   * 0.20 +
    data.spreadScore * 0.10
  )
}

// ─── 7. VALIDATE UP/DOWN SIGNAL ──────────────────────────────────────────────
export function validateUpDownSignal(
  signal: 'BUY' | 'SELL' | 'HOLD',
  yesPrice: number,
  confidence: number
): { valid: boolean; adjustedSignal?: 'BUY' | 'SELL' | 'HOLD'; adjustedConfidence?: number; reason?: string } {
  if (yesPrice < 0.10 && signal === 'BUY') {
    if (confidence < 85) {
      return {
        valid: false,
        adjustedSignal: 'HOLD',
        adjustedConfidence: Math.round(confidence * 0.5),
        reason: `UP price ${(yesPrice*100).toFixed(0)}% is extremely low. Confidence ${confidence}% < 85% threshold. Downgraded to HOLD.`
      }
    }
    return {
      valid: true,
      reason: `UP at ${(yesPrice*100).toFixed(0)}% but confidence ${confidence}% > 85% — allowing trade.`
    }
  }

  if ((1 - yesPrice) < 0.10 && signal === 'SELL') {
    if (confidence < 85) {
      return {
        valid: false,
        adjustedSignal: 'HOLD',
        adjustedConfidence: Math.round(confidence * 0.5),
        reason: `DOWN price ${((1-yesPrice)*100).toFixed(0)}% is extremely low. Downgraded to HOLD.`
      }
    }
  }

  return { valid: true }
}

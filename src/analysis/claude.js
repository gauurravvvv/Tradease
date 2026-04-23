import { spawn } from 'child_process';

/**
 * Call Claude CLI in non-interactive mode and return the response text.
 *
 * @param {string} prompt - The prompt to send.
 * @param {object} options - { timeout, model }
 * @returns {Promise<string>} Claude's response text.
 */
export async function askClaude(prompt, options = {}) {
  const { timeout = 120_000, model = null } = options;

  return new Promise((resolve, reject) => {
    const args = ['--print'];
    if (model) args.push('--model', model);
    args.push('-p', prompt);
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;
    const child = spawn('claude', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Claude CLI timed out after ${timeout}ms`));
    }, timeout);

    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(
          new Error(`Claude CLI exited with code ${code}: ${stderr.trim()}`),
        );
      }
    });

    child.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`Claude CLI spawn failed: ${err.message}`));
    });
  });
}

/**
 * Extract JSON from a response string that may contain markdown fences.
 */
function extractJson(text) {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }

  // Strip markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      /* fall through */
    }
  }

  // Last resort: find first { or [ and parse from there
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  let start = -1;
  if (firstBrace === -1 && firstBracket === -1)
    throw new Error('No JSON found in response');
  if (firstBrace === -1) start = firstBracket;
  else if (firstBracket === -1) start = firstBrace;
  else start = Math.min(firstBrace, firstBracket);

  const candidate = text.slice(start);
  return JSON.parse(candidate);
}

/**
 * Build a fallback recommendation when Claude is unavailable.
 */
function fallbackRecommendation(symbol = 'UNKNOWN') {
  return {
    symbol,
    recommendation: 'SKIP',
    confidence: 0,
    reason: 'AI analysis unavailable',
  };
}

// ---------------------------------------------------------------------------
// Multi-stock analysis
// ---------------------------------------------------------------------------

/**
 * Compress stock data for token-efficient prompting.
 * Strips verbose nested objects, keeps only decision-relevant fields.
 */
function compressStockData(s) {
  const t = s.technicals || {};
  return {
    sym: s.symbol,
    px: s.price,
    chg:
      s.changePct != null
        ? `${s.changePct > 0 ? '+' : ''}${s.changePct.toFixed(1)}%`
        : s.change,
    vol: s.volume,
    sector: s.sector || null,
    secRank: s.sectorRank || null,
    secTrend: s.sectorTrend || null,
    rsi: t.rsi?.value,
    rsiSig: t.rsi?.signal,
    macd: t.macd?.trend,
    atr: t.atr?.value,
    atrPct: t.atr?.percentage,
    bbPos: t.bollingerBands?.position,
    volRatio: t.volume?.ratio,
    signal: t.overallSignal,
    score: t.score,
    sup: t.supportResistance?.supports?.slice(0, 2),
    res: t.supportResistance?.resistances?.slice(0, 2),
    sma20: t.movingAverages?.sma20,
    sma50: t.movingAverages?.sma50,
    sma200: t.movingAverages?.sma200,
    patterns:
      t.candlestickPatterns
        ?.filter(p => p.significance === 'high')
        ?.map(p => p.name) || [],
    fib: t.fibonacci?.levels
      ? {
          0.382: t.fibonacci.levels['0.382'],
          0.618: t.fibonacci.levels['0.618'],
        }
      : null,
    pe: s.fundamentals?.pe,
    mcap: s.fundamentals?.marketCap,
    w52h: s.fundamentals?.fiftyTwoWeekHigh,
    w52l: s.fundamentals?.fiftyTwoWeekLow,
    news: s.news || 0,
    lotSize: s.lotSize,
  };
}

/**
 * Analyse an array of pre-processed stock data and return ranked recommendations.
 *
 * @param {Array} stockDataArray - Screened stocks with technicals, fundamentals, sector data
 * @param {object} [context] - Additional context: { fiiDii, globalCues, sectorRotation }
 * @returns {Promise<Array>} Ranked recommendations with exact field names for trade execution.
 */
export async function analyzeStocksForTrading(stockDataArray, context = {}) {
  const compressed = stockDataArray.map(compressStockData);

  // Build market context string
  const contextParts = [];
  if (context.fiiDii) {
    contextParts.push(
      `FII/DII: ${context.fiiDii.summary || context.fiiDii.sentiment || 'N/A'}`,
    );
  }
  if (context.globalCues) {
    contextParts.push(
      `Global: ${context.globalCues.sentiment || 'N/A'} (score: ${context.globalCues.sentimentScore || 0})`,
    );
  }
  if (context.sectorRotation) {
    contextParts.push(`Sector rotation: ${context.sectorRotation}`);
  }
  const mktContext =
    contextParts.length > 0 ? contextParts.join(' | ') : 'Not available';

  const prompt = `You are an expert Indian F&O options trader. Today's date: ${new Date().toISOString().split('T')[0]}.

MARKET CONTEXT: ${mktContext}

TASK: Analyze these ${compressed.length} pre-screened F&O stocks and recommend trades. Only recommend stocks where you see a clear edge — SKIP the rest. Focus on:
- Directional clarity (strong trend or reversal setup)
- Risk/reward >= 1:2
- Volume confirmation (volRatio > 1.5 preferred)
- Technical confluence (multiple indicators aligning)
- ATR-based stop-loss placement (1.5x ATR from entry)

STOCK DATA (compressed):
${JSON.stringify(compressed)}

RESPOND WITH EXACTLY THIS JSON STRUCTURE — an array of objects:
[{
  "symbol": "RELIANCE",
  "type": "CALL" | "PUT" | "SKIP",
  "confidence": 75,
  "entry_price": 2450,
  "strike": 2450,
  "expiry": "weekly",
  "premium": 45,
  "stop_loss": 2410,
  "target1": 2510,
  "target2": 2560,
  "reason": "Bullish engulfing at SMA50 support with RSI recovery from 35",
  "risk": "Global weakness could cap upside"
}]

RULES:
- "type" must be CALL, PUT, or SKIP. Use SKIP for unclear setups.
- stop_loss MUST be based on ATR (use atr field × 1.5 from entry). For CALL: entry - 1.5×ATR. For PUT: entry + 1.5×ATR.
- target1 = 2× risk, target2 = 3× risk (from entry to stop_loss distance)
- "strike" = nearest round number to current price (ATM strike)
- "premium" = rough estimate of option premium
- "reason" = 1 concise sentence explaining WHY this trade
- "risk" = 1 sentence on what could go wrong
- confidence: 80+ = high conviction, 60-79 = moderate, below 60 = low
- Rank by confidence descending
- Return 3-8 recommendations max. Quality over quantity.

RESPOND WITH VALID JSON ONLY. No markdown, no explanation, just the JSON array.`;

  try {
    const raw = await askClaude(prompt, { timeout: 120_000 });
    const parsed = extractJson(raw);
    const results = Array.isArray(parsed)
      ? parsed
      : (parsed.recommendations ?? parsed.stocks ?? [parsed]);

    // Normalize field names and validate
    return results
      .map(r => ({
        symbol: r.symbol,
        type: normalizeType(r.type || r.recommendation),
        confidence: Math.min(100, Math.max(0, r.confidence ?? 0)),
        entry_price: r.entry_price ?? r.entryPrice ?? null,
        strike: r.strike ?? null,
        expiry: r.expiry ?? null,
        premium: r.premium ?? null,
        stop_loss: r.stop_loss ?? r.stopLoss ?? null,
        target1: r.target1 ?? null,
        target2: r.target2 ?? null,
        reason: r.reason ?? r.reasoning ?? '',
        risk: r.risk ?? r.riskFactors?.[0] ?? '',
        capitalRequired: r.capitalRequired ?? null,
        maxLoss: r.maxLoss ?? null,
      }))
      .filter(r => r.symbol && r.type !== 'SKIP')
      .sort((a, b) => b.confidence - a.confidence);
  } catch (err) {
    console.error('[claude] analyzeStocksForTrading failed:', err.message);
    return stockDataArray.map(s => fallbackRecommendation(s.symbol));
  }
}

function normalizeType(type) {
  if (!type) return 'SKIP';
  const t = String(type).toUpperCase().trim();
  if (t === 'CALL' || t === 'BUY') return 'CALL';
  if (t === 'PUT' || t === 'SELL') return 'PUT';
  if (t === 'NEUTRAL' || t === 'SKIP') return 'SKIP';
  return 'SKIP';
}

// ---------------------------------------------------------------------------
// Single stock — quick
// ---------------------------------------------------------------------------

/**
 * Quick single-stock analysis.
 *
 * @param {{symbol, price, change, volume, technicals, news}} stockData
 * @returns {Promise<object>} Recommendation.
 */
export async function analyzeStockQuick(stockData) {
  const t = stockData.technicals || {};
  const compact = {
    sym: stockData.symbol,
    px: stockData.price,
    chg: stockData.change,
    vol: stockData.volume,
    rsi: t.rsi?.value,
    macd: t.macd?.trend,
    atr: t.atr?.value,
    bbPos: t.bollingerBands?.position,
    signal: t.overallSignal,
    score: t.score,
    sup: t.supportResistance?.supports?.slice(0, 2),
    res: t.supportResistance?.resistances?.slice(0, 2),
    patterns:
      t.candlestickPatterns
        ?.filter(p => p.significance === 'high')
        ?.map(p => p.name) || [],
  };

  const newsStr =
    Array.isArray(stockData.news) && stockData.news.length > 0
      ? stockData.news
          .slice(0, 5)
          .map(n => (typeof n === 'string' ? n : n.title || ''))
          .filter(Boolean)
          .join('; ')
      : 'None';

  const prompt = `Expert Indian F&O trader. Quick analysis for ${stockData.symbol}.

DATA: ${JSON.stringify(compact)}
NEWS: ${newsStr}

RESPOND JSON:
{
  "type": "CALL|PUT|SKIP",
  "confidence": 0-100,
  "entry_price": number,
  "stop_loss": number (ATR-based: entry ± 1.5×ATR),
  "target1": number (2× risk),
  "target2": number (3× risk),
  "reason": "1 sentence",
  "risk": "1 sentence",
  "keyLevels": { "support": [numbers], "resistance": [numbers] }
}

JSON only. No markdown.`;

  try {
    const raw = await askClaude(prompt, { timeout: 60_000 });
    const result = extractJson(raw);
    // Normalize field names
    return {
      ...result,
      type: normalizeType(result.type || result.recommendation),
      entry_price: result.entry_price ?? result.entryPrice,
      stop_loss: result.stop_loss ?? result.stopLoss,
    };
  } catch (err) {
    console.error('[claude] analyzeStockQuick failed:', err.message);
    return fallbackRecommendation(stockData.symbol);
  }
}

// ---------------------------------------------------------------------------
// Single stock — deep
// ---------------------------------------------------------------------------

/**
 * Deep single-stock analysis with full context.
 *
 * @param {{symbol, price, change, volume, technicals, history90d, optionsChain, news, sectorContext}} stockData
 * @returns {Promise<object>} Comprehensive analysis.
 */
export async function analyzeStockDeep(stockData) {
  const t = stockData.technicals || {};

  // Compress technicals
  const techCompact = {
    rsi: t.rsi?.value,
    rsiSig: t.rsi?.signal,
    macd: t.macd?.trend,
    macdHist: t.macd?.histogram,
    atr: t.atr?.value,
    atrPct: t.atr?.percentage,
    bb: {
      pos: t.bollingerBands?.position,
      upper: t.bollingerBands?.upper,
      lower: t.bollingerBands?.lower,
    },
    sma: {
      s20: t.movingAverages?.sma20,
      s50: t.movingAverages?.sma50,
      s200: t.movingAverages?.sma200,
    },
    ema: { e9: t.movingAverages?.ema9, e21: t.movingAverages?.ema21 },
    volRatio: t.volume?.ratio,
    volSignal: t.volume?.signal,
    signal: t.overallSignal,
    score: t.score,
    sup: t.supportResistance?.supports,
    res: t.supportResistance?.resistances,
    fib: t.fibonacci?.levels,
    patterns:
      t.candlestickPatterns?.map(
        p => `${p.name}(${p.type},${p.significance})`,
      ) || [],
  };

  // Compress 90d history to key stats
  const hist = stockData.history90d;
  let histSummary = 'N/A';
  if (Array.isArray(hist) && hist.length > 0) {
    const closes = hist.map(h => h.close).filter(Boolean);
    const high90 = Math.max(...closes);
    const low90 = Math.min(...closes);
    const first = closes[0];
    const last = closes[closes.length - 1];
    const change90 = (((last - first) / first) * 100).toFixed(1);
    histSummary = `90d: ${low90.toFixed(0)}-${high90.toFixed(0)}, change: ${change90}%, days: ${closes.length}`;
  }

  // Options chain — compress to nearby strikes only
  let optionsStr = 'Not available';
  if (stockData.optionsChain) {
    const oc = stockData.optionsChain;
    const nearCalls = (oc.calls || [])
      .filter(c => c.openInterest > 0)
      .sort((a, b) => b.openInterest - a.openInterest)
      .slice(0, 5)
      .map(
        c =>
          `${c.strike}CE: OI=${c.openInterest}, IV=${(c.impliedVolatility * 100).toFixed(0)}%, Px=${c.lastPrice}`,
      );
    const nearPuts = (oc.puts || [])
      .filter(p => p.openInterest > 0)
      .sort((a, b) => b.openInterest - a.openInterest)
      .slice(0, 5)
      .map(
        p =>
          `${p.strike}PE: OI=${p.openInterest}, IV=${(p.impliedVolatility * 100).toFixed(0)}%, Px=${p.lastPrice}`,
      );
    optionsStr = `Top CE by OI: ${nearCalls.join('; ')} | Top PE by OI: ${nearPuts.join('; ')}`;
  }

  const newsStr = Array.isArray(stockData.news)
    ? stockData.news
        .slice(0, 10)
        .map(n => (typeof n === 'string' ? n : n.title || ''))
        .filter(Boolean)
        .join('; ')
    : 'None';

  const prompt = `Senior Indian F&O analyst. Deep analysis for ${stockData.symbol} (₹${stockData.price}, ${stockData.change}%).

TECHNICALS: ${JSON.stringify(techCompact)}
HISTORY: ${histSummary}
OPTIONS: ${optionsStr}
SECTOR: ${stockData.sectorContext || 'N/A'}
NEWS: ${newsStr}

RESPOND WITH THIS EXACT JSON:
{
  "type": "CALL|PUT|SKIP",
  "confidence": 0-100,
  "reasoning": "detailed 3-4 sentence analysis",
  "entryStrategy": {
    "entry_price": number,
    "entryCondition": "e.g. wait for pullback to SMA20"
  },
  "exitStrategy": {
    "target1": number (2× risk),
    "target2": number (3× risk),
    "trailingStopTrigger": "e.g. move SL to breakeven after T1"
  },
  "stop_loss": number (ATR-based),
  "optionSelection": {
    "strike": number,
    "expiry": "weekly|monthly",
    "optionType": "CE|PE",
    "premiumEstimate": number
  },
  "riskFactors": ["risk1", "risk2"],
  "keyLevels": {
    "support": [numbers],
    "resistance": [numbers]
  }
}

RULES:
- stop_loss = entry ± 1.5×ATR (use atr field)
- target1 = 2× risk from entry, target2 = 3× risk
- Strike = ATM (nearest round to current price)
- Include OI-based analysis if options data available
- Be specific with numbers — no vague "around" levels
- JSON ONLY. No markdown.`;

  try {
    const raw = await askClaude(prompt, { timeout: 180_000 });
    const result = extractJson(raw);

    // Normalize field names for consistency
    return {
      symbol: stockData.symbol,
      type: normalizeType(result.type || result.recommendation),
      confidence: result.confidence ?? 0,
      reasoning: result.reasoning || '',
      entry_price:
        result.entryStrategy?.entry_price ??
        result.entry_price ??
        result.entryPrice ??
        null,
      entryCondition: result.entryStrategy?.entryCondition ?? null,
      stop_loss: result.stop_loss ?? result.stopLoss ?? null,
      target1: result.exitStrategy?.target1 ?? result.target1 ?? null,
      target2: result.exitStrategy?.target2 ?? result.target2 ?? null,
      trailingStopTrigger: result.exitStrategy?.trailingStopTrigger ?? null,
      optionSelection: result.optionSelection ?? null,
      riskFactors: result.riskFactors ?? [],
      keyLevels: result.keyLevels ?? null,
    };
  } catch (err) {
    console.error('[claude] analyzeStockDeep failed:', err.message);
    return {
      ...fallbackRecommendation(stockData.symbol),
      entryStrategy: null,
      exitStrategy: null,
      optionSelection: null,
      riskFactors: ['AI analysis unavailable'],
      keyLevels: null,
    };
  }
}

// ---------------------------------------------------------------------------
// News interpretation
// ---------------------------------------------------------------------------

/**
 * Interpret news sentiment for a symbol.
 *
 * @param {Array<string|{title,summary}>} newsItems
 * @param {string} symbol
 * @returns {Promise<{sentiment, score, keyPoints, tradingImpact}>}
 */
export async function interpretNews(newsItems, symbol) {
  const headlines = newsItems.map(n =>
    typeof n === 'string' ? n : (n.title ?? JSON.stringify(n)),
  );

  const prompt = [
    `You are an expert market analyst. Interpret the following news for ${symbol}.`,
    '',
    'News items:',
    ...headlines.map((h, i) => `${i + 1}. ${h}`),
    '',
    'Provide:',
    '  sentiment: "bullish" | "bearish" | "neutral",',
    '  score: -5 (very bearish) to +5 (very bullish),',
    '  keyPoints: [ up to 3 concise takeaways ],',
    '  tradingImpact: one sentence on how this affects a short-term F&O trade.',
    '',
    'Respond in valid JSON only, no markdown formatting.',
  ].join('\n');

  try {
    const raw = await askClaude(prompt, { timeout: 60_000 });
    return extractJson(raw);
  } catch (err) {
    console.error('[claude] interpretNews failed:', err.message);
    return {
      sentiment: 'neutral',
      score: 0,
      keyPoints: ['Unable to analyse news'],
      tradingImpact: 'AI analysis unavailable — treat as neutral.',
    };
  }
}

// ---------------------------------------------------------------------------
// Exit analysis
// ---------------------------------------------------------------------------

/**
 * Generate exit analysis for an open trade.
 *
 * @param {object} trade - The open trade from DB.
 * @param {object} currentMarketData - { price, change, volume, technicals }
 * @returns {Promise<{action, reason, newStopLoss}>}
 */
export async function generateExitAnalysis(trade, currentMarketData) {
  const prompt = [
    'You are an expert F&O trade manager. Evaluate this open position and advise the next action.',
    '',
    'Open Trade:',
    `  Symbol: ${trade.symbol}`,
    `  Type: ${trade.type}`,
    `  Entry Price: ${trade.entry_price}`,
    `  Current Price: ${currentMarketData.price}`,
    `  Stop-Loss: ${trade.stop_loss}`,
    `  Trailing Stop: ${trade.trailing_stop ?? 'not set'}`,
    `  Target 1: ${trade.target1} (hit: ${trade.t1_hit ? 'yes' : 'no'})`,
    `  Target 2: ${trade.target2} (hit: ${trade.t2_hit ? 'yes' : 'no'})`,
    `  Quantity remaining: ${trade.quantity}`,
    `  Entered at: ${trade.entered_at}`,
    '',
    'Current Market:',
    `  Price: ${currentMarketData.price}`,
    `  Change: ${currentMarketData.change}%`,
    `  Volume: ${currentMarketData.volume}`,
    '  Technicals:',
    JSON.stringify(currentMarketData.technicals ?? {}, null, 2),
    '',
    'Should we: HOLD, PARTIAL_EXIT (book partial profits), or FULL_EXIT?',
    'Provide:',
    '  action: "HOLD" | "PARTIAL_EXIT" | "FULL_EXIT",',
    '  reason: one sentence,',
    '  newStopLoss: updated stop-loss price (or null if unchanged).',
    '',
    'Respond in valid JSON only, no markdown formatting.',
  ].join('\n');

  try {
    const raw = await askClaude(prompt, { timeout: 60_000 });
    return extractJson(raw);
  } catch (err) {
    console.error('[claude] generateExitAnalysis failed:', err.message);
    return {
      action: 'HOLD',
      reason: 'AI analysis unavailable — maintaining current position.',
      newStopLoss: null,
    };
  }
}

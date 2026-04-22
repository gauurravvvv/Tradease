import { spawn } from 'child_process';

/**
 * Call Claude CLI in non-interactive mode and return the response text.
 *
 * @param {string} prompt - The prompt to send.
 * @param {object} options - { timeout, maxTokens }
 * @returns {Promise<string>} Claude's response text.
 */
export async function askClaude(prompt, options = {}) {
  const { timeout = 120_000, maxTokens = 4000 } = options;

  return new Promise((resolve, reject) => {
    const args = ['--print', '-p', prompt];
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

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Claude CLI timed out after ${timeout}ms`));
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr.trim()}`));
      }
    });

    child.on('error', (err) => {
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
  } catch { /* fall through */ }

  // Strip markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch { /* fall through */ }
  }

  // Last resort: find first { or [ and parse from there
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  let start = -1;
  if (firstBrace === -1 && firstBracket === -1) throw new Error('No JSON found in response');
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
 * Analyse an array of pre-processed stock data and return ranked recommendations.
 *
 * @param {Array<{symbol, price, change, volume, technicals, news}>} stockDataArray
 * @returns {Promise<Array>} Ranked recommendations.
 */
export async function analyzeStocksForTrading(stockDataArray) {
  const stockSummaries = stockDataArray.map((s) => ({
    symbol: s.symbol,
    price: s.price,
    changePct: s.change,
    volume: s.volume,
    technicals: s.technicals,
    recentNews: Array.isArray(s.news) ? s.news.slice(0, 5) : [],
  }));

  const prompt = [
    'You are an expert Indian F&O (Futures & Options) trader.',
    'Analyse the following stocks and for each provide a trading recommendation.',
    '',
    'Considerations:',
    '- Technical indicators (RSI, MACD, Bollinger Bands, ATR, moving averages)',
    '- News sentiment and potential impact',
    '- Sector trends and global cues',
    '- Volume confirmation',
    '',
    'For EACH stock return:',
    '  symbol, recommendation (CALL | PUT | SKIP), confidence (0-100),',
    '  entryPrice, stopLoss, target1, target2, reasoning (1-2 sentences).',
    '',
    'Rank the results by confidence descending.',
    '',
    'Stock data:',
    JSON.stringify(stockSummaries, null, 2),
    '',
    'Respond in valid JSON only, no markdown formatting.',
    'Return an array of objects.',
  ].join('\n');

  try {
    const raw = await askClaude(prompt, { timeout: 120_000, maxTokens: 4000 });
    const parsed = extractJson(raw);
    const results = Array.isArray(parsed) ? parsed : parsed.recommendations ?? parsed.stocks ?? [parsed];
    return results.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  } catch (err) {
    console.error('[claude] analyzeStocksForTrading failed:', err.message);
    return stockDataArray.map((s) => fallbackRecommendation(s.symbol));
  }
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
  const prompt = [
    'You are an expert Indian F&O trader. Give a quick trading call for this stock.',
    '',
    `Symbol: ${stockData.symbol}`,
    `Current Price: ${stockData.price}`,
    `Change: ${stockData.change}%`,
    `Volume: ${stockData.volume}`,
    '',
    'Technicals:',
    JSON.stringify(stockData.technicals ?? {}, null, 2),
    '',
    'Recent news headlines:',
    ...(Array.isArray(stockData.news) ? stockData.news.slice(0, 5).map((n) => `- ${n}`) : []),
    '',
    'Provide:',
    '  recommendation (CALL | PUT | SKIP), confidence (0-100),',
    '  entryPrice, stopLoss, target1, target2,',
    '  keyLevels: { support, resistance },',
    '  reasoning (1-2 sentences).',
    '',
    'Respond in valid JSON only, no markdown formatting.',
  ].join('\n');

  try {
    const raw = await askClaude(prompt, { timeout: 60_000, maxTokens: 2000 });
    return extractJson(raw);
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
  const prompt = [
    'You are a senior Indian F&O analyst. Provide a comprehensive trading analysis.',
    '',
    `Symbol: ${stockData.symbol}`,
    `Current Price: ${stockData.price}`,
    `Change: ${stockData.change}%`,
    `Volume: ${stockData.volume}`,
    '',
    'Full Technicals:',
    JSON.stringify(stockData.technicals ?? {}, null, 2),
    '',
    '90-Day Price History Summary:',
    JSON.stringify(stockData.history90d ?? {}, null, 2),
    '',
    stockData.optionsChain
      ? `Options Chain (relevant strikes):\n${JSON.stringify(stockData.optionsChain, null, 2)}`
      : 'Options chain data not available.',
    '',
    'All Recent News:',
    ...(Array.isArray(stockData.news)
      ? stockData.news.map((n) => `- ${typeof n === 'string' ? n : n.title ?? JSON.stringify(n)}`)
      : []),
    '',
    `Sector Context: ${stockData.sectorContext ?? 'N/A'}`,
    '',
    'Provide a DETAILED analysis with:',
    '  recommendation (CALL | PUT | SKIP), confidence (0-100),',
    '  entryStrategy: { entryPrice, entryCondition },',
    '  exitStrategy: { target1, target2, trailingStop },',
    '  stopLoss, maxRisk,',
    '  optionSelection: { strike, expiry, type, premiumEstimate },',
    '  riskFactors: [ list of key risks ],',
    '  keyLevels: { support: [], resistance: [] },',
    '  reasoning (detailed paragraph).',
    '',
    'Respond in valid JSON only, no markdown formatting.',
  ].join('\n');

  try {
    const raw = await askClaude(prompt, { timeout: 180_000, maxTokens: 4000 });
    return extractJson(raw);
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
  const headlines = newsItems.map((n) => (typeof n === 'string' ? n : n.title ?? JSON.stringify(n)));

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
    const raw = await askClaude(prompt, { timeout: 60_000, maxTokens: 1500 });
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
    const raw = await askClaude(prompt, { timeout: 60_000, maxTokens: 1500 });
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

import { FNO_STOCKS } from '../data/fno-stocks.js';
import { getMultipleQuotes, getBatchHistorical } from '../data/market.js';
import { analyzeTechnicals } from './technicals.js';
import { fetchAllNews } from '../data/news.js';

/**
 * Full stock screener — fetches quotes, historical, technicals, news.
 * Scores and ranks F&O stocks. Returns top 15 candidates.
 * @returns {Promise<Array>} Top 15 screened stocks with all data
 */
export async function screenStocks() {
  const symbols = FNO_STOCKS.map(s => s.symbol);

  // Parallel fetch: quotes, historical, news
  const [quotesArr, historicalMap, newsItems] = await Promise.all([
    getMultipleQuotes(symbols),
    getBatchHistorical(symbols, 90),
    fetchAllNews(),
  ]);

  // Convert quotes array to map by symbol
  const quotesMap = {};
  for (const q of quotesArr) quotesMap[q.symbol] = q;

  // Build news mention map: symbol -> count of mentions
  const newsMentions = buildNewsMentionMap(newsItems, FNO_STOCKS);

  // Score each stock
  const scored = [];

  for (const stock of FNO_STOCKS) {
    const quote = quotesMap[stock.symbol];
    const historical = historicalMap[stock.symbol];

    if (!quote || !historical || historical.length < 20) continue;

    const technicals = analyzeTechnicals(historical);
    const newsCount = newsMentions[stock.symbol] || 0;

    const totalScore = computeScreenerScore(quote, technicals, newsCount);
    const recommendation = deriveRecommendation(technicals);

    scored.push({
      symbol: stock.symbol,
      name: stock.name,
      lotSize: stock.lotSize,
      sector: stock.sector || null,
      price: quote.price,
      change: quote.change,
      volume: quote.volume,
      technicals,
      news: newsCount,
      score: totalScore,
      recommendation,
    });
  }

  // Sort by score descending, return top 15
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 15);
}

/**
 * Quick screen — quotes only, no historical/technicals.
 * Filters by volume and price change. Returns top 20.
 * @returns {Promise<Array>} Top 20 stocks by quick score
 */
export async function quickScreen() {
  const symbols = FNO_STOCKS.map(s => s.symbol);
  const quotesArr = await getMultipleQuotes(symbols);

  // Convert to map
  const quotesMap = {};
  for (const q of quotesArr) quotesMap[q.symbol] = q;

  const results = [];

  for (const stock of FNO_STOCKS) {
    const quote = quotesMap[stock.symbol];
    if (!quote) continue;

    // Quick filters
    const absChange = Math.abs(quote.change || 0);
    const volumeOk = quote.volume > 0;

    if (!volumeOk) continue;

    // Quick score: weight absolute price movement + volume
    const changeScore = Math.min(absChange * 10, 40); // Max 40 from change
    const volumeScore = quote.volume > 5000000 ? 30
      : quote.volume > 2000000 ? 20
      : quote.volume > 1000000 ? 10
      : 5;

    const quickScore = Math.round(changeScore + volumeScore);
    const recommendation = quote.change > 1 ? 'CALL'
      : quote.change < -1 ? 'PUT'
      : 'NEUTRAL';

    results.push({
      symbol: stock.symbol,
      name: stock.name,
      lotSize: stock.lotSize,
      sector: stock.sector || null,
      price: quote.price,
      change: quote.change,
      volume: quote.volume,
      technicals: null,
      news: 0,
      score: quickScore,
      recommendation,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 20);
}

// ─── Internal helpers ────────────────────────────────────────────────

/**
 * Build map of symbol -> news mention count.
 * Checks stock symbol and name in news title/content.
 */
function buildNewsMentionMap(newsItems, stocks) {
  const mentions = {};

  if (!newsItems || newsItems.length === 0) return mentions;

  for (const stock of stocks) {
    let count = 0;
    const sym = stock.symbol.replace('.NS', '').toUpperCase();
    const nameLower = stock.name.toLowerCase();

    for (const news of newsItems) {
      const text = ((news.title || '') + ' ' + (news.content || '')).toLowerCase();
      if (text.includes(sym.toLowerCase()) || text.includes(nameLower)) {
        count++;
      }
    }
    mentions[stock.symbol] = count;
  }

  return mentions;
}

/**
 * Compute composite screener score (0-100).
 *
 * Weights:
 *   volumeSurge   20%
 *   technicalScore 30%
 *   momentumScore  20%
 *   proximityScore 15%
 *   newsScore      15%
 */
function computeScreenerScore(quote, technicals, newsCount) {
  // Volume surge (20%): ratio vs 20-day avg
  const volRatio = technicals.volume.ratio || 0;
  const volumeSurge = Math.min(volRatio / 3, 1) * 20; // 3x avg = max score

  // Technical score (30%): from analyzeTechnicals overall score (0-100)
  const technicalScore = (technicals.score / 100) * 30;

  // Momentum score (20%): RSI and MACD signals
  let momentumScore = 10; // Neutral baseline
  if (technicals.rsi.signal === 'oversold') momentumScore += 5;
  else if (technicals.rsi.signal === 'overbought') momentumScore += 3; // Still tradeable (PUT)

  if (technicals.macd.trend === 'bullish_crossover') momentumScore += 5;
  else if (technicals.macd.trend === 'bearish_crossover') momentumScore += 4;
  else if (technicals.macd.trend === 'bullish') momentumScore += 2;
  else if (technicals.macd.trend === 'bearish') momentumScore += 1;
  momentumScore = Math.min(momentumScore, 20);

  // Proximity score (15%): how close to support or resistance
  let proximityScore = 0;
  const price = quote.price;
  if (price > 0) {
    const { supports, resistances } = technicals.supportResistance;

    if (supports.length > 0) {
      const nearestSupport = supports.reduce((best, s) =>
        Math.abs(s - price) < Math.abs(best - price) ? s : best
      );
      const supportDist = Math.abs(price - nearestSupport) / price;
      if (supportDist < 0.03) proximityScore += 7.5; // Within 3% of support
      else if (supportDist < 0.05) proximityScore += 4;
    }

    if (resistances.length > 0) {
      const nearestResistance = resistances.reduce((best, r) =>
        Math.abs(r - price) < Math.abs(best - price) ? r : best
      );
      const resistanceDist = Math.abs(price - nearestResistance) / price;
      if (resistanceDist < 0.03) proximityScore += 7.5;
      else if (resistanceDist < 0.05) proximityScore += 4;
    }
    proximityScore = Math.min(proximityScore, 15);
  }

  // News score (15%): recent mentions
  const newsScore = Math.min(newsCount / 5, 1) * 15; // 5+ mentions = max

  const total = volumeSurge + technicalScore + momentumScore + proximityScore + newsScore;
  return Math.round(Math.min(total, 100) * 100) / 100;
}

/**
 * Derive CALL/PUT/NEUTRAL from technical analysis.
 */
function deriveRecommendation(technicals) {
  const { overallSignal } = technicals;
  if (overallSignal === 'STRONG_BUY' || overallSignal === 'BUY') return 'CALL';
  if (overallSignal === 'STRONG_SELL' || overallSignal === 'SELL') return 'PUT';
  return 'NEUTRAL';
}

import { FNO_STOCKS } from '../data/fno-stocks.js';
import { getMultipleQuotes, getBatchHistorical } from '../data/market.js';
import { analyzeTechnicals } from './technicals.js';
import { fetchAllNews } from '../data/news.js';
import { getSectorStrength } from './sectors.js';
import { getFiiDiiData } from '../data/fii-dii.js';
import { getGlobalCues } from '../data/global-cues.js';

/**
 * Full stock screener — fetches quotes, historical, technicals, news.
 * Scores and ranks F&O stocks. Returns top 15 candidates.
 * @returns {Promise<Array>} Top 15 screened stocks with all data
 */
export async function screenStocks() {
  const symbols = FNO_STOCKS.map(s => s.symbol);

  // Parallel fetch: quotes, historical, news, sectors, FII/DII, global cues
  const [quotesArr, historicalMap, newsItems, sectorData, fiiDiiData, globalCues] = await Promise.all([
    getMultipleQuotes(symbols),
    getBatchHistorical(symbols, 90),
    fetchAllNews(),
    getSectorStrength().catch(() => []),
    getFiiDiiData().catch(() => null),
    getGlobalCues().catch(() => null),
  ]);

  // Convert quotes array to map by symbol
  const quotesMap = {};
  for (const q of quotesArr) quotesMap[q.symbol] = q;

  // Build sector map: sectorName -> sectorObj
  const sectorMap = {};
  for (const s of sectorData) sectorMap[s.sector] = s;

  // Map stock sectors to index names
  const SECTOR_ALIAS = {
    Banking: 'Bank', Finance: 'Financial Services', IT: 'IT',
    Energy: 'Energy', Auto: 'Auto', Metals: 'Metal', Pharma: 'Pharma',
    FMCG: 'FMCG', Infra: 'Infrastructure', Telecom: 'IT', Cement: 'Infrastructure',
    Realty: 'Realty',
  };

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

    // Get sector strength for this stock
    const sectorKey = SECTOR_ALIAS[stock.sector] || stock.sector;
    const sectorInfo = sectorMap[sectorKey] || null;

    const totalScore = computeScreenerScore(quote, technicals, newsCount, sectorInfo, fiiDiiData, globalCues);
    const recommendation = deriveRecommendation(technicals, sectorInfo, fiiDiiData, globalCues);

    scored.push({
      symbol: stock.symbol,
      name: stock.name,
      lotSize: stock.lotSize,
      sector: stock.sector || null,
      sectorRank: sectorInfo?.rank || null,
      sectorTrend: sectorInfo?.trend || null,
      sectorMomentum: sectorInfo?.momentumScore || null,
      fiiDii: fiiDiiData,
      price: quote.price,
      change: quote.change,
      changePct: quote.changePct,
      volume: quote.volume,
      technicals,
      fundamentals: {
        pe: quote.pe, eps: quote.eps, marketCap: quote.marketCap,
        fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh, fiftyTwoWeekLow: quote.fiftyTwoWeekLow,
      },
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
 *   volumeSurge    12%
 *   technicalScore 22%
 *   momentumScore  13%
 *   proximityScore 10%
 *   newsScore       8%
 *   sectorScore    13%  (sector momentum + relative strength)
 *   fiiDiiScore     8%  (institutional flow sentiment)
 *   globalScore     8%  (global market sentiment)
 *   volatilityScore 6%  (VIX-based risk appetite)
 */
function computeScreenerScore(quote, technicals, newsCount, sectorInfo, fiiDiiData, globalCues) {
  // Volume surge (12%)
  const volRatio = technicals.volume.ratio || 0;
  const volumeSurge = Math.min(volRatio / 3, 1) * 12;

  // Technical score (22%)
  const technicalScore = (technicals.score / 100) * 22;

  // Momentum score (13%)
  let momentumScore = 6;
  if (technicals.rsi.signal === 'oversold') momentumScore += 4;
  else if (technicals.rsi.signal === 'overbought') momentumScore += 2;

  if (technicals.macd.trend === 'bullish_crossover') momentumScore += 3;
  else if (technicals.macd.trend === 'bearish_crossover') momentumScore += 3;
  else if (technicals.macd.trend === 'bullish') momentumScore += 2;
  else if (technicals.macd.trend === 'bearish') momentumScore += 1;
  momentumScore = Math.min(momentumScore, 13);

  // Proximity score (10%)
  let proximityScore = 0;
  const price = quote.price;
  if (price > 0) {
    const { supports, resistances } = technicals.supportResistance;

    if (supports.length > 0) {
      const nearestSupport = supports.reduce((best, s) =>
        Math.abs(s - price) < Math.abs(best - price) ? s : best
      );
      const supportDist = Math.abs(price - nearestSupport) / price;
      if (supportDist < 0.03) proximityScore += 5;
      else if (supportDist < 0.05) proximityScore += 3;
    }

    if (resistances.length > 0) {
      const nearestResistance = resistances.reduce((best, r) =>
        Math.abs(r - price) < Math.abs(best - price) ? r : best
      );
      const resistanceDist = Math.abs(price - nearestResistance) / price;
      if (resistanceDist < 0.03) proximityScore += 5;
      else if (resistanceDist < 0.05) proximityScore += 3;
    }
    proximityScore = Math.min(proximityScore, 10);
  }

  // News score (8%)
  const newsScore = Math.min(newsCount / 5, 1) * 8;

  // Sector score (13%)
  let sectorScore = 4;
  if (sectorInfo) {
    const mom = sectorInfo.momentumScore || 0;
    sectorScore += Math.round(((mom + 100) / 200) * 9);
    if (sectorInfo.rank <= 3) sectorScore += 2;
    else if (sectorInfo.rank <= 6) sectorScore += 1;
  }
  sectorScore = Math.min(sectorScore, 13);

  // FII/DII score (8%)
  let fiiDiiScore = 4;
  if (fiiDiiData) {
    if (fiiDiiData.fii?.signal === 'BUYING') fiiDiiScore += 2;
    else if (fiiDiiData.fii?.signal === 'SELLING') fiiDiiScore -= 2;
    if (fiiDiiData.dii?.signal === 'BUYING') fiiDiiScore += 1;
    if (fiiDiiData.sentiment === 'BULLISH') fiiDiiScore += 2;
    else if (fiiDiiData.sentiment === 'BEARISH') fiiDiiScore -= 2;
  }
  fiiDiiScore = Math.max(0, Math.min(fiiDiiScore, 8));

  // Global cues score (8%): US/Asia markets, DXY, VIX sentiment
  let globalScore = 4;
  if (globalCues) {
    // sentimentScore is -100 to +100
    const gs = globalCues.sentimentScore || 0;
    // Map to 0-8 range: -100→0, 0→4, +100→8
    globalScore = Math.round(((gs + 100) / 200) * 8);
  }
  globalScore = Math.max(0, Math.min(globalScore, 8));

  // Volatility score (6%): high VIX = more trading opportunity
  let volatilityScore = 3;
  if (globalCues?.volatility?.vix) {
    const vixPrice = globalCues.volatility.vix.price || 0;
    // VIX 15-25 = sweet spot (enough movement, not panic)
    if (vixPrice >= 15 && vixPrice <= 25) volatilityScore = 6;
    else if (vixPrice > 25 && vixPrice <= 35) volatilityScore = 4; // elevated but tradeable
    else if (vixPrice > 35) volatilityScore = 2; // panic — reduce score
    else volatilityScore = 3; // low VIX, less opportunity
  }

  const total = volumeSurge + technicalScore + momentumScore + proximityScore +
    newsScore + sectorScore + fiiDiiScore + globalScore + volatilityScore;
  return Math.round(Math.min(total, 100) * 100) / 100;
}

/**
 * Derive CALL/PUT/NEUTRAL from technicals + sector + FII/DII.
 *
 * Points system:  >= +2 → CALL,  <= -2 → PUT,  else NEUTRAL.
 * Stronger signals when sector + technicals + institutions align.
 */
function deriveRecommendation(technicals, sectorInfo, fiiDiiData, globalCues) {
  let points = 0;

  // Technical signal (strongest weight)
  const { overallSignal } = technicals;
  if (overallSignal === 'STRONG_BUY') points += 3;
  else if (overallSignal === 'BUY') points += 2;
  else if (overallSignal === 'STRONG_SELL') points -= 3;
  else if (overallSignal === 'SELL') points -= 2;

  // Sector trend
  if (sectorInfo) {
    const trend = sectorInfo.trend;
    if (trend === 'strong_up') points += 1;
    else if (trend === 'strong_down') points -= 1;
    if (sectorInfo.rank <= 3) points += 1;
    else if (sectorInfo.rank >= 10) points -= 1;
  }

  // FII/DII sentiment
  if (fiiDiiData) {
    if (fiiDiiData.sentiment === 'BULLISH') points += 1;
    else if (fiiDiiData.sentiment === 'BEARISH') points -= 1;
  }

  // Global cues — nudge direction based on world markets
  if (globalCues) {
    if (globalCues.sentiment === 'BULLISH') points += 1;
    else if (globalCues.sentiment === 'BEARISH') points -= 1;
  }

  if (points >= 2) return 'CALL';
  if (points <= -2) return 'PUT';
  return 'NEUTRAL';
}

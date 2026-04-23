import { getStockNews } from '../data/news.js';

/**
 * Negative keyword patterns for quick sentiment scoring.
 * Weighted: strong negative = -2, mild negative = -1, positive = +1.
 */
const NEGATIVE_KEYWORDS = [
  // Strong negative (-2)
  {
    pattern: /fraud|scam|sebi action|penalty|ban|downgrade|default|bankrupt/i,
    weight: -2,
  },
  { pattern: /crash|plunge|tank|collapse|selloff|sell-off/i, weight: -2 },
  { pattern: /probe|investigation|raid|arrest|money laundering/i, weight: -2 },
  // Mild negative (-1)
  {
    pattern:
      /miss|disappoint|below estimate|weak|concern|risk|warning|caution/i,
    weight: -1,
  },
  { pattern: /decline|drop|fall|slip|slide|pressure|volatile/i, weight: -1 },
  { pattern: /downtrend|bearish|resistance|breakdown|sell/i, weight: -1 },
];

const POSITIVE_KEYWORDS = [
  { pattern: /beat|exceed|surge|rally|bullish|upgrade|outperform/i, weight: 1 },
  {
    pattern: /record high|all-time high|breakout|strong buy|accumulate/i,
    weight: 2,
  },
  { pattern: /dividend|bonus|buyback|expansion|order win/i, weight: 1 },
];

/**
 * Score a news item's sentiment based on keyword matching.
 * Returns number: negative = bearish, positive = bullish.
 */
export function scoreSentiment(newsItem) {
  const text = `${newsItem.title || ''} ${newsItem.snippet || ''}`;
  let score = 0;

  for (const { pattern, weight } of NEGATIVE_KEYWORDS) {
    if (pattern.test(text)) score += weight;
  }
  for (const { pattern, weight } of POSITIVE_KEYWORDS) {
    if (pattern.test(text)) score += weight;
  }

  return score;
}

/**
 * Classify overall sentiment from score.
 */
export function classifySentiment(score) {
  if (score <= -3) return 'very_negative';
  if (score <= -1) return 'negative';
  if (score >= 3) return 'very_positive';
  if (score >= 1) return 'positive';
  return 'neutral';
}

/**
 * Check news for all open positions.
 *
 * @param {object[]} openTrades - Array of open trade objects
 * @returns {Promise<Array<{ trade: object, newsItems: object[], sentiment: string, sentimentScore: number, alert: boolean }>>}
 */
export async function checkNewsForPositions(openTrades) {
  const results = [];

  // Deduplicate symbols — multiple trades on same stock shouldn't double-fetch
  const symbolMap = new Map();
  for (const trade of openTrades) {
    if (!symbolMap.has(trade.symbol)) {
      symbolMap.set(trade.symbol, []);
    }
    symbolMap.get(trade.symbol).push(trade);
  }

  const newsPromises = [...symbolMap.keys()].map(async symbol => {
    try {
      const news = await getStockNews(symbol);
      return { symbol, news };
    } catch (err) {
      console.error(
        `[news-monitor] Failed to fetch news for ${symbol}: ${err.message}`,
      );
      return { symbol, news: [] };
    }
  });

  const newsResults = await Promise.all(newsPromises);
  const newsBySymbol = new Map(newsResults.map(r => [r.symbol, r.news]));

  for (const trade of openTrades) {
    const newsItems = newsBySymbol.get(trade.symbol) || [];

    // Score each article, compute aggregate
    let totalScore = 0;
    const scored = newsItems.map(item => {
      const score = scoreSentiment(item);
      totalScore += score;
      return { ...item, score };
    });

    // Filter to only items with non-zero sentiment
    const relevantNews = scored.filter(n => n.score !== 0);
    const sentiment = classifySentiment(totalScore);

    // Alert if overall sentiment is negative and we're in a CALL,
    // or positive and we're in a PUT (contrarian signal)
    const bearishAlert =
      (sentiment === 'negative' || sentiment === 'very_negative') &&
      trade.type === 'CALL';
    const bullishAlert =
      (sentiment === 'positive' || sentiment === 'very_positive') &&
      trade.type === 'PUT';
    const alert = bearishAlert || bullishAlert;

    results.push({
      trade,
      newsItems: relevantNews.length > 0 ? relevantNews : newsItems.slice(0, 5),
      sentiment,
      sentimentScore: totalScore,
      alert,
    });
  }

  return results;
}

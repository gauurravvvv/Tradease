import { getHistorical, getIntradayData } from '../data/market.js';
import { analyzeTechnicals } from './technicals.js';
import { logger } from '../utils/logger.js';

/**
 * Compute multi-timeframe confluence score for a symbol.
 * Checks if signals align across daily, hourly, and 15-minute timeframes.
 *
 * @param {string} symbol - NSE stock symbol
 * @param {'CALL'|'PUT'} direction - Trade direction to score against
 * @returns {Promise<Object>} { score, breakdown, allAligned, dailyOpposed }
 */
export async function computeConfluence(symbol, direction) {
  const timeframes = await fetchTimeframeData(symbol);

  const weights = { daily: 0.5, hourly: 0.3, fifteenMin: 0.2 };
  const breakdown = {};
  let rawScore = 0;
  let available = 0;

  for (const [tf, weight] of Object.entries(weights)) {
    const data = timeframes[tf];
    if (!data || data.length < 15) {
      breakdown[tf] = { signal: 'unavailable', score: null };
      continue;
    }

    const analysis = analyzeTechnicals(data);
    breakdown[tf] = { signal: analysis.overallSignal, score: analysis.score };
    available += weight;

    if (signalAligns(analysis.overallSignal, direction)) {
      rawScore += weight * 100;
    } else if (analysis.overallSignal === 'NEUTRAL') {
      rawScore += weight * 40;
    }
    // Opposing signal adds 0
  }

  // Normalize if some timeframes unavailable
  if (available > 0 && available < 1) {
    rawScore = rawScore / available;
  }

  // Bonus: all three agree
  const allAligned = Object.values(breakdown).every(
    b => b.signal !== 'unavailable' && signalAligns(b.signal, direction),
  );
  if (allAligned) rawScore += 15;

  // Penalty: daily opposes while lower timeframes agree
  const dailyOpposed = breakdown.daily?.signal !== 'unavailable'
    && !signalAligns(breakdown.daily?.signal, direction)
    && breakdown.daily?.signal !== 'NEUTRAL';

  const lowerAligned = ['hourly', 'fifteenMin'].every(
    tf => breakdown[tf]?.signal && signalAligns(breakdown[tf].signal, direction),
  );

  if (dailyOpposed && lowerAligned) rawScore -= 20;

  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  return { score, breakdown, allAligned, dailyOpposed };
}

/**
 * Compute confluence for multiple symbols in parallel.
 * @param {Array<{symbol: string, direction: string}>} candidates
 * @returns {Promise<Object>} Map of symbol -> confluence result
 */
export async function batchConfluence(candidates) {
  const results = await Promise.allSettled(
    candidates.map(c => computeConfluence(c.symbol, c.direction)),
  );

  const output = {};
  candidates.forEach((c, i) => {
    if (results[i].status === 'fulfilled') {
      output[c.symbol] = results[i].value;
    } else {
      output[c.symbol] = { score: 50, breakdown: {}, allAligned: false, dailyOpposed: false };
    }
  });
  return output;
}

// ── Internal helpers ──

async function fetchTimeframeData(symbol) {
  const [daily, hourly, fifteenMin] = await Promise.allSettled([
    getHistorical(symbol, 90),
    getIntradayData(symbol, '1h', '1mo'),
    getIntradayData(symbol, '15m', '5d'),
  ]);

  return {
    daily: daily.status === 'fulfilled' ? daily.value : null,
    hourly: hourly.status === 'fulfilled' ? hourly.value : null,
    fifteenMin: fifteenMin.status === 'fulfilled' ? fifteenMin.value : null,
  };
}

function signalAligns(signal, direction) {
  if (direction === 'CALL') {
    return signal === 'STRONG_BUY' || signal === 'BUY';
  }
  return signal === 'STRONG_SELL' || signal === 'SELL';
}

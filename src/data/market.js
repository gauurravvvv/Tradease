import YahooFinance from 'yahoo-finance2';
import { DATA } from '../config/settings.js';
import { logger } from '../utils/logger.js';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ---------------------------------------------------------------------------
// Retry helper — exponential backoff for transient network failures
// ---------------------------------------------------------------------------
async function withRetry(fn, { retries = 2, delayMs = 1000, label = '' } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === retries;
      const isTransient = /fetch failed|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|network/i.test(err.message);
      if (isLast || !isTransient) throw err;
      const wait = delayMs * Math.pow(2, attempt);
      logger.debug(`[market] Retry ${attempt + 1}/${retries} for ${label} in ${wait}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------
const cache = new Map();

function cacheGet(key, ttlMinutes) {
  const entry = cache.get(key);
  if (!entry) return null;
  const ttl = ttlMinutes ?? DATA.CACHE_TTL_MINUTES;
  const ageMinutes = (Date.now() - entry.ts) / 60000;
  if (ageMinutes > ttl) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

/**
 * Flush all cached data — useful after system sleep/wake to avoid stale prices.
 */
export function clearMarketCache() {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ySymbol(symbol) {
  // Indices have ^ prefix on Yahoo
  if (symbol === 'NIFTY')     return '^NSEI';
  if (symbol === 'BANKNIFTY') return '^NSEBANK';
  return `${symbol}${DATA.YAHOO_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch current quote for a single symbol.
 * Returns: { symbol, price, change, changePct, volume, dayHigh, dayLow, open, previousClose }
 */
export async function getQuote(symbol) {
  const cKey = `quote:${symbol}`;
  const cached = cacheGet(cKey, 1); // 1 minute cache for live quotes
  if (cached) return cached;

  const ys = ySymbol(symbol);
  const result = await withRetry(() => yahooFinance.quote(ys), { label: `quote:${symbol}` });

  if (!result || result.regularMarketPrice == null) {
    throw new Error(`No data for ${symbol} (Yahoo symbol: ${ys})`);
  }

  const quote = {
    symbol,
    price:         result.regularMarketPrice,
    change:        result.regularMarketChange,
    changePct:     result.regularMarketChangePercent,
    volume:        result.regularMarketVolume,
    dayHigh:       result.regularMarketDayHigh,
    dayLow:        result.regularMarketDayLow,
    open:          result.regularMarketOpen,
    previousClose: result.regularMarketPreviousClose,
    // Fundamental fields
    marketCap:            result.marketCap,
    pe:                   result.trailingPE || result.forwardPE,
    eps:                  result.trailingEps || result.epsTrailingTwelveMonths,
    bookValue:            result.bookValue,
    dividendYield:        result.dividendYield,
    fiftyTwoWeekHigh:     result.fiftyTwoWeekHigh,
    fiftyTwoWeekLow:      result.fiftyTwoWeekLow,
    fiftyDayAverage:      result.fiftyDayAverage,
    twoHundredDayAverage: result.twoHundredDayAverage,
  };

  cacheSet(cKey, quote);
  return quote;
}

/**
 * Fetch historical OHLCV data for last N days.
 * Returns array of { date, open, high, low, close, volume }.
 */
export async function getHistorical(symbol, days = 90) {
  const cKey = `hist:${symbol}:${days}`;
  const cached = cacheGet(cKey);
  if (cached) return cached;

  const ys = ySymbol(symbol);
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days);

  const result = await withRetry(() => yahooFinance.chart(ys, {
    period1: start,
    period2: end,
    interval: '1d',
  }), { label: `hist:${symbol}` });

  const bars = (result.quotes || []).map(q => ({
    date:   q.date,
    open:   q.open,
    high:   q.high,
    low:    q.low,
    close:  q.close,
    volume: q.volume,
  }));

  cacheSet(cKey, bars);
  return bars;
}

/**
 * Fetch intraday OHLCV data at specified interval.
 * @param {string} symbol - NSE stock symbol
 * @param {string} interval - '5m' | '15m' | '1h'
 * @param {string} range - '1d' | '5d' | '1mo'
 * @returns {Promise<Array>} Array of { date, open, high, low, close, volume }
 */
export async function getIntradayData(symbol, interval = '15m', range = '5d') {
  const cKey = `intra:${symbol}:${interval}:${range}`;
  const ttl = interval === '1h' ? 10 : 2; // 2 min for 5m/15m, 10 min for 1h
  const cached = cacheGet(cKey, ttl);
  if (cached) return cached;

  // Convert range to period1 (yahoo-finance2 v3.14+ requires period1 instead of range)
  const rangeDays = { '1d': 1, '5d': 5, '1mo': 30, '3mo': 90 };
  const days = rangeDays[range] || 5;
  const period1 = new Date(Date.now() - days * 86400000);

  const ys = ySymbol(symbol);
  const result = await withRetry(() => yahooFinance.chart(ys, {
    interval,
    period1,
  }), { label: `intra:${symbol}` });

  const bars = (result.quotes || []).map(q => ({
    date:   q.date,
    open:   q.open,
    high:   q.high,
    low:    q.low,
    close:  q.close,
    volume: q.volume,
  }));

  cacheSet(cKey, bars);
  return bars;
}

/**
 * Fetch intraday data for multiple symbols in parallel.
 */
export async function getBatchIntradayData(symbols, interval = '15m', range = '5d') {
  const results = await Promise.allSettled(
    symbols.map(s => getIntradayData(s, interval, range))
  );

  const output = {};
  symbols.forEach((sym, i) => {
    if (results[i].status === 'fulfilled') {
      output[sym] = results[i].value;
    }
  });
  return output;
}

/**
 * Fetch quotes for multiple symbols in parallel.
 * Failures silently skipped — returns only successful results.
 */
export async function getMultipleQuotes(symbols) {
  const results = await Promise.allSettled(
    symbols.map(s => getQuote(s))
  );

  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
}

/**
 * Fetch historical data for multiple symbols in parallel.
 */
export async function getBatchHistorical(symbols, days = 90) {
  const results = await Promise.allSettled(
    symbols.map(s => getHistorical(s, days))
  );

  const output = {};
  symbols.forEach((sym, i) => {
    if (results[i].status === 'fulfilled') {
      output[sym] = results[i].value;
    }
  });
  return output;
}

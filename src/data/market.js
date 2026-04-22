import YahooFinance from 'yahoo-finance2';
import { DATA } from '../config/settings.js';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  const ageMinutes = (Date.now() - entry.ts) / 60000;
  if (ageMinutes > DATA.CACHE_TTL_MINUTES) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
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
  const cached = cacheGet(cKey);
  if (cached) return cached;

  const ys = ySymbol(symbol);
  const result = await yahooFinance.quote(ys);

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

  const result = await yahooFinance.chart(ys, {
    period1: start,
    period2: end,
    interval: '1d',
  });

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

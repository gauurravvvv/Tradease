import YahooFinance from 'yahoo-finance2';
import { DATA } from '../config/settings.js';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ySymbol(symbol) {
  if (symbol === 'NIFTY')     return '^NSEI';
  if (symbol === 'BANKNIFTY') return '^NSEBANK';
  return `${symbol}${DATA.YAHOO_SUFFIX}`;
}

/**
 * Standard normal CDF approximation (Abramowitz & Stegun).
 */
function normCDF(x) {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Simple Black-Scholes call/put price.
 * S = spot, K = strike, T = time in years, r = risk-free rate, sigma = IV.
 */
function blackScholes(S, K, T, r, sigma, type) {
  if (T <= 0) T = 1 / 365; // floor to 1 day

  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);

  if (type === 'CALL') {
    return S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2);
  }
  // PUT
  return K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Try fetching options chain from Yahoo Finance.
 * Returns chain data or null if unavailable.
 */
export async function getOptionsChain(symbol) {
  try {
    const ys = ySymbol(symbol);
    const result = await yahooFinance.options(ys);
    if (!result || !result.options || result.options.length === 0) return null;

    const chain = result.options[0];
    return {
      expirationDate: chain.expirationDate,
      calls: (chain.calls || []).map(c => ({
        strike:        c.strike,
        lastPrice:     c.lastPrice,
        bid:           c.bid,
        ask:           c.ask,
        volume:        c.volume,
        openInterest:  c.openInterest,
        impliedVolatility: c.impliedVolatility,
      })),
      puts: (chain.puts || []).map(p => ({
        strike:        p.strike,
        lastPrice:     p.lastPrice,
        bid:           p.bid,
        ask:           p.ask,
        volume:        p.volume,
        openInterest:  p.openInterest,
        impliedVolatility: p.impliedVolatility,
      })),
    };
  } catch (err) {
    console.error(`[options] Chain unavailable for ${symbol}: ${err.message}`);
    return null;
  }
}

/**
 * Rough premium estimation using Black-Scholes.
 *
 * @param {number} spotPrice     - Current price of underlying
 * @param {number} strikePrice   - Option strike price
 * @param {'CALL'|'PUT'} type    - Option type
 * @param {number} daysToExpiry  - Days until expiration
 * @param {number} [iv=0.25]     - Implied volatility (default 25%)
 * @param {number} [riskFreeRate=0.065] - Risk-free rate (default 6.5% — India 10Y)
 * @returns {number} Estimated premium per share
 */
export function estimatePremium(spotPrice, strikePrice, type, daysToExpiry, iv = 0.25, riskFreeRate = 0.065) {
  const T = daysToExpiry / 365;
  return Math.max(0, blackScholes(spotPrice, strikePrice, T, riskFreeRate, iv, type));
}

/**
 * Calculate nearest expiry dates.
 * Weekly: next Thursday. Monthly: last Thursday of current month.
 * If today IS Thursday and market hours remain, today counts.
 */
export function getNearestExpiry() {
  const now = new Date();
  const THURSDAY = 4;

  // Next Thursday (weekly)
  const weekly = new Date(now);
  const daysUntilThursday = (THURSDAY - now.getDay() + 7) % 7;
  // If today is Thursday, use today
  weekly.setDate(now.getDate() + (daysUntilThursday === 0 ? 0 : daysUntilThursday));
  weekly.setHours(15, 30, 0, 0);

  // If weekly expiry already passed today, jump to next week
  if (weekly <= now) {
    weekly.setDate(weekly.getDate() + 7);
  }

  // Last Thursday of month (monthly)
  const monthly = new Date(now.getFullYear(), now.getMonth() + 1, 0); // last day of month
  while (monthly.getDay() !== THURSDAY) {
    monthly.setDate(monthly.getDate() - 1);
  }
  monthly.setHours(15, 30, 0, 0);

  // If monthly already passed, get last Thursday of next month
  if (monthly <= now) {
    const nextMonthEnd = new Date(now.getFullYear(), now.getMonth() + 2, 0);
    while (nextMonthEnd.getDay() !== THURSDAY) {
      nextMonthEnd.setDate(nextMonthEnd.getDate() - 1);
    }
    nextMonthEnd.setHours(15, 30, 0, 0);
    return {
      weekly:  formatDate(weekly),
      monthly: formatDate(nextMonthEnd),
      weeklyDate:  weekly,
      monthlyDate: nextMonthEnd,
    };
  }

  return {
    weekly:  formatDate(weekly),
    monthly: formatDate(monthly),
    weeklyDate:  weekly,
    monthlyDate: monthly,
  };
}

/**
 * Round to nearest ATM strike.
 *
 * @param {number} currentPrice - Current spot price
 * @param {number} stepSize     - Strike step (e.g. 50 for Nifty, 100 for BankNifty, varies for stocks)
 * @returns {number} ATM strike price
 */
export function getATMStrike(currentPrice, stepSize) {
  return Math.round(currentPrice / stepSize) * stepSize;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------
function formatDate(d) {
  return d.toISOString().split('T')[0];
}

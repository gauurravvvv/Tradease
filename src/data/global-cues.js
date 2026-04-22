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
// Symbol map
// ---------------------------------------------------------------------------
const SYMBOLS = {
  sp500:       '^GSPC',
  nasdaq:      '^IXIC',
  dow:         '^DJI',
  nikkei:      '^N225',
  hangSeng:    '^HSI',
  crudeWTI:    'CL=F',
  brentCrude:  'BZ=F',
  gold:        'GC=F',
  dollarIndex: 'DX-Y.NYB',
  us10y:       '^TNX',
  vix:         '^VIX',
};

// ---------------------------------------------------------------------------
// Sentiment weights
// Each weight represents how much that indicator contributes to sentiment.
// Positive weight = "green is bullish". Negative weight = "up is bearish".
// ---------------------------------------------------------------------------
const SENTIMENT_WEIGHTS = {
  sp500:       +20,   // S&P green = bullish for India
  nasdaq:      +15,   // Tech sentiment
  dow:         +10,   // Blue chips
  nikkei:      +8,    // Asia cue
  hangSeng:    +8,    // Asia cue
  crudeWTI:    -5,    // Crude up = bearish (input cost pressure)
  brentCrude:  -5,    // Same logic
  gold:        -3,    // Gold up = risk-off = slightly bearish
  dollarIndex: -12,   // Strong dollar = FII outflow
  us10y:       -10,   // Yield up = money leaves emerging markets
  vix:         -12,   // Fear up = bearish
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a single Yahoo quote. Returns { price, change, changePct } or null.
 */
async function fetchQuote(yahooSymbol) {
  const result = await yahooFinance.quote(yahooSymbol);
  return {
    price:     result.regularMarketPrice,
    change:    result.regularMarketChange,
    changePct: result.regularMarketChangePercent,
  };
}

/**
 * Clamp a number between min and max.
 */
function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

/**
 * Format number with sign prefix.
 */
function signed(num, decimals = 1) {
  if (num == null || isNaN(num)) return 'N/A';
  const s = num >= 0 ? '+' : '';
  return `${s}${num.toFixed(decimals)}%`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch global market indicators in parallel.
 * Returns structured cues object with sentiment analysis.
 */
export async function getGlobalCues() {
  const cached = cacheGet('global-cues');
  if (cached) return cached;

  // Fetch all symbols in parallel — failures don't kill everything
  const keys = Object.keys(SYMBOLS);
  const results = await Promise.allSettled(
    keys.map(k => fetchQuote(SYMBOLS[k]))
  );

  // Build quotes map — null for failed fetches
  const quotes = {};
  keys.forEach((key, i) => {
    if (results[i].status === 'fulfilled' && results[i].value) {
      quotes[key] = results[i].value;
    } else {
      const reason = results[i].reason?.message || 'unknown';
      console.error(`[global-cues] Failed to fetch ${key} (${SYMBOLS[key]}): ${reason}`);
      quotes[key] = null;
    }
  });

  // Calculate sentiment score
  let sentimentScore = 0;
  let totalWeight = 0;

  for (const [key, weight] of Object.entries(SENTIMENT_WEIGHTS)) {
    const q = quotes[key];
    if (!q || q.changePct == null) continue;

    // Normalize changePct contribution: weight * sign-adjusted changePct
    // Positive weight: green changePct adds positively
    // Negative weight: green changePct adds negatively (e.g. crude up = bad)
    const contribution = weight * (q.changePct / 100);
    sentimentScore += contribution;
    totalWeight += Math.abs(weight);
  }

  // Normalize to -100..+100 range
  if (totalWeight > 0) {
    // Max possible score = sum of abs(weights) * some reasonable max % (say 5%)
    // Normalize by dividing by (totalWeight * 0.05) then scale to 100
    sentimentScore = clamp((sentimentScore / (totalWeight * 0.03)) * 100, -100, 100);
  }
  sentimentScore = Math.round(sentimentScore);

  let sentiment;
  if (sentimentScore >= 25) sentiment = 'BULLISH';
  else if (sentimentScore <= -25) sentiment = 'BEARISH';
  else sentiment = 'MIXED';

  const cues = {
    us: {
      sp500:  quotes.sp500,
      nasdaq: quotes.nasdaq,
      dow:    quotes.dow,
    },
    asia: {
      nikkei:   quotes.nikkei,
      hangSeng: quotes.hangSeng,
    },
    commodities: {
      crudeWTI:   quotes.crudeWTI,
      brentCrude: quotes.brentCrude,
      gold:       quotes.gold,
    },
    currencies: {
      dollarIndex: quotes.dollarIndex,
    },
    bonds: {
      us10y: quotes.us10y,
    },
    volatility: {
      vix: quotes.vix,
    },
    sentiment,
    sentimentScore,
  };

  cacheSet('global-cues', cues);
  return cues;
}

/**
 * One-line summary of global cues for quick display.
 * Example: "US: S&P +0.8% | Nasdaq +1.2% | Asia: Mixed | Crude: $82 (+0.5%) | DXY: 104.2 (-0.3%) | VIX: 15.2 (-5%) | Sentiment: BULLISH"
 */
export async function getGlobalCuesSummary() {
  const cues = await getGlobalCues();

  const parts = [];

  // US markets
  const sp = cues.us.sp500;
  const nq = cues.us.nasdaq;
  if (sp || nq) {
    let us = 'US:';
    if (sp) us += ` S&P ${signed(sp.changePct)}`;
    if (nq) us += ` | Nasdaq ${signed(nq.changePct)}`;
    parts.push(us);
  }

  // Asia
  const nk = cues.asia.nikkei;
  const hs = cues.asia.hangSeng;
  if (nk || hs) {
    const asiaGreen = [nk, hs].filter(Boolean).filter(q => q.changePct >= 0).length;
    const asiaTotal = [nk, hs].filter(Boolean).length;
    let asiaLabel;
    if (asiaGreen === asiaTotal) asiaLabel = 'Green';
    else if (asiaGreen === 0)    asiaLabel = 'Red';
    else                         asiaLabel = 'Mixed';
    parts.push(`Asia: ${asiaLabel}`);
  }

  // Crude
  const wti = cues.commodities.crudeWTI;
  if (wti) {
    parts.push(`Crude: $${wti.price?.toFixed(1)} (${signed(wti.changePct)})`);
  }

  // Dollar Index
  const dxy = cues.currencies.dollarIndex;
  if (dxy) {
    parts.push(`DXY: ${dxy.price?.toFixed(1)} (${signed(dxy.changePct)})`);
  }

  // VIX
  const vix = cues.volatility.vix;
  if (vix) {
    parts.push(`VIX: ${vix.price?.toFixed(1)} (${signed(vix.changePct)})`);
  }

  // Sentiment
  parts.push(`Sentiment: ${cues.sentiment}`);

  return parts.join(' | ');
}

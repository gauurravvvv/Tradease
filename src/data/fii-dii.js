import https from 'https';
import { DATA } from '../config/settings.js';

// ---------------------------------------------------------------------------
// In-memory cache (FII/DII data updates once daily — long TTL fine)
// ---------------------------------------------------------------------------
const cache = new Map();

const FII_DII_CACHE_TTL_MINUTES = 120; // 2 hours — data changes once a day

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  const ageMinutes = (Date.now() - entry.ts) / 60000;
  if (ageMinutes > FII_DII_CACHE_TTL_MINUTES) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ---------------------------------------------------------------------------
// NSE Headers — browser-like to avoid blocking
// ---------------------------------------------------------------------------
const NSE_BASE = 'https://www.nseindia.com';
const NSE_FII_DII_URL = `${NSE_BASE}/api/fiidiiTradeReact`;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.nseindia.com/',
  'Connection': 'keep-alive',
};

// ---------------------------------------------------------------------------
// Helpers — native HTTPS fetch
// ---------------------------------------------------------------------------

/**
 * Make HTTPS GET request. Returns { statusCode, headers, body }.
 * Uses native https to avoid adding dependencies.
 */
function httpsGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { ...BROWSER_HEADERS, ...extraHeaders },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out: ${url}`));
    });
    req.end();
  });
}

/**
 * Step 1: Hit NSE homepage to grab session cookies.
 * NSE requires valid cookies for API access.
 */
async function getNSECookies() {
  const res = await httpsGet(NSE_BASE);
  const setCookies = res.headers['set-cookie'];
  if (!setCookies || setCookies.length === 0) {
    throw new Error('NSE returned no cookies');
  }
  // Extract cookie key=value pairs (drop attributes like Path, Expires)
  const cookies = setCookies
    .map(c => c.split(';')[0].trim())
    .join('; ');
  return cookies;
}

/**
 * Step 2: Fetch NSE API endpoint with session cookies.
 */
async function fetchNSEApi(url, cookies) {
  const res = await httpsGet(url, { Cookie: cookies });
  if (res.statusCode !== 200) {
    throw new Error(`NSE API returned ${res.statusCode}: ${res.body.slice(0, 200)}`);
  }
  return JSON.parse(res.body);
}

// ---------------------------------------------------------------------------
// Data parsing
// ---------------------------------------------------------------------------

/**
 * Parse raw NSE FII/DII response into structured object.
 * NSE returns array of objects with category, buyValue, sellValue.
 */
function parseNSEData(raw) {
  // NSE response is array: [{ category: 'FII/FPI', buyValue, sellValue, netValue, date }, ...]
  // Sometimes wrapped differently. Handle both shapes.
  const rows = Array.isArray(raw) ? raw : (raw?.data || []);

  let fiiRow = null;
  let diiRow = null;

  for (const row of rows) {
    const cat = (row.category || '').toUpperCase();
    if (cat.includes('FII') || cat.includes('FPI')) {
      fiiRow = row;
    } else if (cat.includes('DII')) {
      diiRow = row;
    }
  }

  if (!fiiRow && !diiRow) {
    throw new Error('Could not find FII/DII rows in NSE response');
  }

  return { fiiRow, diiRow };
}

/**
 * Parse a currency string like "12,345.67" into number.
 */
function parseAmount(val) {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  return parseFloat(String(val).replace(/,/g, '')) || 0;
}

/**
 * Determine signal from net value.
 */
function getSignal(netValue) {
  if (netValue > 500)  return 'BUYING';
  if (netValue < -500) return 'SELLING';
  return 'NEUTRAL';
}

/**
 * Determine overall sentiment from FII + DII signals.
 */
function getSentiment(fiiSignal, diiSignal) {
  if (fiiSignal === 'BUYING' && diiSignal === 'BUYING')   return 'BULLISH';
  if (fiiSignal === 'SELLING' && diiSignal === 'SELLING') return 'BEARISH';
  return 'MIXED';
}

/**
 * Format number as ₹X,XXX Cr with sign prefix.
 */
function formatCrores(val) {
  if (val == null || isNaN(val)) return 'N/A';
  const sign = val >= 0 ? '+' : '';
  return `${sign}₹${Math.abs(val).toLocaleString('en-IN')} Cr`;
}

/**
 * Build structured result from parsed FII/DII rows.
 */
function buildResult(fiiRow, diiRow) {
  const fiiBuy  = parseAmount(fiiRow?.buyValue);
  const fiiSell = parseAmount(fiiRow?.sellValue);
  const fiiNet  = fiiRow?.netValue != null ? parseAmount(fiiRow.netValue) : (fiiBuy - fiiSell);

  const diiBuy  = parseAmount(diiRow?.buyValue);
  const diiSell = parseAmount(diiRow?.sellValue);
  const diiNet  = diiRow?.netValue != null ? parseAmount(diiRow.netValue) : (diiBuy - diiSell);

  const fiiSignal = getSignal(fiiNet);
  const diiSignal = getSignal(diiNet);
  const netFlow   = fiiNet + diiNet;
  const sentiment = getSentiment(fiiSignal, diiSignal);

  const date = fiiRow?.date || diiRow?.date || new Date().toISOString().split('T')[0];

  const fiiLabel = fiiSignal === 'BUYING' ? 'buying' : fiiSignal === 'SELLING' ? 'selling' : 'neutral';
  const diiLabel = diiSignal === 'BUYING' ? 'buying' : diiSignal === 'SELLING' ? 'selling' : 'neutral';

  const summary = `FIIs ${fiiLabel} ${formatCrores(fiiNet)} | DIIs ${diiLabel} ${formatCrores(diiNet)} | Net ${formatCrores(netFlow)}`;

  return {
    date,
    fii: {
      buyValue:  fiiBuy,
      sellValue: fiiSell,
      netValue:  fiiNet,
      signal:    fiiSignal,
    },
    dii: {
      buyValue:  diiBuy,
      sellValue: diiSell,
      netValue:  diiNet,
      signal:    diiSignal,
    },
    netFlow,
    sentiment,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch FII/DII data from NSE.
 * Uses 2-step approach: get cookies, then hit API.
 * Returns structured object or null on failure.
 *
 * @returns {Promise<{
 *   date: string,
 *   fii: { buyValue: number, sellValue: number, netValue: number, signal: string },
 *   dii: { buyValue: number, sellValue: number, netValue: number, signal: string },
 *   netFlow: number,
 *   sentiment: string,
 *   summary: string,
 * } | null>}
 */
export async function getFiiDiiData() {
  const cached = cacheGet('fii-dii');
  if (cached) return cached;

  try {
    // Step 1: Get session cookies from NSE homepage
    const cookies = await getNSECookies();

    // Step 2: Fetch FII/DII data with cookies
    const raw = await fetchNSEApi(NSE_FII_DII_URL, cookies);

    // Step 3: Parse and structure
    const { fiiRow, diiRow } = parseNSEData(raw);
    const result = buildResult(fiiRow, diiRow);

    cacheSet('fii-dii', result);
    return result;
  } catch (err) {
    console.error(`[fii-dii] Failed to fetch from NSE: ${err.message}`);
    console.error('[fii-dii] FII/DII data unavailable — continuing without it');
    return null;
  }
}

/**
 * Get FII/DII trend for last N days.
 * NSE API only gives current day — so we return array with today's data.
 * Historical data would need a different source or local storage.
 *
 * @param {number} days - Number of days (currently only today available)
 * @returns {Promise<Array<{
 *   date: string,
 *   fii: { buyValue: number, sellValue: number, netValue: number, signal: string },
 *   dii: { buyValue: number, sellValue: number, netValue: number, signal: string },
 *   netFlow: number,
 *   sentiment: string,
 * }>>}
 */
export async function getFiiDiiTrend(days = 5) {
  const today = await getFiiDiiData();
  if (!today) return [];

  // NSE API only provides current day data.
  // For multi-day trend, would need to store historical data in DB.
  // Return today's data as single-element array for now.
  return [today];
}

/**
 * Get one-line FII/DII summary string.
 * Returns null if data unavailable.
 *
 * @returns {Promise<string | null>}
 * @example "FII: -₹2,500 Cr (selling) | DII: +₹3,000 Cr (buying) | Net: +₹500 Cr"
 */
export async function getFiiDiiSummary() {
  const data = await getFiiDiiData();
  if (!data) return null;

  const fiiLabel = data.fii.signal === 'BUYING' ? 'buying'
    : data.fii.signal === 'SELLING' ? 'selling' : 'neutral';
  const diiLabel = data.dii.signal === 'BUYING' ? 'buying'
    : data.dii.signal === 'SELLING' ? 'selling' : 'neutral';

  return `FII: ${formatCrores(data.fii.netValue)} (${fiiLabel}) | DII: ${formatCrores(data.dii.netValue)} (${diiLabel}) | Net: ${formatCrores(data.netFlow)}`;
}

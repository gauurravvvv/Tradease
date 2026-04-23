import YahooFinance from 'yahoo-finance2';
import { DATA } from '../config/settings.js';
import { FNO_STOCKS } from '../data/fno-stocks.js';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// ---------------------------------------------------------------------------
// Sectoral Index Definitions
// ---------------------------------------------------------------------------
const SECTOR_INDICES = [
  { sector: 'Bank', symbol: '^NSEBANK', nseIndex: 'Nifty Bank' },
  { sector: 'IT', symbol: '^CNXIT', nseIndex: 'Nifty IT' },
  { sector: 'Pharma', symbol: '^CNXPHARMA', nseIndex: 'Nifty Pharma' },
  { sector: 'Auto', symbol: '^CNXAUTO', nseIndex: 'Nifty Auto' },
  { sector: 'Metal', symbol: '^CNXMETAL', nseIndex: 'Nifty Metal' },
  { sector: 'Energy', symbol: '^CNXENERGY', nseIndex: 'Nifty Energy' },
  { sector: 'FMCG', symbol: '^CNXFMCG', nseIndex: 'Nifty FMCG' },
  { sector: 'Realty', symbol: '^CNXREALTY', nseIndex: 'Nifty Realty' },
  {
    sector: 'Financial Services',
    symbol: '^CNXFIN',
    nseIndex: 'Nifty Financial Services',
  },
  { sector: 'Infrastructure', symbol: '^CNXINFRA', nseIndex: 'Nifty Infra' },
  { sector: 'PSU Bank', symbol: '^CNXPSUBANK', nseIndex: 'Nifty PSU Bank' },
  { sector: 'Media', symbol: '^CNXMEDIA', nseIndex: 'Nifty Media' },
];

const NIFTY_SYMBOL = '^NSEI';

// ---------------------------------------------------------------------------
// Stock sector → Sectoral index mapping
// ---------------------------------------------------------------------------
const STOCK_SECTOR_MAP = {
  Banking: 'Bank',
  Finance: 'Financial Services',
  IT: 'IT',
  Energy: 'Energy',
  Auto: 'Auto',
  Metals: 'Metal',
  Pharma: 'Pharma',
  Healthcare: 'Pharma',
  FMCG: 'FMCG',
  Consumer: 'FMCG',
  Infra: 'Infrastructure',
  Cement: 'Infrastructure',
  Telecom: 'IT',
  Index: null,
};

// ---------------------------------------------------------------------------
// In-memory cache (same pattern as market.js)
// ---------------------------------------------------------------------------
const SECTOR_CACHE_TTL = 30; // minutes
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  const ageMinutes = (Date.now() - entry.ts) / 60000;
  if (ageMinutes > SECTOR_CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fetch quote for a Yahoo symbol (index). Returns null on failure.
 * @param {string} symbol - Yahoo Finance symbol (e.g. '^NSEBANK')
 * @returns {Promise<Object|null>}
 */
async function fetchQuote(symbol) {
  try {
    const result = await yahooFinance.quote(symbol);
    if (!result || result.regularMarketPrice == null) return null;
    return {
      price: result.regularMarketPrice,
      change: result.regularMarketChange,
      changePct: result.regularMarketChangePercent,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch 20-day historical close data for a Yahoo symbol.
 * Returns array of close prices (oldest first), or empty array on failure.
 * @param {string} symbol - Yahoo Finance symbol
 * @returns {Promise<number[]>}
 */
async function fetchHistorical(symbol) {
  try {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 30); // fetch 30 calendar days for ~20 trading days

    const result = await yahooFinance.chart(symbol, {
      period1: start,
      period2: end,
      interval: '1d',
    });

    const quotes = result.quotes || [];
    return quotes.filter(q => q.close != null).map(q => q.close);
  } catch {
    return [];
  }
}

/**
 * Compute percentage change between two values.
 * @param {number} current
 * @param {number} previous
 * @returns {number}
 */
function pctChange(current, previous) {
  if (!previous || previous === 0) return 0;
  return ((current - previous) / previous) * 100;
}

/**
 * Determine trend label from momentum score.
 * @param {number} score - Momentum score 0-100
 * @returns {string}
 */
function determineTrend(score) {
  if (score >= 75) return 'STRONG_UP';
  if (score >= 55) return 'UP';
  if (score >= 45) return 'FLAT';
  if (score >= 25) return 'DOWN';
  return 'STRONG_DOWN';
}

/**
 * Normalize a raw change% into 0-100 scale.
 * Maps roughly -5% to 0 and +5% to 100, clamped.
 * @param {number} changePct
 * @returns {number}
 */
function normalizeScore(changePct) {
  const scaled = ((changePct + 5) / 10) * 100;
  return Math.max(0, Math.min(100, scaled));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get strength data for all sectoral indices, sorted strongest first.
 * Uses Promise.allSettled — unavailable indices are skipped.
 *
 * @returns {Promise<Array<{
 *   sector: string,
 *   symbol: string,
 *   price: number,
 *   todayChange: number,
 *   fiveDayChange: number,
 *   twentyDayChange: number,
 *   relativeStrength: number,
 *   momentumScore: number,
 *   trend: string,
 *   rank: number,
 * }>>}
 */
export async function getSectorStrength() {
  const cached = cacheGet('sectorStrength');
  if (cached) return cached;

  // Fetch Nifty 50 data for relative strength calc
  const [niftyQuote, niftyHist] = await Promise.all([
    fetchQuote(NIFTY_SYMBOL),
    fetchHistorical(NIFTY_SYMBOL),
  ]);

  const niftyTodayPct = niftyQuote?.changePct ?? 0;
  const nifty5dPct =
    niftyHist.length >= 5
      ? pctChange(
          niftyHist[niftyHist.length - 1],
          niftyHist[niftyHist.length - 5],
        )
      : 0;
  const nifty20dPct =
    niftyHist.length >= 20
      ? pctChange(niftyHist[niftyHist.length - 1], niftyHist[0])
      : 0;

  // Fetch all sector quotes + historicals in parallel
  const quoteResults = await Promise.allSettled(
    SECTOR_INDICES.map(s => fetchQuote(s.symbol)),
  );
  const histResults = await Promise.allSettled(
    SECTOR_INDICES.map(s => fetchHistorical(s.symbol)),
  );

  const sectors = [];

  for (let i = 0; i < SECTOR_INDICES.length; i++) {
    const def = SECTOR_INDICES[i];

    const quote =
      quoteResults[i].status === 'fulfilled' ? quoteResults[i].value : null;
    const hist =
      histResults[i].status === 'fulfilled' ? histResults[i].value : [];

    if (!quote) continue; // skip unavailable index

    const todayChange = quote.changePct ?? 0;

    const fiveDayChange =
      hist.length >= 5
        ? pctChange(hist[hist.length - 1], hist[hist.length - 5])
        : todayChange;

    const twentyDayChange =
      hist.length >= 15
        ? pctChange(hist[hist.length - 1], hist[0])
        : fiveDayChange;

    // Relative strength vs Nifty (today basis)
    const relativeStrength = +(todayChange - niftyTodayPct).toFixed(2);

    // Weighted momentum score: today 40%, 5d 35%, 20d 25%
    const rawMomentum =
      normalizeScore(todayChange) * 0.4 +
      normalizeScore(fiveDayChange) * 0.35 +
      normalizeScore(twentyDayChange) * 0.25;
    const momentumScore = +Math.max(0, Math.min(100, rawMomentum)).toFixed(1);

    const trend = determineTrend(momentumScore);

    sectors.push({
      sector: def.sector,
      symbol: def.symbol,
      price: quote.price,
      todayChange: +todayChange.toFixed(2),
      fiveDayChange: +fiveDayChange.toFixed(2),
      twentyDayChange: +twentyDayChange.toFixed(2),
      relativeStrength,
      momentumScore,
      trend,
      rank: 0, // assigned after sort
    });
  }

  // Sort by momentum score descending
  sectors.sort((a, b) => b.momentumScore - a.momentumScore);
  sectors.forEach((s, idx) => {
    s.rank = idx + 1;
  });

  cacheSet('sectorStrength', sectors);
  return sectors;
}

/**
 * Given a stock symbol, return its sector strength data.
 * Maps FNO_STOCKS sector field to sectoral index, then looks up strength.
 *
 * @param {string} symbol - Stock symbol (e.g. 'HDFCBANK')
 * @returns {Promise<Object|null>} Sector strength object or null
 */
export async function getSectorForStock(symbol) {
  const stock = FNO_STOCKS.find(
    s => s.symbol.toUpperCase() === symbol.toUpperCase(),
  );
  if (!stock) return null;

  const mappedSector = STOCK_SECTOR_MAP[stock.sector];
  if (!mappedSector) return null;

  const sectors = await getSectorStrength();
  return sectors.find(s => s.sector === mappedSector) || null;
}

/**
 * Compact one-line summary of sector landscape.
 * Format: "HOT: Bank(+2.5%) IT(+1.8%) | COLD: Metal(-1.2%) Realty(-0.8%) | Rotation: Risk-On"
 *
 * @returns {Promise<string>}
 */
export async function getSectorSummary() {
  const sectors = await getSectorStrength();
  if (sectors.length === 0) return 'Sector data unavailable';

  // Top 3 hot, bottom 3 cold
  const hot = sectors.slice(0, 3);
  const cold = sectors.slice(-3).reverse();

  const fmtSector = s => {
    const sign = s.todayChange >= 0 ? '+' : '';
    return `${s.sector}(${sign}${s.todayChange}%)`;
  };

  const hotStr = hot.map(fmtSector).join(' ');
  const coldStr = cold.map(fmtSector).join(' ');

  const rotation = detectRotation(sectors);

  return `HOT: ${hotStr} | COLD: ${coldStr} | Rotation: ${rotation}`;
}

/**
 * Get top N sectors by momentum score.
 *
 * @param {number} n - Number of sectors to return (default 3)
 * @returns {Promise<Array>}
 */
export async function getTopSectors(n = 3) {
  const sectors = await getSectorStrength();
  return sectors.slice(0, n);
}

/**
 * Get bottom N sectors by momentum score.
 *
 * @param {number} n - Number of sectors to return (default 3)
 * @returns {Promise<Array>}
 */
export async function getBottomSectors(n = 3) {
  const sectors = await getSectorStrength();
  return sectors.slice(-n);
}

// ---------------------------------------------------------------------------
// Rotation Detection
// ---------------------------------------------------------------------------

/**
 * Detect sector rotation type based on which sectors are leading.
 *
 * @param {Array} sectors - Sorted sector strength array (strongest first)
 * @returns {string} Rotation label
 */
function detectRotation(sectors) {
  if (sectors.length === 0) return 'Unknown';

  const upCount = sectors.filter(s => s.todayChange > 0.2).length;
  const downCount = sectors.filter(s => s.todayChange < -0.2).length;

  // Broad moves first
  if (upCount >= Math.floor(sectors.length * 0.7)) return 'Broad Rally';
  if (downCount >= Math.floor(sectors.length * 0.7)) return 'Broad Sell-off';

  // Check top 4 sectors for theme
  const topSectors = new Set(sectors.slice(0, 4).map(s => s.sector));

  const riskOnNames = ['Bank', 'IT', 'Auto', 'Financial Services'];
  const defensiveNames = ['FMCG', 'Pharma'];
  const commodityNames = ['Metal', 'Energy'];

  const riskOnCount = riskOnNames.filter(n => topSectors.has(n)).length;
  const defensiveCount = defensiveNames.filter(n => topSectors.has(n)).length;
  const commodityCount = commodityNames.filter(n => topSectors.has(n)).length;

  if (commodityCount >= 2) return 'Commodity Play';
  if (defensiveCount >= 2) return 'Defensive';
  if (riskOnCount >= 2) return 'Risk-On';

  return 'Mixed';
}

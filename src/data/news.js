import Parser from 'rss-parser';
import { DATA } from '../config/settings.js';
import { FNO_STOCKS } from './fno-stocks.js';

const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'Tradease/1.0' },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a single feed item into our standard shape.
 */
function normalize(item, source) {
  return {
    title:   (item.title || '').trim(),
    link:    item.link || '',
    pubDate: item.isoDate || item.pubDate || null,
    source,
    snippet: (item.contentSnippet || item.content || '').slice(0, 300).trim(),
  };
}

/**
 * Simple title-similarity dedup.
 * Two titles are "similar" if lowercased first 60 chars match.
 */
function deduplicate(articles) {
  const seen = new Set();
  return articles.filter(a => {
    const key = a.title.toLowerCase().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Sort newest first. Items without parseable date pushed to end.
 */
function sortByRecency(articles) {
  return articles.sort((a, b) => {
    const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return db - da;
  });
}

// ---------------------------------------------------------------------------
// Fetch a single feed — never throw, return empty on failure.
// ---------------------------------------------------------------------------
async function fetchFeed(url) {
  try {
    const feed = await parser.parseURL(url);
    const source = feed.title || url;
    return (feed.items || []).map(item => normalize(item, source));
  } catch (err) {
    console.error(`[news] Failed to fetch ${url}: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// News cache — prevents score fluctuation on page refresh
// ---------------------------------------------------------------------------
let _newsCache = null;
let _newsCacheTs = 0;
const NEWS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch all configured RSS feeds in parallel.
 * Returns deduplicated, most-recent-first articles.
 * Cached for 5 minutes to prevent sentiment score fluctuation.
 */
export async function fetchAllNews() {
  const now = Date.now();
  if (_newsCache && (now - _newsCacheTs) < NEWS_CACHE_TTL) {
    return _newsCache;
  }

  const batches = await Promise.all(
    DATA.NEWS_FEEDS.map(url => fetchFeed(url))
  );
  const all = batches.flat();
  const result = sortByRecency(deduplicate(all));

  _newsCache = result;
  _newsCacheTs = now;
  return result;
}

/**
 * Fetch all news, then filter by keyword (case-insensitive).
 */
export async function searchNews(query) {
  const all = await fetchAllNews();
  const q = query.toLowerCase();
  return all.filter(
    a => a.title.toLowerCase().includes(q) || a.snippet.toLowerCase().includes(q)
  );
}

/**
 * Get news mentioning a specific stock symbol or company name.
 */
export async function getStockNews(symbol) {
  const stock = FNO_STOCKS.find(s => s.symbol === symbol);
  const all = await fetchAllNews();

  const terms = [symbol.toLowerCase()];
  if (stock) {
    // Add key name words (skip short words)
    stock.name.split(/\s+/).forEach(w => {
      if (w.length > 2) terms.push(w.toLowerCase());
    });
  }

  return all.filter(a => {
    const text = `${a.title} ${a.snippet}`.toLowerCase();
    return terms.some(t => text.includes(t));
  });
}

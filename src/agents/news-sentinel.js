import { createHash } from 'crypto';
import { BaseAgent } from './base.js';
import { fetchAllNews, getStockNews } from '../data/news.js';
import { scoreSentiment, classifySentiment } from '../listeners/news-monitor.js';
import { getOpenTrades } from '../trading/manager.js';
import { logger } from '../utils/logger.js';

const FIVE_MINUTES = 5 * 60 * 1000;
const DEDUP_WINDOW = 30 * 60 * 1000; // 30 min

function md5(str) {
  return createHash('md5').update(str).digest('hex');
}

export class NewsSentinel extends BaseAgent {
  constructor() {
    super('news-sentinel', {
      intervalMs: FIVE_MINUTES,
      model: 'claude-haiku-4-5-20251001',
    });

    this._watchlist = new Set();
    this._seenHashes = new Map(); // hash -> timestamp
  }

  // ── Orchestrator API ──

  updateWatchlist(symbols) {
    this._watchlist = new Set(symbols);
    logger.info(`[news-sentinel] Watchlist updated: ${symbols.join(', ')}`);
  }

  // ── Scheduling ──

  shouldRun() {
    return this.isMarketHours(9, 0, 15, 30);
  }

  // ── Main Logic ──

  async execute() {
    this._pruneSeenHashes();

    const openTrades = getOpenTrades();
    const positionSymbols = [...new Set(openTrades.map(t => t.symbol))];
    const watchlistSymbols = [...this._watchlist].filter(s => !positionSymbols.includes(s));

    // Priority: positions first, then watchlist
    const allSymbols = [...positionSymbols, ...watchlistSymbols];

    if (allSymbols.length === 0) {
      this.log('tick', null, 'No symbols to monitor', 0, 0, 1);
      return;
    }

    // Fetch news per symbol (position stocks get individual fetch, watchlist batch)
    const symbolArticles = new Map();

    // Fetch position stocks individually for accuracy
    const positionFetches = positionSymbols.map(async (sym) => {
      try {
        const articles = await getStockNews(sym);
        symbolArticles.set(sym, articles);
      } catch (err) {
        logger.error(`[news-sentinel] Fetch failed for ${sym}: ${err.message}`);
        symbolArticles.set(sym, []);
      }
    });
    await Promise.all(positionFetches);

    // Fetch all news once for watchlist filtering
    if (watchlistSymbols.length > 0) {
      try {
        const allNews = await fetchAllNews();
        for (const sym of watchlistSymbols) {
          const symLower = sym.toLowerCase();
          const matched = allNews.filter(a => {
            const text = `${a.title} ${a.snippet}`.toLowerCase();
            return text.includes(symLower);
          });
          symbolArticles.set(sym, matched);
        }
      } catch (err) {
        logger.error(`[news-sentinel] Bulk fetch failed: ${err.message}`);
      }
    }

    let totalProcessed = 0;
    let totalSkipped = 0;
    let signalsWritten = 0;
    let claudeCalls = 0;

    const isPosition = new Set(positionSymbols);

    for (const symbol of allSymbols) {
      const articles = symbolArticles.get(symbol) || [];
      const fresh = this._dedup(articles);

      totalSkipped += articles.length - fresh.length;

      if (fresh.length === 0) continue;

      totalProcessed += fresh.length;

      // Score each article with rule-based sentiment
      const scored = fresh.map(a => ({
        ...a,
        score: scoreSentiment(a),
      }));

      const totalScore = scored.reduce((sum, a) => sum + a.score, 0);
      const sentiment = classifySentiment(totalScore);

      // Check if headlines conflict (mixed signals) + 3+ headlines
      const hasConflict = scored.length >= 3 && this._hasMixedSignals(scored);

      // If conflict, use Claude to disambiguate
      if (hasConflict) {
        claudeCalls++;
        const resolution = await this._resolveConflict(symbol, scored);
        if (resolution) {
          this._writeFromResolution(symbol, resolution, scored, isPosition.has(symbol));
          signalsWritten++;
        }
        continue;
      }

      // Rule-based signal emission
      signalsWritten += this._emitRuleSignals(symbol, totalScore, sentiment, scored, isPosition.has(symbol));
    }

    this.log('tick', null, `symbols:${allSymbols.length} articles:${totalProcessed} skipped:${totalSkipped} signals:${signalsWritten} claude:${claudeCalls}`, 0, 0, totalSkipped);
  }

  // ── Deduplication ──

  _dedup(articles) {
    const fresh = [];
    const now = Date.now();

    for (const article of articles) {
      const hash = md5(article.title.toLowerCase().trim());
      const seenAt = this._seenHashes.get(hash);

      if (seenAt && now - seenAt < DEDUP_WINDOW) continue;

      this._seenHashes.set(hash, now);
      fresh.push(article);
    }

    return fresh;
  }

  _pruneSeenHashes() {
    const now = Date.now();
    for (const [hash, ts] of this._seenHashes) {
      if (now - ts > DEDUP_WINDOW) this._seenHashes.delete(hash);
    }
  }

  // ── Signal Detection ──

  _hasMixedSignals(scored) {
    let pos = 0;
    let neg = 0;
    for (const a of scored) {
      if (a.score > 0) pos++;
      if (a.score < 0) neg++;
    }
    return pos > 0 && neg > 0;
  }

  _emitRuleSignals(symbol, totalScore, sentiment, scored, isOpenPosition) {
    let count = 0;

    // Urgent exit: strong negative on open position
    if (isOpenPosition && totalScore <= -4) {
      const topBearish = scored
        .filter(a => a.score < 0)
        .sort((a, b) => a.score - b.score)
        .slice(0, 3);

      this.writeSignal(symbol, 'urgent_exit', Math.min(Math.abs(totalScore) / 6, 1), {
        sentiment,
        totalScore,
        headlines: topBearish.map(a => a.title),
        articleCount: scored.length,
      });
      count++;
    }

    // Bullish signal
    if (totalScore >= 3) {
      this.writeSignal(symbol, 'bullish_news', Math.min(totalScore / 6, 1), {
        sentiment,
        totalScore,
        headlines: scored.filter(a => a.score > 0).map(a => a.title).slice(0, 5),
        articleCount: scored.length,
      });
      count++;
    }

    // Bearish signal
    if (totalScore <= -3) {
      this.writeSignal(symbol, 'bearish_news', Math.min(Math.abs(totalScore) / 6, 1), {
        sentiment,
        totalScore,
        headlines: scored.filter(a => a.score < 0).map(a => a.title).slice(0, 5),
        articleCount: scored.length,
      });
      count++;
    }

    return count;
  }

  // ── Claude: Conflict Resolution Only ──

  async _resolveConflict(symbol, scored) {
    const headlines = scored
      .map(a => `[${a.score > 0 ? '+' : a.score < 0 ? '-' : '0'}] ${a.title}`)
      .slice(0, 8) // cap context
      .join('\n');

    const prompt = `Stock: ${symbol}
Headlines with conflicting sentiment (+ bullish, - bearish):
${headlines}

Which direction dominates? Reply JSON only:
{"direction":"bullish"|"bearish"|"neutral","confidence":0.0-1.0,"reason":"<15 words max>"}`;

    try {
      const raw = await this.callClaude(prompt);
      return this.parseJson(raw);
    } catch (err) {
      logger.error(`[news-sentinel] Claude conflict resolution failed for ${symbol}: ${err.message}`);
      this.log('claude_error', symbol, err.message);
      return null;
    }
  }

  _writeFromResolution(symbol, resolution, scored, isOpenPosition) {
    const { direction, confidence, reason } = resolution;

    const data = {
      source: 'claude_conflict_resolution',
      reason,
      headlines: scored.map(a => a.title).slice(0, 5),
      articleCount: scored.length,
    };

    if (direction === 'bullish' && confidence >= 0.5) {
      this.writeSignal(symbol, 'bullish_news', confidence, data);
    } else if (direction === 'bearish' && confidence >= 0.5) {
      this.writeSignal(symbol, 'bearish_news', confidence, data);
      if (isOpenPosition && confidence >= 0.7) {
        this.writeSignal(symbol, 'urgent_exit', confidence, data);
      }
    }
    // neutral or low confidence = no signal (intentional)
  }
}

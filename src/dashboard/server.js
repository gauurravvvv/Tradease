import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../db/sqlite.js';
import { getOpenTrades, getTradeHistory } from '../trading/manager.js';
import { getPortfolioSummary, getPerformanceStats } from '../trading/portfolio.js';
import { checkIndexHealth } from '../listeners/index-monitor.js';
import { getStockNews } from '../data/news.js';
import { scoreSentiment, classifySentiment } from '../listeners/news-monitor.js';
import { getGlobalCues } from '../data/global-cues.js';
import { getFiiDiiData } from '../data/fii-dii.js';
import { getSectorStrength } from '../analysis/sectors.js';
import { screenStocks } from '../analysis/screener.js';
import { fetchAllNews } from '../data/news.js';
import { logger } from '../utils/logger.js';

// Cache for expensive operations
const screenerCache = { data: null, ts: 0 };
const SCREENER_TTL = 10 * 60 * 1000; // 10 minutes

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Start the dashboard web server.
 * @param {number} port
 */
export function startDashboard(port = 3777) {
  const app = express();

  // Serve static frontend
  app.use(express.static(path.join(__dirname, 'public')));

  // ── API Routes ──────────────────────────────────────────────────────────

  // Portfolio summary
  app.get('/api/portfolio', (req, res) => {
    try {
      getDb();
      const summary = getPortfolioSummary();
      res.json(summary);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Open trades
  app.get('/api/trades', (req, res) => {
    try {
      getDb();
      const trades = getOpenTrades();
      // Compute live P&L for each
      const enriched = trades.map(t => {
        const currentPrice = t.current_price || t.entry_price;
        const pnl = t.type === 'CALL'
          ? (currentPrice - t.entry_price) * t.lot_size * t.quantity
          : (t.entry_price - currentPrice) * t.lot_size * t.quantity;
        const pnlPct = t.entry_price
          ? ((currentPrice - t.entry_price) / t.entry_price * 100)
          : 0;
        return { ...t, live_pnl: pnl, live_pnl_pct: pnlPct };
      });
      res.json(enriched);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Trade history
  app.get('/api/history', (req, res) => {
    try {
      getDb();
      const days = parseInt(req.query.days || '30', 10);
      const history = getTradeHistory(days);
      res.json(history);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Performance stats
  app.get('/api/stats', (req, res) => {
    try {
      getDb();
      const days = parseInt(req.query.days || '30', 10);
      const stats = getPerformanceStats(days);
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Market pulse
  app.get('/api/pulse', async (req, res) => {
    try {
      const indexData = await checkIndexHealth();
      res.json(indexData);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Full market status
  app.get('/api/market-status', async (req, res) => {
    try {
      const [indexHealth, globalCues, fiiDii, sectors] = await Promise.allSettled([
        checkIndexHealth(),
        getGlobalCues(),
        getFiiDiiData(),
        getSectorStrength(),
      ]);

      // Market session
      const now = new Date();
      const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const day = ist.getDay();
      const mins = ist.getHours() * 60 + ist.getMinutes();
      let session;
      if (day === 0 || day === 6) session = 'CLOSED';
      else if (mins < 9 * 60) session = 'PRE-MARKET';
      else if (mins < 9 * 60 + 15) session = 'PRE-OPEN';
      else if (mins < 15 * 60 + 30) session = 'OPEN';
      else if (mins < 16 * 60) session = 'POST-MARKET';
      else session = 'CLOSED';

      res.json({
        session,
        timestamp: now.toISOString(),
        indices: indexHealth.status === 'fulfilled' ? indexHealth.value : null,
        global: globalCues.status === 'fulfilled' ? globalCues.value : null,
        fiiDii: fiiDii.status === 'fulfilled' ? fiiDii.value : null,
        sectors: sectors.status === 'fulfilled' ? sectors.value : [],
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // News sentiment for open positions
  app.get('/api/news', async (req, res) => {
    try {
      getDb();
      const trades = getOpenTrades();
      const symbols = [...new Set(trades.map(t => t.symbol))];

      if (symbols.length === 0) {
        res.json([]);
        return;
      }

      const results = await Promise.all(
        symbols.map(async (symbol) => {
          try {
            const articles = await getStockNews(symbol);
            const scored = articles.map(a => ({
              title: a.title,
              link: a.link,
              source: a.source,
              pubDate: a.pubDate,
              score: scoreSentiment(a),
            }));
            const totalScore = scored.reduce((s, a) => s + a.score, 0);
            return {
              symbol,
              newsCount: articles.length,
              totalScore,
              sentiment: classifySentiment(totalScore),
              headlines: scored.sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 5),
            };
          } catch {
            return { symbol, newsCount: 0, totalScore: 0, sentiment: 'neutral', headlines: [] };
          }
        })
      );

      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Top 15 screener picks (cached 10 min)
  app.get('/api/top-picks', async (req, res) => {
    try {
      const now = Date.now();
      if (screenerCache.data && (now - screenerCache.ts) < SCREENER_TTL) {
        return res.json(screenerCache.data);
      }

      const screened = await screenStocks();
      const picks = screened.slice(0, 15).map(s => ({
        symbol: s.symbol,
        name: s.name,
        sector: s.sector,
        price: s.price,
        changePct: s.changePct,
        volume: s.volume,
        score: s.score,
        recommendation: s.recommendation,
        lotSize: s.lotSize,
        rsi: s.technicals?.rsi?.value,
        macdTrend: s.technicals?.macd?.trend,
        atr: s.technicals?.atr?.value,
        volumeRatio: s.technicals?.volume?.ratio,
        sectorRank: s.sectorRank,
        sectorTrend: s.sectorTrend,
      }));

      screenerCache.data = picks;
      screenerCache.ts = now;
      res.json(picks);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // News digest for top 15 stocks
  app.get('/api/news-digest', async (req, res) => {
    try {
      // Get top picks (from cache or fresh)
      let picks = screenerCache.data;
      if (!picks) {
        const screened = await screenStocks();
        picks = screened.slice(0, 15);
        screenerCache.data = picks;
        screenerCache.ts = Date.now();
      }

      const symbols = picks.map(p => p.symbol);
      const results = await Promise.all(
        symbols.map(async (symbol) => {
          try {
            const articles = await getStockNews(symbol);
            const scored = articles.map(a => ({
              title: a.title,
              link: a.link,
              source: a.source,
              pubDate: a.pubDate,
              score: scoreSentiment(a),
            }));
            const totalScore = scored.reduce((s, a) => s + a.score, 0);
            return {
              symbol,
              newsCount: articles.length,
              totalScore,
              sentiment: classifySentiment(totalScore),
              headlines: scored.sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 5),
            };
          } catch {
            return { symbol, newsCount: 0, totalScore: 0, sentiment: 'neutral', headlines: [] };
          }
        })
      );
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // All-in-one dashboard data (single fetch for frontend)
  app.get('/api/dashboard', async (req, res) => {
    try {
      getDb();

      const [portfolio, trades, history, stats, pulse] = await Promise.all([
        Promise.resolve(getPortfolioSummary()),
        Promise.resolve(getOpenTrades()),
        Promise.resolve(getTradeHistory(30)),
        Promise.resolve(getPerformanceStats(30)),
        checkIndexHealth().catch(() => null),
      ]);

      // Enrich trades with P&L
      const enrichedTrades = trades.map(t => {
        const cp = t.current_price || t.entry_price;
        const pnl = t.type === 'CALL'
          ? (cp - t.entry_price) * t.lot_size * t.quantity
          : (t.entry_price - cp) * t.lot_size * t.quantity;
        const pnlPct = t.entry_price ? ((cp - t.entry_price) / t.entry_price * 100) : 0;
        return { ...t, live_pnl: pnl, live_pnl_pct: pnlPct };
      });

      res.json({
        portfolio,
        trades: enrichedTrades,
        history: history.slice(0, 20), // Last 20
        stats,
        pulse,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Start server
  app.listen(port, () => {
    logger.info(`[dashboard] Running at http://localhost:${port}`);
  });

  return app;
}

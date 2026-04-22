import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../db/sqlite.js';
import { getOpenTrades, getTradeHistory } from '../trading/manager.js';
import { getPortfolioSummary, getPerformanceStats } from '../trading/portfolio.js';
import { checkIndexHealth } from '../listeners/index-monitor.js';
import { getStockNews } from '../data/news.js';
import { scoreSentiment, classifySentiment } from '../listeners/news-monitor.js';
import { logger } from '../utils/logger.js';

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

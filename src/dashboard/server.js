import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../db/sqlite.js';
import {
  getOpenTrades,
  getTradeHistory,
  enterTrade,
  exitTrade,
  partialExit,
} from '../trading/manager.js';
import {
  getPortfolioSummary,
  getPerformanceStats,
  getEquityCurve,
} from '../trading/portfolio.js';
import {
  calculateStopLoss,
  calculateTargets,
  calculatePositionSize,
  validateTrade,
} from '../trading/risk.js';
import { checkIndexHealth } from '../listeners/index-monitor.js';
import { getStockNews, fetchAllNews } from '../data/news.js';
import {
  scoreSentiment,
  classifySentiment,
} from '../listeners/news-monitor.js';
import { getGlobalCues } from '../data/global-cues.js';
import { getFiiDiiData } from '../data/fii-dii.js';
import { getSectorStrength } from '../analysis/sectors.js';
import { screenStocks } from '../analysis/screener.js';
import { getQuote, getHistorical } from '../data/market.js';
import YahooFinance from 'yahoo-finance2';
import { DATA, TRADING } from '../config/settings.js';
import { FNO_STOCKS } from '../data/fno-stocks.js';
import { analyzeTechnicals, computeATR } from '../analysis/technicals.js';
import { logger } from '../utils/logger.js';
import {
  getOrchestrator,
  setOrchestrator,
  AgentOrchestrator,
} from '../agents/orchestrator.js';

// Cache for expensive operations
const screenerCache = { data: null, ts: 0 };
const SCREENER_TTL = 10 * 60 * 1000; // 10 minutes
const chartCache = new Map(); // key: symbol, value: { data, ts }
const CHART_TTL = 2 * 60 * 1000; // 2 minutes

// ── Live data caches (shared across SSE clients) ──
const liveCache = {
  trades: { data: null, ts: 0 },
  news: { data: null, ts: 0 },
  indices: { data: null, ts: 0 },
};
const sseClients = new Set();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Start the dashboard web server.
 * @param {number} port
 */
export function startDashboard(port = 3777) {
  const app = express();

  // Load persisted config (email, telegram, trading) on dashboard start
  import('../config/persist.js')
    .then(({ loadPersistedConfig, getConfigSection }) => {
      loadPersistedConfig();
      const emailCfg = getConfigSection('email');
      if (emailCfg)
        import('../utils/emailer.js').then(({ configureEmail }) =>
          configureEmail(emailCfg),
        );
      const tgCfg = getConfigSection('telegram');
      if (tgCfg)
        import('../utils/telegram.js').then(({ configureTelegram }) =>
          configureTelegram(tgCfg.token, tgCfg.chatId),
        );
      const tradingCfg = getConfigSection('trading');
      if (tradingCfg) {
        Object.assign(TRADING, tradingCfg);
        if (tradingCfg.RISK_REWARD)
          Object.assign(TRADING.RISK_REWARD, tradingCfg.RISK_REWARD);
      }
    })
    .catch(() => {});

  // Middleware
  app.use(express.json());
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
        const pnl =
          t.type === 'CALL'
            ? (currentPrice - t.entry_price) * t.lot_size * t.quantity
            : (t.entry_price - currentPrice) * t.lot_size * t.quantity;
        const rawPct = t.entry_price
          ? ((currentPrice - t.entry_price) / t.entry_price) * 100
          : 0;
        const pnlPct = t.type === 'PUT' ? -rawPct : rawPct;
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
      const [indexHealth, globalCues, fiiDii, sectors] =
        await Promise.allSettled([
          checkIndexHealth(),
          getGlobalCues(),
          getFiiDiiData(),
          getSectorStrength(),
        ]);

      // Market session
      const now = new Date();
      const ist = new Date(
        now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
      );
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
        symbols.map(async symbol => {
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
              headlines: scored
                .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
                .slice(0, 5),
            };
          } catch {
            return {
              symbol,
              newsCount: 0,
              totalScore: 0,
              sentiment: 'neutral',
              headlines: [],
            };
          }
        }),
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
      if (screenerCache.data && now - screenerCache.ts < SCREENER_TTL) {
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
        symbols.map(async symbol => {
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
              headlines: scored
                .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
                .slice(0, 5),
            };
          } catch {
            return {
              symbol,
              newsCount: 0,
              totalScore: 0,
              sentiment: 'neutral',
              headlines: [],
            };
          }
        }),
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
        const pnl =
          t.type === 'CALL'
            ? (cp - t.entry_price) * t.lot_size * t.quantity
            : (t.entry_price - cp) * t.lot_size * t.quantity;
        const rawPct = t.entry_price
          ? ((cp - t.entry_price) / t.entry_price) * 100
          : 0;
        const pnlPct = t.type === 'PUT' ? -rawPct : rawPct;
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

  // ── Action API Routes ────────────────────────────────────────────────────

  // Get live quote + technicals + trade suggestions for a symbol
  app.get('/api/quote/:symbol', async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const [quote, history] = await Promise.all([
        getQuote(symbol),
        getHistorical(symbol, 90).catch(() => []),
      ]);

      let technicals = null;
      let atr = null;
      let suggestions = null;

      if (history.length >= 14) {
        technicals = analyzeTechnicals(history);
        atr = computeATR(history);
      }

      if (quote && atr) {
        const callSL = calculateStopLoss(quote.price, atr, 'CALL');
        const putSL = calculateStopLoss(quote.price, atr, 'PUT');
        const callTargets = calculateTargets(quote.price, callSL, 'CALL');
        const putTargets = calculateTargets(quote.price, putSL, 'PUT');
        const portfolio = getPortfolioSummary();
        const posSize = calculatePositionSize(
          portfolio.availableCapital,
          quote.price,
          1,
        );

        suggestions = {
          call: {
            entry: quote.price,
            stopLoss: callSL,
            target1: callTargets.target1,
            target2: callTargets.target2,
            riskPerLot: callTargets.riskPerLot,
          },
          put: {
            entry: quote.price,
            stopLoss: putSL,
            target1: putTargets.target1,
            target2: putTargets.target2,
            riskPerLot: putTargets.riskPerLot,
          },
          positionSize: posSize,
          atr,
        };
      }

      res.json({ quote, technicals, suggestions });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Quick research — quote + technicals + news + suggestions
  app.get('/api/research/:symbol', async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const [quote, history, articles] = await Promise.all([
        getQuote(symbol),
        getHistorical(symbol, 90).catch(() => []),
        getStockNews(symbol).catch(() => []),
      ]);

      let technicals = null;
      let atr = null;
      let suggestions = null;

      if (history.length >= 14) {
        technicals = analyzeTechnicals(history);
        atr = computeATR(history);
      }

      const scoredNews = articles.map(a => ({
        title: a.title,
        link: a.link,
        source: a.source,
        pubDate: a.pubDate,
        score: scoreSentiment(a),
      }));
      const newsScore = scoredNews.reduce((s, a) => s + a.score, 0);

      if (quote && atr) {
        const callSL = calculateStopLoss(quote.price, atr, 'CALL');
        const putSL = calculateStopLoss(quote.price, atr, 'PUT');
        const callTargets = calculateTargets(quote.price, callSL, 'CALL');
        const putTargets = calculateTargets(quote.price, putSL, 'PUT');
        const portfolio = getPortfolioSummary();

        suggestions = {
          call: {
            entry: quote.price,
            stopLoss: callSL,
            target1: callTargets.target1,
            target2: callTargets.target2,
            riskPerLot: callTargets.riskPerLot,
          },
          put: {
            entry: quote.price,
            stopLoss: putSL,
            target1: putTargets.target1,
            target2: putTargets.target2,
            riskPerLot: putTargets.riskPerLot,
          },
          atr,
          availableCapital: portfolio.availableCapital,
          openPositions: portfolio.openPositions,
        };
      }

      res.json({
        symbol,
        quote,
        technicals,
        suggestions,
        news: {
          articles: scoredNews.slice(0, 8),
          totalScore: newsScore,
          sentiment: classifySentiment(newsScore),
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Enter a trade
  app.post('/api/trades/enter', (req, res) => {
    try {
      getDb();
      const {
        symbol,
        type,
        entryPrice,
        premium,
        lotSize,
        stopLoss,
        target1,
        target2,
        confidence,
        reason,
        expiry,
        strike,
      } = req.body;
      if (!symbol || !type || !entryPrice || !lotSize || !stopLoss) {
        return res
          .status(400)
          .json({
            error:
              'Missing required fields: symbol, type, entryPrice, lotSize, stopLoss',
          });
      }
      const trade = enterTrade({
        symbol: symbol.toUpperCase(),
        type: type.toUpperCase(),
        entryPrice: Number(entryPrice),
        premium: Number(premium || entryPrice * 0.02),
        lotSize: Number(lotSize),
        stopLoss: Number(stopLoss),
        target1: target1 ? Number(target1) : null,
        target2: target2 ? Number(target2) : null,
        confidence: Number(confidence || 70),
        reason: reason || 'Manual UI entry',
        expiry,
        strike: strike ? Number(strike) : undefined,
      });
      logger.trade(
        `[dashboard] Trade entered via UI: ${symbol} ${type} @ ${entryPrice}`,
      );
      res.json({ ok: true, trade });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Exit a trade
  app.post('/api/trades/:id/exit', async (req, res) => {
    try {
      getDb();
      const tradeId = parseInt(req.params.id, 10);
      const { reason } = req.body || {};
      const trades = getOpenTrades();
      const trade = trades.find(t => t.id === tradeId);
      if (!trade) return res.status(404).json({ error: 'Trade not found' });

      let exitPrice = trade.current_price || trade.entry_price;
      try {
        const q = await getQuote(trade.symbol);
        exitPrice = q.price;
      } catch {}
      exitTrade(tradeId, exitPrice, reason || 'Manual UI exit');
      logger.trade(
        `[dashboard] Trade exited via UI: ${trade.symbol} @ ${exitPrice}`,
      );
      res.json({ ok: true, exitPrice });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Partial exit a trade
  app.post('/api/trades/:id/partial-exit', async (req, res) => {
    try {
      getDb();
      const tradeId = parseInt(req.params.id, 10);
      const { percentage, reason } = req.body || {};
      const trades = getOpenTrades();
      const trade = trades.find(t => t.id === tradeId);
      if (!trade) return res.status(404).json({ error: 'Trade not found' });

      let exitPrice = trade.current_price || trade.entry_price;
      try {
        const q = await getQuote(trade.symbol);
        exitPrice = q.price;
      } catch {}
      const pct = Number(percentage || 0.5);
      partialExit(
        tradeId,
        pct,
        exitPrice,
        reason || `Partial exit ${Math.round(pct * 100)}% via UI`,
      );
      logger.trade(
        `[dashboard] Partial exit via UI: ${trade.symbol} ${Math.round(pct * 100)}% @ ${exitPrice}`,
      );
      res.json({ ok: true, exitPrice, percentage: pct });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Run screener scan (force fresh)
  app.post('/api/scan', async (req, res) => {
    try {
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
      screenerCache.ts = Date.now();
      logger.info(`[dashboard] Fresh scan via UI: ${picks.length} picks`);
      res.json(picks);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Hard reload — flush all caches
  app.post('/api/reload', async (req, res) => {
    try {
      screenerCache.data = null;
      screenerCache.ts = 0;
      chartCache.clear();
      liveCache.trades = { data: null, ts: 0 };
      liveCache.news = { data: null, ts: 0 };
      liveCache.indices = { data: null, ts: 0 };
      try {
        const { clearMarketCache } = await import('../data/market.js');
        clearMarketCache();
      } catch {}
      logger.info('[dashboard] Hard reload — all caches flushed');
      res.json({ success: true, message: 'All caches cleared' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Intraday 5-min chart data
  app.get('/api/chart/:symbol', async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const now = Date.now();
      const cached = chartCache.get(symbol);
      if (cached && now - cached.ts < CHART_TTL) {
        return res.json(cached.data);
      }

      const ySymbol =
        symbol === 'NIFTY'
          ? '^NSEI'
          : symbol === 'BANKNIFTY'
            ? '^NSEBANK'
            : `${symbol}${DATA.YAHOO_SUFFIX}`;

      const yahooFinance = new YahooFinance({
        suppressNotices: ['yahooSurvey'],
      });
      const result = await yahooFinance.chart(ySymbol, {
        period1: new Date(new Date().setHours(0, 0, 0, 0)),
        interval: '5m',
      });

      const quotes = result.quotes || [];
      const candles = quotes
        .filter(q => q.open != null && q.close != null)
        .map(q => ({
          time: Math.floor(new Date(q.date).getTime() / 1000),
          open: q.open,
          high: q.high,
          low: q.low,
          close: q.close,
        }));

      const volume = quotes
        .filter(q => q.volume != null)
        .map(q => ({
          time: Math.floor(new Date(q.date).getTime() / 1000),
          value: q.volume,
          color:
            q.close >= q.open ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)',
        }));

      const data = { symbol, candles, volume };
      chartCache.set(symbol, { data, ts: now });
      res.json(data);
    } catch (err) {
      res
        .status(500)
        .json({
          error: err.message,
          symbol: req.params.symbol,
          candles: [],
          volume: [],
        });
    }
  });

  // Equity curve + daily P&L chart data
  app.get('/api/equity-curve', (req, res) => {
    try {
      getDb();
      const days = parseInt(req.query.days || '30', 10);
      const data = getEquityCurve(days);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Risk dashboard summary
  app.get('/api/risk-summary', (req, res) => {
    try {
      getDb();
      const portfolio = getPortfolioSummary();
      const trades = getOpenTrades();
      const totalCapital = portfolio.totalCapital;

      // Sector lookup
      const sectorMap = {};
      for (const s of FNO_STOCKS) sectorMap[s.symbol] = s.sector;

      // Position allocation
      const positions = trades.map(t => ({
        symbol: t.symbol,
        sector: sectorMap[t.symbol] || 'Other',
        capital: t.capital_used,
        pct:
          totalCapital > 0
            ? Math.round((t.capital_used / totalCapital) * 10000) / 100
            : 0,
      }));

      const availablePct =
        totalCapital > 0
          ? Math.round((portfolio.availableCapital / totalCapital) * 10000) /
            100
          : 100;

      // Sector exposure (aggregate by sector)
      const sectorTotals = {};
      for (const p of positions) {
        sectorTotals[p.sector] = (sectorTotals[p.sector] || 0) + p.capital;
      }
      const sectorExposure = Object.entries(sectorTotals).map(
        ([sector, capital]) => ({
          sector,
          capital,
          pct:
            totalCapital > 0
              ? Math.round((capital / totalCapital) * 10000) / 100
              : 0,
        }),
      );

      // Drawdown from daily_summary
      const db = getDb();
      const summaries = db
        .prepare(
          'SELECT ending_capital FROM daily_summary WHERE ending_capital IS NOT NULL ORDER BY date ASC',
        )
        .all();
      let peakCapital = totalCapital;
      let maxDrawdownPct = 0;
      for (const row of summaries) {
        if (row.ending_capital > peakCapital) peakCapital = row.ending_capital;
        const dd =
          peakCapital > 0
            ? ((peakCapital - row.ending_capital) / peakCapital) * 100
            : 0;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;
      }
      const currentCapitalVal = totalCapital + portfolio.unrealizedPnl;
      const currentDrawdownPct =
        peakCapital > 0
          ? Math.max(0, ((peakCapital - currentCapitalVal) / peakCapital) * 100)
          : 0;

      // Risk metrics
      const totalHeat = trades.reduce((s, t) => s + t.capital_used, 0);

      const worstCaseLoss = trades.reduce((s, t) => {
        if (!t.stop_loss) return s;
        const loss =
          t.type === 'CALL'
            ? (t.entry_price - t.stop_loss) * t.lot_size * t.quantity
            : (t.stop_loss - t.entry_price) * t.lot_size * t.quantity;
        return s - Math.abs(loss);
      }, 0);

      const avgRiskReward =
        trades.length > 0
          ? trades.reduce((s, t) => {
              if (!t.stop_loss || !t.target1) return s;
              const risk = Math.abs(t.entry_price - t.stop_loss);
              const reward = Math.abs(t.target1 - t.entry_price);
              return s + (risk > 0 ? reward / risk : 0);
            }, 0) / trades.length
          : 0;

      // Win/loss streak
      const recent = db
        .prepare(
          `SELECT pnl FROM trades WHERE status IN ('CLOSED','STOPPED') ORDER BY exited_at DESC LIMIT 20`,
        )
        .all();
      let winStreak = 0,
        lossStreak = 0;
      for (const t of recent) {
        if ((t.pnl || 0) > 0) {
          winStreak++;
          if (lossStreak > 0) break;
        } else if ((t.pnl || 0) < 0) {
          lossStreak++;
          if (winStreak > 0) break;
        } else break;
      }

      res.json({
        allocation: {
          positions,
          available: {
            capital: Math.round(portfolio.availableCapital * 100) / 100,
            pct: availablePct,
          },
        },
        sectorExposure,
        drawdown: {
          peakCapital: Math.round(peakCapital * 100) / 100,
          currentCapital: Math.round(currentCapitalVal * 100) / 100,
          maxDrawdownPct: Math.round(maxDrawdownPct * 100) / 100,
          currentDrawdownPct: Math.round(currentDrawdownPct * 100) / 100,
        },
        metrics: {
          totalHeat: Math.round(totalHeat * 100) / 100,
          worstCaseLoss: Math.round(worstCaseLoss * 100) / 100,
          avgRiskReward: Math.round(avgRiskReward * 100) / 100,
          winStreak,
          lossStreak,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Backtest results
  app.get('/api/backtest/latest', async (req, res) => {
    try {
      const { loadLatestBacktest, listBacktests } =
        await import('../backtesting/report.js');
      const latest = loadLatestBacktest();
      const all = listBacktests();
      res.json({ latest, history: all });
    } catch {
      res.json({ latest: null, history: [] });
    }
  });

  // Run backtest from dashboard
  app.post('/api/backtest/run', async (req, res) => {
    // Set long timeout for backtest (5 minutes)
    req.setTimeout(300000);
    res.setTimeout(300000);

    try {
      const { runBacktest } = await import('../backtesting/engine.js');
      const { saveBacktestResult } = await import('../backtesting/report.js');
      const { FNO_STOCKS } = await import('../data/fno-stocks.js');

      const {
        strategy = 'screener',
        days = 90,
        symbolCount = 5,
      } = req.body || {};
      const end = new Date().toISOString().slice(0, 10);
      const start = new Date(Date.now() - days * 86400000)
        .toISOString()
        .slice(0, 10);
      const count = Math.min(Math.max(1, parseInt(symbolCount) || 5), 15);
      const symbols = FNO_STOCKS.slice(0, count).map(s => s.symbol);

      logger.info(
        `[backtest] Dashboard request: ${strategy}, ${symbols.length} symbols, ${start} → ${end}`,
      );

      const result = await runBacktest({
        strategy,
        symbols,
        startDate: start,
        endDate: end,
      });
      saveBacktestResult(result);

      // Strip equity curve and trade details to reduce response size
      res.json({
        metrics: result.metrics,
        config: result.config,
        tradeCount: result.trades?.length || 0,
      });
    } catch (err) {
      logger.error(`[backtest] Dashboard backtest failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // Recommended trades with pre-computed entry/SL/targets
  app.get('/api/recommendations', async (req, res) => {
    try {
      getDb();
      // Return empty outside market hours (9:15 - 15:30 IST, Mon-Fri)
      const ist = new Date(
        new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
      );
      const day = ist.getDay();
      const mins = ist.getHours() * 60 + ist.getMinutes();
      const marketOpen = mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
      if (day === 0 || day === 6 || !marketOpen) {
        screenerCache.data = null;
        screenerCache.ts = 0;
        return res.json({
          recommendations: [],
          portfolio: { available: 0, positions: 0, maxPositions: TRADING.MAX_POSITIONS },
          scannedAt: null,
          marketClosed: true,
        });
      }
      const now = Date.now();
      let picks = screenerCache.data;
      if (!picks || now - screenerCache.ts >= SCREENER_TTL) {
        const screened = await screenStocks();
        picks = screened.slice(0, 15).map(s => ({
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
          overallSignal: s.technicals?.overallSignal,
          sectorRank: s.sectorRank,
          sectorTrend: s.sectorTrend,
        }));
        screenerCache.data = picks;
        screenerCache.ts = now;
      }

      // Filter to actionable picks with trade params
      const portfolio = getPortfolioSummary();
      const openSymbols = new Set(getOpenTrades().map(t => t.symbol));
      const actionable = picks
        .filter(
          p =>
            (p.recommendation === 'CALL' || p.recommendation === 'PUT') &&
            !openSymbols.has(p.symbol),
        )
        .slice(0, 8)
        .map(p => {
          const atr = p.atr || 0;
          const type = p.recommendation;
          const sl = atr ? calculateStopLoss(p.price, atr, type) : null;
          const targets = sl ? calculateTargets(p.price, sl, type) : null;
          const posSize = calculatePositionSize(
            portfolio.availableCapital,
            p.price,
            p.lotSize || 1,
          );
          return {
            ...p,
            atr,
            entry: p.price,
            stopLoss: sl,
            target1: targets?.target1 || null,
            target2: targets?.target2 || null,
            riskPerLot: targets?.riskPerLot || null,
            riskReward:
              sl && targets
                ? Math.abs(targets.target1 - p.price) / Math.abs(p.price - sl)
                : null,
            maxLots: posSize.lots,
            capitalRequired: posSize.capitalRequired,
            canTrade:
              !openSymbols.has(p.symbol) &&
              portfolio.openPositions < TRADING.MAX_POSITIONS &&
              posSize.lots > 0,
          };
        });

      res.json({
        recommendations: actionable,
        portfolio: {
          available: portfolio.availableCapital,
          positions: portfolio.openPositions,
          maxPositions: TRADING.MAX_POSITIONS,
        },
        scannedAt: screenerCache.ts
          ? new Date(screenerCache.ts).toISOString()
          : null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Validate a potential trade before entry
  app.post('/api/trades/validate', (req, res) => {
    try {
      getDb();
      const { symbol, type, capitalRequired, maxLoss } = req.body;
      const portfolio = getPortfolioSummary();
      const result = validateTrade(
        {
          symbol,
          type,
          capitalRequired: Number(capitalRequired),
          maxLoss: Number(maxLoss),
        },
        {
          positions: portfolio.trades,
          capitalUsed: portfolio.capitalInUse,
          totalCapital: portfolio.totalCapital,
        },
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Agent API Routes ───────────────────────────────────────────────────

  // Start/stop agents from dashboard
  app.post('/api/agents/start', async (req, res) => {
    try {
      let orch = getOrchestrator();
      if (!orch) {
        orch = new AgentOrchestrator();
        setOrchestrator(orch);
      }
      if (!orch.isRunning()) {
        await orch.start();
      }
      res.json({ ok: true, running: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/agents/stop', (req, res) => {
    try {
      const orch = getOrchestrator();
      if (orch && orch.isRunning()) orch.stop();
      res.json({ ok: true, running: false });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Agent status
  app.get('/api/agents/status', (req, res) => {
    try {
      const orch = getOrchestrator();
      if (!orch) {
        // Return DB-based stats even when orchestrator not in this process
        const db = getDb();
        const agents = [
          'news-sentinel',
          'trade-strategist',
          'position-guardian',
        ];
        const status = agents.map(name => {
          const stats = db
            .prepare(
              `SELECT COUNT(*) as runs, SUM(skipped) as skipped, SUM(tokens_in + tokens_out) as tokens
             FROM agent_logs WHERE agent = ? AND created_at > datetime('now', '+5 hours', '+30 minutes', '-1 hour')`,
            )
            .get(name);
          const errors = db
            .prepare(
              `SELECT COUNT(*) as count FROM agent_logs WHERE agent = ? AND action = 'error' AND created_at > datetime('now', '+5 hours', '+30 minutes', '-1 hour')`,
            )
            .get(name);
          const last = db
            .prepare(
              'SELECT action, symbol, details, created_at FROM agent_logs WHERE agent = ? ORDER BY created_at DESC LIMIT 1',
            )
            .get(name);
          return {
            name,
            runs: stats?.runs || 0,
            skipped: stats?.skipped || 0,
            tokens: stats?.tokens || 0,
            errors: errors?.count || 0,
            lastAction: last?.action || 'idle',
            lastRun: last?.created_at || null,
          };
        });
        return res.json({ running: false, agents: status });
      }
      const hourly = orch.getHourlyStats();
      const tokenUsage = orch.getTodayTokenUsage();
      res.json({ running: orch.isRunning(), agents: hourly, tokenUsage });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Recent agent logs
  app.get('/api/agents/logs', (req, res) => {
    try {
      const db = getDb();
      const limit = parseInt(req.query.limit || '30', 10);
      const logs = db
        .prepare('SELECT * FROM agent_logs ORDER BY created_at DESC LIMIT ?')
        .all(limit);
      res.json(logs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Pending signals
  app.get('/api/agents/signals', (req, res) => {
    try {
      const db = getDb();
      const signals = db
        .prepare(
          'SELECT * FROM agent_signals WHERE consumed = 0 ORDER BY created_at DESC',
        )
        .all();
      res.json(signals);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Toggle individual agent
  app.post('/api/agents/:name/toggle', (req, res) => {
    try {
      const orch = getOrchestrator();
      if (!orch) return res.status(400).json({ error: 'Agents not running' });
      const { enabled } = req.body || {};
      const ok = orch.setAgentEnabled(req.params.name, enabled !== false);
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Live Data Endpoints ──────────────────────────────────────────────────

  // General finance news (all RSS feeds, not stock-specific)
  app.get('/api/live-news', async (req, res) => {
    try {
      const now = Date.now();
      if (liveCache.news.data && now - liveCache.news.ts < 120_000) {
        return res.json(liveCache.news.data);
      }
      const articles = await fetchAllNews();
      const scored = articles.slice(0, 30).map(a => ({
        title: a.title,
        link: a.link,
        source: a.source,
        pubDate: a.pubDate,
        snippet: a.snippet,
        score: scoreSentiment(a),
      }));
      liveCache.news.data = scored;
      liveCache.news.ts = now;
      res.json(scored);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Live trade prices — fetch fresh quotes for open positions
  app.get('/api/trades/live', async (req, res) => {
    try {
      getDb();
      const trades = getOpenTrades();
      if (!trades.length) return res.json([]);

      const symbols = [...new Set(trades.map(t => t.symbol))];
      const quotes = {};
      await Promise.allSettled(
        symbols.map(async sym => {
          try {
            const q = await getQuote(sym);
            quotes[sym] = q.price;
          } catch {}
        }),
      );

      const enriched = trades.map(t => {
        const cp = quotes[t.symbol] || t.current_price || t.entry_price;
        const pnl =
          t.type === 'CALL'
            ? (cp - t.entry_price) * t.lot_size * t.quantity
            : (t.entry_price - cp) * t.lot_size * t.quantity;
        const rawPct = t.entry_price
          ? ((cp - t.entry_price) / t.entry_price) * 100
          : 0;
        const pnlPct = t.type === 'PUT' ? -rawPct : rawPct;
        return { ...t, current_price: cp, live_pnl: pnl, live_pnl_pct: pnlPct };
      });
      res.json(enriched);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Server-Sent Events stream ──────────────────────────────────────────

  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('data: {"type":"connected"}\n\n');

    sseClients.add(res);
    logger.info(`[sse] Client connected (${sseClients.size} total)`);

    req.on('close', () => {
      sseClients.delete(res);
      logger.info(`[sse] Client disconnected (${sseClients.size} total)`);
    });
  });

  function broadcast(eventType, data) {
    const msg = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(msg);
      } catch {}
    }
  }

  // Background live data pump — only runs when clients connected
  let pumpInterval = null;
  let pumpTick = 0;

  function isMarketOpen() {
    const ist = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
    );
    const day = ist.getDay();
    if (day === 0 || day === 6) return false;
    const mins = ist.getHours() * 60 + ist.getMinutes();
    return mins >= 9 * 60 && mins < 16 * 60; // 9:00 - 16:00 (include pre/post)
  }

  function startPump() {
    if (pumpInterval) return;
    pumpInterval = setInterval(async () => {
      if (sseClients.size === 0) return;
      pumpTick++;

      const marketOpen = isMarketOpen();

      // Broadcast market status so frontend knows
      if (pumpTick % 4 === 0) {
        broadcast('marketStatus', { open: marketOpen });
      }

      // Every 15s: live trade prices (only during market hours OR if positions open)
      try {
        getDb();
        const trades = getOpenTrades();
        if (trades.length && marketOpen) {
          const symbols = [...new Set(trades.map(t => t.symbol))];
          const quotes = {};
          await Promise.allSettled(
            symbols.map(async sym => {
              try {
                const q = await getQuote(sym);
                quotes[sym] = q.price;
              } catch {}
            }),
          );
          // Update DB current_price so portfolio summary uses fresh prices
          const db = getDb();
          const updateStmt = db.prepare(
            'UPDATE trades SET current_price = ? WHERE id = ? AND status = ?',
          );
          const updateMany = db.transaction(items => {
            for (const { id, cp } of items) updateStmt.run(cp, id, 'OPEN');
          });
          const updates = [];
          const enriched = trades.map(t => {
            const cp = quotes[t.symbol] || t.current_price || t.entry_price;
            if (quotes[t.symbol]) updates.push({ id: t.id, cp });
            const pnl =
              t.type === 'CALL'
                ? (cp - t.entry_price) * t.lot_size * t.quantity
                : (t.entry_price - cp) * t.lot_size * t.quantity;
            const rawPct = t.entry_price
              ? ((cp - t.entry_price) / t.entry_price) * 100
              : 0;
            const pnlPct = t.type === 'PUT' ? -rawPct : rawPct;
            return {
              id: t.id,
              symbol: t.symbol,
              type: t.type,
              entry_price: t.entry_price,
              current_price: cp,
              stop_loss: t.stop_loss,
              target1: t.target1,
              target2: t.target2,
              t1_hit: t.t1_hit,
              t2_hit: t.t2_hit,
              quantity: t.quantity,
              capital_used: t.capital_used,
              entered_at: t.entered_at,
              live_pnl: pnl,
              live_pnl_pct: pnlPct,
            };
          });
          if (updates.length) updateMany(updates);
          broadcast('trades', enriched);
        }

        // Portfolio: always broadcast (lightweight, DB-only)
        const portfolio = getPortfolioSummary();
        portfolio.maxPositions = TRADING.MAX_POSITIONS;
        broadcast('portfolio', portfolio);
      } catch {}

      // Every 60s: index prices (skip when market closed)
      if (pumpTick % 4 === 0 && marketOpen) {
        try {
          const idx = await checkIndexHealth();
          broadcast('indices', idx);
        } catch {}
      }

      // Every 2min: live news (skip when market closed)
      if (pumpTick % 8 === 0 && marketOpen) {
        try {
          const articles = await fetchAllNews();
          const scored = articles.slice(0, 20).map(a => ({
            title: a.title,
            link: a.link,
            source: a.source,
            pubDate: a.pubDate,
            score: scoreSentiment(a),
          }));
          broadcast('news', scored);
        } catch {}
      }

      // Every 30s: agent activity (DB-only, always fine)
      if (pumpTick % 2 === 0) {
        try {
          const db = getDb();
          const logs = db
            .prepare(
              'SELECT * FROM agent_logs ORDER BY created_at DESC LIMIT 10',
            )
            .all();
          const signals = db
            .prepare(
              'SELECT * FROM agent_signals WHERE consumed = 0 ORDER BY created_at DESC LIMIT 5',
            )
            .all();
          const orch = getOrchestrator();
          broadcast('agents', {
            logs,
            signals,
            running: orch?.isRunning() || false,
          });
        } catch {}
      }
    }, 15_000); // 15-second base tick
  }

  // ── Agent Configuration ──────────────────────────────────────────────────

  app.get('/api/agent-config', async (req, res) => {
    try {
      const { TRADING } = await import('../config/settings.js');
      res.json({
        maxPositions: TRADING.MAX_POSITIONS,
        maxCapitalPerPosition: TRADING.MAX_CAPITAL_PER_POSITION * 100,
        maxLossPerTrade: TRADING.MAX_LOSS_PER_TRADE * 100,
        atrStopMultiplier: TRADING.ATR_STOP_MULTIPLIER,
        trailingStopATR: TRADING.TRAILING_STOP_ATR,
        trailingTriggerPct: TRADING.TRAILING_TRIGGER_PCT,
        riskRewardT1: TRADING.RISK_REWARD.T1,
        riskRewardT2: TRADING.RISK_REWARD.T2,
        noNewEntryAfter: TRADING.NO_NEW_ENTRY_AFTER,
        autoEntryThreshold: 70,
        minVolumeRatio: 1.0,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/agent-config', express.json(), async (req, res) => {
    try {
      const { TRADING } = await import('../config/settings.js');
      const c = req.body;
      if (c.maxPositions != null)
        TRADING.MAX_POSITIONS = parseInt(c.maxPositions);
      if (c.maxCapitalPerPosition != null)
        TRADING.MAX_CAPITAL_PER_POSITION =
          parseFloat(c.maxCapitalPerPosition) / 100;
      if (c.maxLossPerTrade != null)
        TRADING.MAX_LOSS_PER_TRADE = parseFloat(c.maxLossPerTrade) / 100;
      if (c.atrStopMultiplier != null)
        TRADING.ATR_STOP_MULTIPLIER = parseFloat(c.atrStopMultiplier);
      if (c.trailingStopATR != null)
        TRADING.TRAILING_STOP_ATR = parseFloat(c.trailingStopATR);
      if (c.trailingTriggerPct != null)
        TRADING.TRAILING_TRIGGER_PCT = parseFloat(c.trailingTriggerPct);
      if (c.riskRewardT1 != null)
        TRADING.RISK_REWARD.T1 = parseFloat(c.riskRewardT1);
      if (c.riskRewardT2 != null)
        TRADING.RISK_REWARD.T2 = parseFloat(c.riskRewardT2);
      if (c.noNewEntryAfter != null)
        TRADING.NO_NEW_ENTRY_AFTER = c.noNewEntryAfter;

      // Persist trading config to disk
      const { saveConfigSection } = await import('../config/persist.js');
      saveConfigSection('trading', {
        MAX_POSITIONS: TRADING.MAX_POSITIONS,
        MAX_CAPITAL_PER_POSITION: TRADING.MAX_CAPITAL_PER_POSITION,
        MAX_LOSS_PER_TRADE: TRADING.MAX_LOSS_PER_TRADE,
        ATR_STOP_MULTIPLIER: TRADING.ATR_STOP_MULTIPLIER,
        TRAILING_STOP_ATR: TRADING.TRAILING_STOP_ATR,
        TRAILING_TRIGGER_PCT: TRADING.TRAILING_TRIGGER_PCT,
        RISK_REWARD: TRADING.RISK_REWARD,
        NO_NEW_ENTRY_AFTER: TRADING.NO_NEW_ENTRY_AFTER,
      });

      res.json({ success: true, message: 'Configuration updated' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Trade Journal ──────────────────────────────────────────────────────

  app.get('/api/journal', async (req, res) => {
    try {
      const { getJournalEntries, getJournalStats } =
        await import('../trading/journal.js');
      const days = parseInt(req.query.days || '30', 10);
      const symbol = req.query.symbol || undefined;
      const tag = req.query.tag || undefined;
      const entries = getJournalEntries({ days, symbol, tag });
      const stats = getJournalStats(days);
      res.json({ entries, stats });
    } catch (err) {
      res.json({
        entries: [],
        stats: {
          totalEntries: 0,
          avgRating: 0,
          tagBreakdown: {},
          winners: 0,
          losers: 0,
        },
      });
    }
  });

  app.put('/api/journal/:id', async (req, res) => {
    try {
      const { updateJournalEntry } = await import('../trading/journal.js');
      const id = parseInt(req.params.id, 10);
      updateJournalEntry(id, req.body);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/journal/auto', async (req, res) => {
    try {
      const { autoJournalRecentTrades } = await import('../trading/journal.js');
      const created = autoJournalRecentTrades();
      res.json({ ok: true, created });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Telegram Configuration ─────────────────────────────────────────────

  app.get('/api/telegram/status', async (req, res) => {
    const { isTelegramConfigured } = await import('../utils/telegram.js');
    res.json({ configured: isTelegramConfigured() });
  });

  app.post('/api/telegram/configure', async (req, res) => {
    const { token, chatId } = req.body;
    if (!token || !chatId) {
      return res.status(400).json({ error: 'token and chatId required' });
    }
    const { configureTelegram, sendTelegram } =
      await import('../utils/telegram.js');
    const { saveConfigSection } = await import('../config/persist.js');
    configureTelegram(token, chatId);
    saveConfigSection('telegram', { token, chatId });
    await sendTelegram(
      '✅ Tradease connected! You will receive trade alerts here.',
    );
    res.json({ success: true });
  });

  app.post('/api/telegram/test', async (req, res) => {
    const { sendTelegram, isTelegramConfigured } =
      await import('../utils/telegram.js');
    if (!isTelegramConfigured()) {
      return res.status(400).json({ error: 'Telegram not configured' });
    }
    await sendTelegram('🧪 Test message from Tradease dashboard!');
    res.json({ success: true });
  });

  // ── Email Configuration ───────────────────────────────────────────────

  app.get('/api/email/status', async (req, res) => {
    const { getEmailConfig } = await import('../utils/emailer.js');
    res.json(getEmailConfig());
  });

  app.post('/api/email/configure', express.json(), async (req, res) => {
    const { host, port, user, pass, from, to } = req.body;
    if (!host || !user || !pass || !from || !to) {
      return res
        .status(400)
        .json({
          error: 'All SMTP fields required (host, port, user, pass, from, to)',
        });
    }
    const { configureEmail, sendTestEmail } =
      await import('../utils/emailer.js');
    const { saveConfigSection } = await import('../config/persist.js');
    configureEmail({ host, port: parseInt(port) || 587, user, pass, from, to });
    saveConfigSection('email', {
      host,
      port: parseInt(port) || 587,
      user,
      pass,
      from,
      to,
    });
    try {
      await sendTestEmail();
      res.json({ success: true, message: 'Email configured and test sent' });
    } catch (err) {
      res.json({
        success: true,
        warning: `Saved but test failed: ${err.message}`,
      });
    }
  });

  app.post('/api/email/test', express.json(), async (req, res) => {
    const { isEmailConfigured, sendTestEmail } =
      await import('../utils/emailer.js');
    if (!isEmailConfigured()) {
      return res.status(400).json({ error: 'Email not configured' });
    }
    try {
      await sendTestEmail();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Catch-all JSON error handler for API routes
  app.use('/api', (err, req, res, next) => {
    logger.error(`[api] Unhandled error: ${err.message}`);
    res.status(500).json({ error: err.message || 'Internal server error' });
  });

  // Start server
  const server = app.listen(port, () => {
    logger.info(`[dashboard] Running at http://localhost:${port}`);
    startPump();
  });

  return app;
}

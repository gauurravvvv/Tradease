import { getHistorical } from '../data/market.js';
import { analyzeTechnicals, computeATR } from '../analysis/technicals.js';
import {
  calculateStopLoss,
  calculateTargets,
  calculatePositionSize,
} from '../trading/risk.js';
import { TRADING } from '../config/settings.js';
import { getStrategy } from './strategies.js';
import { generateReport } from './report.js';
import { logger } from '../utils/logger.js';

/**
 * Run a backtest simulation over historical data.
 *
 * @param {Object} config
 * @param {string} config.strategy - 'screener' | 'momentum' | 'custom'
 * @param {string[]} config.symbols - Symbols to test
 * @param {string} config.startDate - ISO date string
 * @param {string} config.endDate - ISO date string
 * @param {number} [config.capital=200000] - Starting capital
 * @param {number} [config.maxPositions=3]
 * @param {number} [config.maxCapitalPerPosition=0.20]
 * @param {number} [config.stopMultiplier=1.5]
 * @param {number} [config.trailingATR=0.5]
 * @param {Object} [config.riskReward={ T1: 2, T2: 3 }]
 * @returns {Promise<Object>} { trades, metrics, equityCurve, config }
 */
export async function runBacktest(config) {
  const {
    strategy: strategyName = 'screener',
    symbols = [],
    startDate,
    endDate,
    capital: startingCapital = TRADING.VIRTUAL_CAPITAL,
    maxPositions = TRADING.MAX_POSITIONS,
    maxCapitalPerPosition = TRADING.MAX_CAPITAL_PER_POSITION,
    stopMultiplier = TRADING.ATR_STOP_MULTIPLIER,
    trailingATR = TRADING.TRAILING_STOP_ATR,
    riskReward = TRADING.RISK_REWARD,
  } = config;

  const strategy = getStrategy(strategyName);
  logger.info(`[backtest] Starting ${strategyName} backtest: ${symbols.length} symbols, ${startDate} to ${endDate}`);

  // Fetch all historical data
  const allData = {};
  for (const symbol of symbols) {
    try {
      const days = Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000) + 90; // extra for indicator warmup
      const data = await getHistorical(symbol, days);
      if (data && data.length >= 30) {
        allData[symbol] = data;
      }
    } catch (err) {
      logger.warn(`[backtest] Skipping ${symbol}: ${err.message}`);
    }
  }

  // Build unified timeline
  const start = new Date(startDate);
  const end = new Date(endDate);
  const timeline = buildTimeline(allData, start, end);

  // Simulation state
  let capital = startingCapital;
  const openPositions = [];
  const closedTrades = [];
  const equityCurve = [];

  // Bar-by-bar replay
  for (const { date, bars } of timeline) {
    // 1. Check exits for open positions
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i];
      const bar = bars[pos.symbol];
      if (!bar) continue;

      const exitResult = checkExit(pos, bar, stopMultiplier, trailingATR);
      if (exitResult.exit) {
        pos.exitPrice = exitResult.price;
        pos.exitDate = date;
        pos.exitReason = exitResult.reason;
        pos.pnl = computePnl(pos);
        capital += pos.capitalUsed + pos.pnl;
        closedTrades.push({ ...pos });
        openPositions.splice(i, 1);
      } else if (exitResult.updateTrail) {
        pos.trailingStop = exitResult.trailingStop;
      }
    }

    // 2. Check entries
    if (openPositions.length < maxPositions) {
      for (const symbol of Object.keys(bars)) {
        if (openPositions.length >= maxPositions) break;
        if (openPositions.some(p => p.symbol === symbol)) continue;

        const historicalSlice = getSliceUpTo(allData[symbol], date);
        if (!historicalSlice || historicalSlice.length < 30) continue;

        const technicals = analyzeTechnicals(historicalSlice);
        const atr = computeATR(historicalSlice);
        if (!atr) continue;

        const signal = strategy.shouldEnter(technicals, bars[symbol]);
        if (!signal) continue;

        const entryPrice = bars[symbol].close;
        const sl = calculateStopLoss(entryPrice, atr, signal.type);
        const { target1, target2 } = calculateTargets(entryPrice, sl, signal.type);

        const maxCap = capital * maxCapitalPerPosition;
        const lotSize = 1; // Simplified for backtesting
        const lots = Math.floor(maxCap / entryPrice);
        if (lots <= 0) continue;

        const capitalUsed = lots * entryPrice;
        if (capitalUsed > capital) continue;

        capital -= capitalUsed;
        openPositions.push({
          symbol,
          type: signal.type,
          entryPrice,
          entryDate: date,
          stopLoss: sl,
          target1,
          target2,
          quantity: lots,
          capitalUsed,
          lotSize: 1,
          t1Hit: false,
          trailingStop: null,
          highWaterMark: entryPrice,
        });
      }
    }

    // 3. Update high water marks
    for (const pos of openPositions) {
      const bar = bars[pos.symbol];
      if (!bar) continue;
      if (pos.type === 'CALL' && bar.high > pos.highWaterMark) {
        pos.highWaterMark = bar.high;
      } else if (pos.type === 'PUT' && bar.low < pos.highWaterMark) {
        pos.highWaterMark = bar.low;
      }
    }

    // 4. Record equity
    const unrealized = openPositions.reduce((sum, pos) => {
      const bar = bars[pos.symbol];
      if (!bar) return sum;
      const dir = pos.type === 'CALL' ? 1 : -1;
      return sum + dir * (bar.close - pos.entryPrice) * pos.quantity;
    }, 0);

    equityCurve.push({
      date: date.toISOString().slice(0, 10),
      capital: Math.round((capital + unrealized) * 100) / 100,
    });
  }

  // Force-close remaining positions at last bar
  for (const pos of openPositions) {
    const lastBar = allData[pos.symbol]?.[allData[pos.symbol].length - 1];
    if (lastBar) {
      pos.exitPrice = lastBar.close;
      pos.exitDate = end;
      pos.exitReason = 'backtest_end';
      pos.pnl = computePnl(pos);
      closedTrades.push({ ...pos });
    }
  }

  const metrics = generateReport(closedTrades, equityCurve, startingCapital);

  return { trades: closedTrades, metrics, equityCurve, config };
}

// ── Internal helpers ──

function buildTimeline(allData, start, end) {
  const dateMap = new Map();

  for (const [symbol, bars] of Object.entries(allData)) {
    for (const bar of bars) {
      const d = new Date(bar.date);
      if (d < start || d > end) continue;
      const key = d.toISOString().slice(0, 10);
      if (!dateMap.has(key)) dateMap.set(key, { date: d, bars: {} });
      dateMap.get(key).bars[symbol] = bar;
    }
  }

  return [...dateMap.values()].sort((a, b) => a.date - b.date);
}

function getSliceUpTo(data, date) {
  if (!data) return null;
  const idx = data.findIndex(d => new Date(d.date) >= date);
  if (idx <= 0) return data;
  return data.slice(0, idx);
}

function checkExit(pos, bar, stopMultiplier, trailingATR) {
  const price = bar.close;

  // Stop-loss
  if (pos.type === 'CALL' && price <= pos.stopLoss) {
    return { exit: true, price: pos.stopLoss, reason: 'stop_loss' };
  }
  if (pos.type === 'PUT' && price >= pos.stopLoss) {
    return { exit: true, price: pos.stopLoss, reason: 'stop_loss' };
  }

  // Target 2 (full exit)
  if (pos.type === 'CALL' && price >= pos.target2) {
    return { exit: true, price: pos.target2, reason: 'target2' };
  }
  if (pos.type === 'PUT' && price <= pos.target2) {
    return { exit: true, price: pos.target2, reason: 'target2' };
  }

  // Target 1 (mark hit, move SL to breakeven)
  if (!pos.t1Hit) {
    if (pos.type === 'CALL' && price >= pos.target1) {
      pos.t1Hit = true;
      pos.stopLoss = pos.entryPrice; // breakeven
    }
    if (pos.type === 'PUT' && price <= pos.target1) {
      pos.t1Hit = true;
      pos.stopLoss = pos.entryPrice;
    }
  }

  // Trailing stop (after T1 hit)
  if (pos.t1Hit && pos.trailingStop) {
    if (pos.type === 'CALL' && price <= pos.trailingStop) {
      return { exit: true, price: pos.trailingStop, reason: 'trailing_stop' };
    }
    if (pos.type === 'PUT' && price >= pos.trailingStop) {
      return { exit: true, price: pos.trailingStop, reason: 'trailing_stop' };
    }
  }

  // Update trailing stop
  if (pos.t1Hit) {
    const risk = Math.abs(pos.entryPrice - pos.target1) / 2; // simple ATR proxy
    let newTrail;
    if (pos.type === 'CALL') {
      newTrail = Math.round((pos.highWaterMark - risk * trailingATR) * 100) / 100;
      if (!pos.trailingStop || newTrail > pos.trailingStop) {
        return { exit: false, updateTrail: true, trailingStop: newTrail };
      }
    } else {
      newTrail = Math.round((pos.highWaterMark + risk * trailingATR) * 100) / 100;
      if (!pos.trailingStop || newTrail < pos.trailingStop) {
        return { exit: false, updateTrail: true, trailingStop: newTrail };
      }
    }
  }

  return { exit: false };
}

function computePnl(pos) {
  const dir = pos.type === 'CALL' ? 1 : -1;
  return Math.round(dir * (pos.exitPrice - pos.entryPrice) * pos.quantity * 100) / 100;
}

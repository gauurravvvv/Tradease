import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKTESTS_DIR = path.resolve(__dirname, '..', '..', 'data', 'backtests');
const MAX_RESULTS = 20;

/**
 * Generate performance metrics from closed trades and equity curve.
 *
 * @param {Array} trades - Closed trade objects
 * @param {Array} equityCurve - { date, capital }[]
 * @param {number} startingCapital
 * @returns {Object} BacktestMetrics
 */
export function generateReport(trades, equityCurve, startingCapital) {
  if (!trades.length) {
    return emptyMetrics(startingCapital);
  }

  const winners = trades.filter(t => t.pnl > 0);
  const losers = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));

  // Drawdown from equity curve
  let peak = startingCapital;
  let maxDrawdown = 0;
  let maxDrawdownAmount = 0;

  for (const point of equityCurve) {
    if (point.capital > peak) peak = point.capital;
    const dd = (peak - point.capital) / peak * 100;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownAmount = peak - point.capital;
    }
  }

  // Holding period
  const holdingDays = trades
    .filter(t => t.entryDate && t.exitDate)
    .map(t => (new Date(t.exitDate) - new Date(t.entryDate)) / 86400000);

  const avgHoldingDays = holdingDays.length
    ? Math.round(holdingDays.reduce((s, d) => s + d, 0) / holdingDays.length * 10) / 10
    : 0;

  // Streaks
  let maxWinStreak = 0, maxLossStreak = 0, curWin = 0, curLoss = 0;
  for (const t of trades) {
    if (t.pnl > 0) { curWin++; curLoss = 0; maxWinStreak = Math.max(maxWinStreak, curWin); }
    else { curLoss++; curWin = 0; maxLossStreak = Math.max(maxLossStreak, curLoss); }
  }

  // Sharpe ratio (annualized, assuming 252 trading days)
  const dailyReturns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const ret = (equityCurve[i].capital - equityCurve[i - 1].capital) / equityCurve[i - 1].capital;
    dailyReturns.push(ret);
  }
  const avgReturn = dailyReturns.length
    ? dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length
    : 0;
  const stdDev = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (dailyReturns.length - 1))
    : 0;
  const sharpeRatio = stdDev > 0 ? Math.round((avgReturn / stdDev) * Math.sqrt(252) * 100) / 100 : 0;

  const finalCapital = equityCurve.length ? equityCurve[equityCurve.length - 1].capital : startingCapital;

  return {
    totalTrades: trades.length,
    winners: winners.length,
    losers: losers.length,
    winRate: Math.round(winners.length / trades.length * 100 * 10) / 10,
    avgWin: winners.length ? Math.round(grossProfit / winners.length) : 0,
    avgLoss: losers.length ? Math.round(grossLoss / losers.length) * -1 : 0,
    profitFactor: grossLoss > 0 ? Math.round(grossProfit / grossLoss * 100) / 100 : grossProfit > 0 ? Infinity : 0,
    totalPnl: Math.round(totalPnl),
    totalReturnPct: Math.round((finalCapital - startingCapital) / startingCapital * 100 * 100) / 100,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    maxDrawdownAmount: Math.round(maxDrawdownAmount),
    sharpeRatio,
    avgHoldingDays,
    bestTrade: Math.round(Math.max(...trades.map(t => t.pnl))),
    worstTrade: Math.round(Math.min(...trades.map(t => t.pnl))),
    consecutiveWins: maxWinStreak,
    consecutiveLosses: maxLossStreak,
    recoveryFactor: maxDrawdown > 0
      ? Math.round((finalCapital - startingCapital) / maxDrawdownAmount * 100) / 100
      : 0,
  };
}

/**
 * Save backtest result to JSON file and auto-prune old results.
 * @param {Object} result - Full backtest result
 * @returns {string} Path to saved file
 */
export function saveBacktestResult(result) {
  if (!fs.existsSync(BACKTESTS_DIR)) {
    fs.mkdirSync(BACKTESTS_DIR, { recursive: true });
  }

  const now = new Date();
  const filename = `${now.toISOString().slice(0, 10)}-${now.toTimeString().slice(0, 5).replace(':', '')}-${result.config?.strategy || 'unknown'}.json`;
  const filepath = path.join(BACKTESTS_DIR, filename);

  fs.writeFileSync(filepath, JSON.stringify(result, null, 2));

  // Auto-prune: keep only MAX_RESULTS most recent
  const files = fs.readdirSync(BACKTESTS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  for (const old of files.slice(MAX_RESULTS)) {
    fs.unlinkSync(path.join(BACKTESTS_DIR, old));
  }

  return filepath;
}

/**
 * Load the most recent backtest result.
 * @returns {Object|null} Backtest result or null
 */
export function loadLatestBacktest() {
  if (!fs.existsSync(BACKTESTS_DIR)) return null;

  const files = fs.readdirSync(BACKTESTS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  if (!files.length) return null;

  const content = fs.readFileSync(path.join(BACKTESTS_DIR, files[0]), 'utf-8');
  return JSON.parse(content);
}

/**
 * List all saved backtest results (metadata only).
 * @returns {Array} [{ filename, strategy, date, totalReturn, winRate }]
 */
export function listBacktests() {
  if (!fs.existsSync(BACKTESTS_DIR)) return [];

  return fs.readdirSync(BACKTESTS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse()
    .map(f => {
      try {
        const content = fs.readFileSync(path.join(BACKTESTS_DIR, f), 'utf-8');
        const data = JSON.parse(content);
        return {
          filename: f,
          strategy: data.config?.strategy || 'unknown',
          date: f.slice(0, 10),
          totalReturn: data.metrics?.totalReturnPct || 0,
          winRate: data.metrics?.winRate || 0,
          totalTrades: data.metrics?.totalTrades || 0,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function emptyMetrics(startingCapital) {
  return {
    totalTrades: 0, winners: 0, losers: 0, winRate: 0,
    avgWin: 0, avgLoss: 0, profitFactor: 0,
    totalPnl: 0, totalReturnPct: 0,
    maxDrawdown: 0, maxDrawdownAmount: 0, sharpeRatio: 0,
    avgHoldingDays: 0, bestTrade: 0, worstTrade: 0,
    consecutiveWins: 0, consecutiveLosses: 0, recoveryFactor: 0,
  };
}

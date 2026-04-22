import { getDb } from '../db/sqlite.js';
import { TRADING } from '../config/settings.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return today's date as YYYY-MM-DD in local time.
 */
function todayStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Compute unrealised P&L for a single open trade row.
 */
function unrealisedPnl(trade) {
  const current = trade.current_price ?? trade.entry_price;
  if (trade.type === 'CALL') {
    return (current - trade.entry_price) * trade.lot_size * trade.quantity;
  }
  return (trade.entry_price - current) * trade.lot_size * trade.quantity;
}

// ---------------------------------------------------------------------------
// Portfolio summary
// ---------------------------------------------------------------------------

/**
 * Get a high-level portfolio snapshot.
 *
 * @returns {object} { totalCapital, capitalInUse, availableCapital, openPositions, unrealizedPnl }
 */
export function getPortfolioSummary() {
  const db = getDb();

  const openTrades = db.prepare('SELECT * FROM trades WHERE status = ?').all('OPEN');
  const capitalInUse = openTrades.reduce((sum, t) => sum + t.capital_used, 0);
  const unrealized = openTrades.reduce((sum, t) => sum + unrealisedPnl(t), 0);

  return {
    totalCapital: TRADING.VIRTUAL_CAPITAL,
    capitalInUse,
    availableCapital: TRADING.VIRTUAL_CAPITAL - capitalInUse,
    openPositions: openTrades.length,
    unrealizedPnl: Math.round(unrealized * 100) / 100,
    trades: openTrades,
  };
}

// ---------------------------------------------------------------------------
// Daily P&L
// ---------------------------------------------------------------------------

/**
 * Get today's (or a specific date's) realised + unrealised P&L.
 *
 * @param {string} [date] YYYY-MM-DD, defaults to today.
 * @returns {object} { date, realized, unrealized, total, trades }
 */
export function getDailyPnL(date) {
  const db = getDb();
  const day = date ?? todayStr();

  // Trades closed today
  const closedToday = db
    .prepare(
      `SELECT * FROM trades
       WHERE status IN ('CLOSED', 'STOPPED')
         AND DATE(exited_at) = @day
       ORDER BY exited_at DESC`
    )
    .all({ day });

  const realized = closedToday.reduce((sum, t) => sum + (t.pnl ?? 0), 0);

  // Open trades (unrealized)
  const openTrades = db.prepare('SELECT * FROM trades WHERE status = ?').all('OPEN');
  const unrealized = openTrades.reduce((sum, t) => sum + unrealisedPnl(t), 0);

  return {
    date: day,
    realized: Math.round(realized * 100) / 100,
    unrealized: Math.round(unrealized * 100) / 100,
    total: Math.round((realized + unrealized) * 100) / 100,
    trades: [...closedToday, ...openTrades],
  };
}

// ---------------------------------------------------------------------------
// Performance stats
// ---------------------------------------------------------------------------

/**
 * Compute detailed performance statistics over the last N days.
 *
 * @param {number} days
 * @returns {object}
 */
export function getPerformanceStats(days = 30) {
  const db = getDb();

  const trades = db
    .prepare(
      `SELECT * FROM trades
       WHERE status IN ('CLOSED', 'STOPPED')
         AND exited_at >= datetime('now', '-' || @days || ' days')
       ORDER BY exited_at DESC`
    )
    .all({ days });

  const total = trades.length;

  if (total === 0) {
    return {
      period: `${days} days`,
      totalTrades: 0,
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      totalPnl: 0,
      bestTrade: null,
      worstTrade: null,
    };
  }

  const winners = trades.filter((t) => (t.pnl ?? 0) > 0);
  const losers = trades.filter((t) => (t.pnl ?? 0) < 0);

  const grossWin = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));

  const avgWin = winners.length > 0 ? grossWin / winners.length : 0;
  const avgLoss = losers.length > 0 ? grossLoss / losers.length : 0;

  // Profit factor (guard division by zero)
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  // Max drawdown: walk through trades chronologically and track peak-to-trough
  const chronological = [...trades].reverse(); // oldest first
  let cumPnl = 0;
  let peak = 0;
  let maxDrawdown = 0;

  for (const t of chronological) {
    cumPnl += t.pnl ?? 0;
    if (cumPnl > peak) peak = cumPnl;
    const drawdown = peak - cumPnl;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);

  // Best & worst
  const sorted = [...trades].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
  const bestTrade = sorted[0];
  const worstTrade = sorted[sorted.length - 1];

  return {
    period: `${days} days`,
    totalTrades: total,
    winRate: Math.round((winners.length / total) * 10000) / 100, // e.g. 66.67
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    profitFactor: profitFactor === Infinity ? 'Inf' : Math.round(profitFactor * 100) / 100,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    totalPnl: Math.round(totalPnl * 100) / 100,
    bestTrade: bestTrade
      ? { id: bestTrade.id, symbol: bestTrade.symbol, pnl: bestTrade.pnl }
      : null,
    worstTrade: worstTrade
      ? { id: worstTrade.id, symbol: worstTrade.symbol, pnl: worstTrade.pnl }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Save daily summary
// ---------------------------------------------------------------------------

/**
 * Compute and persist today's daily summary row.
 *
 * @returns {object} The saved summary row.
 */
export function saveDailySummary() {
  const db = getDb();
  const day = todayStr();

  // Trades closed today
  const closedToday = db
    .prepare(
      `SELECT * FROM trades
       WHERE status IN ('CLOSED', 'STOPPED')
         AND DATE(exited_at) = @day`
    )
    .all({ day });

  const totalTrades = closedToday.length;
  const winningTrades = closedToday.filter((t) => (t.pnl ?? 0) > 0).length;
  const losingTrades = closedToday.filter((t) => (t.pnl ?? 0) < 0).length;
  const grossPnl = closedToday.reduce((s, t) => s + (t.pnl ?? 0), 0);

  // Upsert
  db.prepare(`
    INSERT INTO daily_summary (date, total_trades, winning_trades, losing_trades, gross_pnl)
    VALUES (@day, @totalTrades, @winningTrades, @losingTrades, @grossPnl)
    ON CONFLICT(date) DO UPDATE SET
      total_trades   = @totalTrades,
      winning_trades = @winningTrades,
      losing_trades  = @losingTrades,
      gross_pnl      = @grossPnl
  `).run({
    day,
    totalTrades,
    winningTrades,
    losingTrades,
    grossPnl: Math.round(grossPnl * 100) / 100,
  });

  return db.prepare('SELECT * FROM daily_summary WHERE date = ?').get(day);
}

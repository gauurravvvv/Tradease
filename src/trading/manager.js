import { getDb } from '../db/sqlite.js';
import { TRADING } from '../config/settings.js';
import {
  calculateStopLoss,
  calculateTargets,
  calculatePositionSize,
  validateTrade,
} from './risk.js';

// ---------------------------------------------------------------------------
// Enter a new trade
// ---------------------------------------------------------------------------

/**
 * Open a new paper trade after validation.
 *
 * @param {object} params
 * @param {string} params.symbol
 * @param {'CALL'|'PUT'} params.type
 * @param {number} params.entryPrice
 * @param {number} params.premium
 * @param {number} params.lotSize
 * @param {number} params.stopLoss
 * @param {number} params.target1
 * @param {number} params.target2
 * @param {number} params.confidence
 * @param {string} params.reason
 * @param {string} [params.expiry]
 * @param {number} [params.strike]
 * @returns {object} The newly created trade row.
 */
export function enterTrade({
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
  expiry = null,
  strike = null,
}) {
  const db = getDb();

  // ---- validation ----
  const validation = validateTrade({
    symbol,
    type,
    entryPrice,
    premium,
    lotSize,
    stopLoss,
    target1,
    target2,
    confidence,
  });

  if (!validation.valid) {
    throw new Error(`Trade validation failed: ${validation.errors.join('; ')}`);
  }

  // ---- position sizing ----
  const positionSize = calculatePositionSize({
    entryPrice,
    stopLoss,
    lotSize,
    premium,
  });

  const quantity = positionSize.quantity;
  const capitalUsed = premium * lotSize * quantity;

  // ---- check available capital ----
  const openCapital = db
    .prepare('SELECT COALESCE(SUM(capital_used), 0) AS total FROM trades WHERE status = ?')
    .get('OPEN').total;

  const available = TRADING.VIRTUAL_CAPITAL - openCapital;
  if (capitalUsed > available) {
    throw new Error(
      `Insufficient capital. Need ${capitalUsed.toFixed(2)}, available ${available.toFixed(2)}`
    );
  }

  // ---- check max positions ----
  const openCount = db
    .prepare('SELECT COUNT(*) AS cnt FROM trades WHERE status = ?')
    .get('OPEN').cnt;

  if (openCount >= TRADING.MAX_POSITIONS) {
    throw new Error(`Maximum open positions (${TRADING.MAX_POSITIONS}) reached.`);
  }

  // ---- insert ----
  const stmt = db.prepare(`
    INSERT INTO trades
      (symbol, type, entry_price, current_price, stop_loss, target1, target2,
       lot_size, premium, capital_used, quantity, entry_reason, confidence, expiry, strike)
    VALUES
      (@symbol, @type, @entryPrice, @entryPrice, @stopLoss, @target1, @target2,
       @lotSize, @premium, @capitalUsed, @quantity, @reason, @confidence, @expiry, @strike)
  `);

  const result = stmt.run({
    symbol,
    type,
    entryPrice,
    stopLoss,
    target1,
    target2,
    lotSize,
    premium,
    capitalUsed,
    quantity,
    reason,
    confidence,
    expiry,
    strike,
  });

  return db.prepare('SELECT * FROM trades WHERE id = ?').get(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Exit a trade fully
// ---------------------------------------------------------------------------

/**
 * Close a trade entirely.
 *
 * @param {number} tradeId
 * @param {number} exitPrice
 * @param {string} reason
 * @returns {object} Updated trade row.
 */
export function exitTrade(tradeId, exitPrice, reason) {
  const db = getDb();
  const trade = db.prepare('SELECT * FROM trades WHERE id = ? AND status = ?').get(tradeId, 'OPEN');

  if (!trade) {
    throw new Error(`No open trade found with id ${tradeId}`);
  }

  const pnl =
    trade.type === 'CALL'
      ? (exitPrice - trade.entry_price) * trade.lot_size * trade.quantity
      : (trade.entry_price - exitPrice) * trade.lot_size * trade.quantity;

  db.prepare(`
    UPDATE trades
    SET status      = 'CLOSED',
        exit_price  = @exitPrice,
        pnl         = @pnl,
        exit_reason = @reason,
        exited_at   = datetime('now')
    WHERE id = @id
  `).run({ id: tradeId, exitPrice, pnl, reason });

  return db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
}

// ---------------------------------------------------------------------------
// Partial exit
// ---------------------------------------------------------------------------

/**
 * Reduce position by a percentage and record partial P&L.
 *
 * @param {number} tradeId
 * @param {number} percentage - Fraction to close (0-1), e.g. 0.5 = 50 %
 * @param {number} exitPrice
 * @param {string} reason
 * @returns {object} Updated trade row.
 */
export function partialExit(tradeId, percentage, exitPrice, reason) {
  const db = getDb();
  const trade = db.prepare('SELECT * FROM trades WHERE id = ? AND status = ?').get(tradeId, 'OPEN');

  if (!trade) {
    throw new Error(`No open trade found with id ${tradeId}`);
  }

  if (percentage <= 0 || percentage >= 1) {
    throw new Error('Percentage must be between 0 (exclusive) and 1 (exclusive). Use exitTrade for full close.');
  }

  const qtyToClose = Math.max(1, Math.round(trade.quantity * percentage));
  const remainingQty = trade.quantity - qtyToClose;

  if (remainingQty < 1) {
    // If rounding leaves nothing, do a full exit instead
    return exitTrade(tradeId, exitPrice, reason);
  }

  const partialPnl =
    trade.type === 'CALL'
      ? (exitPrice - trade.entry_price) * trade.lot_size * qtyToClose
      : (trade.entry_price - exitPrice) * trade.lot_size * qtyToClose;

  const existingPnl = trade.pnl ?? 0;
  const newPnl = existingPnl + partialPnl;
  const newCapitalUsed = (trade.premium ?? trade.entry_price) * trade.lot_size * remainingQty;

  // Determine if T1 or T2 was hit based on the exit price
  let t1Hit = trade.t1_hit;
  let t2Hit = trade.t2_hit;
  let trailingStop = trade.trailing_stop;

  if (trade.type === 'CALL') {
    if (trade.target1 && exitPrice >= trade.target1) t1Hit = 1;
    if (trade.target2 && exitPrice >= trade.target2) t2Hit = 1;
  } else {
    if (trade.target1 && exitPrice <= trade.target1) t1Hit = 1;
    if (trade.target2 && exitPrice <= trade.target2) t2Hit = 1;
  }

  // Set trailing stop to entry price once T1 is hit (lock in breakeven)
  if (t1Hit && !trade.t1_hit) {
    trailingStop = trade.entry_price;
  }

  db.prepare(`
    UPDATE trades
    SET quantity      = @remainingQty,
        capital_used  = @newCapitalUsed,
        pnl           = @newPnl,
        t1_hit        = @t1Hit,
        t2_hit        = @t2Hit,
        trailing_stop = @trailingStop,
        exit_reason   = @reason
    WHERE id = @id
  `).run({
    id: tradeId,
    remainingQty,
    newCapitalUsed,
    newPnl,
    t1Hit,
    t2Hit,
    trailingStop,
    reason: `PARTIAL(${Math.round(percentage * 100)}%): ${reason}`,
  });

  return db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
}

// ---------------------------------------------------------------------------
// Stop-loss exit
// ---------------------------------------------------------------------------

/**
 * Exit a trade via stop-loss.
 *
 * @param {number} tradeId
 * @param {number} currentPrice
 * @returns {object} Updated trade row (status = STOPPED).
 */
export function stopTrade(tradeId, currentPrice) {
  const db = getDb();
  const trade = db.prepare('SELECT * FROM trades WHERE id = ? AND status = ?').get(tradeId, 'OPEN');

  if (!trade) {
    throw new Error(`No open trade found with id ${tradeId}`);
  }

  const pnl =
    trade.type === 'CALL'
      ? (currentPrice - trade.entry_price) * trade.lot_size * trade.quantity
      : (trade.entry_price - currentPrice) * trade.lot_size * trade.quantity;

  db.prepare(`
    UPDATE trades
    SET status      = 'STOPPED',
        exit_price  = @exitPrice,
        pnl         = @pnl,
        exit_reason = 'Stop-loss triggered',
        exited_at   = datetime('now')
    WHERE id = @id
  `).run({ id: tradeId, exitPrice: currentPrice, pnl });

  return db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get all currently open trades.
 * @returns {Array} Open trade rows.
 */
export function getOpenTrades() {
  const db = getDb();
  return db.prepare('SELECT * FROM trades WHERE status = ? ORDER BY entered_at DESC').all('OPEN');
}

/**
 * Get closed/stopped trades from the last N days.
 *
 * @param {number} days
 * @returns {Array}
 */
export function getTradeHistory(days = 30) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM trades
       WHERE status IN ('CLOSED', 'STOPPED')
         AND exited_at >= datetime('now', '-' || @days || ' days')
       ORDER BY exited_at DESC`
    )
    .all({ days });
}

/**
 * Update the live current_price for an open trade.
 *
 * @param {number} tradeId
 * @param {number} currentPrice
 * @returns {object} Updated trade row.
 */
export function updateTradePrice(tradeId, currentPrice) {
  const db = getDb();

  const changes = db
    .prepare('UPDATE trades SET current_price = @currentPrice WHERE id = @id AND status = ?')
    .run({ id: tradeId, currentPrice }, 'OPEN').changes;

  if (changes === 0) {
    throw new Error(`No open trade found with id ${tradeId} to update price.`);
  }

  return db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
}

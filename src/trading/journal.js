import { getDb } from '../db/sqlite.js';
import { logger } from '../utils/logger.js';

/**
 * Initialize trade journal table if not exists.
 */
export function initJournalTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS trade_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id INTEGER,
      symbol TEXT NOT NULL,
      type TEXT,
      entry_date TEXT,
      exit_date TEXT,
      entry_price REAL,
      exit_price REAL,
      pnl REAL,
      status TEXT,
      notes TEXT,
      tags TEXT,
      ai_review TEXT,
      rating INTEGER,
      lessons TEXT,
      created_at DATETIME DEFAULT (datetime('now', '+5 hours', '+30 minutes')),
      updated_at DATETIME DEFAULT (datetime('now', '+5 hours', '+30 minutes'))
    )
  `);
}

/**
 * Auto-generate journal entry from a closed trade.
 * @param {Object} trade - Closed trade row from DB
 * @returns {Object} Journal entry
 */
export function createJournalEntry(trade) {
  const db = getDb();
  initJournalTable();

  // Check if entry already exists
  const existing = db.prepare('SELECT id FROM trade_journal WHERE trade_id = ?').get(trade.id);
  if (existing) return existing;

  const holdingTime = trade.exited_at && trade.entered_at
    ? Math.round((new Date(trade.exited_at) - new Date(trade.entered_at)) / 3600000)
    : null;

  const pnlPct = trade.capital_used > 0
    ? ((trade.pnl || 0) / trade.capital_used * 100).toFixed(1)
    : '0';

  const autoNotes = [
    `${trade.type || 'Unknown'} trade on ${trade.symbol}`,
    `Entry: ₹${trade.entry_price} → Exit: ₹${trade.exit_price || 'open'}`,
    `P&L: ₹${(trade.pnl || 0).toFixed(0)} (${pnlPct}%)`,
    `Status: ${trade.status}`,
    trade.exit_reason ? `Exit reason: ${trade.exit_reason}` : null,
    holdingTime ? `Holding time: ${holdingTime}h` : null,
    trade.t1_hit ? 'T1 was hit ✓' : 'T1 not reached',
    trade.t2_hit ? 'T2 was hit ✓' : null,
  ].filter(Boolean).join('\n');

  const tags = [
    trade.status === 'STOPPED' ? 'stop-loss' : trade.pnl > 0 ? 'winner' : 'loser',
    (trade.type || 'unknown').toLowerCase(),
    trade.t1_hit ? 'target-hit' : 'no-target',
    holdingTime && holdingTime < 2 ? 'scalp' : holdingTime && holdingTime > 24 ? 'swing' : 'intraday',
  ].join(',');

  const stmt = db.prepare(`
    INSERT INTO trade_journal (trade_id, symbol, type, entry_date, exit_date, entry_price, exit_price, pnl, status, notes, tags)
    VALUES (@tradeId, @symbol, @type, @entryDate, @exitDate, @entryPrice, @exitPrice, @pnl, @status, @notes, @tags)
  `);

  const result = stmt.run({
    tradeId: trade.id,
    symbol: trade.symbol,
    type: trade.type,
    entryDate: trade.entered_at,
    exitDate: trade.exited_at,
    entryPrice: trade.entry_price,
    exitPrice: trade.exit_price,
    pnl: trade.pnl || 0,
    status: trade.status,
    notes: autoNotes,
    tags,
  });

  return db.prepare('SELECT * FROM trade_journal WHERE id = ?').get(result.lastInsertRowid);
}

/**
 * Get journal entries with optional filters.
 * @param {Object} opts
 * @param {number} [opts.days=30]
 * @param {string} [opts.symbol]
 * @param {string} [opts.tag]
 * @returns {Array}
 */
export function getJournalEntries(opts = {}) {
  const db = getDb();
  initJournalTable();

  const { days = 30, symbol, tag } = opts;
  let query = `SELECT * FROM trade_journal WHERE created_at >= datetime('now', '+5 hours', '+30 minutes', '-${days} days')`;
  const params = {};

  if (symbol) {
    query += ` AND symbol = @symbol`;
    params.symbol = symbol;
  }
  if (tag) {
    query += ` AND tags LIKE @tag`;
    params.tag = `%${tag}%`;
  }

  query += ` ORDER BY created_at DESC`;
  return db.prepare(query).all(params);
}

/**
 * Update journal entry with user notes, rating, or AI review.
 * @param {number} id
 * @param {Object} updates
 */
export function updateJournalEntry(id, updates) {
  const db = getDb();
  const sets = [];
  const params = { id };

  if (updates.notes != null) { sets.push('notes = @notes'); params.notes = updates.notes; }
  if (updates.rating != null) { sets.push('rating = @rating'); params.rating = updates.rating; }
  if (updates.lessons != null) { sets.push('lessons = @lessons'); params.lessons = updates.lessons; }
  if (updates.ai_review != null) { sets.push('ai_review = @aiReview'); params.aiReview = updates.ai_review; }
  if (updates.tags != null) { sets.push('tags = @tags'); params.tags = updates.tags; }

  if (!sets.length) return;

  sets.push("updated_at = datetime('now', '+5 hours', '+30 minutes')");
  db.prepare(`UPDATE trade_journal SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

/**
 * Get journal statistics.
 * @param {number} days
 * @returns {Object}
 */
export function getJournalStats(days = 30) {
  const db = getDb();
  initJournalTable();

  const entries = db.prepare(`
    SELECT pnl, tags, rating FROM trade_journal
    WHERE created_at >= datetime('now', '+5 hours', '+30 minutes', '-${days} days')
  `).all();

  if (!entries.length) {
    return { totalEntries: 0, avgRating: 0, topLessons: [], tagBreakdown: {} };
  }

  const ratings = entries.filter(e => e.rating).map(e => e.rating);
  const avgRating = ratings.length ? (ratings.reduce((s, r) => s + r, 0) / ratings.length).toFixed(1) : 0;

  const tagCounts = {};
  for (const e of entries) {
    if (e.tags) {
      for (const tag of e.tags.split(',')) {
        tagCounts[tag.trim()] = (tagCounts[tag.trim()] || 0) + 1;
      }
    }
  }

  return {
    totalEntries: entries.length,
    avgRating: parseFloat(avgRating),
    tagBreakdown: tagCounts,
    winners: entries.filter(e => e.pnl > 0).length,
    losers: entries.filter(e => e.pnl <= 0).length,
  };
}

/**
 * Auto-journal all recent closed trades that don't have entries yet.
 * Called by post-market routine.
 */
export function autoJournalRecentTrades() {
  const db = getDb();
  initJournalTable();

  const closedTrades = db.prepare(`
    SELECT * FROM trades
    WHERE status IN ('CLOSED', 'STOPPED')
      AND exited_at >= datetime('now', '+5 hours', '+30 minutes', '-1 day')
    ORDER BY exited_at DESC
  `).all();

  let created = 0;
  for (const trade of closedTrades) {
    const existing = db.prepare('SELECT id FROM trade_journal WHERE trade_id = ?').get(trade.id);
    if (!existing) {
      createJournalEntry(trade);
      created++;
    }
  }

  if (created > 0) {
    logger.info(`[journal] Auto-created ${created} journal entries`);
  }

  return created;
}

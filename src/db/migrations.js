/**
 * Run all database migrations. Idempotent — safe to call on every startup.
 */
export function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol        TEXT    NOT NULL,
      type          TEXT    NOT NULL CHECK(type IN ('CALL','PUT')),
      entry_price   REAL    NOT NULL,
      current_price REAL,
      stop_loss     REAL    NOT NULL,
      target1       REAL,
      target2       REAL,
      trailing_stop REAL,
      lot_size      INTEGER NOT NULL,
      premium       REAL,
      capital_used  REAL    NOT NULL,
      quantity      INTEGER NOT NULL,
      t1_hit        INTEGER NOT NULL DEFAULT 0,
      t2_hit        INTEGER NOT NULL DEFAULT 0,
      status        TEXT    NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED','STOPPED')),
      exit_price    REAL,
      pnl           REAL,
      entry_reason  TEXT,
      exit_reason   TEXT,
      confidence    REAL,
      entered_at    TEXT    NOT NULL DEFAULT (datetime('now', '+5 hours', '+30 minutes')),
      exited_at     TEXT,
      expiry        TEXT,
      strike        REAL
    );

    CREATE TABLE IF NOT EXISTS daily_summary (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      date           TEXT    NOT NULL UNIQUE,
      total_trades   INTEGER NOT NULL DEFAULT 0,
      winning_trades INTEGER NOT NULL DEFAULT 0,
      losing_trades  INTEGER NOT NULL DEFAULT 0,
      gross_pnl      REAL    NOT NULL DEFAULT 0,
      notes          TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now', '+5 hours', '+30 minutes'))
    );

    CREATE TABLE IF NOT EXISTS market_cache (
      key       TEXT PRIMARY KEY,
      data      TEXT NOT NULL,
      cached_at TEXT NOT NULL DEFAULT (datetime('now', '+5 hours', '+30 minutes'))
    );

    CREATE TABLE IF NOT EXISTS agent_signals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent       TEXT    NOT NULL,
      symbol      TEXT,
      signal_type TEXT    NOT NULL,
      confidence  INTEGER DEFAULT 0,
      data        TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now', '+5 hours', '+30 minutes')),
      consumed    INTEGER NOT NULL DEFAULT 0,
      consumed_by TEXT,
      consumed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      agent      TEXT    NOT NULL,
      action     TEXT    NOT NULL,
      symbol     TEXT,
      details    TEXT,
      tokens_in  INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      skipped    INTEGER DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now', '+5 hours', '+30 minutes'))
    );
  `);

  // Migration: add ending_capital to daily_summary if not present
  const cols = db.prepare('PRAGMA table_info(daily_summary)').all();
  if (!cols.some(c => c.name === 'ending_capital')) {
    db.exec('ALTER TABLE daily_summary ADD COLUMN ending_capital REAL');
  }

  // ── Migration: fix table DEFAULT from UTC → IST ──
  // SQLite can't ALTER COLUMN defaults, so recreate tables with correct defaults.
  // Existing data already has mixed timestamps (some shifted by earlier UPDATE,
  // some still UTC). We copy data AS-IS and only fix the DEFAULT for new rows.
  // For agent_logs: wipe old data (ephemeral) so dashboard shows clean state.

  _fixDefault(
    db,
    'agent_logs',
    `
    CREATE TABLE agent_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      agent      TEXT    NOT NULL,
      action     TEXT    NOT NULL,
      symbol     TEXT,
      details    TEXT,
      tokens_in  INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      skipped    INTEGER DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now', '+5 hours', '+30 minutes'))
    )`,
    null, // don't copy old logs — mixed timestamps, ephemeral data
  );

  _fixDefault(
    db,
    'agent_signals',
    `
    CREATE TABLE agent_signals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent       TEXT    NOT NULL,
      symbol      TEXT,
      signal_type TEXT    NOT NULL,
      confidence  INTEGER DEFAULT 0,
      data        TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now', '+5 hours', '+30 minutes')),
      consumed    INTEGER NOT NULL DEFAULT 0,
      consumed_by TEXT,
      consumed_at TEXT
    )`,
    null, // wipe — stale signals shouldn't carry over
  );

  _fixDefault(
    db,
    'trades',
    `
    CREATE TABLE trades (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol        TEXT    NOT NULL,
      type          TEXT    NOT NULL CHECK(type IN ('CALL','PUT')),
      entry_price   REAL    NOT NULL,
      current_price REAL,
      stop_loss     REAL    NOT NULL,
      target1       REAL,
      target2       REAL,
      trailing_stop REAL,
      lot_size      INTEGER NOT NULL,
      premium       REAL,
      capital_used  REAL    NOT NULL,
      quantity      INTEGER NOT NULL,
      t1_hit        INTEGER NOT NULL DEFAULT 0,
      t2_hit        INTEGER NOT NULL DEFAULT 0,
      status        TEXT    NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED','STOPPED')),
      exit_price    REAL,
      pnl           REAL,
      entry_reason  TEXT,
      exit_reason   TEXT,
      confidence    REAL,
      entered_at    TEXT    NOT NULL DEFAULT (datetime('now', '+5 hours', '+30 minutes')),
      exited_at     TEXT,
      expiry        TEXT,
      strike        REAL
    )`,
    // Copy AS-IS — timestamps already IST from earlier bulk UPDATE
    `INSERT INTO trades SELECT * FROM trades_old`,
  );

  _fixDefault(
    db,
    'daily_summary',
    `
    CREATE TABLE daily_summary (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      date           TEXT    NOT NULL UNIQUE,
      total_trades   INTEGER NOT NULL DEFAULT 0,
      winning_trades INTEGER NOT NULL DEFAULT 0,
      losing_trades  INTEGER NOT NULL DEFAULT 0,
      gross_pnl      REAL    NOT NULL DEFAULT 0,
      notes          TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now', '+5 hours', '+30 minutes')),
      ending_capital REAL
    )`,
    `INSERT INTO daily_summary SELECT * FROM daily_summary_old`,
  );

  _fixDefault(
    db,
    'market_cache',
    `
    CREATE TABLE market_cache (
      key       TEXT PRIMARY KEY,
      data      TEXT NOT NULL,
      cached_at TEXT NOT NULL DEFAULT (datetime('now', '+5 hours', '+30 minutes'))
    )`,
    null, // wipe cache — stale anyway
  );

  _fixDefault(
    db,
    'trade_journal',
    `
    CREATE TABLE trade_journal (
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
    )`,
    `INSERT INTO trade_journal SELECT * FROM trade_journal_old`,
  );
}

/**
 * Helper: recreate a table with IST default if it still has UTC.
 * If insertSQL is null, old data is discarded (fresh start).
 */
function _fixDefault(db, tableName, createSQL, insertSQL) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName);
  if (!row || !row.sql) return;
  if (row.sql.includes('+5 hours')) return; // already migrated

  db.exec(`ALTER TABLE ${tableName} RENAME TO ${tableName}_old;`);
  db.exec(createSQL + ';');
  if (insertSQL) db.exec(insertSQL + ';');
  db.exec(`DROP TABLE ${tableName}_old;`);
}

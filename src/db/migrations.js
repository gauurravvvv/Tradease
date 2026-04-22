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
      entered_at    TEXT    NOT NULL DEFAULT (datetime('now')),
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
      created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS market_cache (
      key       TEXT PRIMARY KEY,
      data      TEXT NOT NULL,
      cached_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

# Tradease Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an AI-powered Indian F&O trading CLI that autonomously scans markets, recommends trades, manages positions with stop-losses, and monitors open trades via event listeners.

**Architecture:** Node.js daemon with cron scheduler + CLI commands. Data pipeline fetches market data and news (zero AI tokens), pre-filters stocks algorithmically, then spawns Claude Code CLI for final analysis. Trade manager handles paper execution with persistent SQLite storage. Event listeners monitor open positions every 60s.

**Tech Stack:** Node.js 20+, ES modules, Yahoo Finance 2, technicalindicators, node-cron, Commander.js, chalk, better-sqlite3, rss-parser, Claude Code CLI

---

### Task 1: Config & Settings

**Files:**
- Create: `src/config/settings.js`

- [ ] **Step 1: Create settings module**

```js
// src/config/settings.js
export const TRADING = {
  VIRTUAL_CAPITAL: 200000,
  MAX_POSITIONS: 3,
  MAX_CAPITAL_PER_POSITION: 0.20,
  MAX_LOSS_PER_TRADE: 0.05,
  MIN_CONFIDENCE: 70,
  MIN_VOLUME: 1000000,
  ATR_STOP_MULTIPLIER: 1.5,
  TRAILING_STOP_ATR: 0.5,
  TRAILING_TRIGGER_PCT: 1.0,
  PROFIT_BOOK_T1: 0.50,
  PROFIT_BOOK_T2: 0.25,
  PROFIT_BOOK_RUNNER: 0.25,
  RISK_REWARD_T1: 2,
  RISK_REWARD_T2: 3,
  NO_NEW_ENTRY_AFTER: '15:00',
  EXIT_ALL_BY: '15:15',
  INDEX_CRASH_THRESHOLD: -1.5,
};

export const SCHEDULE = {
  PRE_MARKET_SCAN: '30 8 * * 1-5',
  MARKET_OPEN_CHECK: '15 9 * * 1-5',
  TRADE_EXECUTION: '30 9 * * 1-5',
  MARKET_PULSE: '*/30 9-15 * * 1-5',
  POSITION_MONITOR: '*/1 9-15 * * 1-5',
  WIND_DOWN: '15 15 * * 1-5',
  POST_MARKET: '45 15 * * 1-5',
};

export const DATA = {
  FNO_STOCKS_URL: 'https://archives.nseindia.com/content/fo/fo_mktlots.csv',
  NEWS_FEEDS: [
    'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
    'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms',
    'https://www.moneycontrol.com/rss/marketreports.xml',
  ],
  YAHOO_SUFFIX: '.NS',
  CACHE_TTL_MINUTES: 30,
};

export const DB_PATH = new URL('../../data/trades.db', import.meta.url).pathname;
```

- [ ] **Step 2: Commit**

```bash
git add src/config/settings.js
git commit -m "feat: add trading config and settings"
```

---

### Task 2: Database Layer

**Files:**
- Create: `src/db/sqlite.js`
- Create: `src/db/migrations.js`

- [ ] **Step 1: Create migrations**

```js
// src/db/migrations.js
export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('CALL','PUT')),
    entry_price REAL NOT NULL,
    current_price REAL,
    stop_loss REAL NOT NULL,
    target1 REAL NOT NULL,
    target2 REAL NOT NULL,
    trailing_stop REAL,
    lot_size INTEGER NOT NULL,
    premium REAL NOT NULL,
    capital_used REAL NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    t1_hit INTEGER DEFAULT 0,
    t2_hit INTEGER DEFAULT 0,
    status TEXT DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED','STOPPED')),
    exit_price REAL,
    pnl REAL,
    entry_reason TEXT,
    exit_reason TEXT,
    confidence INTEGER,
    entered_at TEXT DEFAULT (datetime('now','localtime')),
    exited_at TEXT,
    expiry TEXT,
    strike REAL
  )`,
  `CREATE TABLE IF NOT EXISTS daily_summary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE NOT NULL,
    total_trades INTEGER DEFAULT 0,
    winning_trades INTEGER DEFAULT 0,
    losing_trades INTEGER DEFAULT 0,
    gross_pnl REAL DEFAULT 0,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE TABLE IF NOT EXISTS market_cache (
    key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    cached_at TEXT DEFAULT (datetime('now','localtime'))
  )`
];
```

- [ ] **Step 2: Create DB connection module**

```js
// src/db/sqlite.js
import Database from 'better-sqlite3';
import { DB_PATH } from '../config/settings.js';
import { MIGRATIONS } from './migrations.js';

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    for (const sql of MIGRATIONS) {
      db.exec(sql);
    }
  }
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
```

- [ ] **Step 3: Commit**

---

### Task 3: Market Data Fetcher

**Files:**
- Create: `src/data/market.js`
- Create: `src/data/fno-stocks.js`

- [ ] **Step 1: Create F&O stock list**

Hardcoded top 50 liquid F&O stocks with lot sizes (avoids unreliable CSV parsing from NSE).

- [ ] **Step 2: Create market data fetcher**

Yahoo Finance wrapper: getQuote, getHistorical, getOptionsChain for .NS suffix stocks.

- [ ] **Step 3: Commit**

---

### Task 4: News Fetcher

**Files:**
- Create: `src/data/news.js`

- [ ] **Step 1: Create RSS news fetcher**

Fetch from ET Markets, MoneyControl RSS. Parse, deduplicate, extract stock mentions. Return structured array.

- [ ] **Step 2: Commit**

---

### Task 5: Technical Analysis Engine

**Files:**
- Create: `src/analysis/technicals.js`

- [ ] **Step 1: Create technicals module**

Compute RSI, MACD, Bollinger Bands, ATR, support/resistance, volume analysis using technicalindicators package. Input: OHLCV array. Output: structured signals object.

- [ ] **Step 2: Commit**

---

### Task 6: Stock Screener (Pre-Filter)

**Files:**
- Create: `src/analysis/screener.js`

- [ ] **Step 1: Create screener**

Fetch data for all F&O stocks, compute technicals, score each stock, filter to top 15. Scoring: volume surge (20%), RSI extremes (20%), MACD signal (20%), support/resistance proximity (20%), news mentions (20%).

- [ ] **Step 2: Commit**

---

### Task 7: Claude Code Integration

**Files:**
- Create: `src/analysis/claude.js`

- [ ] **Step 1: Create Claude Code spawner**

Spawn `claude` CLI with `--print` flag, pass structured prompt with stock data, receive analysis. Handle timeout, parse response.

- [ ] **Step 2: Create prompt templates**

Pre-market scan prompt, quick research prompt, deep research prompt, exit analysis prompt, news interpretation prompt.

- [ ] **Step 3: Commit**

---

### Task 8: Risk Management

**Files:**
- Create: `src/trading/risk.js`

- [ ] **Step 1: Create risk module**

Position sizing (max 20% capital), stop-loss calculator (ATR-based), trailing stop updater, profit target calculator (1:2, 1:3 R:R), max loss enforcer.

- [ ] **Step 2: Commit**

---

### Task 9: Trade Manager (Paper Trading)

**Files:**
- Create: `src/trading/manager.js`
- Create: `src/trading/portfolio.js`

- [ ] **Step 1: Create trade manager**

Enter trade (validate risk rules, insert to DB), exit trade (update DB, calculate P&L), partial exit (T1/T2 booking).

- [ ] **Step 2: Create portfolio tracker**

Current positions, available capital, daily P&L, 30-day performance, win rate.

- [ ] **Step 3: Commit**

---

### Task 10: Event Listeners

**Files:**
- Create: `src/listeners/price.js`
- Create: `src/listeners/news-monitor.js`
- Create: `src/listeners/index-monitor.js`
- Create: `src/listeners/manager.js`

- [ ] **Step 1: Create price listener**

Check price vs stop-loss, targets, trailing stop for all open positions. Auto-trigger exits.

- [ ] **Step 2: Create news monitor**

Periodically fetch news for open position symbols. Flag negative sentiment.

- [ ] **Step 3: Create index monitor**

Watch Nifty/BankNifty for crash threshold. Emergency exit all if breached.

- [ ] **Step 4: Create listener manager**

Start/stop all listeners, coordinate intervals, aggregate alerts.

- [ ] **Step 5: Commit**

---

### Task 11: CLI Interface

**Files:**
- Create: `src/index.js`
- Create: `src/cli/scan.js`
- Create: `src/cli/research.js`
- Create: `src/cli/portfolio.js`
- Create: `src/cli/trades.js`
- Create: `src/cli/display.js`

- [ ] **Step 1: Create display helpers**

Formatted tables, colored output, box drawing for trade cards, confidence bars.

- [ ] **Step 2: Create scan command**

Run screener → Claude analysis → display morning brief with trade cards.

- [ ] **Step 3: Create research command**

Quick and deep modes. Fetch data → optional Claude → display.

- [ ] **Step 4: Create portfolio and trades commands**

Show positions, P&L, performance stats.

- [ ] **Step 5: Create main entry point (index.js)**

Commander setup with all commands + daemon mode.

- [ ] **Step 6: Commit**

---

### Task 12: Scheduler (Daemon)

**Files:**
- Create: `src/scheduler/cron.js`

- [ ] **Step 1: Create scheduler**

Register all cron jobs: pre-market scan, market open check, pulse, position monitor, wind down, post-market review. Start/stop control.

- [ ] **Step 2: Commit**

---

### Task 13: Integration & Wiring

- [ ] **Step 1: Wire daemon mode in index.js**

Start scheduler + listeners on `daemon` command.

- [ ] **Step 2: End-to-end test**

Run scan command, verify output, run portfolio, verify DB.

- [ ] **Step 3: Final commit**

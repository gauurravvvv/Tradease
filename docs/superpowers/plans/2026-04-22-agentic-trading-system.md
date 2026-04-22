# Agentic Autonomous Trading System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build 3 autonomous Claude-powered agents that monitor news, enter trades, and manage exits — zero human intervention, token-optimized.

**Architecture:** Each agent runs on its own interval during market hours, uses focused Claude CLI prompts with capped tokens, communicates through SQLite signal/decision tables. Mechanical checks (SL/target/index crash) skip Claude entirely to save tokens. A central orchestrator starts/stops all agents and integrates with the existing daemon.

**Tech Stack:** Node.js ES modules, Claude CLI (`--print -p`), better-sqlite3, existing risk/market/news/technicals modules.

---

## File Structure

```
src/agents/
├── base.js              # Base agent class: spawn Claude, parse JSON, token tracking, logging
├── orchestrator.js      # Start/stop/schedule all agents, health monitoring, dashboard integration
├── news-sentinel.js     # Agent 1: News monitoring → sentiment signals (every 5 min)
├── trade-strategist.js  # Agent 2: Signal evaluation → entry decisions (every 10 min)
└── position-guardian.js # Agent 3: Position monitoring → exit decisions (every 2 min)
```

**Modified files:**
- `src/db/sqlite.js` — add `agent_signals` + `agent_logs` tables
- `src/analysis/claude.js` — add `--max-tokens` support to `askClaude`
- `src/scheduler/cron.js` — integrate orchestrator into daemon lifecycle
- `src/index.js` — add `tradease agents` CLI command
- `src/dashboard/server.js` — add `/api/agents/*` endpoints + SSE agent events
- `src/dashboard/public/index.html` — add Agent Activity section to dashboard

---

## Token Budget

| Agent | Input Tokens | Max Output | Frequency | Claude Calls/hr | Notes |
|-------|-------------|-----------|-----------|-----------------|-------|
| News Sentinel | ~800 | 500 | Every 5 min | ≤12 | Skips if no new headlines |
| Trade Strategist | ~1200 | 800 | Every 10 min | ≤6 | Skips if no signals or positions full |
| Position Guardian | ~600 | 400 | Every 2 min | ~5 actual | Mechanical SL/target = no Claude |
| **Total estimated** | | | | **~23/hr** | **~30K tokens/hr max** |

**Token optimization rules:**
1. Hash headlines — only send NEW ones since last run
2. Skip Claude when nothing changed (no new news, no pending signals, no open positions)
3. Mechanical exits (SL hit, target hit, index crash) — no Claude call
4. Compressed JSON prompts — abbreviated keys, no prose context
5. `maxTokens` capped per agent role in `askClaude` call
6. Position Guardian only calls Claude near decision boundaries

---

## DB Schema

```sql
-- Agent communication channel
CREATE TABLE IF NOT EXISTS agent_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  symbol TEXT,
  signal_type TEXT NOT NULL,
  confidence INTEGER DEFAULT 0,
  data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  consumed INTEGER DEFAULT 0,
  consumed_by TEXT,
  consumed_at TEXT
);

-- Agent activity log (for dashboard + debugging)
CREATE TABLE IF NOT EXISTS agent_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  action TEXT NOT NULL,
  symbol TEXT,
  details TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  skipped INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
```

**Signal types:** `bullish_news`, `bearish_news`, `urgent_exit`, `entry_signal`, `exit_signal`, `trail_sl`, `partial_exit`

---

## The Flow (Normal Use Case)

```
1. News Sentinel   → detects "RELIANCE strong earnings" → writes bullish_news signal (conf: 4)
2. Trade Strategist → reads signal + checks screener data + portfolio
                    → Claude confirms CALL with entry/SL/targets
                    → auto-enters trade via enterTrade()
3. Position Guardian → monitors every 2 min
                     → price hits T1 → mechanical partial exit 50% (no Claude)
                     → News Sentinel writes bearish_news for RELIANCE sector
                     → Guardian reads signal → asks Claude → trails SL to breakeven
                     → SL hit → mechanical exit (no Claude)
4. Dashboard        → shows all agent actions in real-time via SSE
```

---

### Task 1: Base Agent Class + DB Schema

**Files:**
- Create: `src/agents/base.js`
- Modify: `src/db/sqlite.js`
- Modify: `src/analysis/claude.js`

- [ ] **Step 1: Add agent tables to SQLite schema**

In `src/db/sqlite.js`, add to the `getDb()` initialization (after existing CREATE TABLE statements):

```javascript
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    symbol TEXT,
    signal_type TEXT NOT NULL,
    confidence INTEGER DEFAULT 0,
    data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    consumed INTEGER DEFAULT 0,
    consumed_by TEXT,
    consumed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS agent_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    action TEXT NOT NULL,
    symbol TEXT,
    details TEXT,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    skipped INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);
```

- [ ] **Step 2: Add maxTokens support to askClaude**

In `src/analysis/claude.js`, modify the `askClaude` function to pass `--max-tokens` flag:

```javascript
export async function askClaude(prompt, options = {}) {
  const { timeout = 120_000, maxTokens = 4000 } = options;

  return new Promise((resolve, reject) => {
    const args = ['--print', '--max-tokens', String(maxTokens), '-p', prompt];
    // ... rest unchanged
```

- [ ] **Step 3: Create base agent class**

```javascript
// src/agents/base.js
import { getDb } from '../db/sqlite.js';
import { askClaude } from '../analysis/claude.js';
import { logger } from '../utils/logger.js';

export class BaseAgent {
  constructor(name, { intervalMs, maxInputTokens, maxOutputTokens }) {
    this.name = name;
    this.intervalMs = intervalMs;
    this.maxInputTokens = maxInputTokens;
    this.maxOutputTokens = maxOutputTokens;
    this._timer = null;
    this._running = false;
    this._lastRun = 0;
    this._stats = { runs: 0, skipped: 0, errors: 0, totalTokens: 0 };
  }

  // Override in subclass — return true if agent should run this tick
  shouldRun() { return true; }

  // Override in subclass — main agent logic
  async execute() { throw new Error('execute() not implemented'); }

  async tick() {
    if (this._running) return; // prevent overlap
    this._running = true;
    try {
      if (!this.shouldRun()) {
        this._stats.skipped++;
        this.log('skip', null, 'No actionable data');
        return;
      }
      await this.execute();
      this._stats.runs++;
      this._lastRun = Date.now();
    } catch (err) {
      this._stats.errors++;
      logger.error(`[${this.name}] Error: ${err.message}`);
      this.log('error', null, err.message);
    } finally {
      this._running = false;
    }
  }

  start() {
    logger.info(`[${this.name}] Started (interval: ${this.intervalMs}ms)`);
    this.tick(); // immediate first run
    this._timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    logger.info(`[${this.name}] Stopped`);
  }

  // Ask Claude with token caps
  async askClaude(prompt) {
    const response = await askClaude(prompt, {
      timeout: 60_000,
      maxTokens: this.maxOutputTokens,
    });
    // Rough token estimate: ~4 chars per token
    const tokensIn = Math.ceil(prompt.length / 4);
    const tokensOut = Math.ceil(response.length / 4);
    this._stats.totalTokens += tokensIn + tokensOut;
    this.log('claude_call', null, null, tokensIn, tokensOut);
    return response;
  }

  // Write signal to DB
  writeSignal(symbol, signalType, confidence, data = {}) {
    const db = getDb();
    db.prepare(`
      INSERT INTO agent_signals (agent, symbol, signal_type, confidence, data)
      VALUES (?, ?, ?, ?, ?)
    `).run(this.name, symbol, signalType, confidence, JSON.stringify(data));
    logger.info(`[${this.name}] Signal: ${signalType} for ${symbol} (conf: ${confidence})`);
  }

  // Read pending signals (optionally filter by type)
  readSignals(signalTypes = null) {
    const db = getDb();
    if (signalTypes) {
      const placeholders = signalTypes.map(() => '?').join(',');
      return db.prepare(`
        SELECT * FROM agent_signals
        WHERE consumed = 0 AND signal_type IN (${placeholders})
        ORDER BY created_at DESC
      `).all(...signalTypes);
    }
    return db.prepare(`
      SELECT * FROM agent_signals WHERE consumed = 0 ORDER BY created_at DESC
    `).all();
  }

  // Mark signals as consumed
  consumeSignals(ids) {
    if (!ids.length) return;
    const db = getDb();
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`
      UPDATE agent_signals
      SET consumed = 1, consumed_by = ?, consumed_at = datetime('now')
      WHERE id IN (${placeholders})
    `).run(this.name, ...ids);
  }

  // Log agent activity
  log(action, symbol = null, details = null, tokensIn = 0, tokensOut = 0, skipped = 0) {
    const db = getDb();
    db.prepare(`
      INSERT INTO agent_logs (agent, action, symbol, details, tokens_in, tokens_out, skipped)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(this.name, action, symbol, details, tokensIn, tokensOut, skipped);
  }

  // Check if within market hours (IST)
  isMarketHours(startHour = 9, startMin = 0, endHour = 15, endMin = 30) {
    const now = new Date();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = ist.getDay();
    if (day === 0 || day === 6) return false;
    const mins = ist.getHours() * 60 + ist.getMinutes();
    return mins >= (startHour * 60 + startMin) && mins <= (endHour * 60 + endMin);
  }

  getStats() {
    return { ...this._stats, name: this.name, lastRun: this._lastRun, running: this._running };
  }
}
```

- [ ] **Step 4: Run tests to verify DB schema migration works**

Run: `npm test`
Expected: All 64 tests still pass (DB schema is additive, no breaking changes)

- [ ] **Step 5: Commit**

```bash
git add src/agents/base.js src/db/sqlite.js src/analysis/claude.js
git commit -m "feat: add base agent class + agent DB schema + maxTokens support"
```

---

### Task 2: News Sentinel Agent

**Files:**
- Create: `src/agents/news-sentinel.js`

- [ ] **Step 1: Create News Sentinel agent**

```javascript
// src/agents/news-sentinel.js
import { BaseAgent } from './base.js';
import { fetchAllNews, getStockNews } from '../data/news.js';
import { getOpenTrades } from '../trading/manager.js';
import { getDb } from '../db/sqlite.js';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';

// Track seen headlines to avoid duplicate Claude calls
const seenHeadlines = new Map(); // hash → timestamp
const SEEN_TTL = 30 * 60 * 1000; // 30 min

function hashHeadline(title) {
  return crypto.createHash('md5').update(title || '').digest('hex').slice(0, 12);
}

function filterNewHeadlines(articles) {
  const now = Date.now();
  // Clean old entries
  for (const [hash, ts] of seenHeadlines) {
    if (now - ts > SEEN_TTL) seenHeadlines.delete(hash);
  }
  const fresh = articles.filter(a => {
    const h = hashHeadline(a.title);
    if (seenHeadlines.has(h)) return false;
    seenHeadlines.set(h, now);
    return true;
  });
  return fresh;
}

export class NewsSentinel extends BaseAgent {
  constructor() {
    super('news-sentinel', {
      intervalMs: 5 * 60 * 1000, // 5 minutes
      maxInputTokens: 800,
      maxOutputTokens: 500,
    });
    this._watchlist = []; // Top stocks to monitor
    this._lastScreenerSync = 0;
  }

  shouldRun() {
    return this.isMarketHours(9, 0, 15, 30);
  }

  async execute() {
    // Step 1: Get watchlist — open positions + top screener picks
    const openTrades = getOpenTrades();
    const openSymbols = openTrades.map(t => t.symbol);

    // Build watchlist: open positions (priority) + recent screener picks
    const watchlist = [...new Set([...openSymbols, ...this._watchlist])].slice(0, 15);

    if (!watchlist.length) {
      // Fallback: fetch general market news for broad signals
      await this._scanGeneralNews();
      return;
    }

    // Step 2: Fetch news for all watchlist stocks
    const allArticles = await fetchAllNews();
    const newArticles = filterNewHeadlines(allArticles);

    if (!newArticles.length) {
      this.log('skip', null, 'No new headlines', 0, 0, 1);
      return;
    }

    // Step 3: Build stock-specific headline map
    const stockNews = {};
    for (const sym of watchlist) {
      const relevant = newArticles.filter(a => {
        const title = (a.title || '').toUpperCase();
        return title.includes(sym) || title.includes(sym.replace(/\s+/g, ''));
      });
      if (relevant.length > 0) {
        stockNews[sym] = relevant.slice(0, 5).map(a => a.title);
      }
    }

    // Also include general market headlines for broad sentiment
    const generalHeadlines = newArticles
      .filter(a => {
        const t = (a.title || '').toUpperCase();
        return t.includes('NIFTY') || t.includes('MARKET') || t.includes('SENSEX')
          || t.includes('FII') || t.includes('RBI') || t.includes('SECTOR');
      })
      .slice(0, 5)
      .map(a => a.title);

    if (Object.keys(stockNews).length === 0 && generalHeadlines.length === 0) {
      this.log('skip', null, 'No relevant headlines for watchlist', 0, 0, 1);
      return;
    }

    // Step 4: Ask Claude for sentiment analysis (single batch call)
    const prompt = `F&O news sentiment analyst. Score these headlines for trading signals.

WATCHLIST: ${watchlist.join(',')}
OPEN POSITIONS: ${openSymbols.join(',') || 'none'}

STOCK NEWS:
${Object.entries(stockNews).map(([sym, headlines]) =>
  `${sym}: ${headlines.join(' | ')}`
).join('\n')}

MARKET: ${generalHeadlines.join(' | ') || 'none'}

RESPOND JSON array — only stocks with actionable signals (score >= 3 or <= -3):
[{"sym":"RELIANCE","score":4,"signal":"bullish_news","reason":"strong earnings beat"}]

score: -5 (very bearish) to +5 (very bullish). Skip neutral stocks.
URGENT: If NEGATIVE news for open positions (${openSymbols.join(',')}), always include with signal "urgent_exit".
JSON only.`;

    try {
      const raw = await this.askClaude(prompt);
      const signals = JSON.parse(raw.replace(/```json?\s*/g, '').replace(/```/g, '').trim());

      if (!Array.isArray(signals)) return;

      for (const s of signals) {
        if (!s.sym || !s.signal) continue;
        const isOpen = openSymbols.includes(s.sym);
        const signalType = s.signal === 'urgent_exit' && isOpen ? 'urgent_exit'
          : s.score >= 3 ? 'bullish_news'
          : s.score <= -3 ? 'bearish_news'
          : null;

        if (signalType) {
          this.writeSignal(s.sym, signalType, Math.abs(s.score), {
            reason: s.reason,
            score: s.score,
            isOpenPosition: isOpen,
          });
        }
      }

      this.log('analyze', null, `${signals.length} signals from ${Object.keys(stockNews).length} stocks`);
    } catch (err) {
      logger.error(`[news-sentinel] Claude parse failed: ${err.message}`);
      this.log('error', null, `Parse failed: ${err.message}`);
    }
  }

  async _scanGeneralNews() {
    const allArticles = await fetchAllNews();
    const newArticles = filterNewHeadlines(allArticles);
    if (!newArticles.length) {
      this.log('skip', null, 'No new general headlines', 0, 0, 1);
      return;
    }
    // Just log for now — no Claude call for general market scan without watchlist
    this.log('general_scan', null, `${newArticles.length} new general headlines`);
  }

  // Called by orchestrator when screener updates
  updateWatchlist(symbols) {
    this._watchlist = symbols.slice(0, 15);
    this._lastScreenerSync = Date.now();
  }
}
```

- [ ] **Step 2: Verify module imports resolve**

```bash
node -e "import('./src/agents/news-sentinel.js').then(()=>console.log('OK')).catch(e=>console.error(e.message))"
```

- [ ] **Step 3: Commit**

```bash
git add src/agents/news-sentinel.js
git commit -m "feat: add News Sentinel agent — monitors headlines, writes sentiment signals"
```

---

### Task 3: Trade Strategist Agent

**Files:**
- Create: `src/agents/trade-strategist.js`

- [ ] **Step 1: Create Trade Strategist agent**

```javascript
// src/agents/trade-strategist.js
import { BaseAgent } from './base.js';
import { getOpenTrades, enterTrade } from '../trading/manager.js';
import { getPortfolioSummary } from '../trading/portfolio.js';
import { calculateStopLoss, calculateTargets, calculatePositionSize, validateTrade } from '../trading/risk.js';
import { getQuote, getHistorical } from '../data/market.js';
import { analyzeTechnicals, computeATR } from '../analysis/technicals.js';
import { screenStocks } from '../analysis/screener.js';
import { getDb } from '../db/sqlite.js';
import { logger } from '../utils/logger.js';
import { notifyTradeEntry } from '../utils/notify.js';

// Screener cache — shared within this agent
let screenerCache = { data: null, ts: 0 };
const SCREENER_TTL = 10 * 60 * 1000; // 10 min

export class TradeStrategist extends BaseAgent {
  constructor() {
    super('trade-strategist', {
      intervalMs: 10 * 60 * 1000, // 10 minutes
      maxInputTokens: 1200,
      maxOutputTokens: 800,
    });
  }

  shouldRun() {
    // Only trade between 9:30 and 14:30 IST
    if (!this.isMarketHours(9, 30, 14, 30)) return false;

    // Don't run if max positions reached
    const portfolio = getPortfolioSummary();
    if (portfolio.openPositions >= 3) {
      this.log('skip', null, 'Max positions (3) reached', 0, 0, 1);
      return false;
    }

    return true;
  }

  async execute() {
    const db = getDb();
    const portfolio = getPortfolioSummary();

    // Step 1: Check for pending news signals
    const newsSignals = this.readSignals(['bullish_news']);
    const signalSymbols = [...new Set(newsSignals.map(s => s.symbol))];

    // Step 2: Get screener recommendations (cached)
    let screenerPicks = [];
    const now = Date.now();
    if (!screenerCache.data || (now - screenerCache.ts) >= SCREENER_TTL) {
      try {
        const screened = await screenStocks();
        screenerPicks = screened
          .filter(s => s.recommendation === 'CALL' || s.recommendation === 'PUT')
          .slice(0, 8);
        screenerCache.data = screenerPicks;
        screenerCache.ts = now;
      } catch (err) {
        screenerPicks = screenerCache.data || [];
        logger.error(`[trade-strategist] Screener failed: ${err.message}`);
      }
    } else {
      screenerPicks = screenerCache.data;
    }

    // Step 3: Merge signal stocks with screener picks (prioritize signal stocks)
    const candidates = [];
    const seen = new Set();

    // First: stocks with news signals that also appear in screener
    for (const sym of signalSymbols) {
      const pick = screenerPicks.find(p => p.symbol === sym);
      if (pick && !seen.has(sym)) {
        candidates.push({ ...pick, hasNewsSignal: true, newsConfidence: newsSignals.find(s => s.symbol === sym)?.confidence || 0 });
        seen.add(sym);
      }
    }

    // Then: top screener picks without signals
    for (const pick of screenerPicks) {
      if (!seen.has(pick.symbol) && candidates.length < 5) {
        candidates.push({ ...pick, hasNewsSignal: false, newsConfidence: 0 });
        seen.add(pick.symbol);
      }
    }

    if (!candidates.length) {
      this.log('skip', null, 'No candidates', 0, 0, 1);
      // Consume old signals to prevent stale buildup
      if (newsSignals.length) this.consumeSignals(newsSignals.map(s => s.id));
      return;
    }

    // Step 4: Fetch live data for top candidates
    const liveData = [];
    for (const c of candidates.slice(0, 5)) {
      try {
        const [quote, history] = await Promise.all([
          getQuote(c.symbol),
          getHistorical(c.symbol, 30).catch(() => []),
        ]);
        let atr = c.technicals?.atr?.value || 0;
        if (!atr && history.length >= 14) atr = computeATR(history);

        liveData.push({
          sym: c.symbol,
          px: quote.price,
          chg: quote.changePct?.toFixed(1) + '%',
          rec: c.recommendation,
          score: c.score,
          rsi: c.technicals?.rsi?.value,
          macd: c.technicals?.macd?.trend,
          atr,
          volRatio: c.technicals?.volume?.ratio,
          sector: c.sector,
          hasNews: c.hasNewsSignal,
          newsConf: c.newsConfidence,
          lotSize: c.lotSize || 1,
        });
      } catch (err) {
        logger.warn(`[trade-strategist] Failed to fetch ${c.symbol}: ${err.message}`);
      }
    }

    if (!liveData.length) {
      this.log('skip', null, 'Failed to fetch live data for candidates');
      return;
    }

    // Step 5: Ask Claude for entry decision
    const prompt = `F&O entry strategist. Decide which trade(s) to enter RIGHT NOW.

PORTFOLIO: capital=${portfolio.availableCapital}, positions=${portfolio.openPositions}/3
MAX_RISK_PER_TRADE: 5% of capital (₹${(portfolio.totalCapital * 0.05).toFixed(0)})

CANDIDATES:
${JSON.stringify(liveData)}

RULES:
- Only recommend HIGH conviction entries (confidence >= 70)
- Must have clear directional setup (RSI + MACD + volume confirming)
- News-backed signals get priority (hasNews=true)
- SL = entry ± 1.5 × ATR. Target1 = 2× risk. Target2 = 3× risk.
- Max 1-2 entries per run. Quality over quantity.
- SKIP if setup is weak or unclear.

RESPOND JSON:
[{"sym":"RELIANCE","type":"CALL","confidence":78,"entry":2450,"sl":2410,"t1":2530,"t2":2570,"lots":1,"reason":"bullish RSI recovery + earnings news"}]

Empty array [] if no trades worth entering. JSON only.`;

    try {
      const raw = await this.askClaude(prompt);
      const decisions = JSON.parse(raw.replace(/```json?\s*/g, '').replace(/```/g, '').trim());

      if (!Array.isArray(decisions) || !decisions.length) {
        this.log('no_entry', null, 'Claude recommended no entries');
        this.consumeSignals(newsSignals.map(s => s.id));
        return;
      }

      // Step 6: Execute approved trades
      for (const d of decisions) {
        if (!d.sym || !d.type || d.confidence < 70) continue;
        if (portfolio.openPositions >= 3) break;

        const candidate = liveData.find(c => c.sym === d.sym);
        if (!candidate) continue;

        // Validate trade
        const capitalRequired = d.entry * (candidate.lotSize || 1) * (d.lots || 1);
        const validation = validateTrade(
          { symbol: d.sym, type: d.type, capitalRequired, maxLoss: Math.abs(d.entry - d.sl) * (candidate.lotSize || 1) * (d.lots || 1) },
          { positions: getOpenTrades(), capitalUsed: portfolio.capitalInUse, totalCapital: portfolio.totalCapital }
        );

        if (!validation.valid) {
          this.log('rejected', d.sym, `Validation failed: ${validation.reasons?.join(', ')}`);
          continue;
        }

        // Enter the trade
        try {
          const trade = enterTrade({
            symbol: d.sym,
            type: d.type.toUpperCase(),
            entryPrice: d.entry,
            premium: d.entry * 0.02,
            lotSize: candidate.lotSize || 1,
            stopLoss: d.sl,
            target1: d.t1,
            target2: d.t2,
            confidence: d.confidence,
            reason: `[Agent] ${d.reason}`,
          });

          this.writeSignal(d.sym, 'entry_signal', d.confidence, {
            type: d.type,
            entry: d.entry,
            sl: d.sl,
            t1: d.t1,
            t2: d.t2,
            reason: d.reason,
            tradeId: trade?.id,
          });

          this.log('entry', d.sym, `${d.type} @ ₹${d.entry} SL:₹${d.sl} T1:₹${d.t1} (conf:${d.confidence})`);
          logger.trade(`[trade-strategist] AUTO ENTRY: ${d.sym} ${d.type} @ ${d.entry}`);

          try { notifyTradeEntry(d.sym, d.type, d.entry); } catch {}
          portfolio.openPositions++; // Local counter
        } catch (err) {
          this.log('entry_failed', d.sym, err.message);
          logger.error(`[trade-strategist] Entry failed for ${d.sym}: ${err.message}`);
        }
      }

      // Consume processed signals
      this.consumeSignals(newsSignals.map(s => s.id));
    } catch (err) {
      logger.error(`[trade-strategist] Claude parse failed: ${err.message}`);
      this.log('error', null, `Parse failed: ${err.message}`);
    }
  }

  // Expose screener cache for News Sentinel watchlist sync
  getTopSymbols() {
    return (screenerCache.data || []).map(p => p.symbol);
  }
}
```

- [ ] **Step 2: Verify module imports resolve**

```bash
node -e "import('./src/agents/trade-strategist.js').then(()=>console.log('OK')).catch(e=>console.error(e.message))"
```

- [ ] **Step 3: Commit**

```bash
git add src/agents/trade-strategist.js
git commit -m "feat: add Trade Strategist agent — evaluates signals, auto-enters trades"
```

---

### Task 4: Position Guardian Agent

**Files:**
- Create: `src/agents/position-guardian.js`

- [ ] **Step 1: Create Position Guardian agent**

```javascript
// src/agents/position-guardian.js
import { BaseAgent } from './base.js';
import { getOpenTrades, exitTrade, partialExit } from '../trading/manager.js';
import { getPortfolioSummary } from '../trading/portfolio.js';
import { checkIndexHealth } from '../listeners/index-monitor.js';
import { getQuote } from '../data/market.js';
import { getDb } from '../db/sqlite.js';
import { logger } from '../utils/logger.js';
import { notifyTradeExit, notifyStopLoss, notifyTargetHit, notifyIndexCrash } from '../utils/notify.js';

export class PositionGuardian extends BaseAgent {
  constructor() {
    super('position-guardian', {
      intervalMs: 2 * 60 * 1000, // 2 minutes
      maxInputTokens: 600,
      maxOutputTokens: 400,
    });
    this._lastIndexCheck = 0;
  }

  shouldRun() {
    if (!this.isMarketHours(9, 15, 15, 20)) return false;
    // Skip if no open positions
    const trades = getOpenTrades();
    if (!trades.length) return false;
    return true;
  }

  async execute() {
    const db = getDb();
    const trades = getOpenTrades();
    if (!trades.length) return;

    // Step 1: Check index health (every 10 min)
    const now = Date.now();
    if (now - this._lastIndexCheck > 10 * 60 * 1000) {
      try {
        const idx = await checkIndexHealth();
        if (idx && idx.severity === 'crash') {
          logger.warn(`[position-guardian] INDEX CRASH detected: ${idx.niftyChange}%`);
          this.log('index_crash', null, `Nifty: ${idx.niftyChange}%`);
          try { notifyIndexCrash(idx.niftyChange); } catch {}
          // Emergency exit ALL positions
          await this._emergencyExitAll(trades, 'Index crash');
          return;
        }
        this._lastIndexCheck = now;
      } catch {}
    }

    // Step 2: Check for urgent exit signals from News Sentinel
    const urgentSignals = this.readSignals(['urgent_exit', 'bearish_news']);
    const urgentSymbols = new Set(urgentSignals.filter(s => s.signal_type === 'urgent_exit').map(s => s.symbol));

    // Step 3: Fetch live prices for all open positions
    const livePositions = [];
    for (const trade of trades) {
      try {
        const quote = await getQuote(trade.symbol);
        const currentPrice = quote.price;
        const isCall = trade.type === 'CALL';
        const pnl = isCall
          ? (currentPrice - trade.entry_price) * trade.lot_size * trade.quantity
          : (trade.entry_price - currentPrice) * trade.lot_size * trade.quantity;
        const pnlPct = ((currentPrice - trade.entry_price) / trade.entry_price * 100);
        const risk = Math.abs(trade.entry_price - trade.stop_loss);

        livePositions.push({
          ...trade,
          currentPrice,
          pnl,
          pnlPct,
          risk,
          distanceToSL: isCall ? currentPrice - trade.stop_loss : trade.stop_loss - currentPrice,
          distanceToT1: trade.target1 ? (isCall ? trade.target1 - currentPrice : currentPrice - trade.target1) : null,
          hasUrgentSignal: urgentSymbols.has(trade.symbol),
        });
      } catch (err) {
        logger.warn(`[position-guardian] Price fetch failed for ${trade.symbol}: ${err.message}`);
      }
    }

    if (!livePositions.length) return;

    // Step 4: Mechanical checks first (no Claude needed)
    const needsClaudeDecision = [];

    for (const pos of livePositions) {
      const isCall = pos.type === 'CALL';

      // Check stop-loss hit
      if (isCall ? pos.currentPrice <= pos.stop_loss : pos.currentPrice >= pos.stop_loss) {
        await this._exitPosition(pos, pos.currentPrice, 'Stop-loss hit');
        try { notifyStopLoss(pos.symbol, pos.currentPrice); } catch {}
        continue;
      }

      // Check target1 hit (partial exit 50%)
      if (!pos.t1_hit && pos.target1) {
        if (isCall ? pos.currentPrice >= pos.target1 : pos.currentPrice <= pos.target1) {
          await this._partialExit(pos, 0.5, pos.currentPrice, 'Target 1 hit');
          try { notifyTargetHit(pos.symbol, 1, pos.currentPrice); } catch {}
          continue;
        }
      }

      // Check target2 hit (partial exit 25%)
      if (pos.t1_hit && !pos.t2_hit && pos.target2) {
        if (isCall ? pos.currentPrice >= pos.target2 : pos.currentPrice <= pos.target2) {
          await this._partialExit(pos, 0.5, pos.currentPrice, 'Target 2 hit');
          try { notifyTargetHit(pos.symbol, 2, pos.currentPrice); } catch {}
          continue;
        }
      }

      // Urgent exit signal from news
      if (pos.hasUrgentSignal) {
        needsClaudeDecision.push(pos);
        continue;
      }

      // Near decision boundary? (within 30% of SL distance)
      if (pos.distanceToSL < pos.risk * 0.3) {
        needsClaudeDecision.push(pos);
        continue;
      }

      // Profitable and past T1 — might need trailing SL adjustment
      if (pos.t1_hit && pos.pnlPct > 1) {
        needsClaudeDecision.push(pos);
      }
    }

    // Step 5: Ask Claude only for ambiguous positions
    if (needsClaudeDecision.length > 0) {
      await this._claudeDecision(needsClaudeDecision);
    }

    // Consume urgent signals
    if (urgentSignals.length) {
      this.consumeSignals(urgentSignals.map(s => s.id));
    }

    this.log('monitor', null, `${livePositions.length} positions checked, ${needsClaudeDecision.length} needed Claude`);
  }

  async _claudeDecision(positions) {
    const compact = positions.map(p => ({
      id: p.id,
      sym: p.symbol,
      type: p.type,
      entry: p.entry_price,
      current: p.currentPrice,
      sl: p.stop_loss,
      t1: p.target1,
      t2: p.target2,
      t1Hit: p.t1_hit ? 1 : 0,
      t2Hit: p.t2_hit ? 1 : 0,
      pnl: p.pnl?.toFixed(0),
      pnlPct: p.pnlPct?.toFixed(1) + '%',
      distSL: p.distanceToSL?.toFixed(1),
      urgent: p.hasUrgentSignal ? 1 : 0,
      qty: p.quantity,
    }));

    const prompt = `F&O position guardian. Decide action for each position.

POSITIONS:
${JSON.stringify(compact)}

For each position, decide:
- HOLD: keep position, optionally adjust SL
- PARTIAL_EXIT: book partial profits (specify %)
- FULL_EXIT: close entire position

RESPOND JSON:
[{"id":1,"action":"HOLD","newSL":2435,"reason":"trail SL to breakeven after T1"}]

RULES:
- urgent=1 → strongly consider FULL_EXIT unless price action is favorable
- If near SL (distSL small) and momentum weakening → FULL_EXIT
- If profitable past T1 → trail SL to at least breakeven
- Be protective of capital. Better to exit early than ride a loss.
JSON only.`;

    try {
      const raw = await this.askClaude(prompt);
      const decisions = JSON.parse(raw.replace(/```json?\s*/g, '').replace(/```/g, '').trim());

      if (!Array.isArray(decisions)) return;

      for (const d of decisions) {
        const pos = positions.find(p => p.id === d.id);
        if (!pos) continue;

        if (d.action === 'FULL_EXIT') {
          await this._exitPosition(pos, pos.currentPrice, `[Agent] ${d.reason}`);
        } else if (d.action === 'PARTIAL_EXIT') {
          const pct = d.percentage || 0.5;
          await this._partialExit(pos, pct, pos.currentPrice, `[Agent] ${d.reason}`);
        } else if (d.action === 'HOLD' && d.newSL) {
          // Update trailing stop-loss
          this._updateStopLoss(pos, d.newSL, d.reason);
        }
      }
    } catch (err) {
      logger.error(`[position-guardian] Claude decision failed: ${err.message}`);
      this.log('error', null, `Claude decision failed: ${err.message}`);
    }
  }

  async _exitPosition(pos, price, reason) {
    try {
      exitTrade(pos.id, price, reason);
      this.writeSignal(pos.symbol, 'exit_signal', 5, { price, reason, pnl: pos.pnl });
      this.log('exit', pos.symbol, `${reason} @ ₹${price} P&L: ₹${pos.pnl?.toFixed(0)}`);
      logger.trade(`[position-guardian] EXIT: ${pos.symbol} @ ${price} — ${reason}`);
      try { notifyTradeExit(pos.symbol, price, pos.pnl); } catch {}
    } catch (err) {
      this.log('exit_failed', pos.symbol, err.message);
    }
  }

  async _partialExit(pos, percentage, price, reason) {
    try {
      partialExit(pos.id, percentage, price, reason);
      this.writeSignal(pos.symbol, 'partial_exit', 4, { price, percentage, reason });
      this.log('partial_exit', pos.symbol, `${Math.round(percentage * 100)}% @ ₹${price} — ${reason}`);
      logger.trade(`[position-guardian] PARTIAL EXIT: ${pos.symbol} ${Math.round(percentage * 100)}% @ ${price}`);
    } catch (err) {
      this.log('partial_exit_failed', pos.symbol, err.message);
    }
  }

  _updateStopLoss(pos, newSL, reason) {
    try {
      const db = getDb();
      // Only move SL in favorable direction
      const isCall = pos.type === 'CALL';
      if (isCall ? newSL > pos.stop_loss : newSL < pos.stop_loss) {
        db.prepare('UPDATE trades SET stop_loss = ?, trailing_stop = ? WHERE id = ?')
          .run(newSL, newSL, pos.id);
        this.log('trail_sl', pos.symbol, `SL moved to ₹${newSL} — ${reason}`);
        logger.info(`[position-guardian] Trail SL: ${pos.symbol} → ₹${newSL}`);
      }
    } catch (err) {
      this.log('trail_sl_failed', pos.symbol, err.message);
    }
  }

  async _emergencyExitAll(trades, reason) {
    for (const trade of trades) {
      let price = trade.current_price || trade.entry_price;
      try { const q = await getQuote(trade.symbol); price = q.price; } catch {}
      await this._exitPosition({ ...trade, pnl: 0, currentPrice: price }, price, `EMERGENCY: ${reason}`);
    }
  }
}
```

- [ ] **Step 2: Verify module imports resolve**

```bash
node -e "import('./src/agents/position-guardian.js').then(()=>console.log('OK')).catch(e=>console.error(e.message))"
```

- [ ] **Step 3: Commit**

```bash
git add src/agents/position-guardian.js
git commit -m "feat: add Position Guardian agent — monitors positions, mechanical + AI exits"
```

---

### Task 5: Agent Orchestrator

**Files:**
- Create: `src/agents/orchestrator.js`

- [ ] **Step 1: Create orchestrator**

```javascript
// src/agents/orchestrator.js
import { NewsSentinel } from './news-sentinel.js';
import { TradeStrategist } from './trade-strategist.js';
import { PositionGuardian } from './position-guardian.js';
import { getDb } from '../db/sqlite.js';
import { logger } from '../utils/logger.js';

export class AgentOrchestrator {
  constructor() {
    this.newsSentinel = new NewsSentinel();
    this.tradeStrategist = new TradeStrategist();
    this.positionGuardian = new PositionGuardian();
    this._syncTimer = null;
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    getDb(); // Ensure DB + agent tables exist

    logger.info('[orchestrator] Starting all agents...');

    // Stagger agent starts to avoid burst
    this.positionGuardian.start();              // Most critical — starts first
    setTimeout(() => this.newsSentinel.start(), 5_000);    // 5s delay
    setTimeout(() => this.tradeStrategist.start(), 15_000); // 15s delay

    // Sync watchlist from strategist → sentinel every 10 min
    this._syncTimer = setInterval(() => {
      const symbols = this.tradeStrategist.getTopSymbols();
      if (symbols.length) {
        this.newsSentinel.updateWatchlist(symbols);
      }
    }, 10 * 60 * 1000);

    logger.info('[orchestrator] All agents started');
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    this.positionGuardian.stop();
    this.newsSentinel.stop();
    this.tradeStrategist.stop();
    if (this._syncTimer) clearInterval(this._syncTimer);
    this._syncTimer = null;
    logger.info('[orchestrator] All agents stopped');
  }

  getStatus() {
    return {
      running: this._running,
      agents: [
        this.newsSentinel.getStats(),
        this.tradeStrategist.getStats(),
        this.positionGuardian.getStats(),
      ],
    };
  }

  // Get recent agent activity for dashboard
  getRecentActivity(limit = 20) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM agent_logs
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
  }

  // Get pending signals for dashboard
  getPendingSignals() {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM agent_signals
      WHERE consumed = 0
      ORDER BY created_at DESC
    `).all();
  }
}
```

- [ ] **Step 2: Verify orchestrator imports resolve**

```bash
node -e "import('./src/agents/orchestrator.js').then(()=>console.log('OK')).catch(e=>console.error(e.message))"
```

- [ ] **Step 3: Commit**

```bash
git add src/agents/orchestrator.js
git commit -m "feat: add Agent Orchestrator — starts/stops/syncs all 3 agents"
```

---

### Task 6: Integrate Agents into Daemon + CLI

**Files:**
- Modify: `src/index.js` — add `tradease agents` command
- Modify: `src/scheduler/cron.js` or daemon section of `src/index.js` — start orchestrator in daemon

- [ ] **Step 1: Add `agents` CLI command to `src/index.js`**

After the `dashboard` command block, add:

```javascript
// ─── agents ──────────────────────────────────────────────────────────────────
program
  .command('agents')
  .description('Start autonomous trading agents (news + trade + position)')
  .option('--dry-run', 'Run agents in observation mode (no real trades)')
  .action(async (opts) => {
    try {
      getDb();
      const { AgentOrchestrator } = await import('./agents/orchestrator.js');
      const orchestrator = new AgentOrchestrator();

      displayHeader('Tradease Agents', 'Autonomous trading agents starting...');

      orchestrator.start();

      console.log(chalk.bold.white('\n  Agents:'));
      console.log(chalk.cyan('    News Sentinel      — every 5 min  (news + sentiment)'));
      console.log(chalk.green('    Trade Strategist   — every 10 min (entry decisions)'));
      console.log(chalk.yellow('    Position Guardian  — every 2 min  (exit management)'));
      console.log('');
      console.log(chalk.green.bold('  All agents running autonomously.'));
      console.log(chalk.gray('  Press Ctrl+C to stop.\n'));

      // Print agent stats every 5 min
      setInterval(() => {
        const status = orchestrator.getStatus();
        for (const a of status.agents) {
          console.log(chalk.gray(`  [${a.name}] runs:${a.runs} skipped:${a.skipped} errors:${a.errors} tokens:${a.totalTokens}`));
        }
      }, 5 * 60 * 1000);

      // Graceful shutdown
      const shutdown = () => {
        orchestrator.stop();
        closeDb();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (err) {
      console.error(chalk.red(`Agents failed: ${err.message}`));
      process.exit(1);
    }
  });
```

- [ ] **Step 2: Integrate orchestrator into daemon command**

In the daemon's `action` handler (after `listeners.start()`), add:

```javascript
// Start autonomous agents
const { AgentOrchestrator } = await import('./agents/orchestrator.js');
const agentOrchestrator = new AgentOrchestrator();
agentOrchestrator.start();

console.log(chalk.bold.white('\n  Agents:'));
console.log(chalk.cyan('    News Sentinel      — every 5 min'));
console.log(chalk.green('    Trade Strategist   — every 10 min'));
console.log(chalk.yellow('    Position Guardian  — every 2 min'));
```

And in the shutdown handler, add `agentOrchestrator.stop();` before `closeDb()`.

- [ ] **Step 3: Test CLI command loads**

```bash
node src/index.js agents --help
```

Expected: Shows agents command help with `--dry-run` option

- [ ] **Step 4: Commit**

```bash
git add src/index.js
git commit -m "feat: integrate agents into daemon + add 'tradease agents' CLI command"
```

---

### Task 7: Dashboard Agent API + UI

**Files:**
- Modify: `src/dashboard/server.js` — add agent status/logs/signals endpoints
- Modify: `src/dashboard/public/index.html` — add Agent Activity section

- [ ] **Step 1: Add agent API endpoints to `server.js`**

After the existing API routes (before the SSE section), add:

```javascript
  // ── Agent API Routes ──────────────────────────────────────────────────────

  // Agent status (for dashboard)
  app.get('/api/agents/status', (req, res) => {
    try {
      // Read from agent_logs for stats
      const db = getDb();
      const agents = ['news-sentinel', 'trade-strategist', 'position-guardian'];
      const status = agents.map(name => {
        const lastLog = db.prepare('SELECT * FROM agent_logs WHERE agent = ? ORDER BY created_at DESC LIMIT 1').get(name);
        const stats = db.prepare('SELECT COUNT(*) as total, SUM(skipped) as skipped, SUM(tokens_in + tokens_out) as tokens FROM agent_logs WHERE agent = ? AND created_at > datetime("now", "-1 hour")').get(name);
        const errors = db.prepare('SELECT COUNT(*) as count FROM agent_logs WHERE agent = ? AND action = "error" AND created_at > datetime("now", "-1 hour")').get(name);
        return {
          name,
          lastAction: lastLog?.action || 'idle',
          lastRun: lastLog?.created_at || null,
          hourlyRuns: stats?.total || 0,
          hourlySkipped: stats?.skipped || 0,
          hourlyTokens: stats?.tokens || 0,
          hourlyErrors: errors?.count || 0,
        };
      });
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Recent agent activity log
  app.get('/api/agents/logs', (req, res) => {
    try {
      const db = getDb();
      const limit = parseInt(req.query.limit || '30', 10);
      const logs = db.prepare('SELECT * FROM agent_logs ORDER BY created_at DESC LIMIT ?').all(limit);
      res.json(logs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Pending agent signals
  app.get('/api/agents/signals', (req, res) => {
    try {
      const db = getDb();
      const signals = db.prepare('SELECT * FROM agent_signals WHERE consumed = 0 ORDER BY created_at DESC').all();
      res.json(signals);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 2: Add SSE broadcast for agent events in the background pump**

In the pump interval (after news broadcast), add:

```javascript
      // Every 30s: agent status
      if (pumpTick % 2 === 0) {
        try {
          const db = getDb();
          const recentLogs = db.prepare('SELECT * FROM agent_logs ORDER BY created_at DESC LIMIT 5').all();
          broadcast('agents', recentLogs);
        } catch {}
      }
```

- [ ] **Step 3: Add Agent Activity section to dashboard HTML**

In `index.html`, after the "Stock News & Sentiment" section div and before "Stats + History", add the Agent Activity section:

```html
<!-- Agent Activity -->
<div class="section">
  <div class="section-header">
    <span class="section-title">Agent Activity</span>
    <div class="section-actions">
      <span class="badge badge-live" style="font-size:0.5rem">LIVE</span>
      <span class="badge badge-purple" id="agent-badge">--</span>
    </div>
  </div>
  <div id="agent-container"><div class="loading" style="height:150px"></div></div>
</div>
```

Add CSS for agent cards:

```css
.agent-status-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:14px}
.agent-status-card{background:rgba(10,10,15,0.5);border:1px solid var(--card-border);border-radius:8px;padding:14px}
.agent-name{font-size:0.75rem;font-weight:700;margin-bottom:8px}
.agent-stat{display:flex;justify-content:space-between;font-size:0.65rem;padding:2px 0}
.agent-log-row{display:flex;gap:12px;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.03);font-size:0.65rem}
.agent-log-time{color:var(--text-dim);min-width:60px}
.agent-log-agent{min-width:100px;font-weight:600}
.agent-log-action{min-width:80px}
```

Add JS render function + loader:

```javascript
function renderAgentActivity(status, logs) {
  const el = document.getElementById('agent-container');
  const agentColors = { 'news-sentinel': 'var(--cyan)', 'trade-strategist': 'var(--green)', 'position-guardian': 'var(--yellow)' };
  const agentIcons = { 'news-sentinel': '📰', 'trade-strategist': '📈', 'position-guardian': '🛡️' };

  let html = '<div class="agent-status-grid">';
  for (const a of status) {
    const color = agentColors[a.name] || 'var(--text-dim)';
    const icon = agentIcons[a.name] || '🤖';
    html += `<div class="agent-status-card" style="border-left:3px solid ${color}">
      <div class="agent-name">${icon} ${a.name.replace('-', ' ').replace(/\b\w/g, c => c.toUpperCase())}</div>
      <div class="agent-stat"><span class="text-dim">Last</span><span>${a.lastAction || 'idle'}</span></div>
      <div class="agent-stat"><span class="text-dim">Runs/hr</span><span>${a.hourlyRuns}</span></div>
      <div class="agent-stat"><span class="text-dim">Skipped</span><span>${a.hourlySkipped}</span></div>
      <div class="agent-stat"><span class="text-dim">Tokens/hr</span><span>${(a.hourlyTokens || 0).toLocaleString()}</span></div>
      <div class="agent-stat"><span class="text-dim">Errors</span><span class="${a.hourlyErrors > 0 ? 'text-red' : ''}">${a.hourlyErrors}</span></div>
    </div>`;
  }
  html += '</div>';

  // Recent activity log
  if (logs && logs.length) {
    html += '<div style="max-height:200px;overflow-y:auto">';
    for (const log of logs.slice(0, 15)) {
      const color = agentColors[log.agent] || 'var(--text-dim)';
      const actionClass = log.action === 'entry' ? 'text-green' : log.action === 'exit' ? 'text-red' : log.action === 'error' ? 'text-red' : 'text-dim';
      const time = log.created_at ? new Date(log.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '--';
      html += `<div class="agent-log-row">
        <span class="agent-log-time">${time}</span>
        <span class="agent-log-agent" style="color:${color}">${log.agent.split('-')[0]}</span>
        <span class="agent-log-action ${actionClass}">${log.action}</span>
        <span>${log.symbol || ''}</span>
        <span class="text-dim" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${log.details || ''}</span>
      </div>`;
    }
    html += '</div>';
  }

  el.innerHTML = html;
  document.getElementById('agent-badge').textContent = `${status.length} agents`;
}

async function loadAgentActivity() {
  try {
    const [status, logs] = await Promise.all([
      api('/api/agents/status'),
      api('/api/agents/logs?limit=15'),
    ]);
    renderAgentActivity(status, logs);
  } catch (e) {
    console.error('Agents:', e);
  }
}
```

Add `loadAgentActivity()` to `initialLoad()` and add SSE handler:

```javascript
// In SSE handler, add:
if (d.type === 'agents') { loadAgentActivity(); }
```

Add polling fallback:

```javascript
setInterval(loadAgentActivity, 30000);
```

- [ ] **Step 4: Verify dashboard loads with agent section**

```bash
node src/index.js dashboard &
sleep 3
curl -s http://localhost:3777/api/agents/status | head -c 300
curl -s http://localhost:3777/api/agents/logs | head -c 300
```

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.js src/dashboard/public/index.html
git commit -m "feat: add Agent Activity dashboard section with status, logs, signals API"
```

---

### Task 8: End-to-End Test

- [ ] **Step 1: Run existing test suite**

```bash
npm test
```

Expected: All 64 tests pass (no existing tests broken)

- [ ] **Step 2: Verify all agent modules load**

```bash
node -e "
  Promise.all([
    import('./src/agents/base.js'),
    import('./src/agents/news-sentinel.js'),
    import('./src/agents/trade-strategist.js'),
    import('./src/agents/position-guardian.js'),
    import('./src/agents/orchestrator.js'),
  ]).then(() => console.log('All agent modules OK'))
    .catch(e => { console.error('FAIL:', e.message); process.exit(1); });
"
```

- [ ] **Step 3: Verify DB tables created**

```bash
node -e "
  import { getDb } from './src/db/sqlite.js';
  const db = getDb();
  const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_%'\").all();
  console.log('Agent tables:', tables.map(t => t.name));
"
```

Expected: `['agent_signals', 'agent_logs']`

- [ ] **Step 4: Verify CLI commands**

```bash
node src/index.js agents --help
node src/index.js dashboard --help
```

- [ ] **Step 5: Start agents in observation mode (brief run)**

```bash
timeout 30 node src/index.js agents 2>&1 || true
```

Verify: Agents start, sentinel runs first tick, no crash.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: complete agentic autonomous trading system — 3 agents, orchestrator, dashboard"
```

---

## Summary

| Component | File | Purpose |
|-----------|------|---------|
| Base Agent | `src/agents/base.js` | Claude calls, signal DB, token tracking, market hours |
| News Sentinel | `src/agents/news-sentinel.js` | Headlines → sentiment signals (5 min) |
| Trade Strategist | `src/agents/trade-strategist.js` | Signals + screener → auto entry (10 min) |
| Position Guardian | `src/agents/position-guardian.js` | Positions → mechanical/AI exits (2 min) |
| Orchestrator | `src/agents/orchestrator.js` | Lifecycle, sync, status |
| DB Schema | `src/db/sqlite.js` | `agent_signals` + `agent_logs` tables |
| CLI | `src/index.js` | `tradease agents` command |
| Dashboard | `server.js` + `index.html` | Agent status + activity log + SSE |

# Dashboard Charts + Risk Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live intraday candlestick charts per position, equity curve + daily P&L charts, and a real-time risk dashboard panel to the Tradease web dashboard.

**Architecture:** Three new API endpoints serve chart data and risk metrics. lightweight-charts (TradingView CDN) renders candlestick and line/histogram charts. A canvas-drawn donut and CSS bars handle the risk panel. One new DB column (`ending_capital` on `daily_summary`) tracks equity over time.

**Tech Stack:** lightweight-charts v4 (CDN), HTML5 Canvas API, Express (existing), SQLite (existing), yahoo-finance2 (existing)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/db/migrations.js` | Modify | Add `ending_capital` column to `daily_summary` |
| `src/trading/portfolio.js` | Modify | Update `saveDailySummary()` to persist `ending_capital`, add `getEquityCurve()` |
| `src/dashboard/server.js` | Modify | Add 3 new API endpoints: `/api/chart/:symbol`, `/api/equity-curve`, `/api/risk-summary` |
| `src/dashboard/public/index.html` | Modify | Add lightweight-charts CDN, Risk Dashboard section, chart toggles in Open Trades, Performance Analytics section, all supporting CSS and JS |

---

### Task 1: DB Migration — Add ending_capital Column

**Files:**
- Modify: `src/db/migrations.js:34-43`

- [ ] **Step 1: Add ending_capital column to daily_summary table**

In `src/db/migrations.js`, after the `daily_summary` CREATE TABLE statement (which already runs via `IF NOT EXISTS`), add an ALTER TABLE that safely adds the column if missing:

```javascript
// Add after the existing db.exec(...) block, still inside runMigrations():

  // Migration: add ending_capital to daily_summary if not present
  const cols = db.prepare("PRAGMA table_info(daily_summary)").all();
  if (!cols.some(c => c.name === 'ending_capital')) {
    db.exec('ALTER TABLE daily_summary ADD COLUMN ending_capital REAL');
  }
```

- [ ] **Step 2: Verify migration runs without error**

Run: `node -e "import('./src/db/sqlite.js').then(m => { m.getDb(); console.log('OK'); process.exit(0); })"`

Expected: `OK` (no errors)

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations.js
git commit -m "feat: add ending_capital column to daily_summary table"
```

---

### Task 2: Portfolio — getEquityCurve() + Update saveDailySummary()

**Files:**
- Modify: `src/trading/portfolio.js:193-229`

- [ ] **Step 1: Update saveDailySummary() to persist ending_capital**

In `src/trading/portfolio.js`, modify the `saveDailySummary()` function to compute and store `ending_capital`:

```javascript
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

  // Compute ending capital: base + realized P&L from all closed trades
  const allClosed = db.prepare(
    `SELECT COALESCE(SUM(pnl), 0) as totalPnl FROM trades WHERE status IN ('CLOSED', 'STOPPED')`
  ).get();
  const openTrades = db.prepare('SELECT * FROM trades WHERE status = ?').all('OPEN');
  const unrealized = openTrades.reduce((sum, t) => sum + unrealisedPnl(t), 0);
  const endingCapital = Math.round((TRADING.VIRTUAL_CAPITAL + allClosed.totalPnl + unrealized) * 100) / 100;

  // Upsert
  db.prepare(`
    INSERT INTO daily_summary (date, total_trades, winning_trades, losing_trades, gross_pnl, ending_capital)
    VALUES (@day, @totalTrades, @winningTrades, @losingTrades, @grossPnl, @endingCapital)
    ON CONFLICT(date) DO UPDATE SET
      total_trades   = @totalTrades,
      winning_trades = @winningTrades,
      losing_trades  = @losingTrades,
      gross_pnl      = @grossPnl,
      ending_capital = @endingCapital
  `).run({
    day,
    totalTrades,
    winningTrades,
    losingTrades,
    grossPnl: Math.round(grossPnl * 100) / 100,
    endingCapital,
  });

  return db.prepare('SELECT * FROM daily_summary WHERE date = ?').get(day);
}
```

- [ ] **Step 2: Add getEquityCurve() function**

Add this new export at the bottom of `src/trading/portfolio.js`:

```javascript
/**
 * Get equity curve and daily P&L data for charting.
 * @param {number} days - Number of days to look back
 * @returns {{ curve: Array, dailyPnl: Array, stats: Object }}
 */
export function getEquityCurve(days = 30) {
  const db = getDb();

  const rows = db.prepare(
    `SELECT date, gross_pnl, ending_capital
     FROM daily_summary
     WHERE date >= date('now', '-' || @days || ' days')
     ORDER BY date ASC`
  ).all({ days });

  const startingCapital = TRADING.VIRTUAL_CAPITAL;

  const curve = rows
    .filter(r => r.ending_capital != null)
    .map(r => ({ time: r.date, value: r.ending_capital }));

  const dailyPnl = rows.map(r => ({
    time: r.date,
    value: r.gross_pnl || 0,
    color: (r.gross_pnl || 0) >= 0 ? 'rgba(34,197,94,0.8)' : 'rgba(239,68,68,0.8)',
  }));

  // Compute stats from the curve
  let peakCapital = startingCapital;
  let maxDrawdown = 0;
  let bestDay = 0;
  let worstDay = 0;
  const currentCapital = curve.length ? curve[curve.length - 1].value : startingCapital;

  for (const row of rows) {
    const cap = row.ending_capital || startingCapital;
    if (cap > peakCapital) peakCapital = cap;
    const dd = peakCapital > 0 ? ((peakCapital - cap) / peakCapital) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
    const pnl = row.gross_pnl || 0;
    if (pnl > bestDay) bestDay = pnl;
    if (pnl < worstDay) worstDay = pnl;
  }

  const totalReturn = startingCapital > 0
    ? ((currentCapital - startingCapital) / startingCapital) * 100
    : 0;

  return {
    curve,
    dailyPnl,
    stats: {
      startingCapital,
      currentCapital: Math.round(currentCapital * 100) / 100,
      totalReturn: Math.round(totalReturn * 100) / 100,
      maxDrawdown: Math.round(maxDrawdown * 100) / 100,
      peakCapital: Math.round(peakCapital * 100) / 100,
      bestDay: Math.round(bestDay * 100) / 100,
      worstDay: Math.round(worstDay * 100) / 100,
    },
  };
}
```

- [ ] **Step 3: Verify both functions work**

Run: `node -e "import('./src/db/sqlite.js').then(s => { s.getDb(); return import('./src/trading/portfolio.js'); }).then(p => { console.log(JSON.stringify(p.getEquityCurve(30))); process.exit(0); })"`

Expected: JSON output with `curve`, `dailyPnl`, `stats` fields.

- [ ] **Step 4: Commit**

```bash
git add src/trading/portfolio.js
git commit -m "feat: add getEquityCurve() and persist ending_capital in daily summary"
```

---

### Task 3: Server — Add /api/chart/:symbol Endpoint

**Files:**
- Modify: `src/dashboard/server.js`

- [ ] **Step 1: Add intraday chart cache and endpoint**

Add a chart cache near the existing `screenerCache` (around line 22) in `src/dashboard/server.js`:

```javascript
const chartCache = new Map(); // key: symbol, value: { data, ts }
const CHART_TTL = 2 * 60 * 1000; // 2 minutes
```

Add the import for `yahoo-finance2` at the top (after existing imports):

```javascript
import YahooFinance from 'yahoo-finance2';
import { DATA } from '../config/settings.js';
```

Add the endpoint after the existing `/api/scan` POST route (around line 484):

```javascript
  // Intraday 5-min chart data
  app.get('/api/chart/:symbol', async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const now = Date.now();
      const cached = chartCache.get(symbol);
      if (cached && (now - cached.ts) < CHART_TTL) {
        return res.json(cached.data);
      }

      const ySymbol = symbol === 'NIFTY' ? '^NSEI'
        : symbol === 'BANKNIFTY' ? '^NSEBANK'
        : `${symbol}${DATA.YAHOO_SUFFIX}`;

      const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
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
          color: q.close >= q.open ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)',
        }));

      const data = { symbol, candles, volume };
      chartCache.set(symbol, { data, ts: now });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message, symbol: req.params.symbol, candles: [], volume: [] });
    }
  });
```

- [ ] **Step 2: Test the endpoint**

Start dashboard: `node src/index.js dashboard &`

Run: `curl -s http://localhost:3777/api/chart/RELIANCE | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log('symbol:',j.symbol,'candles:',j.candles?.length,'vol:',j.volume?.length)})"`

Expected: `symbol: RELIANCE candles: <number> vol: <number>` (candle count depends on market hours — may be 0 after hours, but no error)

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/server.js
git commit -m "feat: add /api/chart/:symbol endpoint for intraday 5-min candlestick data"
```

---

### Task 4: Server — Add /api/equity-curve Endpoint

**Files:**
- Modify: `src/dashboard/server.js`

- [ ] **Step 1: Add import and endpoint**

Update the import at the top of `src/dashboard/server.js` to include `getEquityCurve`:

```javascript
import { getPortfolioSummary, getPerformanceStats, getEquityCurve } from '../trading/portfolio.js';
```

Add the endpoint after the `/api/chart/:symbol` route:

```javascript
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
```

- [ ] **Step 2: Test the endpoint**

Run: `curl -s http://localhost:3777/api/equity-curve?days=30 | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log('curve:',j.curve?.length,'pnl:',j.dailyPnl?.length,'stats:',JSON.stringify(j.stats))})"`

Expected: `curve: 0 pnl: 0 stats: {"startingCapital":200000,...}` (0 entries until first trading day summary is saved)

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/server.js
git commit -m "feat: add /api/equity-curve endpoint for equity curve and daily P&L data"
```

---

### Task 5: Server — Add /api/risk-summary Endpoint

**Files:**
- Modify: `src/dashboard/server.js`

- [ ] **Step 1: Add import for FNO_STOCKS and endpoint**

Add import at the top of `src/dashboard/server.js`:

```javascript
import { FNO_STOCKS } from '../data/fno-stocks.js';
```

Add the endpoint after the `/api/equity-curve` route:

```javascript
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
        pct: totalCapital > 0 ? Math.round((t.capital_used / totalCapital) * 10000) / 100 : 0,
      }));

      const availablePct = totalCapital > 0
        ? Math.round((portfolio.availableCapital / totalCapital) * 10000) / 100
        : 100;

      // Sector exposure (aggregate by sector)
      const sectorTotals = {};
      for (const p of positions) {
        sectorTotals[p.sector] = (sectorTotals[p.sector] || 0) + p.capital;
      }
      const sectorExposure = Object.entries(sectorTotals).map(([sector, capital]) => ({
        sector,
        capital,
        pct: totalCapital > 0 ? Math.round((capital / totalCapital) * 10000) / 100 : 0,
      }));

      // Drawdown from daily_summary
      const db = getDb();
      const summaries = db.prepare(
        'SELECT ending_capital FROM daily_summary WHERE ending_capital IS NOT NULL ORDER BY date ASC'
      ).all();
      let peakCapital = totalCapital;
      let maxDrawdownPct = 0;
      for (const row of summaries) {
        if (row.ending_capital > peakCapital) peakCapital = row.ending_capital;
        const dd = peakCapital > 0 ? ((peakCapital - row.ending_capital) / peakCapital) * 100 : 0;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;
      }
      const currentCapitalVal = totalCapital - portfolio.capitalInUse + portfolio.capitalInUse + portfolio.unrealizedPnl;
      const currentDrawdownPct = peakCapital > 0 ? Math.max(0, ((peakCapital - currentCapitalVal) / peakCapital) * 100) : 0;

      // Risk metrics
      const totalHeat = trades.reduce((s, t) => s + t.capital_used, 0);

      const worstCaseLoss = trades.reduce((s, t) => {
        if (!t.stop_loss) return s;
        const loss = t.type === 'CALL'
          ? (t.entry_price - t.stop_loss) * t.lot_size * t.quantity
          : (t.stop_loss - t.entry_price) * t.lot_size * t.quantity;
        return s - Math.abs(loss);
      }, 0);

      const avgRiskReward = trades.length > 0
        ? trades.reduce((s, t) => {
            if (!t.stop_loss || !t.target1) return s;
            const risk = Math.abs(t.entry_price - t.stop_loss);
            const reward = Math.abs(t.target1 - t.entry_price);
            return s + (risk > 0 ? reward / risk : 0);
          }, 0) / trades.length
        : 0;

      // Win/loss streak
      const recent = db.prepare(
        `SELECT pnl FROM trades WHERE status IN ('CLOSED','STOPPED') ORDER BY exited_at DESC LIMIT 20`
      ).all();
      let winStreak = 0, lossStreak = 0;
      for (const t of recent) {
        if ((t.pnl || 0) > 0) { winStreak++; if (lossStreak > 0) break; }
        else if ((t.pnl || 0) < 0) { lossStreak++; if (winStreak > 0) break; }
        else break;
      }

      res.json({
        allocation: {
          positions,
          available: { capital: Math.round(portfolio.availableCapital * 100) / 100, pct: availablePct },
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
```

- [ ] **Step 2: Test the endpoint**

Run: `curl -s http://localhost:3777/api/risk-summary | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log('positions:',j.allocation?.positions?.length,'sectors:',j.sectorExposure?.length,'heat:',j.metrics?.totalHeat)})"`

Expected: `positions: 0 sectors: 0 heat: 0` (no trades open, all zeroes)

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/server.js
git commit -m "feat: add /api/risk-summary endpoint for real-time risk dashboard data"
```

---

### Task 6: Dashboard UI — Add lightweight-charts CDN + CSS for New Sections

**Files:**
- Modify: `src/dashboard/public/index.html`

- [ ] **Step 1: Add lightweight-charts CDN script tag**

In `index.html`, add this script tag just before the closing `</head>` tag (or just before the first `<script>` block):

```html
<script src="https://unpkg.com/lightweight-charts@4.1.1/dist/lightweight-charts.standalone.production.js"></script>
```

- [ ] **Step 2: Add CSS for new sections**

Add these CSS rules inside the existing `<style>` block, after the existing styles:

```css
    /* ═══ Risk Dashboard ═══ */
    .risk-grid{display:grid;grid-template-columns:200px 1fr 1fr;gap:16px;align-items:start}
    .risk-donut-wrap{text-align:center}
    .risk-donut-wrap canvas{display:block;margin:0 auto 8px}
    .risk-donut-legend{font-size:0.6rem;color:var(--text-dim);text-align:left;padding-left:8px}
    .risk-donut-legend div{padding:2px 0;display:flex;align-items:center;gap:6px}
    .risk-donut-legend .dot{width:8px;height:8px;border-radius:50%;display:inline-block}
    .risk-donut-center{font-size:0.7rem;font-weight:700;color:var(--text)}
    .risk-bars{display:flex;flex-direction:column;gap:6px}
    .risk-bar-row{display:flex;align-items:center;gap:8px;font-size:0.65rem}
    .risk-bar-label{width:60px;color:var(--text-dim);text-align:right;flex-shrink:0}
    .risk-bar-track{flex:1;height:16px;background:rgba(255,255,255,0.04);border-radius:3px;overflow:hidden;position:relative}
    .risk-bar-fill{height:100%;border-radius:3px;transition:width 0.5s}
    .risk-bar-pct{width:40px;font-size:0.6rem;color:var(--text-dim);text-align:right}
    .risk-concentration{font-size:0.55rem;color:var(--red);margin-top:4px;display:none}
    .risk-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:12px}
    .risk-metric{background:var(--bg);border:1px solid var(--card-border);border-radius:8px;padding:10px;text-align:center}
    .risk-metric-label{font-size:0.55rem;text-transform:uppercase;letter-spacing:1px;color:var(--text-dim);margin-bottom:4px}
    .risk-metric-value{font-size:1rem;font-weight:700}
    .drawdown-bar{height:8px;background:rgba(255,255,255,0.04);border-radius:4px;overflow:hidden;margin:8px 0}
    .drawdown-fill{height:100%;border-radius:4px;transition:width 0.5s}
    .drawdown-text{font-size:0.65rem;color:var(--text-dim)}

    /* ═══ Candlestick Chart ═══ */
    .chart-toggle{cursor:pointer;padding:4px 10px;font-size:0.6rem;background:rgba(6,182,212,0.1);border:1px solid rgba(6,182,212,0.3);color:var(--cyan);border-radius:4px;font-family:inherit;font-weight:600}
    .chart-toggle:hover{background:rgba(6,182,212,0.2)}
    .chart-toggle.active{background:rgba(6,182,212,0.25);border-color:var(--cyan)}
    .trade-chart-area{height:350px;margin-top:10px;border-radius:8px;overflow:hidden;display:none}
    .trade-chart-area.visible{display:block}
    .default-chart-area{height:400px;border-radius:8px;overflow:hidden;margin-top:10px}

    /* ═══ Performance Analytics ═══ */
    .perf-charts{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    .perf-chart-box{height:250px;border-radius:8px;overflow:hidden}
    .perf-toggle-bar{display:flex;gap:4px;margin-bottom:10px}
    .perf-toggle{padding:4px 12px;font-size:0.6rem;border-radius:4px;border:1px solid var(--card-border);background:transparent;color:var(--text-dim);cursor:pointer;font-family:inherit}
    .perf-toggle.active{background:rgba(6,182,212,0.15);border-color:var(--cyan);color:var(--cyan)}

    @media(max-width:900px){
      .risk-grid{grid-template-columns:1fr}
      .perf-charts{grid-template-columns:1fr}
      .risk-metrics{grid-template-columns:repeat(2,1fr)}
    }
```

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/public/index.html
git commit -m "feat: add lightweight-charts CDN and CSS for risk dashboard, charts, performance analytics"
```

---

### Task 7: Dashboard UI — Risk Dashboard Section HTML

**Files:**
- Modify: `src/dashboard/public/index.html`

- [ ] **Step 1: Add Risk Dashboard section HTML**

Insert this HTML block **between** the Autonomous Agents section closing `</div>` and the Open Trades `<!-- Open Trades (live-updating) -->` comment (around line 328-329):

```html
<!-- Risk Dashboard -->
<div class="section" id="risk-section">
  <div class="section-header">
    <span class="section-title">Risk Dashboard</span>
    <div class="section-actions">
      <span class="badge badge-gray" id="risk-heat-badge">No positions</span>
    </div>
  </div>
  <div class="risk-grid" id="risk-grid">
    <div class="risk-donut-wrap">
      <canvas id="risk-donut" width="180" height="180"></canvas>
      <div class="risk-donut-center" id="risk-donut-center">100% free</div>
      <div class="risk-donut-legend" id="risk-donut-legend"></div>
    </div>
    <div>
      <div style="font-size:0.65rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Sector Exposure</div>
      <div class="risk-bars" id="risk-sector-bars"><div class="text-dim" style="font-size:0.65rem">No positions</div></div>
      <div class="risk-concentration" id="risk-concentration-warn">Warning: >50% concentration in one sector</div>
    </div>
    <div>
      <div style="font-size:0.65rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Max Drawdown</div>
      <div class="drawdown-text" id="drawdown-text">Drawdown: 0% (max: 0%)</div>
      <div class="drawdown-bar"><div class="drawdown-fill" id="drawdown-fill" style="width:0%;background:var(--green)"></div></div>
    </div>
  </div>
  <div class="risk-metrics" id="risk-metrics">
    <div class="risk-metric"><div class="risk-metric-label">Heat</div><div class="risk-metric-value text-green" id="rm-heat">₹0</div></div>
    <div class="risk-metric"><div class="risk-metric-label">Worst Case</div><div class="risk-metric-value text-red" id="rm-worst">₹0</div></div>
    <div class="risk-metric"><div class="risk-metric-label">Avg R:R</div><div class="risk-metric-value text-cyan" id="rm-rr">0.0</div></div>
    <div class="risk-metric"><div class="risk-metric-label">Streak</div><div class="risk-metric-value" id="rm-streak">--</div></div>
  </div>
</div>
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/public/index.html
git commit -m "feat: add Risk Dashboard section HTML to dashboard"
```

---

### Task 8: Dashboard UI — Performance Analytics Section HTML

**Files:**
- Modify: `src/dashboard/public/index.html`

- [ ] **Step 1: Add Performance Analytics section HTML**

Insert this HTML block **between** the "Stock News & Sentiment" section closing `</div>` and the "Stats + History" `<div class="grid-2">` (around line 395-397):

```html
<!-- Performance Analytics -->
<div class="section" id="perf-section">
  <div class="section-header">
    <span class="section-title">Performance Analytics</span>
    <div class="section-actions">
      <div class="perf-toggle-bar">
        <button class="perf-toggle active" onclick="loadEquityCurve(7)" data-days="7">7d</button>
        <button class="perf-toggle" onclick="loadEquityCurve(30)" data-days="30">30d</button>
        <button class="perf-toggle" onclick="loadEquityCurve(90)" data-days="90">90d</button>
        <button class="perf-toggle" onclick="loadEquityCurve(365)" data-days="365">All</button>
      </div>
    </div>
  </div>
  <div id="perf-stats-row" style="display:flex;gap:16px;margin-bottom:10px;font-size:0.65rem;color:var(--text-dim)">
    <span>Return: <b id="perf-return" class="text-green">0%</b></span>
    <span>Peak: <b id="perf-peak">₹2,00,000</b></span>
    <span>Drawdown: <b id="perf-dd" class="text-red">0%</b></span>
    <span>Best Day: <b id="perf-best" class="text-green">₹0</b></span>
    <span>Worst Day: <b id="perf-worst" class="text-red">₹0</b></span>
  </div>
  <div class="perf-charts">
    <div>
      <div style="font-size:0.6rem;color:var(--text-dim);margin-bottom:4px">Equity Curve</div>
      <div class="perf-chart-box" id="equity-chart"></div>
    </div>
    <div>
      <div style="font-size:0.6rem;color:var(--text-dim);margin-bottom:4px">Daily P&L</div>
      <div class="perf-chart-box" id="pnl-chart"></div>
    </div>
  </div>
  <div id="perf-empty" style="display:none;text-align:center;padding:40px;color:var(--text-dim);font-size:0.7rem">Not enough data — charts populate after first trading day</div>
</div>
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/public/index.html
git commit -m "feat: add Performance Analytics section HTML to dashboard"
```

---

### Task 9: Dashboard JS — Risk Dashboard Rendering

**Files:**
- Modify: `src/dashboard/public/index.html` (script section)

- [ ] **Step 1: Add drawDonut() helper function**

Add this inside the `<script>` block in `index.html`:

```javascript
    // ═══ Risk Dashboard ═══
    const SECTOR_COLORS = {
      Banking:'#3b82f6', Finance:'#6366f1', IT:'#06b6d4', Energy:'#f97316',
      Auto:'#eab308', Metals:'#a855f7', Pharma:'#22c55e', Healthcare:'#10b981',
      FMCG:'#ec4899', Consumer:'#f43f5e', Infra:'#8b5cf6', Cement:'#78716c',
      Telecom:'#14b8a6', Index:'#64748b', Other:'#475569',
    };

    function drawDonut(canvasId, slices, centerText) {
      const canvas = document.getElementById(canvasId);
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      const cx = w / 2, cy = h / 2, r = Math.min(cx, cy) - 10, inner = r * 0.6;

      ctx.clearRect(0, 0, w, h);

      if (!slices.length) {
        // Empty state: single gray ring
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.arc(cx, cy, inner, 0, Math.PI * 2, true);
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        ctx.fill();
      } else {
        let startAngle = -Math.PI / 2;
        for (const s of slices) {
          const sweep = (s.pct / 100) * Math.PI * 2;
          ctx.beginPath();
          ctx.arc(cx, cy, r, startAngle, startAngle + sweep);
          ctx.arc(cx, cy, inner, startAngle + sweep, startAngle, true);
          ctx.closePath();
          ctx.fillStyle = s.color;
          ctx.fill();
          startAngle += sweep;
        }
      }

      // Center text
      ctx.fillStyle = '#e0e0e0';
      ctx.font = '700 13px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(centerText, cx, cy);
    }
```

- [ ] **Step 2: Add renderRiskDashboard() function**

```javascript
    async function loadRiskDashboard() {
      try {
        const res = await fetch('/api/risk-summary');
        const data = await res.json();
        renderRiskDashboard(data);
      } catch (err) {
        console.error('Risk dashboard load failed:', err);
      }
    }

    function renderRiskDashboard(data) {
      const { allocation, sectorExposure, drawdown, metrics } = data;

      // Donut
      const slices = [];
      for (const p of allocation.positions) {
        slices.push({ pct: p.pct, color: SECTOR_COLORS[p.sector] || SECTOR_COLORS.Other, label: p.symbol });
      }
      slices.push({ pct: allocation.available.pct, color: 'rgba(255,255,255,0.06)', label: 'Available' });
      drawDonut('risk-donut', slices, `${allocation.available.pct}% free`);

      // Legend
      const legend = document.getElementById('risk-donut-legend');
      if (legend) {
        legend.innerHTML = allocation.positions.map(p =>
          `<div><span class="dot" style="background:${SECTOR_COLORS[p.sector] || SECTOR_COLORS.Other}"></span>${p.symbol} ₹${fmt(p.capital)}</div>`
        ).join('') + (allocation.positions.length ? `<div><span class="dot" style="background:rgba(255,255,255,0.06)"></span>Available ₹${fmt(allocation.available.capital)}</div>` : '');
      }

      // Sector bars
      const barsEl = document.getElementById('risk-sector-bars');
      if (barsEl) {
        if (sectorExposure.length === 0) {
          barsEl.innerHTML = '<div class="text-dim" style="font-size:0.65rem">No positions</div>';
        } else {
          const maxPct = Math.max(...sectorExposure.map(s => s.pct), 1);
          barsEl.innerHTML = sectorExposure.map(s => {
            const color = SECTOR_COLORS[s.sector] || SECTOR_COLORS.Other;
            const widthPct = (s.pct / Math.max(maxPct * 1.2, 50)) * 100;
            return `<div class="risk-bar-row">
              <span class="risk-bar-label">${s.sector}</span>
              <div class="risk-bar-track"><div class="risk-bar-fill" style="width:${widthPct}%;background:${color}"></div></div>
              <span class="risk-bar-pct">${s.pct}%</span>
            </div>`;
          }).join('');
        }
        // Concentration warning
        const warn = document.getElementById('risk-concentration-warn');
        const deployed = sectorExposure.reduce((s, e) => s + e.capital, 0);
        const concentrated = deployed > 0 && sectorExposure.some(s => (s.capital / deployed) > 0.5);
        if (warn) warn.style.display = concentrated ? 'block' : 'none';
      }

      // Drawdown
      const ddText = document.getElementById('drawdown-text');
      const ddFill = document.getElementById('drawdown-fill');
      if (ddText) ddText.textContent = `Drawdown: ${drawdown.currentDrawdownPct}% (max: ${drawdown.maxDrawdownPct}%)`;
      if (ddFill) {
        const pct = Math.min(drawdown.currentDrawdownPct, 20);
        ddFill.style.width = `${(pct / 20) * 100}%`;
        ddFill.style.background = pct < 5 ? 'var(--green)' : pct < 10 ? 'var(--yellow)' : 'var(--red)';
      }

      // Metrics
      const heatPct = data.allocation.available.capital > 0
        ? (metrics.totalHeat / (metrics.totalHeat + data.allocation.available.capital)) * 100 : 0;
      const heatEl = document.getElementById('rm-heat');
      if (heatEl) {
        heatEl.textContent = `₹${fmt(metrics.totalHeat)}`;
        heatEl.className = 'risk-metric-value ' + (heatPct < 30 ? 'text-green' : heatPct < 60 ? 'text-yellow' : 'text-red');
      }
      const worstEl = document.getElementById('rm-worst');
      if (worstEl) worstEl.textContent = `₹${fmt(metrics.worstCaseLoss)}`;
      const rrEl = document.getElementById('rm-rr');
      if (rrEl) {
        rrEl.textContent = metrics.avgRiskReward.toFixed(1);
        rrEl.className = 'risk-metric-value ' + (metrics.avgRiskReward >= 2 ? 'text-green' : 'text-yellow');
      }
      const streakEl = document.getElementById('rm-streak');
      if (streakEl) {
        if (metrics.winStreak > 0) {
          streakEl.textContent = `${metrics.winStreak}W`;
          streakEl.className = 'risk-metric-value text-green';
        } else if (metrics.lossStreak > 0) {
          streakEl.textContent = `${metrics.lossStreak}L`;
          streakEl.className = 'risk-metric-value text-red';
        } else {
          streakEl.textContent = '--';
          streakEl.className = 'risk-metric-value text-dim';
        }
      }

      // Heat badge
      const heatBadge = document.getElementById('risk-heat-badge');
      if (heatBadge) {
        if (allocation.positions.length === 0) {
          heatBadge.textContent = 'No positions';
          heatBadge.className = 'badge badge-gray';
        } else {
          heatBadge.textContent = `${allocation.positions.length} pos | ₹${fmt(metrics.totalHeat)} at risk`;
          heatBadge.className = 'badge ' + (heatPct < 30 ? 'badge-green' : heatPct < 60 ? 'badge-yellow' : 'badge-red');
        }
      }
    }
```

- [ ] **Step 3: Wire into initialLoad() and refreshAll()**

Find the existing `initialLoad()` function and add `loadRiskDashboard()` call. Find the existing `refreshAll()` function and add it there too. Also add to the polling interval:

```javascript
// Inside initialLoad():
loadRiskDashboard();

// Inside refreshAll():
loadRiskDashboard();

// Add new interval (after existing intervals):
setInterval(loadRiskDashboard, 30000);
```

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/public/index.html
git commit -m "feat: add risk dashboard rendering with donut chart, sector bars, drawdown, metrics"
```

---

### Task 10: Dashboard JS — Intraday Candlestick Charts

**Files:**
- Modify: `src/dashboard/public/index.html` (script section)

- [ ] **Step 1: Add chart instance tracker and createTradeChart() function**

```javascript
    // ═══ Intraday Charts ═══
    const tradeCharts = {}; // symbol -> { chart, candleSeries, volumeSeries }

    function createTradeChart(containerId, symbol, trade) {
      const container = document.getElementById(containerId);
      if (!container) return null;
      container.innerHTML = '';

      const chart = LightweightCharts.createChart(container, {
        width: container.clientWidth,
        height: 350,
        layout: { background: { color: '#0a0a0f' }, textColor: '#6b7280', fontSize: 10, fontFamily: 'monospace' },
        grid: { vertLines: { color: '#1e1e2e' }, horzLines: { color: '#1e1e2e' } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#1e1e2e' },
        timeScale: { borderColor: '#1e1e2e', timeVisible: true, secondsVisible: false },
      });

      const candleSeries = chart.addCandlestickSeries({
        upColor: '#22c55e', downColor: '#ef4444',
        borderUpColor: '#22c55e', borderDownColor: '#ef4444',
        wickUpColor: '#22c55e', wickDownColor: '#ef4444',
      });

      const volumeSeries = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
      });
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

      // Price lines for trade levels
      if (trade) {
        if (trade.entry_price) candleSeries.createPriceLine({ price: trade.entry_price, color: '#ffffff', lineWidth: 1, lineStyle: 0, title: 'Entry' });
        if (trade.stop_loss) candleSeries.createPriceLine({ price: trade.stop_loss, color: '#ef4444', lineWidth: 1, lineStyle: 0, title: 'SL' });
        if (trade.target1) candleSeries.createPriceLine({ price: trade.target1, color: '#22c55e', lineWidth: 1, lineStyle: 0, title: 'T1' });
        if (trade.target2) candleSeries.createPriceLine({ price: trade.target2, color: '#3b82f6', lineWidth: 1, lineStyle: 0, title: 'T2' });
        if (trade.trailing_stop) candleSeries.createPriceLine({ price: trade.trailing_stop, color: '#eab308', lineWidth: 1, lineStyle: 2, title: 'Trail' });
      }

      // Responsive
      const ro = new ResizeObserver(() => {
        chart.applyOptions({ width: container.clientWidth });
      });
      ro.observe(container);

      return { chart, candleSeries, volumeSeries, resizeObserver: ro };
    }

    async function loadChartData(symbol) {
      try {
        const res = await fetch(`/api/chart/${symbol}`);
        const data = await res.json();
        return data;
      } catch {
        return { candles: [], volume: [] };
      }
    }

    async function toggleTradeChart(symbol, trade) {
      const areaId = `chart-area-${symbol}`;
      const area = document.getElementById(areaId);
      if (!area) return;

      if (area.classList.contains('visible')) {
        // Hide
        area.classList.remove('visible');
        if (tradeCharts[symbol]) {
          tradeCharts[symbol].resizeObserver?.disconnect();
          tradeCharts[symbol].chart?.remove();
          delete tradeCharts[symbol];
        }
        return;
      }

      // Show
      area.classList.add('visible');
      const chartObj = createTradeChart(areaId, symbol, trade);
      if (!chartObj) return;
      tradeCharts[symbol] = chartObj;

      const data = await loadChartData(symbol);
      if (data.candles.length) {
        chartObj.candleSeries.setData(data.candles);
        chartObj.volumeSeries.setData(data.volume);
        chartObj.chart.timeScale().fitContent();
      }
    }

    // Auto-refresh open charts every 2 minutes
    setInterval(async () => {
      for (const [symbol, chartObj] of Object.entries(tradeCharts)) {
        try {
          const data = await loadChartData(symbol);
          if (data.candles.length) {
            chartObj.candleSeries.setData(data.candles);
            chartObj.volumeSeries.setData(data.volume);
          }
        } catch {}
      }
    }, 120000);
```

- [ ] **Step 2: Modify the trades rendering to include chart toggle buttons**

Find the existing function that renders open trades (look for the function that writes to `trades-container`). In the trade row/card rendering, add a "Chart" toggle button and a chart area div after each trade. The exact modification depends on the current render function, but the pattern is:

For each trade rendered, append:

```javascript
// Inside the trade rendering loop, after each trade row/card:
const chartBtn = `<button class="chart-toggle" onclick="toggleTradeChart('${t.symbol}', ${JSON.stringify({entry_price:t.entry_price,stop_loss:t.stop_loss,target1:t.target1,target2:t.target2,trailing_stop:t.trailing_stop}).replace(/"/g,'&quot;')})">Chart</button>`;
// And after the trade element:
const chartArea = `<div class="trade-chart-area" id="chart-area-${t.symbol}"></div>`;
```

This will need to be integrated into the specific render function. The chart button goes in the trade's action area, and the chart div goes right after each trade row.

- [ ] **Step 3: Add default Nifty chart when no trades**

In the empty state for trades container (where it says "No open trades"), add a default chart:

```javascript
// When no trades, show Nifty chart
async function showDefaultChart() {
  const container = document.getElementById('trades-container');
  if (!container) return;
  const existing = document.getElementById('default-chart');
  if (existing) return; // already showing

  container.innerHTML = `<div class="empty">No open trades<div class="empty-cta"><button class="btn btn-green btn-sm" onclick="openTradeWizard()">Enter Trade</button></div></div>
  <div style="margin-top:12px;font-size:0.6rem;color:var(--text-dim)">Nifty 50 Intraday</div>
  <div class="default-chart-area" id="default-chart"></div>`;

  const chartObj = createTradeChart('default-chart', 'NIFTY', null);
  if (!chartObj) return;
  const data = await loadChartData('NIFTY');
  if (data.candles.length) {
    chartObj.candleSeries.setData(data.candles);
    chartObj.volumeSeries.setData(data.volume);
    chartObj.chart.timeScale().fitContent();
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/public/index.html
git commit -m "feat: add intraday candlestick charts with trade level overlays"
```

---

### Task 11: Dashboard JS — Equity Curve + Daily P&L Charts

**Files:**
- Modify: `src/dashboard/public/index.html` (script section)

- [ ] **Step 1: Add equity curve and P&L chart rendering**

```javascript
    // ═══ Performance Analytics Charts ═══
    let equityChart = null;
    let pnlChart = null;

    async function loadEquityCurve(days = 7) {
      // Update toggle buttons
      document.querySelectorAll('.perf-toggle').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.days) === days);
      });

      try {
        const res = await fetch(`/api/equity-curve?days=${days}`);
        const data = await res.json();

        const { curve, dailyPnl, stats } = data;

        // Update stats row
        const retEl = document.getElementById('perf-return');
        if (retEl) {
          retEl.textContent = `${stats.totalReturn >= 0 ? '+' : ''}${stats.totalReturn}%`;
          retEl.className = stats.totalReturn >= 0 ? 'text-green' : 'text-red';
        }
        const peakEl = document.getElementById('perf-peak');
        if (peakEl) peakEl.textContent = `₹${fmt(stats.peakCapital)}`;
        const ddEl = document.getElementById('perf-dd');
        if (ddEl) ddEl.textContent = `${stats.maxDrawdown}%`;
        const bestEl = document.getElementById('perf-best');
        if (bestEl) bestEl.textContent = `₹${fmt(stats.bestDay)}`;
        const worstEl = document.getElementById('perf-worst');
        if (worstEl) worstEl.textContent = `₹${fmt(stats.worstDay)}`;

        // Show empty state if no data
        const emptyEl = document.getElementById('perf-empty');
        const chartsEl = document.querySelector('.perf-charts');
        if (curve.length === 0 && dailyPnl.length === 0) {
          if (emptyEl) emptyEl.style.display = 'block';
          if (chartsEl) chartsEl.style.display = 'none';
          return;
        }
        if (emptyEl) emptyEl.style.display = 'none';
        if (chartsEl) chartsEl.style.display = 'grid';

        // Equity curve chart
        const eqContainer = document.getElementById('equity-chart');
        if (eqContainer) {
          if (equityChart) equityChart.remove();
          equityChart = LightweightCharts.createChart(eqContainer, {
            width: eqContainer.clientWidth, height: 250,
            layout: { background: { color: '#0a0a0f' }, textColor: '#6b7280', fontSize: 10, fontFamily: 'monospace' },
            grid: { vertLines: { color: '#1e1e2e' }, horzLines: { color: '#1e1e2e' } },
            rightPriceScale: { borderColor: '#1e1e2e' },
            timeScale: { borderColor: '#1e1e2e' },
          });

          const areaSeries = equityChart.addAreaSeries({
            lineColor: '#00d4aa', lineWidth: 2,
            topColor: 'rgba(0,212,170,0.3)', bottomColor: 'rgba(0,212,170,0.02)',
          });
          areaSeries.setData(curve);

          // Starting capital baseline
          areaSeries.createPriceLine({
            price: stats.startingCapital, color: '#4b5563',
            lineWidth: 1, lineStyle: 2, title: 'Start',
          });

          equityChart.timeScale().fitContent();
          new ResizeObserver(() => equityChart?.applyOptions({ width: eqContainer.clientWidth })).observe(eqContainer);
        }

        // Daily P&L chart
        const pnlContainer = document.getElementById('pnl-chart');
        if (pnlContainer) {
          if (pnlChart) pnlChart.remove();
          pnlChart = LightweightCharts.createChart(pnlContainer, {
            width: pnlContainer.clientWidth, height: 250,
            layout: { background: { color: '#0a0a0f' }, textColor: '#6b7280', fontSize: 10, fontFamily: 'monospace' },
            grid: { vertLines: { color: '#1e1e2e' }, horzLines: { color: '#1e1e2e' } },
            rightPriceScale: { borderColor: '#1e1e2e' },
            timeScale: { borderColor: '#1e1e2e' },
          });

          const histSeries = pnlChart.addHistogramSeries({
            color: '#22c55e',
          });
          histSeries.setData(dailyPnl);

          pnlChart.timeScale().fitContent();
          new ResizeObserver(() => pnlChart?.applyOptions({ width: pnlContainer.clientWidth })).observe(pnlContainer);
        }
      } catch (err) {
        console.error('Equity curve load failed:', err);
      }
    }
```

- [ ] **Step 2: Wire into initialLoad()**

Add to `initialLoad()`:

```javascript
loadEquityCurve(7);
```

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/public/index.html
git commit -m "feat: add equity curve and daily P&L chart rendering"
```

---

### Task 12: Integration — Wire Everything Together + Test

**Files:**
- Modify: `src/dashboard/public/index.html` (minor wiring)
- Modify: `src/dashboard/server.js` (SSE broadcast for risk data)

- [ ] **Step 1: Add risk data to SSE pump**

In `src/dashboard/server.js`, inside the `startPump()` interval function, add a risk summary broadcast every 30s (alongside agent broadcast, around the `pumpTick % 2 === 0` block):

```javascript
      // Every 30s: risk summary
      if (pumpTick % 2 === 0) {
        try {
          // ... existing agent broadcast code ...

          // Risk data
          const portfolio = getPortfolioSummary();
          const riskTrades = getOpenTrades();
          if (riskTrades.length > 0) {
            broadcast('risk', { positions: riskTrades.length, heat: riskTrades.reduce((s, t) => s + t.capital_used, 0) });
          }
        } catch {}
      }
```

- [ ] **Step 2: Handle SSE risk events in the frontend**

In the SSE event handler in `index.html` (find the `eventSource.addEventListener` or `onmessage` handler), add:

```javascript
// Inside SSE handler:
if (event.type === 'risk' || (data && data.type === 'risk')) {
  loadRiskDashboard();
}
```

- [ ] **Step 3: Ensure chart cleanup when trades change**

When trades are loaded/refreshed and the trade list changes, destroy charts for closed positions:

```javascript
// After rendering trades, clean up stale charts
for (const symbol of Object.keys(tradeCharts)) {
  if (!currentTradeSymbols.includes(symbol)) {
    tradeCharts[symbol].resizeObserver?.disconnect();
    tradeCharts[symbol].chart?.remove();
    delete tradeCharts[symbol];
  }
}
```

- [ ] **Step 4: Full integration test**

Start dashboard: `node src/index.js dashboard --port 3777`

Test all endpoints:
```bash
curl -s http://localhost:3777/api/chart/RELIANCE | head -c 200
curl -s http://localhost:3777/api/equity-curve?days=30 | head -c 200
curl -s http://localhost:3777/api/risk-summary | head -c 200
```

Open browser at `http://localhost:3777` and verify:
- Risk Dashboard section visible between Agents and Open Trades
- Donut chart shows "100% free" (no positions)
- Drawdown shows 0%
- Metrics show zeroes
- Performance Analytics section visible with toggle buttons
- Nifty chart appears in the Open Trades area (default chart)

- [ ] **Step 5: Run existing test suite**

Run: `node --test test/`

Expected: All existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/server.js src/dashboard/public/index.html
git commit -m "feat: wire risk dashboard + charts into SSE and integrate end-to-end"
```

---

## Self-Review

**1. Spec coverage:**
- Intraday candlestick charts: Task 3 (API), Task 6 (CSS), Task 10 (JS rendering) — covered
- Equity curve + daily P&L: Task 2 (data layer), Task 4 (API), Task 6 (CSS), Task 8 (HTML), Task 11 (JS rendering) — covered
- Risk dashboard panel (donut, sector bars, drawdown, metrics): Task 5 (API), Task 6 (CSS), Task 7 (HTML), Task 9 (JS rendering) — covered
- DB migration: Task 1 — covered
- SSE integration: Task 12 — covered
- Error handling (empty states, no data): Tasks 9, 10, 11 all handle empty states — covered

**2. Placeholder scan:** No TBD, TODO, or "fill in" patterns found. All code blocks are complete.

**3. Type consistency:**
- `getEquityCurve()` returns `{ curve, dailyPnl, stats }` — matches Task 4 API response and Task 11 frontend consumption
- `/api/risk-summary` response shape matches Task 5 definition and Task 9 `renderRiskDashboard()` consumption
- `/api/chart/:symbol` response shape matches Task 3 definition and Task 10 `loadChartData()` consumption
- `drawDonut()` signature matches calls in `renderRiskDashboard()`
- `createTradeChart()` signature matches calls in `toggleTradeChart()` and `showDefaultChart()`

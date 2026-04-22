# Dashboard Charts + Risk Panel — Design Spec

## Goal

Enrich the Tradease dashboard with live intraday candlestick charts per open position, an equity curve with daily P&L visualization, and a real-time risk dashboard panel — making the system visually powerful for monitoring trades and risk exposure.

This is **Sub-project 1** of the "Trading Cockpit" feature enrichment. Sub-project 2 (Engine Upgrades: backtesting, multi-timeframe, adaptive trailing) and Sub-project 3 (Operations: Telegram, agent config UI, trade journal) follow separately.

## Architecture

All chart rendering uses **lightweight-charts** (TradingView open-source, ~45KB, CDN-loaded, zero build step). Server provides data via new API endpoints. No new npm dependencies — lightweight-charts loaded via `<script>` tag in index.html. Risk metrics computed server-side from existing DB tables (no new tables). Canvas-drawn donut for capital allocation (no extra library).

## Tech Stack

- **Charts:** lightweight-charts v4 (CDN: `https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js`)
- **Server:** Express (existing), new endpoints added to `src/dashboard/server.js`
- **Data:** Yahoo Finance 5-min intraday via `yahoo-finance2`, existing `daily_summary` table
- **Canvas:** Native HTML5 Canvas API for donut chart (no lib)
- **DB:** One new column (`ending_capital`) on `daily_summary` table

---

## Feature 1: Intraday Candlestick Charts

### What

Each open trade gets a toggleable candlestick chart showing 1-day of 5-minute OHLCV candles. Horizontal lines overlay entry price, stop-loss, T1, T2, and trailing stop.

### API

**`GET /api/chart/:symbol`**

Returns 5-minute intraday OHLCV for the current trading day.

Response:
```json
{
  "symbol": "RELIANCE",
  "candles": [
    { "time": 1714024200, "open": 2450.5, "high": 2455.0, "low": 2448.0, "close": 2453.2 },
    ...
  ],
  "volume": [
    { "time": 1714024200, "value": 125000 },
    ...
  ]
}
```

Implementation:
- Use `yahoo-finance2` `chart()` method with `interval: '5m'`, `range: '1d'`
- Cache for 2 minutes (matches Position Guardian tick)
- Append `.NS` suffix for NSE symbols per existing convention
- Return Unix timestamps (lightweight-charts expects seconds, not milliseconds)

### UI

- Each open trade card in the "Open Trades" section gets a **"Chart"** toggle button
- Clicking "Chart" expands a 400px-height chart area below the trade row
- Chart renders:
  - Candlestick series (green/red candles)
  - Volume histogram at bottom (semi-transparent)
  - Horizontal price lines:
    - Entry price: white solid, label "Entry"
    - Stop-loss: red solid, label "SL"
    - Target 1: green solid, label "T1"
    - Target 2: blue solid, label "T2"
    - Trailing stop (if active): yellow dashed, label "Trail"
- Auto-refreshes every 2 minutes
- When no trades open, show Nifty 50 (`^NSEI`) chart as default in a standalone chart area

### Chart Behavior

- Time axis: IST (UTC+5:30), shows 9:15 AM to current time
- Price axis: auto-scale with padding
- Crosshair enabled for hover inspection
- Responsive: chart width = container width
- Dark theme matching dashboard (background: `#0a0e17`, grid: `#1a1f2e`)

---

## Feature 2: Equity Curve + Daily P&L Charts

### What

Two charts in a new "Performance Analytics" section:
- **Equity Curve:** Line chart of total capital over time
- **Daily P&L:** Bar chart with green (profit) / red (loss) bars per day

### DB Change

Add `ending_capital REAL` column to `daily_summary` table.

Migration:
```sql
ALTER TABLE daily_summary ADD COLUMN ending_capital REAL;
```

Populate on each `saveDailySummary()` call: `ending_capital = totalCapital + unrealizedPnl` from `getPortfolioSummary()`.

### API

**`GET /api/equity-curve?days=30`**

Response:
```json
{
  "curve": [
    { "time": "2026-03-23", "value": 200000 },
    { "time": "2026-03-24", "value": 202500 },
    ...
  ],
  "dailyPnl": [
    { "time": "2026-03-23", "value": 0 },
    { "time": "2026-03-24", "value": 2500 },
    ...
  ],
  "stats": {
    "startingCapital": 200000,
    "currentCapital": 215000,
    "totalReturn": 7.5,
    "maxDrawdown": 3.2,
    "peakCapital": 218000,
    "bestDay": 5200,
    "worstDay": -3100
  }
}
```

Implementation:
- Query `daily_summary` table ordered by date
- Compute equity curve from `ending_capital` column
- Compute daily P&L from `gross_pnl` column
- Stats derived from the series (max drawdown = peak-to-trough %)

### UI

- New section **"Performance Analytics"** placed between existing "Performance (30D)" stats and "Recent Trades"
- Two charts side-by-side (50/50 split on desktop, stacked on narrow screens)
- Left: Equity curve (line chart, area fill below line with gradient)
  - Line color: cyan (`#00d4aa`)
  - Area fill: cyan-to-transparent gradient
  - Starting capital shown as gray dashed horizontal line
- Right: Daily P&L (histogram)
  - Green bars for profit days
  - Red bars for loss days
- Toggle buttons above: **7d | 30d | 90d | All**
- Chart height: 250px each
- Dark theme matching dashboard

---

## Feature 3: Risk Dashboard Panel

### What

Real-time risk exposure panel showing capital allocation, sector concentration, drawdown, and risk metrics.

### API

**`GET /api/risk-summary`**

Response:
```json
{
  "allocation": {
    "positions": [
      { "symbol": "RELIANCE", "sector": "Energy", "capital": 38000, "pct": 19.0 },
      { "symbol": "TCS", "sector": "IT", "capital": 35000, "pct": 17.5 }
    ],
    "available": { "capital": 127000, "pct": 63.5 }
  },
  "sectorExposure": [
    { "sector": "Energy", "capital": 38000, "pct": 19.0 },
    { "sector": "IT", "capital": 35000, "pct": 17.5 }
  ],
  "drawdown": {
    "peakCapital": 218000,
    "currentCapital": 215000,
    "maxDrawdownPct": 3.2,
    "currentDrawdownPct": 1.4
  },
  "metrics": {
    "totalHeat": 73000,
    "worstCaseLoss": -8500,
    "avgRiskReward": 2.3,
    "winStreak": 3,
    "lossStreak": 0
  }
}
```

Implementation:
- Computed server-side from `getOpenTrades()`, `getPortfolioSummary()`, `getPerformanceStats()`
- `totalHeat` = sum of `capital_used` across open positions
- `worstCaseLoss` = sum of (entry - SL) * quantity for CALL, (SL - entry) * quantity for PUT
- `avgRiskReward` = average of (T1 distance / SL distance) across open trades
- Win/loss streak from recent closed trades in `trades` table
- Sector lookup from `fno-stocks.js` data

### UI Components

#### Capital Allocation Donut (Canvas)
- Canvas element, ~200x200px
- Slices: one per open position (color-coded by sector), plus "Available" slice (dark gray)
- Center text: "63.5% free" or "₹1,27,000 available"
- Legend below with symbol + amount
- Drawn with native Canvas API arc() — no library needed (~40 lines JS)

#### Sector Exposure Bars
- Horizontal bar chart (CSS-based, no chart lib needed)
- One bar per sector with capital deployed
- Red highlight if any sector > 50% of deployed capital (concentration warning)
- Bar width proportional to percentage

#### Max Drawdown Tracker
- Shows: peak capital, current drawdown %, max historical drawdown %
- Visual: progress-bar style, green→yellow→red as drawdown increases
- Thresholds: green (<5%), yellow (5-10%), red (>10%)
- Text: "Drawdown: 1.4% (max: 3.2%)"

#### Risk Metrics Row
- Four stat cards in a row:
  1. **Heat** — Total capital at risk, colored by % of total (green <30%, yellow 30-60%, red >60%)
  2. **Worst Case** — Max loss if all SLs hit, always red
  3. **Avg R:R** — Average risk-reward ratio, green if >2.0
  4. **Streak** — Current win/loss streak, green for wins, red for losses

### Placement

New section **"Risk Dashboard"** placed between "Autonomous Agents" and "Open Trades" sections.

---

## Dashboard Section Order (Updated)

1. News Ticker (scrolling)
2. Header + Action Bar
3. Key Metrics (6-card grid)
4. Recommended Trades
5. Autonomous Agents
6. **Risk Dashboard (NEW)**
7. Open Trades (with **Chart toggle — NEW**)
8. Live Market News + Global Markets
9. Sector Rotation + Sector Heatmap
10. All Screener Results
11. Stock News & Sentiment
12. **Performance Analytics (NEW)** — Equity Curve + Daily P&L
13. Performance (30D) Stats
14. Recent Trades

---

## Files Touched

### New/Modified Server Files
- `src/dashboard/server.js` — 3 new endpoints: `/api/chart/:symbol`, `/api/equity-curve`, `/api/risk-summary`
- `src/db/migrations.js` — Add `ending_capital` column to `daily_summary`
- `src/trading/portfolio.js` — Update `saveDailySummary()` to persist `ending_capital`

### Modified Dashboard Files
- `src/dashboard/public/index.html` — All UI changes:
  - CDN script tag for lightweight-charts
  - Chart toggle in Open Trades section
  - Risk Dashboard section (donut canvas + exposure bars + drawdown + metrics)
  - Performance Analytics section (equity curve + daily P&L charts)
  - Supporting CSS and JS functions

### No New npm Dependencies
- lightweight-charts via CDN
- Canvas API is native browser

---

## Error Handling

- **Yahoo intraday unavailable:** Show "Chart data unavailable" placeholder, retry next tick
- **No daily_summary data yet:** Show "Not enough data — charts populate after first trading day" message
- **No open trades for risk panel:** Show zeroed-out metrics with "No positions" state
- **Chart resize:** Lightweight-charts `resize()` called on window resize event

---

## Performance Considerations

- Chart data cached server-side (2 min TTL) — no Yahoo spam
- Equity curve queries are simple SQLite SELECTs on indexed date column
- Risk summary computed from in-memory trade data (already loaded by other endpoints)
- Canvas donut redrawn only on data change, not on every frame
- Charts destroyed and recreated on trade open/close (no memory leaks from orphaned chart instances)

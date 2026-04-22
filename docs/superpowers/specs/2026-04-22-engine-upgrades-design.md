# Engine Upgrades — Design Spec

## Goal

Upgrade Tradease's trading engine with a backtesting simulator, multi-timeframe confluence analysis, and adaptive trailing stops — making the system smarter at entry timing, exit management, and strategy validation.

This is **Sub-project 2** of the "Trading Cockpit" feature enrichment. Sub-project 1 (Dashboard Charts + Risk Panel) is complete. Sub-project 3 (Operations: Telegram, agent config UI, trade journal) follows separately.

## Architecture

All upgrades build on existing pure functions in `risk.js` and `technicals.js`. Multi-timeframe extends `market.js` with intraday interval support. Backtesting replays historical bars through existing risk/exit logic — no separate simulation engine. Adaptive trailing modifies the existing `calculateTrailingStop()` to accept momentum context. No new npm dependencies. No new DB tables (backtesting results stored as JSON files).

## Tech Stack

- **Data:** Yahoo Finance `chart()` with `interval` param (already used for 1d, extending to 5m/15m/1h)
- **Analysis:** Existing `technicalindicators` npm package (RSI, MACD, BB, etc.)
- **Backtesting:** Pure JS simulation loop using existing risk functions
- **Storage:** JSON files in `data/backtests/` for results (no DB bloat)
- **Config:** Existing `src/config/settings.js` extended with new constants

---

## Feature 1: Multi-Timeframe Data Layer

### What

Extend `market.js` to fetch intraday OHLCV at 5-minute, 15-minute, and 1-hour intervals. Currently only `1d` is supported.

### API Change

New exported function in `src/data/market.js`:

```javascript
export async function getIntradayData(symbol, interval = '15m', range = '5d')
```

**Parameters:**
- `symbol` — NSE stock symbol (e.g., `'RELIANCE'`)
- `interval` — `'5m'` | `'15m'` | `'1h'`
- `range` — `'1d'` | `'5d'` | `'1mo'` (Yahoo range strings)

**Returns:** Same `{ date, open, high, low, close, volume }[]` shape as `getHistorical()`.

**Implementation:**
- Uses `yahoo-finance2` `chart()` method (same as `getHistorical()`, different `interval` param)
- Cache key includes interval + range: `intra:${symbol}:${interval}:${range}`
- Cache TTL: 2 minutes for 5m/15m, 10 minutes for 1h (matches dashboard chart cache)
- Appends `.NS` suffix via existing `ySymbol()` helper

### Constraints

- Yahoo limits intraday data: 5m = max 60 days, 15m = max 60 days, 1h = max 2 years
- For backtesting, daily data remains primary (better Yahoo availability for long periods)
- Intraday used for real-time confluence scoring, not backtesting

---

## Feature 2: Multi-Timeframe Confluence Analysis

### What

Score trade candidates by checking if signals align across multiple timeframes. When daily + hourly + 15-minute technicals all agree on direction, confluence is high → stronger entry signal.

### New File

`src/analysis/confluence.js`

### How It Works

For a given symbol, run `analyzeTechnicals()` on three timeframes:
1. **Daily** (existing `getHistorical()`, 90 days)
2. **Hourly** (new `getIntradayData()`, `'1h'`, `'1mo'`)
3. **15-minute** (new `getIntradayData()`, `'15m'`, `'5d'`)

Each timeframe produces `overallSignal` (STRONG_BUY/BUY/NEUTRAL/SELL/STRONG_SELL) and `score` (0-100).

### Confluence Score Algorithm

```
confluenceScore = 0

For each timeframe [daily, hourly, 15m] with weights [0.5, 0.3, 0.2]:
  if signal aligns with trade direction (CALL→BUY/STRONG_BUY, PUT→SELL/STRONG_SELL):
    confluenceScore += weight * 100
  if signal is NEUTRAL:
    confluenceScore += weight * 40
  if signal opposes trade direction:
    confluenceScore += 0

Bonus: if ALL three timeframes agree → +15
Penalty: if daily opposes while lower timeframes agree → -20
```

Result: 0-115 score, normalized to 0-100.

### Exported Function

```javascript
export async function computeConfluence(symbol, direction)
// Returns: {
//   score: number (0-100),
//   breakdown: { daily: { signal, score }, hourly: { signal, score }, fifteenMin: { signal, score } },
//   allAligned: boolean,
//   dailyOpposed: boolean,
// }
```

### Integration with Screener

Modify `src/analysis/screener.js` `computeScreenerScore()`:
- Add new weight: `confluenceScore 10%` (taken from existing weights — reduce `technicalScore` from 22% to 17%, `momentumScore` from 13% to 8%)
- Only compute confluence for top 30 candidates (performance — avoid 180+ intraday API calls for all F&O stocks)
- Flow: screen all stocks → take top 30 by preliminary score → add confluence for top 30 → re-rank → return top 15

### Integration with Trade Strategist

Modify `src/agents/trade-strategist.js`:
- Add confluence check before entry: if `confluenceScore < 40`, skip even if screener score ≥ 70
- If `confluenceScore ≥ 70`, lower auto-entry threshold from 70 to 65 (high confluence = more confident with lower base score)
- Log confluence score in entry reason string

---

## Feature 3: Adaptive Trailing Stops

### What

Replace static `ATR * 0.5` trailing stop with momentum-aware trailing that widens in strong trends (let profits run) and tightens when momentum fades (protect gains).

### Current Behavior

```javascript
// risk.js line 102
return Math.round((currentPrice - atr * TRAILING_STOP_ATR) * 100) / 100;
// TRAILING_STOP_ATR = 0.5 (always)
```

### New Behavior

Trailing stop multiplier adjusts based on momentum strength:

| Momentum State | ATR Multiplier | Rationale |
|---|---|---|
| Strong trend (RSI 40-60 + MACD expanding) | 1.0 × ATR | Wide trail — let runner run |
| Normal trend (MACD bullish but not expanding) | 0.7 × ATR | Standard trail |
| Weakening (RSI diverging, MACD contracting) | 0.4 × ATR | Tight trail — protect gains |
| Exhaustion (RSI >75 for CALL, <25 for PUT) | 0.3 × ATR | Very tight — exit imminent |

### API Change

Modify `calculateTrailingStop()` signature in `src/trading/risk.js`:

```javascript
export function calculateTrailingStop(entryPrice, currentPrice, atr, type, momentum = null)
```

New optional `momentum` parameter:
```javascript
// momentum = { rsi: number, macdHistogram: number, macdPrevHistogram: number }
// If null, falls back to static TRAILING_STOP_ATR (backward compatible)
```

### New Helper

Add `computeMomentumMultiplier(momentum, type)` to `risk.js`:

```javascript
function computeMomentumMultiplier(momentum, type) {
  if (!momentum) return TRAILING_STOP_ATR; // fallback: 0.5

  const { rsi, macdHistogram, macdPrevHistogram } = momentum;
  const macdExpanding = Math.abs(macdHistogram) > Math.abs(macdPrevHistogram);
  const macdDirection = type === 'CALL' ? macdHistogram > 0 : macdHistogram < 0;

  // Exhaustion
  if (type === 'CALL' && rsi > 75) return 0.3;
  if (type === 'PUT' && rsi < 25) return 0.3;

  // Strong trend
  if (macdExpanding && macdDirection && rsi > 40 && rsi < 60) return 1.0;

  // Normal trend
  if (macdDirection) return 0.7;

  // Weakening
  return 0.4;
}
```

### Integration with Position Guardian

Modify `src/agents/position-guardian.js` `_manageTrade()`:
- After fetching historical data and computing ATR, also compute RSI and MACD histogram
- Pass momentum context to `calculateTrailingStop()` calls
- Log momentum state in agent log

### Config

Add to `src/config/settings.js` `TRADING`:
```javascript
ADAPTIVE_TRAIL: {
  STRONG_MULTIPLIER: 1.0,
  NORMAL_MULTIPLIER: 0.7,
  WEAK_MULTIPLIER: 0.4,
  EXHAUSTION_MULTIPLIER: 0.3,
},
```

---

## Feature 4: Backtesting Engine

### What

Simulate any trading strategy on historical data using existing risk functions. Bar-by-bar replay with realistic entry/exit mechanics. Results saved as JSON for dashboard display.

### New Files

- `src/backtesting/engine.js` — Core simulation loop
- `src/backtesting/strategies.js` — Strategy definitions (screener-based, momentum-based)
- `src/backtesting/report.js` — Generate performance reports from results

### How It Works

1. **Input:** Strategy config + date range + list of symbols
2. **Data:** Fetch daily OHLCV for all symbols in range via `getHistorical()`
3. **Replay:** Iterate bar-by-bar chronologically
4. **Per bar:**
   - Run `analyzeTechnicals()` on data up to current bar (sliding window)
   - Check if any open positions should exit via `shouldExit()`
   - Check if new entries qualify via strategy rules
   - Apply `calculatePositionSize()`, `calculateStopLoss()`, `calculateTargets()`
5. **Output:** Trade log + performance metrics

### Engine API

```javascript
export async function runBacktest(config)
// config = {
//   strategy: 'screener' | 'momentum' | 'custom',
//   symbols: string[],         // e.g., ['RELIANCE', 'TCS', 'INFY']
//   startDate: string,         // '2025-01-01'
//   endDate: string,           // '2026-04-01'
//   capital: number,           // starting capital (default: 200000)
//   maxPositions: number,      // default: 3
//   maxCapitalPerPosition: number, // default: 0.20
//   stopMultiplier: number,    // ATR multiplier (default: 1.5)
//   trailingATR: number,       // trailing ATR multiplier (default: 0.5)
//   riskReward: { T1: number, T2: number }, // default: { T1: 2, T2: 3 }
// }
//
// Returns: {
//   trades: Trade[],
//   metrics: BacktestMetrics,
//   equityCurve: { date, capital }[],
//   config: config,
// }
```

### BacktestMetrics Shape

```javascript
{
  totalTrades: number,
  winners: number,
  losers: number,
  winRate: number,           // percentage
  avgWin: number,            // average winning trade P&L
  avgLoss: number,           // average losing trade P&L
  profitFactor: number,      // gross profit / gross loss
  totalPnl: number,
  totalReturnPct: number,
  maxDrawdown: number,       // peak-to-trough %
  maxDrawdownAmount: number,
  sharpeRatio: number,       // annualized, assuming 252 trading days
  avgHoldingDays: number,
  bestTrade: number,
  worstTrade: number,
  consecutiveWins: number,
  consecutiveLosses: number,
  recoveryFactor: number,    // total return / max drawdown
}
```

### Strategy: 'screener'

Mirrors the live Trade Strategist logic:
- Run `analyzeTechnicals()` per bar
- Score ≥ 70 → enter (CALL if score > 60 and signal is BUY/STRONG_BUY, PUT if SELL/STRONG_SELL)
- Use `shouldExit()` for exits
- Max 3 concurrent positions
- Same position sizing as live

### Strategy: 'momentum'

Simplified momentum strategy:
- Enter CALL when RSI crosses above 30 from below AND MACD histogram turns positive
- Enter PUT when RSI crosses below 70 from above AND MACD histogram turns negative
- Exit via `shouldExit()` (same SL/target logic)
- Useful as comparison baseline

### CLI Command

Add `tradease backtest` command:
```
tradease backtest --strategy screener --days 90 --symbols RELIANCE,TCS,INFY
tradease backtest --strategy momentum --start 2025-01-01 --end 2026-04-01
```

Defaults: strategy=screener, days=90, symbols=top 10 F&O by volume.

### Result Storage

Save results to `data/backtests/YYYY-MM-DD-HH-mm-strategy.json`. Keep last 20 results (auto-prune older ones).

### Dashboard Integration

New API endpoint: `GET /api/backtest/latest`
- Returns most recent backtest result
- Dashboard shows summary card in Performance Analytics section (if backtest data exists):
  - Win rate, profit factor, total return, max drawdown, Sharpe ratio
  - Mini equity curve (reuse lightweight-charts)

---

## Files Touched

### New Files
- `src/analysis/confluence.js` — Multi-timeframe confluence scoring
- `src/backtesting/engine.js` — Core backtest simulation
- `src/backtesting/strategies.js` — Strategy definitions
- `src/backtesting/report.js` — Performance report generation

### Modified Files
- `src/data/market.js` — Add `getIntradayData()` function
- `src/trading/risk.js` — Adaptive trailing stop (`calculateTrailingStop()` + `computeMomentumMultiplier()`)
- `src/config/settings.js` — Add `ADAPTIVE_TRAIL` config block
- `src/analysis/screener.js` — Integrate confluence score (top-30 rerank)
- `src/agents/trade-strategist.js` — Confluence gate before entry
- `src/agents/position-guardian.js` — Pass momentum context to trailing stop
- `src/dashboard/server.js` — Add `/api/backtest/latest` endpoint
- `src/dashboard/public/index.html` — Backtest summary card in Performance Analytics
- `src/cli/commands.js` — Add `backtest` command

### No New npm Dependencies
- All analysis uses existing `technicalindicators` package
- Yahoo Finance intraday uses existing `yahoo-finance2`
- File I/O uses native `fs`

---

## Error Handling

- **Yahoo intraday unavailable for a timeframe:** Skip that timeframe in confluence, compute from available timeframes only (weight redistributed)
- **Insufficient historical data for backtest:** Require minimum 30 bars, warn user if fewer
- **Backtest takes too long:** Cap at 500 symbols × 365 days = ~180k bars (should run in <30s)
- **Momentum data unavailable:** `calculateTrailingStop()` falls back to static `TRAILING_STOP_ATR` when `momentum` is null (full backward compatibility)

---

## Performance Considerations

- **Confluence:** Only computed for top 30 screener candidates, not all 180+ F&O stocks
- **Intraday cache:** 2-min TTL for 5m/15m, 10-min for 1h — avoids Yahoo API spam
- **Backtest:** Uses daily bars (no intraday for backtesting — Yahoo daily data more reliable for long ranges)
- **Backtest parallelism:** Symbols processed sequentially to avoid Yahoo rate limits, but bars within a symbol processed in-memory (fast)
- **Result files:** Auto-pruned to 20 most recent, each ~50-200KB JSON

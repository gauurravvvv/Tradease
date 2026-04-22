# TradeOracle

AI-powered Indian F&O (Futures & Options) paper trading system. Uses Claude as the analysis engine, Yahoo Finance for market data, and technical indicators to generate, execute, and monitor trade ideas — all from the terminal.

**Paper trading only.** No real money. No broker integration.

## Features

- **Multi-factor stock screener** — volume, technicals, momentum, proximity, news, sector rotation, FII/DII flows, global cues, VIX
- **AI-powered analysis** — Claude analyzes screened stocks and produces trade recommendations with entry/SL/targets
- **Paper trading engine** — virtual ₹2,00,000 capital, max 3 concurrent positions, ATR-based stop-losses
- **24x7 daemon mode** — automated pre-market scan, trade execution, position monitoring, wind-down, and daily summaries
- **Position monitoring** — real-time price tracking, trailing stops, partial profit booking (T1/T2), emergency exit on index crash
- **Desktop notifications** — trade entries, exits, stop-losses, target hits, index crashes, daily summaries
- **Persistent logging** — daily rotating log files in `data/logs/`
- **Research mode** — quick or deep analysis on any F&O stock with full market context

## Prerequisites

- **Node.js 18+** (20+ recommended)
- **Claude Code CLI** — installed and authenticated ([claude.ai/claude-code](https://claude.ai/claude-code))
- **macOS/Linux** (desktop notifications via `node-notifier`)

## Installation

```bash
# Clone the repo
git clone <your-repo-url> TradeOracle
cd TradeOracle

# Install dependencies
npm install

# Link CLI globally (optional)
npm link
```

After `npm link`, you can use `tradeoracle` from anywhere. Without it, use `node src/index.js` instead.

## Quick Start

```bash
# Run a pre-market scan
tradeoracle scan

# Quick research on a stock
tradeoracle research RELIANCE

# Deep research with options + 90-day history
tradeoracle research deep RELIANCE

# Check market pulse
tradeoracle pulse

# Start the daemon (runs everything on schedule)
tradeoracle daemon
```

## Commands

### `tradeoracle scan`

Run pre-market screening and AI analysis. Displays a morning brief with top trade ideas.

```bash
tradeoracle scan                  # Interactive — prompts for action
tradeoracle scan --no-interactive # Non-interactive (daemon mode)
tradeoracle scan -n 20            # Screen top 20 stocks (default: 15)
```

**Interactive actions after scan:**
- `E` — Execute all recommended trades
- `1-N` — Execute a specific trade
- `D1-DN` — Deep research a specific stock
- `S` — Skip (no trades)

### `tradeoracle research <symbol>`

Analyze a single stock. Two modes:

```bash
# Quick analysis — current price, technicals, news
tradeoracle research RELIANCE
tradeoracle research quick RELIANCE

# Deep analysis — 90-day history, options chain, full context
tradeoracle research deep RELIANCE
tradeoracle research RELIANCE --deep
```

Deep mode fetches FII/DII flows, global cues, sector data, and passes everything to Claude for comprehensive analysis.

### `tradeoracle portfolio`

Show portfolio overview — total capital, available capital, unrealized P&L, open positions.

### `tradeoracle trades`

Show active trades with live P&L, stop-loss levels, and target status.

### `tradeoracle history`

Show closed trades with win rate and performance stats.

```bash
tradeoracle history            # Last 30 days (default)
tradeoracle history --days 7   # Last 7 days
tradeoracle history --days 90  # Last 90 days
```

### `tradeoracle exit <symbol>`

Manually exit an open position.

```bash
tradeoracle exit RELIANCE
tradeoracle exit RELIANCE --reason "Sector rotation out"
```

### `tradeoracle pulse`

Quick market pulse — Nifty/BankNifty levels, change %, and open positions summary.

### `tradeoracle daemon`

Start the 24x7 daemon. Runs all tasks on schedule:

| Schedule | Task | Time (IST) |
|---|---|---|
| Pre-market scan | Screen stocks + AI analysis | 8:30 AM Mon-Fri |
| Market open check | Index health check | 9:15 AM Mon-Fri |
| Trade execution | Auto-execute high-confidence trades | 9:30 AM Mon-Fri |
| Market pulse | Index monitoring (every 30 min) | 9:00 AM – 2:59 PM Mon-Fri |
| Position monitor | Price/SL/target checks (every minute) | 9:00 AM – 2:59 PM Mon-Fri |
| Wind-down | Close all positions | 3:15 PM Mon-Fri |
| Post-market | Save daily summary + stats | 3:45 PM Mon-Fri |

```bash
tradeoracle daemon    # Start daemon
# or
npm start             # Same thing
```

Press `Ctrl+C` to stop gracefully.

## Configuration

All settings in `src/config/settings.js`:

### Trading Rules

| Setting | Default | Description |
|---|---|---|
| `VIRTUAL_CAPITAL` | ₹2,00,000 | Total paper trading capital |
| `MAX_POSITIONS` | 3 | Max concurrent open trades |
| `MAX_CAPITAL_PER_POSITION` | 20% | Max capital per single trade |
| `MAX_LOSS_PER_TRADE` | 5% | Hard max loss per trade |
| `ATR_STOP_MULTIPLIER` | 1.5x | Stop-loss = 1.5x ATR |
| `TRAILING_TRIGGER_PCT` | 1% | Trailing stop activates after 1% profit |
| `MIN_CONFIDENCE` | 70 | Minimum AI confidence to show trade |
| `NO_NEW_ENTRY_AFTER` | 3:00 PM | No new trades after this time |
| `EXIT_ALL_BY` | 3:15 PM | Wind-down exit time |

### Profit Booking

| Target | % of Position | Risk:Reward |
|---|---|---|
| T1 | 50% exit | 2:1 |
| T2 | 25% exit | 3:1 |
| Runner | 25% rides with trailing SL | — |

### Safety

- **Index crash threshold**: -1.5% Nifty drop → emergency exit ALL positions
- **Trailing stop**: moves to breakeven after T1 hit, then trails at 0.5x ATR
- **News monitoring**: checks sentiment every 5 minutes for open positions

## Project Structure

```
TradeOracle/
├── src/
│   ├── index.js              # CLI entry point (Commander.js)
│   ├── analysis/
│   │   ├── claude.js          # Claude AI integration
│   │   ├── screener.js        # Multi-factor stock screener
│   │   ├── sectors.js         # Sector rotation analysis
│   │   └── technicals.js      # Technical indicators (RSI, MACD, etc.)
│   ├── cli/
│   │   ├── display.js         # Terminal UI (tables, charts, briefs)
│   │   ├── portfolio.js       # Portfolio/trades/history display
│   │   ├── research.js        # Research command handler
│   │   └── scan.js            # Scan command + trade execution
│   ├── config/
│   │   └── settings.js        # All configuration
│   ├── data/
│   │   ├── fii-dii.js         # FII/DII flow data
│   │   ├── fno-stocks.js      # F&O eligible stock list
│   │   ├── global-cues.js     # Global market cues (US, Asia, Europe)
│   │   ├── market.js          # Yahoo Finance quotes
│   │   ├── news.js            # Google News RSS
│   │   └── options.js         # Options chain, expiry, strikes
│   ├── db/
│   │   └── sqlite.js          # SQLite database (better-sqlite3)
│   ├── listeners/
│   │   ├── index-monitor.js   # Nifty/BankNifty health monitor
│   │   ├── manager.js         # Listener orchestrator (tick loop)
│   │   ├── news-monitor.js    # News sentiment monitor
│   │   └── price.js           # Price/SL/target checker
│   ├── scheduler/
│   │   └── cron.js            # Cron job scheduler
│   ├── trading/
│   │   ├── manager.js         # Trade entry/exit/partial/stop
│   │   ├── portfolio.js       # Portfolio summary + daily P&L
│   │   └── risk.js            # Position sizing, SL, targets, validation
│   └── utils/
│       ├── logger.js          # Daily rotating file logger
│       └── notify.js          # Desktop notifications
├── tests/
│   ├── risk.test.js           # Risk module tests (23 tests)
│   ├── options.test.js        # Options module tests (13 tests)
│   ├── screener.test.js       # Screener tests (17 tests)
│   └── claude-parse.test.js   # AI response parsing tests (11 tests)
├── data/
│   ├── trades.db              # SQLite database (auto-created)
│   └── logs/                  # Daily log files (auto-created)
├── package.json
├── jest.config.js
└── CLAUDE.md
```

## Data Storage

- **Trades database**: `data/trades.db` (SQLite, auto-created on first run)
- **Log files**: `data/logs/YYYY-MM-DD.log` (auto-rotated, cleaned after 30 days)

## Testing

```bash
npm test
```

Runs 64 tests across 4 test suites:
- `risk.test.js` — position sizing, stop-loss, targets, trailing stop, validation
- `options.test.js` — Black-Scholes premium, expiry dates, ATM strike
- `screener.test.js` — scoring algorithm, recommendation derivation
- `claude-parse.test.js` — JSON extraction, type normalization

## Notifications

Desktop notifications fire on:
- Trade entry/exit
- Stop-loss triggered
- Target T1/T2 hit
- Index crash (with sound alert)
- Scan complete
- Daemon start/stop
- Daily summary

Critical alerts (index crash) play a sound. Requires macOS notification support.

## How It Works

1. **Screening** — scans ~180 F&O eligible NSE stocks through a 9-factor scoring model
2. **AI Analysis** — top candidates sent to Claude with compressed market data + context
3. **Execution** — trades entered with ATR-based stops, lot sizing, and capital checks
4. **Monitoring** — daemon checks prices every minute, news every 5 minutes, index every 30 minutes
5. **Exit logic** — partial exit at T1 (50%), T2 (25%), runner rides with trailing SL. Emergency exit on index crash (-1.5%).
6. **Wind-down** — all positions closed by 3:15 PM IST, daily P&L saved

## License

MIT

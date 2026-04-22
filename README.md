# Tradease

AI-powered autonomous Indian F&O (Futures & Options) paper trading system. Three autonomous agents collaborate to scan markets, enter trades, monitor positions, and exit — all without human intervention. Built with Claude AI, Yahoo Finance, and real-time technical analysis.

**Paper trading only.** No real money. No broker integration. Start the daemon and walk away.

---

## Highlights

- **3 Autonomous AI Agents** — Trade Strategist (entries), Position Guardian (exits), News Sentinel (news-driven signals)
- **Multi-factor screener** — 9-factor scoring across 180+ F&O stocks (volume, technicals, momentum, news, sectors, FII/DII, global cues, VIX)
- **Multi-timeframe confluence** — confirms signals across 5m, 15m, 1h, daily timeframes before entry
- **Adaptive trailing stops** — momentum-aware (RSI + MACD) with exhaustion detection
- **Real-time web dashboard** — live prices via SSE, candlestick charts, equity curve, risk panel, agent monitoring
- **Backtesting engine** — 3 strategies (screener, momentum, mean-reversion) with Sharpe ratio, drawdown, profit factor
- **Trade journal** — auto-generated entries from closed trades with tags, ratings, and AI review slots
- **Telegram alerts** — instant notifications for entries, exits, stop-losses, target hits, index crashes
- **Full CLI** — 10+ commands for scanning, research, portfolio management, and market status

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    DAEMON (24x7)                        │
├──────────────┬──────────────┬───────────────────────────┤
│  Scheduler   │  Listeners   │   Agent Orchestrator      │
│  (7 cron     │  (price,     │                           │
│   jobs)      │   news,      │  ┌───────────────────┐    │
│              │   index)     │  │  News Sentinel     │    │
│              │              │  │  (RSS → signals)   │    │
│              │              │  └───────┬───────────┘    │
│              │              │          │ bullish_news    │
│              │              │          │ bearish_news    │
│              │              │          │ urgent_exit     │
│              │              │          ▼                 │
│              │              │  ┌───────────────────┐    │
│              │              │  │ Trade Strategist   │    │
│              │              │  │ (screen→enter)     │    │
│              │              │  └───────────────────┘    │
│              │              │  ┌───────────────────┐    │
│              │              │  │ Position Guardian  │    │
│              │              │  │ (monitor→exit)     │    │
│              │              │  └───────────────────┘    │
├──────────────┴──────────────┴───────────────────────────┤
│  SQLite DB  │  Yahoo Finance  │  RSS Feeds  │  Claude   │
└─────────────┴─────────────────┴─────────────┴───────────┘
```

### Agent Signal Flow

| Producer | Signal | Consumer | Action |
|----------|--------|----------|--------|
| News Sentinel | `bullish_news` | Trade Strategist | Boost borderline candidates, Claude confirmation |
| News Sentinel | `bearish_news` | Position Guardian | Tighten stops, evaluate exit |
| News Sentinel | `urgent_exit` | Position Guardian | Immediate exit on losing positions, Claude decision on profitable |

---

## Claude Code CLI Integration

Tradease uses **Claude Code CLI** (`claude`) as its AI engine — spawned as a child process via `child_process.spawn()`. No direct API keys needed; it uses your authenticated Claude Code session.

### How Claude is Used

| Context | Model | When Called | Token Budget |
|---------|-------|-------------|-------------|
| **Pre-market scan** | Default (Sonnet) | Once per morning, analyzes top screened stocks | ~4000 output tokens |
| **Deep research** | Default (Sonnet) | On-demand, full stock analysis | ~4000 output tokens |
| **Trade Strategist agent** | Haiku 4.5 | Only for borderline candidates (score 60-69 with news) | ~600 output tokens |
| **Position Guardian agent** | Haiku 4.5 | Only for ambiguous exits (profitable + urgent signal) | ~400 output tokens |
| **News Sentinel agent** | Haiku 4.5 | Only for edge-case headline relevance scoring | ~400 output tokens |

### Token Efficiency

**Most decisions are rule-based — no Claude calls needed.** The system is designed to minimize token consumption:

- **Trade entries**: Stocks scoring 70+ are auto-entered by rules (RSI, volume, confluence, ATR). Claude is only consulted for borderline 60-69 scores with news signals — roughly **0-2 calls per day**.
- **Trade exits**: Stop-loss, trailing stops, T1/T2 targets, and index crash exits are all mechanical. Claude is only asked when a profitable position receives an `urgent_exit` signal — **rare, ~0-1 calls per day**.
- **News scoring**: Keyword-based sentiment (no AI). Claude only used if edge cases arise.
- **All agents use Haiku 4.5** (cheapest model) with strict output caps (400-600 tokens).

**Typical daily token usage**: ~2,000-5,000 tokens on a quiet day. Up to ~15,000 tokens on active scan + research days. The pre-market scan is the largest single call.

## Prerequisites

- **Node.js 18+** (20+ recommended)
- **Claude Code CLI** — installed and authenticated (`npm install -g @anthropic-ai/claude-code`)
- **macOS/Linux** (desktop notifications via `node-notifier`)

## Installation

```bash
git clone https://github.com/gauravgoel11/Tradease.git
cd Tradease
npm install

# Optional: link CLI globally
npm link
```

## Quick Start

```bash
# Just start everything (daemon + dashboard + agents)
tradease daemon

# Dashboard at http://localhost:3777
tradease dashboard

# Or explore individual commands
tradease scan              # Pre-market scan
tradease research RELIANCE # Quick analysis
tradease pulse             # Market status
tradease news              # News + sentiment
```

---

## Commands

| Command | Description |
|---------|-------------|
| `tradease scan` | Pre-market screening + AI analysis, interactive trade execution |
| `tradease research [quick\|deep] <SYMBOL>` | Stock analysis with technicals, news, entry/SL/targets |
| `tradease news` | Top 15 stocks consolidated news + sentiment scores |
| `tradease dashboard` | Web dashboard at `localhost:3777` |
| `tradease portfolio` | Portfolio overview + unrealized P&L |
| `tradease trades` | Active trades with live P&L |
| `tradease exit <SYMBOL>` | Manual exit position |
| `tradease history` | Closed trades + win rate + performance stats |
| `tradease status` / `pulse` | Full market status (indices, global, FII/DII, sectors, VIX) |
| `tradease daemon` | Start 24x7 daemon with all schedulers + agents |

---

## Web Dashboard

Dark-themed, real-time dashboard with SSE live updates.

**Sections:**
- **Portfolio** — capital, available, unrealized P&L, open positions count
- **Market Pulse** — Nifty, BankNifty, VIX, market session status
- **Global Markets** — S&P 500, Nasdaq, Dow, Nikkei, Hang Seng, Crude, Gold, DXY
- **FII/DII Flows** — buy/sell signals with visual indicators
- **Sector Rotation** — sector strength with trend arrows
- **Open Trades** — live P&L bars, stop-loss, targets, one-click exit
- **Recommendations** — screened picks with pre-computed entry/SL/targets, one-click trade
- **Candlestick Charts** — intraday 5-minute charts (LightweightCharts)
- **Equity Curve** — portfolio value over time + daily P&L histogram
- **Risk Dashboard** — capital allocation, sector exposure, drawdown, worst-case loss
- **Backtesting** — run strategies from UI, view metrics (Sharpe, drawdown, win rate, profit factor)
- **Trade Journal** — auto-generated entries, filter by tag/period, rate trades
- **Agent Monitor** — agent status, recent logs, pending signals, start/stop controls
- **News Feed** — general finance news with sentiment scores
- **Telegram Setup** — configure bot token + chat ID from UI
- **Agent Config** — tune max positions, ATR multiplier, trailing stops, risk:reward from UI

---

## Autonomous Agents

### Trade Strategist
- Runs every 10 minutes during market hours (9:30 AM - 2:30 PM)
- Screens stocks, filters by RSI/volume/confluence
- Auto-enters trades scoring 70+ (65+ with high confluence)
- Borderline candidates (60-69) need news signal + Claude confirmation
- Max 1 entry per tick

### Position Guardian
- Runs every 2 minutes during market hours (9:15 AM - 3:20 PM)
- Checks stop-loss, trailing stop, T1/T2 targets for every position
- Adaptive trailing stops using RSI + MACD momentum
- Processes `urgent_exit` / `bearish_news` signals from News Sentinel
- Index crash detection (-1.5% Nifty) → emergency exit ALL
- Wind-down at 3:15 PM — close everything

### News Sentinel
- Runs every 5 minutes during market hours
- Monitors RSS feeds for open positions + strategist watchlist
- Keyword-based sentiment scoring (strong neg: -2, mild neg: -1, positive: +1, strong positive: +2)
- Writes signals: `bullish_news`, `bearish_news`, `urgent_exit`

---

## Backtesting

Three built-in strategies:

| Strategy | Logic |
|----------|-------|
| **Screener** | Full multi-factor scoring (same as live screener) |
| **Momentum** | RSI oversold + MACD bullish crossover + volume spike |
| **Mean Reversion** | RSI extreme + Bollinger Band touch + volume confirmation |

Run from dashboard UI or CLI. Metrics: total P&L, win rate, Sharpe ratio, max drawdown, profit factor, best/worst trade, consecutive wins/losses, recovery factor.

---

## Trading Rules

| Rule | Value |
|------|-------|
| Virtual capital | ₹2,00,000 |
| Max concurrent positions | 3 |
| Max capital per position | 20% |
| Max loss per trade | 5% of capital |
| Stop-loss | 1.5x ATR |
| Trailing stop trigger | After 1% profit |
| Trailing stop distance | 0.5x ATR (adaptive with momentum) |
| T1 partial exit | 50% at 2:1 R:R |
| T2 partial exit | 25% at 3:1 R:R |
| Runner | 25% rides with trailing SL |
| Index crash exit | -1.5% Nifty → exit ALL |
| No new entries after | 3:00 PM IST |
| Wind-down exit | 3:15 PM IST |

---

## Project Structure

```
Tradease/
├── src/
│   ├── index.js                # CLI entry + daemon orchestration
│   ├── agents/
│   │   ├── base.js             # BaseAgent class (Claude calls, signals, logging)
│   │   ├── orchestrator.js     # Agent lifecycle management
│   │   ├── trade-strategist.js # Entry agent (screener → trade)
│   │   ├── position-guardian.js# Exit agent (monitor → exit)
│   │   └── news-sentinel.js    # News agent (RSS → signals)
│   ├── analysis/
│   │   ├── claude.js           # Claude AI integration
│   │   ├── confluence.js       # Multi-timeframe confluence scoring
│   │   ├── screener.js         # 9-factor stock screener
│   │   ├── sectors.js          # Sector rotation analysis
│   │   └── technicals.js       # Technical indicators (RSI, MACD, BB, ATR)
│   ├── backtesting/
│   │   ├── engine.js           # Bar-by-bar simulation engine
│   │   ├── strategies.js       # Screener, momentum, mean-reversion
│   │   └── report.js           # Metrics generation + result storage
│   ├── cli/
│   │   ├── display.js          # Terminal UI (tables, charts, briefs)
│   │   ├── news.js             # News digest command
│   │   ├── portfolio.js        # Portfolio/trades/history display
│   │   ├── research.js         # Research command handler
│   │   ├── scan.js             # Scan command + trade execution
│   │   └── status.js           # Market status command
│   ├── config/
│   │   └── settings.js         # All configuration
│   ├── dashboard/
│   │   ├── server.js           # Express API (30+ endpoints) + SSE
│   │   └── public/
│   │       └── index.html      # Web dashboard (single-page, dark theme)
│   ├── data/
│   │   ├── fii-dii.js          # FII/DII flow data
│   │   ├── fno-stocks.js       # 180+ F&O eligible stocks (NSE)
│   │   ├── global-cues.js      # Global market data
│   │   ├── market.js           # Yahoo Finance quotes + historical
│   │   ├── news.js             # Google News RSS with 5-min cache
│   │   └── options.js          # Options chain, expiry, strikes
│   ├── db/
│   │   ├── sqlite.js           # SQLite database (better-sqlite3)
│   │   └── migrations.js       # Schema migrations
│   ├── listeners/
│   │   ├── index-monitor.js    # Nifty/BankNifty crash detection
│   │   ├── manager.js          # Listener orchestrator
│   │   ├── news-monitor.js     # Keyword-based sentiment scoring
│   │   └── price.js            # Live price/SL/target checker
│   ├── scheduler/
│   │   └── cron.js             # 7 cron jobs for daemon
│   ├── trading/
│   │   ├── journal.js          # Trade journal (auto-journaling)
│   │   ├── manager.js          # Trade entry/exit/partial/stop
│   │   ├── portfolio.js        # Portfolio summary + equity curve
│   │   └── risk.js             # Position sizing, SL, targets, adaptive trailing
│   └── utils/
│       ├── logger.js           # Daily rotating file logger
│       ├── notify.js           # Desktop notifications
│       └── telegram.js         # Telegram Bot API integration
├── tests/                      # Jest test suites
├── package.json
├── jest.config.js
└── CLAUDE.md
```

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 20+ (ES modules) |
| AI Engine | Claude (via Claude Code CLI) |
| Market Data | Yahoo Finance |
| News | Google News RSS |
| Database | SQLite (better-sqlite3) |
| Web Server | Express 5 |
| Charts | LightweightCharts (TradingView) |
| Technical Analysis | technicalindicators |
| Scheduling | node-cron |
| CLI | Commander.js |
| Notifications | node-notifier + Telegram Bot API |

---

## Testing

```bash
npm test
```

64 tests across 4 suites — risk calculations, options pricing, screener scoring, AI response parsing.

---

## License

MIT

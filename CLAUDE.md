# TradeOracle

AI-powered Indian F&O trading decision system. Uses Claude Code CLI as analysis engine.

## Architecture

- Node.js 20+ with ES modules
- SQLite for trade/P&L storage
- Yahoo Finance + NSE scraping for market data
- Google News RSS for news
- Claude Code CLI spawned via child_process for AI analysis
- node-cron for scheduling
- Commander.js for CLI

## Key Rules

- Paper trading only (no real money integration yet)
- Virtual capital: ₹2,00,000
- Max 3 concurrent positions
- Max 20% capital per position
- Only F&O eligible stocks (NSE)
- Hard stop-loss on every trade (1.5x ATR)
- Trailing stop-loss after 1% profit
- Max loss per trade: 5% of capital

## Commands

- `tradeoracle scan` — Pre-market scan, find top trades
- `tradeoracle research quick <SYMBOL>` — Quick analysis
- `tradeoracle research deep <SYMBOL>` — Deep analysis
- `tradeoracle portfolio` — View portfolio + P&L
- `tradeoracle trades` — Active trades with live P&L
- `tradeoracle exit <SYMBOL>` — Manual exit position
- `tradeoracle history` — Past trades + win rate + performance stats
- `tradeoracle pulse` — Quick market pulse
- `tradeoracle daemon` — Start 24x7 daemon with all schedulers

## Code Style

- ES modules (import/export)
- Async/await throughout
- Descriptive variable names
- No TypeScript — plain JS
- Error handling at boundaries only

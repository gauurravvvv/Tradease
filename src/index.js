#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { runScan } from './cli/scan.js';
import { runResearch } from './cli/research.js';
import { showPortfolio, showTrades } from './cli/portfolio.js';
import { displayHeader, displayMarketPulse, formatCurrency } from './cli/display.js';
import { createScheduler } from './scheduler/cron.js';
import { ListenerManager } from './listeners/manager.js';
import { checkIndexHealth } from './listeners/index-monitor.js';
import { getOpenTrades, exitTrade } from './trading/manager.js';
import { getPortfolioSummary } from './trading/portfolio.js';
import { getDb, closeDb } from './db/sqlite.js';
import { SCHEDULE } from './config/settings.js';

const program = new Command();

program
  .name('tradeoracle')
  .description('AI-powered Indian F&O trading decision system')
  .version('1.0.0');

// ─── scan ───────────────────────────────────────────────────────────────────
program
  .command('scan')
  .description('Run pre-market scan — find top F&O trade ideas')
  .option('--no-interactive', 'Skip interactive prompt')
  .option('-n, --top <number>', 'Number of stocks to screen', '15')
  .action(async (opts) => {
    try {
      getDb(); // Ensure DB initialized
      await runScan({
        interactive: opts.interactive !== false,
        topN: parseInt(opts.top, 10),
      });
    } catch (err) {
      console.error(chalk.red(`Scan failed: ${err.message}`));
      process.exit(1);
    }
  });

// ─── research ───────────────────────────────────────────────────────────────
program
  .command('research <modeOrSymbol> [symbol]')
  .description('Research a stock — `research quick RELIANCE` or `research deep RELIANCE` or `research RELIANCE --deep`')
  .option('-d, --deep', 'Run deep analysis (90-day history + options)')
  .action(async (modeOrSymbol, symbol, opts) => {
    try {
      let mode = 'quick';
      let sym;
      if (['quick', 'deep'].includes(modeOrSymbol.toLowerCase())) {
        mode = modeOrSymbol.toLowerCase();
        sym = symbol;
      } else {
        sym = modeOrSymbol;
        if (opts.deep) mode = 'deep';
      }
      if (!sym) {
        console.error(chalk.red('Usage: tradeoracle research [quick|deep] <SYMBOL>'));
        process.exit(1);
      }
      await runResearch(sym.toUpperCase(), mode);
    } catch (err) {
      console.error(chalk.red(`Research failed: ${err.message}`));
      process.exit(1);
    }
  });

// ─── portfolio ──────────────────────────────────────────────────────────────
program
  .command('portfolio')
  .description('Show portfolio — capital, P&L, open positions')
  .action(async () => {
    try {
      getDb();
      await showPortfolio();
    } catch (err) {
      console.error(chalk.red(`Portfolio failed: ${err.message}`));
      process.exit(1);
    }
  });

// ─── trades ─────────────────────────────────────────────────────────────────
program
  .command('trades')
  .description('Show active trades with live P&L')
  .action(async () => {
    try {
      getDb();
      await showTrades();
    } catch (err) {
      console.error(chalk.red(`Trades failed: ${err.message}`));
      process.exit(1);
    }
  });

// ─── exit ───────────────────────────────────────────────────────────────────
program
  .command('exit <symbol>')
  .description('Manually exit a position')
  .option('-r, --reason <reason>', 'Exit reason', 'Manual exit')
  .action(async (symbol, opts) => {
    try {
      getDb();
      const sym = symbol.toUpperCase();
      // Find open trade by symbol
      const trade = getOpenTrades().find(t => t.symbol === sym);
      if (!trade) {
        console.error(chalk.red(`No open position found for ${sym}`));
        process.exit(1);
      }
      // Fetch live price for exit
      let exitPrice = trade.current_price || trade.entry_price;
      try {
        const { getQuote } = await import('./data/market.js');
        const quote = await getQuote(sym);
        exitPrice = quote.price;
      } catch { /* use last known */ }
      exitTrade(trade.id, exitPrice, opts.reason);
      console.log(chalk.green(`Exited position: ${sym} at ${formatCurrency(exitPrice)}`));
    } catch (err) {
      console.error(chalk.red(`Exit failed: ${err.message}`));
      process.exit(1);
    }
  });

// ─── pulse ──────────────────────────────────────────────────────────────────
program
  .command('pulse')
  .description('Quick market pulse — index levels + open positions')
  .action(async () => {
    try {
      displayHeader('Market Pulse', new Date().toLocaleString('en-IN'));

      const indexData = await checkIndexHealth();
      displayMarketPulse(indexData);

      // Open positions summary
      try {
        getDb();
        const openTrades = getOpenTrades();
        if (openTrades.length > 0) {
          console.log(chalk.bold.white(`  Open Positions: ${openTrades.length}`));
          for (const t of openTrades) {
            const typeColor = t.type === 'CALL' ? chalk.green : chalk.red;
            console.log(`    ${typeColor(t.type)} ${chalk.white(t.symbol)} @ ${formatCurrency(t.entry_price)} → SL: ${formatCurrency(t.stop_loss)}`);
          }
          console.log('');
        } else {
          console.log(chalk.gray('  No open positions.\n'));
        }
      } catch {
        // DB not initialized — skip trades
      }
    } catch (err) {
      console.error(chalk.red(`Pulse failed: ${err.message}`));
      process.exit(1);
    }
  });

// ─── daemon ─────────────────────────────────────────────────────────────────
program
  .command('daemon')
  .description('Start 24x7 daemon — scheduler + position monitors')
  .action(async () => {
    try {
      getDb(); // Initialize DB

      displayHeader('TradeOracle Daemon', 'Starting all schedulers and monitors...');

      // Build handler stubs — these wire to actual functions
      const handlers = {
        preMarketScan: async () => {
          console.log('[daemon] Pre-market scan starting...');
          await runScan({ interactive: false });
        },
        marketOpenCheck: async () => {
          console.log('[daemon] Market open check...');
          const indexData = await checkIndexHealth();
          displayMarketPulse(indexData);
        },
        tradeExecution: async () => {
          console.log('[daemon] Trade execution window...');
          // Auto-execute if scan produced recommendations with high confidence
          // Actual logic would come from trading/manager.js
        },
        marketPulse: async () => {
          const indexData = await checkIndexHealth();
          const severity = indexData.severity;
          if (severity !== 'normal') {
            displayMarketPulse(indexData);
          }
        },
        positionMonitor: async () => {
          // Handled by ListenerManager tick(), this is for cron logging
        },
        windDown: async () => {
          console.log('[daemon] Wind-down: preparing to close positions...');
          const { getQuote } = await import('./data/market.js');
          const openTrades = getOpenTrades();
          for (const t of openTrades) {
            console.log(`[daemon] End-of-day exit: ${t.symbol}`);
            try {
              let exitPrice = t.current_price || t.entry_price;
              try {
                const quote = await getQuote(t.symbol);
                exitPrice = quote.price;
              } catch { /* use last known */ }
              exitTrade(t.id, exitPrice, 'End-of-day wind-down');
            } catch (err) {
              console.error(`[daemon] Wind-down exit failed for ${t.symbol}: ${err.message}`);
            }
          }
        },
        postMarket: async () => {
          console.log('[daemon] Post-market summary...');
          const portfolio = getPortfolioSummary();
          console.log(`[daemon] Capital: ${formatCurrency(portfolio.totalCapital)} | P&L today: ${formatCurrency(portfolio.unrealizedPnl)}`);
        },
      };

      // Create and start scheduler
      const scheduler = createScheduler(handlers);
      scheduler.start();

      // Create and start listener manager
      const listeners = new ListenerManager({ tickIntervalMs: 60_000 });
      listeners.start();

      // Log schedule summary
      console.log(chalk.bold.white('\n  Schedule:'));
      console.log(chalk.gray(`    Pre-Market Scan:    ${SCHEDULE.PRE_MARKET_SCAN}`));
      console.log(chalk.gray(`    Market Open Check:  ${SCHEDULE.MARKET_OPEN_CHECK}`));
      console.log(chalk.gray(`    Trade Execution:    ${SCHEDULE.TRADE_EXECUTION}`));
      console.log(chalk.gray(`    Market Pulse:       ${SCHEDULE.MARKET_PULSE}`));
      console.log(chalk.gray(`    Position Monitor:   ${SCHEDULE.POSITION_MONITOR}`));
      console.log(chalk.gray(`    Wind Down:          ${SCHEDULE.WIND_DOWN}`));
      console.log(chalk.gray(`    Post Market:        ${SCHEDULE.POST_MARKET}`));
      console.log('');
      console.log(chalk.green.bold('  TradeOracle daemon running...'));
      console.log(chalk.gray('  Press Ctrl+C to stop.\n'));

      // Graceful shutdown
      const shutdown = (signal) => {
        console.log(`\n[daemon] Received ${signal}. Shutting down...`);
        scheduler.stop();
        listeners.stop();
        closeDb();
        console.log('[daemon] Shutdown complete.');
        process.exit(0);
      };

      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));

    } catch (err) {
      console.error(chalk.red(`Daemon failed: ${err.message}`));
      closeDb();
      process.exit(1);
    }
  });

// Parse and execute
program.parse();

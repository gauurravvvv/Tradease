#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { runScan, autoExecuteTrades } from './cli/scan.js';
import { runResearch } from './cli/research.js';
import { runNewsDigest } from './cli/news.js';
import { showPortfolio, showTrades, showHistory } from './cli/portfolio.js';
import { displayHeader, displayMarketPulse, formatCurrency } from './cli/display.js';
import { startDashboard } from './dashboard/server.js';
import { runMarketStatus } from './cli/status.js';
import { createScheduler } from './scheduler/cron.js';
import { ListenerManager } from './listeners/manager.js';
import { checkIndexHealth } from './listeners/index-monitor.js';
import { getOpenTrades, exitTrade } from './trading/manager.js';
import { getPortfolioSummary, saveDailySummary, getPerformanceStats } from './trading/portfolio.js';
import { getDb, closeDb } from './db/sqlite.js';
import { SCHEDULE } from './config/settings.js';
import { logger, cleanOldLogs } from './utils/logger.js';
import { notifyScanComplete, notifyDaemonStart, notifyDaemonStop, notifyDailySummary } from './utils/notify.js';

const program = new Command();

program
  .name('tradease')
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
        console.error(chalk.red('Usage: tradease research [quick|deep] <SYMBOL>'));
        process.exit(1);
      }
      await runResearch(sym.toUpperCase(), mode);
    } catch (err) {
      console.error(chalk.red(`Research failed: ${err.message}`));
      process.exit(1);
    }
  });

// ─── news ────────────────────────────────────────────────────────────────────
program
  .command('news')
  .description('Top 15 stocks — consolidated news + sentiment')
  .option('-n, --top <number>', 'Number of stocks', '15')
  .option('-d, --detail', 'Show all headlines')
  .action(async (opts) => {
    try {
      await runNewsDigest({
        topN: parseInt(opts.top, 10),
        detail: opts.detail || false,
      });
    } catch (err) {
      console.error(chalk.red(`News failed: ${err.message}`));
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

// ─── history ────────────────────────────────────────────────────────────────
program
  .command('history')
  .description('Show closed trades + win rate + performance stats')
  .option('-d, --days <number>', 'Look back N days', '30')
  .action(async (opts) => {
    try {
      getDb();
      await showHistory(parseInt(opts.days, 10));
    } catch (err) {
      console.error(chalk.red(`History failed: ${err.message}`));
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

// ─── status / pulse ─────────────────────────────────────────────────────────
program
  .command('status')
  .alias('pulse')
  .description('Full market status — indices, global cues, FII/DII, sectors, VIX')
  .action(async () => {
    try {
      await runMarketStatus();
    } catch (err) {
      console.error(chalk.red(`Status failed: ${err.message}`));
      process.exit(1);
    }
  });

// ─── dashboard ──────────────────────────────────────────────────────────────
program
  .command('dashboard')
  .description('Launch web dashboard — trades, P&L, sentiment')
  .option('-p, --port <number>', 'Port number', '3777')
  .action(async (opts) => {
    try {
      getDb();
      const port = parseInt(opts.port, 10);
      displayHeader('Tradease Dashboard', `http://localhost:${port}`);
      startDashboard(port);
      console.log(chalk.green.bold(`\n  Dashboard running at http://localhost:${port}`));
      console.log(chalk.gray('  Press Ctrl+C to stop.\n'));
    } catch (err) {
      console.error(chalk.red(`Dashboard failed: ${err.message}`));
      process.exit(1);
    }
  });

// ─── agents ──────────────────────────────────────────────────────────────────
program
  .command('agents')
  .description('Start autonomous trading agents (news + trade + position)')
  .option('-p, --port <number>', 'Also start dashboard on this port')
  .action(async (opts) => {
    try {
      getDb();
      const { AgentOrchestrator, setOrchestrator } = await import('./agents/orchestrator.js');
      const orchestrator = new AgentOrchestrator();
      setOrchestrator(orchestrator);

      displayHeader('Tradease Agents', 'Autonomous trading agents');

      await orchestrator.start();

      console.log(chalk.bold.white('\n  Agents:'));
      console.log(chalk.cyan('    News Sentinel      — every 5 min  (rule-based sentiment)'));
      console.log(chalk.green('    Trade Strategist   — every 10 min (rule-based entries)'));
      console.log(chalk.yellow('    Position Guardian  — every 2 min  (mechanical exits)'));
      console.log(chalk.gray('\n  Claude called ONLY at decision boundaries (Haiku model)'));

      // Optionally start dashboard too
      if (opts.port) {
        const port = parseInt(opts.port, 10);
        startDashboard(port);
        console.log(chalk.green.bold(`\n  Dashboard: http://localhost:${port}`));
      }

      console.log(chalk.green.bold('\n  All agents running autonomously.'));
      console.log(chalk.gray('  Press Ctrl+C to stop.\n'));

      // Stats every 5 min
      setInterval(() => {
        const status = orchestrator.getStatus();
        for (const a of status.agents) {
          const name = (a.name || '').padEnd(20);
          console.log(chalk.gray(`  [${name}] runs:${a.runs||0} claude:${a.claudeCalls||0} tokens:${a.totalTokens||0} err:${a.errors||0}`));
        }
      }, 5 * 60 * 1000);

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

// ─── daemon ─────────────────────────────────────────────────────────────────
program
  .command('daemon')
  .description('Start 24x7 daemon — scheduler + position monitors')
  .action(async () => {
    try {
      getDb(); // Initialize DB

      displayHeader('Tradease Daemon', 'Starting all schedulers and monitors...');

      // Clean old log files on startup
      cleanOldLogs(30);

      // Build handler stubs — these wire to actual functions
      const handlers = {
        preMarketScan: async () => {
          logger.info('[daemon] Pre-market scan starting...');
          const recs = await runScan({ interactive: false });
          notifyScanComplete(Array.isArray(recs) ? recs.length : 0);
        },
        marketOpenCheck: async () => {
          logger.info('[daemon] Market open check...');
          const indexData = await checkIndexHealth();
          displayMarketPulse(indexData);
        },
        tradeExecution: async () => {
          logger.info('[daemon] Trade execution window...');
          try {
            const recommendations = await runScan({ interactive: false });
            if (Array.isArray(recommendations) && recommendations.length > 0) {
              notifyScanComplete(recommendations.length);
              const entered = autoExecuteTrades(recommendations, 60);
              logger.info(`[daemon] Auto-executed ${entered.length} trade(s)`);
            } else {
              logger.info('[daemon] No recommendations to execute.');
            }
          } catch (err) {
            logger.error(`[daemon] Trade execution failed: ${err.message}`);
          }
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
          logger.info('[daemon] Wind-down: preparing to close positions...');
          const { getQuote } = await import('./data/market.js');
          const openTrades = getOpenTrades();
          for (const t of openTrades) {
            logger.info(`[daemon] End-of-day exit: ${t.symbol}`);
            try {
              let exitPrice = t.current_price || t.entry_price;
              try {
                const quote = await getQuote(t.symbol);
                exitPrice = quote.price;
              } catch { /* use last known */ }
              exitTrade(t.id, exitPrice, 'End-of-day wind-down');
            } catch (err) {
              logger.error(`[daemon] Wind-down exit failed for ${t.symbol}: ${err.message}`);
            }
          }
        },
        postMarket: async () => {
          logger.info('[daemon] Post-market summary...');
          try {
            saveDailySummary();
            logger.info('[daemon] Daily summary saved to DB');
          } catch (err) {
            logger.error(`[daemon] saveDailySummary failed: ${err.message}`);
          }
          const portfolio = getPortfolioSummary();
          const stats = getPerformanceStats(30);
          logger.info(`[daemon] Capital: ${formatCurrency(portfolio.totalCapital)} | Unrealized: ${formatCurrency(portfolio.unrealizedPnl)}`);
          logger.info(`[daemon] 30d stats: ${stats.totalTrades} trades | Win: ${stats.winRate}% | P&L: ${formatCurrency(stats.totalPnl)}`);
          notifyDailySummary(stats.totalPnl || 0, stats.winRate || 0, stats.totalTrades || 0);
        },
      };

      // Create and start scheduler
      const scheduler = createScheduler(handlers);
      scheduler.start();

      // Create and start listener manager
      const listeners = new ListenerManager({ tickIntervalMs: 60_000 });
      listeners.start();

      // Start autonomous agents
      const { AgentOrchestrator, setOrchestrator } = await import('./agents/orchestrator.js');
      const agentOrchestrator = new AgentOrchestrator();
      setOrchestrator(agentOrchestrator);
      await agentOrchestrator.start();

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
      console.log(chalk.bold.white('  Agents:'));
      console.log(chalk.cyan('    News Sentinel      — every 5 min'));
      console.log(chalk.green('    Trade Strategist   — every 10 min'));
      console.log(chalk.yellow('    Position Guardian  — every 2 min'));
      console.log('');
      console.log(chalk.green.bold('  Tradease daemon running...'));
      console.log(chalk.gray('  Press Ctrl+C to stop.\n'));

      notifyDaemonStart();
      logger.info('[daemon] All schedulers and monitors started.');

      // Graceful shutdown
      const shutdown = (signal) => {
        logger.info(`[daemon] Received ${signal}. Shutting down...`);
        scheduler.stop();
        listeners.stop();
        agentOrchestrator.stop();
        closeDb();
        notifyDaemonStop();
        logger.info('[daemon] Shutdown complete.');
        process.exit(0);
      };

      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));

    } catch (err) {
      logger.error(`Daemon failed: ${err.message}`);
      closeDb();
      process.exit(1);
    }
  });

// Parse and execute
program.parse();

import { getOpenTrades, getTradeHistory } from '../trading/manager.js';
import {
  getPortfolioSummary,
  getPerformanceStats,
} from '../trading/portfolio.js';
import { getQuote } from '../data/market.js';
import {
  displayHeader,
  displayPortfolioTable,
  displayTradesTable,
  formatCurrency,
  formatPercent,
} from './display.js';
import chalk from 'chalk';
import Table from 'cli-table3';

/**
 * Show portfolio overview: capital summary, performance stats, open positions.
 */
export async function showPortfolio() {
  displayHeader('Portfolio', 'Capital & Performance Overview');

  // Portfolio summary
  const portfolio = getPortfolioSummary();
  displayPortfolioTable(portfolio);

  // Performance stats
  const stats = getPerformanceStats();
  if (stats) {
    displayPerformanceStats(stats);
  }

  // Open trades
  const openTrades = getOpenTrades();
  if (openTrades.length > 0) {
    console.log(chalk.bold.white('\n  Open Positions:\n'));
    displayTradesTable(openTrades);
  } else {
    console.log(chalk.gray('\n  No open positions.\n'));
  }
}

/**
 * Show active trades with live P&L (fetches current prices).
 */
export async function showTrades() {
  displayHeader('Active Trades', 'Live P&L');

  const openTrades = getOpenTrades();

  if (openTrades.length === 0) {
    console.log(chalk.gray('\n  No active trades.\n'));
    return;
  }

  // Fetch live prices for all open trades
  const pricePromises = openTrades.map(async trade => {
    try {
      const quote = await getQuote(trade.symbol);
      return {
        ...trade,
        current_price: quote.price,
        live_change: quote.changePct,
      };
    } catch {
      return { ...trade }; // Keep existing current_price if fetch fails
    }
  });

  const tradesWithPrices = await Promise.all(pricePromises);

  // Display table
  displayTradesTable(tradesWithPrices);

  // Summary line
  let totalPnl = 0;
  let totalCapital = 0;

  for (const t of tradesWithPrices) {
    const price = t.current_price || t.entry_price;
    const pnl = (price - t.entry_price) * (t.quantity || 1);
    totalPnl += pnl;
    totalCapital += t.capital_used || 0;
  }

  const pnlColor = totalPnl >= 0 ? chalk.green : chalk.red;
  const pnlPct = totalCapital > 0 ? (totalPnl / totalCapital) * 100 : 0;

  console.log(
    `  Total Unrealized P&L: ${pnlColor(formatCurrency(totalPnl))} (${formatPercent(pnlPct)})`,
  );
  console.log(`  Positions: ${tradesWithPrices.length}\n`);
}

/**
 * Show trade history with performance stats.
 * @param {number} days - Look back N days (default 30)
 */
export async function showHistory(days = 30) {
  displayHeader('Trade History', `Last ${days} days`);

  // Performance stats
  const stats = getPerformanceStats(days);
  if (stats) {
    displayPerformanceStats(stats);
  }

  // Closed/stopped trades
  const history = getTradeHistory(days);
  if (history.length === 0) {
    console.log(chalk.gray('\n  No closed trades in this period.\n'));
    return;
  }

  const table = new Table({
    head: [
      chalk.cyan('Date'),
      chalk.cyan('Symbol'),
      chalk.cyan('Type'),
      chalk.cyan('Entry'),
      chalk.cyan('Exit'),
      chalk.cyan('P&L'),
      chalk.cyan('Status'),
      chalk.cyan('Reason'),
    ],
    style: { head: [], border: ['gray'] },
    colWidths: [12, 14, 6, 10, 10, 14, 9, 24],
  });

  for (const t of history) {
    const exitDate = t.exited_at
      ? new Date(t.exited_at).toLocaleDateString('en-IN')
      : '—';
    const pnl = t.pnl || 0;
    const pnlStr = formatCurrency(pnl);
    const pnlColored = pnl >= 0 ? chalk.green(pnlStr) : chalk.red(pnlStr);
    const typeStr = t.type === 'CALL' ? chalk.green(t.type) : chalk.red(t.type);
    const statusColor = t.status === 'CLOSED' ? chalk.green : chalk.red;
    const reason = (t.exit_reason || '').slice(0, 22);

    table.push([
      exitDate,
      chalk.white(t.symbol),
      typeStr,
      formatCurrency(t.entry_price),
      formatCurrency(t.exit_price || 0),
      pnlColored,
      statusColor(t.status),
      chalk.gray(reason),
    ]);
  }

  console.log(chalk.bold.white(`\n  ${history.length} Closed Trade(s):\n`));
  console.log(table.toString());

  // Win/loss summary line
  const wins = history.filter(t => (t.pnl || 0) > 0).length;
  const losses = history.filter(t => (t.pnl || 0) < 0).length;
  const totalPnl = history.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const pnlColor = totalPnl >= 0 ? chalk.green : chalk.red;

  console.log(
    `  ${chalk.green(`W: ${wins}`)} | ${chalk.red(`L: ${losses}`)} | Net P&L: ${pnlColor(formatCurrency(totalPnl))}\n`,
  );
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function displayPerformanceStats(stats) {
  const table = new Table({
    head: [chalk.cyan('Metric'), chalk.cyan('Value')],
    style: { head: [], border: ['gray'] },
    colWidths: [25, 20],
  });

  const totalPnl = stats.totalPnl || 0;
  const bestPnl = stats.bestTrade ? stats.bestTrade.pnl || 0 : 0;
  const worstPnl = stats.worstTrade ? stats.worstTrade.pnl || 0 : 0;

  table.push(
    ['Period', String(stats.period || '30 days')],
    ['Total Trades', String(stats.totalTrades || 0)],
    ['Win Rate', formatPercent(stats.winRate || 0)],
    ['Avg Win', chalk.green(formatCurrency(stats.avgWin || 0))],
    ['Avg Loss', chalk.red(formatCurrency(stats.avgLoss || 0))],
    ['Profit Factor', String(stats.profitFactor || 0)],
    [
      'Total P&L',
      totalPnl >= 0
        ? chalk.green(formatCurrency(totalPnl))
        : chalk.red(formatCurrency(totalPnl)),
    ],
    ['Max Drawdown', chalk.red(formatCurrency(stats.maxDrawdown || 0))],
    [
      'Best Trade',
      `${formatCurrency(bestPnl)} ${stats.bestTrade?.symbol ? `(${stats.bestTrade.symbol})` : ''}`,
    ],
    [
      'Worst Trade',
      `${formatCurrency(worstPnl)} ${stats.worstTrade?.symbol ? `(${stats.worstTrade.symbol})` : ''}`,
    ],
  );

  console.log(chalk.bold.white('\n  Performance Stats:\n'));
  console.log(table.toString());
}

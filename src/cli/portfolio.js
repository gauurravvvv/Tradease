import { getOpenTrades } from '../trading/manager.js';
import { getPortfolioSummary, getPerformanceStats } from '../trading/portfolio.js';
import { getQuote } from '../data/market.js';
import { displayHeader, displayPortfolioTable, displayTradesTable, formatCurrency, formatPercent } from './display.js';
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
  const pricePromises = openTrades.map(async (trade) => {
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
  const pnlPct = totalCapital > 0 ? (totalPnl / totalCapital * 100) : 0;

  console.log(`  Total Unrealized P&L: ${pnlColor(formatCurrency(totalPnl))} (${formatPercent(pnlPct)})`);
  console.log(`  Positions: ${tradesWithPrices.length}\n`);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function displayPerformanceStats(stats) {
  const table = new Table({
    head: [
      chalk.cyan('Metric'),
      chalk.cyan('Value'),
    ],
    style: { head: [], border: ['gray'] },
    colWidths: [25, 20],
  });

  const totalPnl = stats.totalPnl || 0;
  const bestPnl = stats.bestTrade ? (stats.bestTrade.pnl || 0) : 0;
  const worstPnl = stats.worstTrade ? (stats.worstTrade.pnl || 0) : 0;

  table.push(
    ['Period', String(stats.period || '30 days')],
    ['Total Trades', String(stats.totalTrades || 0)],
    ['Win Rate', formatPercent(stats.winRate || 0)],
    ['Avg Win', chalk.green(formatCurrency(stats.avgWin || 0))],
    ['Avg Loss', chalk.red(formatCurrency(stats.avgLoss || 0))],
    ['Profit Factor', String(stats.profitFactor || 0)],
    ['Total P&L', totalPnl >= 0
      ? chalk.green(formatCurrency(totalPnl))
      : chalk.red(formatCurrency(totalPnl))],
    ['Max Drawdown', chalk.red(formatCurrency(stats.maxDrawdown || 0))],
    ['Best Trade', `${formatCurrency(bestPnl)} ${stats.bestTrade?.symbol ? `(${stats.bestTrade.symbol})` : ''}`],
    ['Worst Trade', `${formatCurrency(worstPnl)} ${stats.worstTrade?.symbol ? `(${stats.worstTrade.symbol})` : ''}`],
  );

  console.log(chalk.bold.white('\n  Performance Stats:\n'));
  console.log(table.toString());
}

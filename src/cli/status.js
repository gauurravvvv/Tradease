import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import boxen from 'boxen';
import { checkIndexHealth } from '../listeners/index-monitor.js';
import { getGlobalCues } from '../data/global-cues.js';
import { getFiiDiiData } from '../data/fii-dii.js';
import { getSectorStrength } from '../analysis/sectors.js';
import {
  displayFiiDiiBar,
  displaySectorBar,
  displaySentimentBar,
  formatCurrency,
  formatPercent,
} from './display.js';

/**
 * Determine if Indian market is currently open.
 * NSE hours: Mon-Fri 9:15 AM – 3:30 PM IST.
 */
function getMarketSession() {
  const now = new Date();
  const ist = new Date(
    now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
  );
  const day = ist.getDay(); // 0=Sun, 6=Sat
  const h = ist.getHours();
  const m = ist.getMinutes();
  const mins = h * 60 + m;

  if (day === 0 || day === 6)
    return { status: 'CLOSED', label: 'Weekend', color: chalk.gray };
  if (mins < 9 * 60)
    return { status: 'PRE-MARKET', label: 'Pre-market', color: chalk.yellow };
  if (mins < 9 * 60 + 15)
    return {
      status: 'PRE-OPEN',
      label: 'Pre-open auction',
      color: chalk.yellow,
    };
  if (mins < 15 * 60 + 30)
    return { status: 'OPEN', label: 'Market Open', color: chalk.green };
  if (mins < 16 * 60)
    return { status: 'POST-MARKET', label: 'Post-market', color: chalk.yellow };
  return { status: 'CLOSED', label: 'Market Closed', color: chalk.gray };
}

/**
 * Run full market status display.
 */
export async function runMarketStatus() {
  const spinner = ora('Fetching market data...').start();

  // Fetch everything in parallel
  const [indexHealth, globalCues, fiiDii, sectors] = await Promise.allSettled([
    checkIndexHealth(),
    getGlobalCues(),
    getFiiDiiData(),
    getSectorStrength(),
  ]);

  spinner.stop();

  const index = indexHealth.status === 'fulfilled' ? indexHealth.value : null;
  const global = globalCues.status === 'fulfilled' ? globalCues.value : null;
  const fii = fiiDii.status === 'fulfilled' ? fiiDii.value : null;
  const sectorData = sectors.status === 'fulfilled' ? sectors.value : [];

  // ── Header ──────────────────────────────────────────────
  const session = getMarketSession();
  const now = new Date();
  const timeStr = now.toLocaleString('en-IN', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  });

  const statusBadge =
    session.status === 'OPEN'
      ? chalk.bgGreen.black.bold(` ${session.status} `)
      : session.status.includes('PRE') || session.status === 'POST-MARKET'
        ? chalk.bgYellow.black.bold(` ${session.status} `)
        : chalk.bgGray.white.bold(` ${session.status} `);

  const headerLines = [];
  headerLines.push(
    `  ${chalk.bold.cyan('TRADEASE')}  ${statusBadge}  ${chalk.gray(timeStr)}`,
  );

  // ── Index Levels ────────────────────────────────────────
  if (index) {
    const nifty = index.nifty || {};
    const bank = index.bankNifty || {};
    const sevColor =
      index.severity === 'critical'
        ? chalk.red
        : index.severity === 'warning'
          ? chalk.yellow
          : chalk.green;

    headerLines.push('');
    headerLines.push(
      `  ${chalk.white.bold('NIFTY')}   ${chalk.white(nifty.price ? nifty.price.toLocaleString('en-IN') : '--')} ${formatPercent(nifty.changePct)}` +
        `    ${chalk.white.bold('BANKNIFTY')}   ${chalk.white(bank.price ? bank.price.toLocaleString('en-IN') : '--')} ${formatPercent(bank.changePct)}` +
        `    ${sevColor.bold(index.severity?.toUpperCase() || 'NORMAL')}`,
    );
  }

  // ── VIX ─────────────────────────────────────────────────
  if (global?.volatility?.vix) {
    const vix = global.volatility.vix;
    const vixColor =
      vix.price > 20 ? chalk.red : vix.price > 15 ? chalk.yellow : chalk.green;
    headerLines.push(
      `  ${chalk.white.bold('VIX')}     ${vixColor(vix.price?.toFixed(1))} ${formatPercent(vix.changePct)}`,
    );
  }

  console.log(
    boxen(headerLines.join('\n'), {
      padding: { top: 0, bottom: 0, left: 0, right: 1 },
      margin: { top: 1, bottom: 0 },
      borderStyle: 'double',
      borderColor: session.status === 'OPEN' ? 'green' : 'gray',
    }),
  );

  // ── Global Cues ─────────────────────────────────────────
  if (global) {
    console.log('');
    console.log(chalk.bold.cyan('  GLOBAL MARKETS'));
    console.log(chalk.gray('  ' + '─'.repeat(55)));

    const globalTable = new Table({
      style: { head: [], border: ['gray'] },
      colWidths: [18, 12, 10],
      head: [chalk.cyan('Market'), chalk.cyan('Price'), chalk.cyan('Change')],
    });

    const addRow = (name, q) => {
      if (!q) return;
      const chg = formatPercent(q.changePct);
      globalTable.push([
        chalk.white(name),
        chalk.white(q.price?.toFixed(1) || '--'),
        chg,
      ]);
    };

    addRow('S&P 500', global.us?.sp500);
    addRow('Nasdaq', global.us?.nasdaq);
    addRow('Dow Jones', global.us?.dow);
    addRow('Nikkei 225', global.asia?.nikkei);
    addRow('Hang Seng', global.asia?.hangSeng);
    addRow('Crude WTI', global.commodities?.crudeWTI);
    addRow('Brent Crude', global.commodities?.brentCrude);
    addRow('Gold', global.commodities?.gold);
    addRow('Dollar Index', global.currencies?.dollarIndex);
    addRow('US 10Y Yield', global.bonds?.us10y);

    console.log(globalTable.toString());

    // Sentiment
    if (global.sentimentScore != null) {
      console.log(
        `  ${chalk.white('GLOBAL MOOD:')} ${displaySentimentBar(global.sentimentScore)}`,
      );
    }
  }

  // ── FII/DII Flows ──────────────────────────────────────
  if (fii) {
    console.log('');
    console.log(chalk.bold.cyan('  FII/DII FLOWS'));
    console.log(chalk.gray('  ' + '─'.repeat(55)));
    const bar = displayFiiDiiBar(fii);
    if (bar) console.log('  ' + bar);
  }

  // ── Sector Rotation ────────────────────────────────────
  if (sectorData.length > 0) {
    console.log('');
    console.log(chalk.bold.cyan('  SECTOR ROTATION'));
    console.log(chalk.gray('  ' + '─'.repeat(55)));

    const sectorTable = new Table({
      style: { head: [], border: ['gray'] },
      head: [
        chalk.cyan('#'),
        chalk.cyan('Sector'),
        chalk.cyan('Change'),
        chalk.cyan('Trend'),
      ],
      colWidths: [4, 24, 10, 10],
    });

    const sorted = [...sectorData].sort(
      (a, b) => (b.todayChange || 0) - (a.todayChange || 0),
    );
    sorted.forEach((s, i) => {
      const chg =
        s.todayChange != null ? formatPercent(s.todayChange) : chalk.gray('--');
      const trendIcon = s.trend?.includes('up')
        ? chalk.green('▲')
        : s.trend?.includes('down')
          ? chalk.red('▼')
          : chalk.gray('─');
      sectorTable.push([
        chalk.gray(String(i + 1)),
        chalk.white(s.sector?.replace('Nifty ', '') || '--'),
        chg,
        trendIcon,
      ]);
    });

    console.log(sectorTable.toString());

    // Hot/Cold summary
    const bar = displaySectorBar(sectorData);
    if (bar) console.log('  ' + bar);
  }

  console.log('');
}

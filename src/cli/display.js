import chalk from 'chalk';
import Table from 'cli-table3';
import boxen from 'boxen';

// ---------------------------------------------------------------------------
// Currency & number formatting
// ---------------------------------------------------------------------------

/**
 * Format amount as ₹XX,XXX with Indian numbering (lakhs/crores).
 */
export function formatCurrency(amount) {
  if (amount == null || isNaN(amount)) return '₹0';

  const negative = amount < 0;
  const abs = Math.abs(amount);
  const formatted = abs.toLocaleString('en-IN', {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  });

  return `${negative ? '-' : ''}₹${formatted}`;
}

/**
 * Format as +X.XX% or -X.XX% with color.
 */
export function formatPercent(value) {
  if (value == null || isNaN(value)) return chalk.gray('0.00%');

  const sign = value >= 0 ? '+' : '';
  const text = `${sign}${value.toFixed(2)}%`;

  if (value > 0) return chalk.green(text);
  if (value < 0) return chalk.red(text);
  return chalk.gray(text);
}

// ---------------------------------------------------------------------------
// Confidence bar
// ---------------------------------------------------------------------------

/**
 * Star rating from confidence score.
 */
export function displayConfidenceBar(confidence) {
  let stars;
  if (confidence >= 90) stars = '\u2605\u2605\u2605\u2605\u2605';
  else if (confidence >= 75) stars = '\u2605\u2605\u2605\u2605\u2606';
  else if (confidence >= 60) stars = '\u2605\u2605\u2605\u2606\u2606';
  else if (confidence >= 40) stars = '\u2605\u2605\u2606\u2606\u2606';
  else stars = '\u2605\u2606\u2606\u2606\u2606';

  if (confidence > 80) return chalk.green(stars);
  if (confidence >= 60) return chalk.yellow(stars);
  return chalk.red(stars);
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/**
 * Boxed header with title and subtitle.
 */
export function displayHeader(title, subtitle) {
  const content = subtitle
    ? `${chalk.bold.cyan(title)}\n${chalk.gray(subtitle)}`
    : chalk.bold.cyan(title);

  console.log(boxen(content, {
    padding: 1,
    margin: { top: 1, bottom: 1 },
    borderStyle: 'double',
    borderColor: 'cyan',
  }));
}

// ---------------------------------------------------------------------------
// Trade card
// ---------------------------------------------------------------------------

/**
 * Display single trade recommendation in formatted card.
 */
export function displayTradeCard(trade, index = 1) {
  const typeColor = trade.type === 'CALL' ? chalk.green : chalk.red;
  const confColor = trade.confidence >= 75 ? chalk.white : chalk.yellow;
  const stars = displayConfidenceBar(trade.confidence);

  const symbolStr = chalk.bold.white(trade.symbol);
  const typeStr = typeColor.bold(trade.type);
  const confStr = confColor(`Confidence: ${trade.confidence}%`);

  console.log(`\n  ${chalk.gray(`#${index}`)}  ${symbolStr}  | ${typeStr} | ${confStr} | ${stars}`);

  const strike = trade.strike ? `₹${trade.strike.toLocaleString('en-IN')}` : '—';
  const expiry = trade.expiry || '—';
  console.log(chalk.gray(`  \u251C\u2500 Entry: ${strike} ${trade.type === 'CALL' ? 'CE' : 'PE'} (${expiry} expiry)`));

  const premium = trade.premium ? `~₹${trade.premium.toLocaleString('en-IN')}` : '—';
  const lot = trade.lotSize || '—';
  const capital = trade.capitalRequired ? formatCurrency(trade.capitalRequired) : '—';
  console.log(chalk.gray(`  \u251C\u2500 Premium: ${premium} | Lot: ${lot} | Capital: ${capital}`));

  const slPct = trade.entry_price && trade.stop_loss
    ? ((trade.stop_loss - trade.entry_price) / trade.entry_price * 100).toFixed(0)
    : '—';
  const t1Pct = trade.entry_price && trade.target1
    ? ((trade.target1 - trade.entry_price) / trade.entry_price * 100).toFixed(0)
    : '—';
  const t2Pct = trade.entry_price && trade.target2
    ? ((trade.target2 - trade.entry_price) / trade.entry_price * 100).toFixed(0)
    : '—';
  const maxLoss = trade.maxLoss ? formatCurrency(trade.maxLoss) : '—';

  const sl = trade.stop_loss ? `₹${trade.stop_loss.toLocaleString('en-IN')}` : '—';
  const t1 = trade.target1 ? `₹${trade.target1.toLocaleString('en-IN')}` : '—';
  const t2 = trade.target2 ? `₹${trade.target2.toLocaleString('en-IN')}` : '—';

  console.log(chalk.gray(`  \u251C\u2500 Stop-Loss: ${sl} (${slPct}%) | Target 1: ${t1} (${t1Pct}%)`));
  console.log(chalk.gray(`  \u251C\u2500 Target 2: ${t2} (${t2Pct}%) | Max Loss: ${maxLoss}`));

  if (trade.reason) {
    console.log(chalk.gray(`  \u251C\u2500 Reason: ${chalk.white(trade.reason)}`));
  }
  if (trade.risk) {
    console.log(chalk.gray(`  \u2514\u2500 Risk: ${chalk.yellow(trade.risk)}`));
  } else {
    // Close the tree
    console.log(chalk.gray('  \u2514\u2500'));
  }
}

// ---------------------------------------------------------------------------
// Portfolio table
// ---------------------------------------------------------------------------

/**
 * Display portfolio summary as table.
 */
export function displayPortfolioTable(portfolio) {
  const table = new Table({
    head: [
      chalk.cyan('Capital'),
      chalk.cyan('In Use'),
      chalk.cyan('Available'),
      chalk.cyan('Open Positions'),
      chalk.cyan('Unrealized P&L'),
    ],
    style: { head: [], border: ['gray'] },
  });

  const pnlColor = portfolio.unrealizedPnl >= 0 ? chalk.green : chalk.red;

  table.push([
    formatCurrency(portfolio.totalCapital),
    formatCurrency(portfolio.capitalInUse),
    formatCurrency(portfolio.availableCapital),
    String(portfolio.openPositions),
    pnlColor(formatCurrency(portfolio.unrealizedPnl)),
  ]);

  console.log(table.toString());
}

// ---------------------------------------------------------------------------
// Trades table
// ---------------------------------------------------------------------------

/**
 * Display active trades table with live P&L.
 */
export function displayTradesTable(trades) {
  if (!trades || trades.length === 0) {
    console.log(chalk.gray('\n  No active trades.\n'));
    return;
  }

  const table = new Table({
    head: [
      chalk.cyan('Symbol'),
      chalk.cyan('Type'),
      chalk.cyan('Entry'),
      chalk.cyan('Current'),
      chalk.cyan('SL'),
      chalk.cyan('T1'),
      chalk.cyan('T2'),
      chalk.cyan('P&L'),
      chalk.cyan('Status'),
    ],
    style: { head: [], border: ['gray'] },
    colWidths: [14, 6, 10, 10, 10, 10, 10, 12, 10],
  });

  for (const t of trades) {
    const pnl = t.current_price && t.entry_price
      ? (t.current_price - t.entry_price) * (t.quantity || 1)
      : 0;
    const pnlPct = t.entry_price
      ? ((t.current_price - t.entry_price) / t.entry_price * 100)
      : 0;
    const pnlStr = `${formatCurrency(pnl)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`;
    const pnlColored = pnl >= 0 ? chalk.green(pnlStr) : chalk.red(pnlStr);

    const typeStr = t.type === 'CALL' ? chalk.green(t.type) : chalk.red(t.type);

    const statusColor = t.status === 'OPEN' ? chalk.green : chalk.gray;

    table.push([
      chalk.white(t.symbol),
      typeStr,
      formatCurrency(t.entry_price),
      formatCurrency(t.current_price || 0),
      formatCurrency(t.stop_loss),
      formatCurrency(t.target1 || 0),
      formatCurrency(t.target2 || 0),
      pnlColored,
      statusColor(t.status),
    ]);
  }

  console.log(table.toString());
}

// ---------------------------------------------------------------------------
// Market pulse
// ---------------------------------------------------------------------------

/**
 * Display Nifty and BankNifty with change%.
 */
export function displayMarketPulse(indexData) {
  const { nifty, bankNifty } = indexData;

  const niftyChange = formatPercent(nifty.changePct);
  const bankNiftyChange = formatPercent(bankNifty.changePct);

  const niftyPrice = nifty.price ? nifty.price.toLocaleString('en-IN') : '—';
  const bankNiftyPrice = bankNifty.price ? bankNifty.price.toLocaleString('en-IN') : '—';

  const severityBadge = indexData.severity === 'critical'
    ? chalk.bgRed.white.bold(' CRITICAL ')
    : indexData.severity === 'warning'
      ? chalk.bgYellow.black.bold(' WARNING ')
      : chalk.bgGreen.black(' NORMAL ');

  console.log(`\n  ${chalk.bold('NIFTY 50')}     ${niftyPrice}  ${niftyChange}`);
  console.log(`  ${chalk.bold('BANK NIFTY')}   ${bankNiftyPrice}  ${bankNiftyChange}`);
  console.log(`  Status: ${severityBadge}\n`);
}

// ---------------------------------------------------------------------------
// Morning brief
// ---------------------------------------------------------------------------

/**
 * Full morning brief: header, global cues, trade cards, action menu.
 */
export function displayMorningBrief(recommendations, globalCues) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  displayHeader('TradeOracle Morning Brief', dateStr);

  // Global cues bar
  if (globalCues) {
    console.log(chalk.bold.white('  Global Cues:'));

    if (globalCues.sgxNifty != null) {
      console.log(`    SGX Nifty: ${formatPercent(globalCues.sgxNifty)}`);
    }
    if (globalCues.dowJones != null) {
      console.log(`    Dow Jones: ${formatPercent(globalCues.dowJones)}`);
    }
    if (globalCues.nasdaq != null) {
      console.log(`    NASDAQ:    ${formatPercent(globalCues.nasdaq)}`);
    }
    if (globalCues.asianMarkets != null) {
      console.log(`    Asia:      ${formatPercent(globalCues.asianMarkets)}`);
    }
    if (globalCues.crude != null) {
      console.log(`    Crude Oil: ${formatPercent(globalCues.crude)}`);
    }
    if (globalCues.dxy != null) {
      console.log(`    DXY:       ${formatPercent(globalCues.dxy)}`);
    }

    console.log('');
  }

  // Trade cards
  if (!recommendations || recommendations.length === 0) {
    console.log(chalk.yellow('  No trade recommendations today.\n'));
  } else {
    console.log(chalk.bold.white(`  Top ${recommendations.length} Trade Ideas:\n`));
    recommendations.forEach((rec, i) => displayTradeCard(rec, i + 1));
  }

  // Action menu
  console.log('');
  console.log(chalk.gray('  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500'));
  console.log(`  ${chalk.cyan('[E]')}xecute all  |  ${chalk.cyan('[1-' + (recommendations?.length || 'N') + ']')} specific  |  ${chalk.cyan('[S]')}kip  |  ${chalk.cyan('[D]')}eep #N`);
  console.log('');
}

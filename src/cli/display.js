import chalk from 'chalk';
import Table from 'cli-table3';
import boxen from 'boxen';

// Conditional import — global-cues.js may still be in-flight from another agent
let getGlobalCues;
try {
  const mod = await import('../data/global-cues.js');
  getGlobalCues = mod.getGlobalCues;
} catch {
  getGlobalCues = null;
}

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

/**
 * Format market cap in ₹ Cr / ₹L Cr notation.
 * Input expected in absolute rupees.
 */
export function formatMarketCap(value) {
  if (value == null || isNaN(value)) return '—';
  const crores = value / 1e7;
  if (crores >= 1e5) return `₹${(crores / 1e5).toFixed(1)}L Cr`;
  if (crores >= 1000) return `₹${(crores / 1000).toFixed(1)}K Cr`;
  return `₹${Math.round(crores)} Cr`;
}

/**
 * Format volume as 15.9M / 1.2L / 5.3K.
 */
export function formatVolume(value) {
  if (value == null || isNaN(value)) return '—';
  if (value >= 1e7) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e5) return `${(value / 1e5).toFixed(1)}L`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(value);
}

// ---------------------------------------------------------------------------
// Confidence block bar
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

/**
 * Visual block bar for confidence: ████████░░ 85%
 * 10-block scale. Color: green >= 70, yellow >= 50, red < 50.
 */
export function displayConfidenceBlock(confidence) {
  const c = Math.max(0, Math.min(100, confidence || 0));
  const filled = Math.round(c / 10);
  const empty = 10 - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
  const pct = `${c}%`;

  if (c >= 70) return chalk.green(bar) + ' ' + chalk.green.bold(pct);
  if (c >= 50) return chalk.yellow(bar) + ' ' + chalk.yellow.bold(pct);
  return chalk.red(bar) + ' ' + chalk.red.bold(pct);
}

/**
 * Sentiment bar for -100 to +100 score.
 * Maps to 10-block scale centered at 5.
 */
export function displaySentimentBar(score) {
  const s = Math.max(-100, Math.min(100, score || 0));
  // Map -100..+100 to 0..10
  const filled = Math.round(((s + 100) / 200) * 10);
  const empty = 10 - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);

  let label, colorFn;
  if (s >= 25) { label = 'BULLISH'; colorFn = chalk.green; }
  else if (s <= -25) { label = 'BEARISH'; colorFn = chalk.red; }
  else { label = 'MIXED'; colorFn = chalk.yellow; }

  return colorFn(bar) + ' ' + colorFn.bold(label);
}

// ---------------------------------------------------------------------------
// Global cues bar
// ---------------------------------------------------------------------------

/**
 * Compact global cues display. Takes output from getGlobalCues().
 * Returns array of formatted lines (no leading newlines).
 */
export function displayGlobalCuesBar(cues) {
  if (!cues) return [];

  const lines = [];

  // US + Asia line
  const parts1 = [];
  if (cues.us?.sp500) parts1.push(`S&P ${signedPct(cues.us.sp500.changePct)}`);
  if (cues.us?.nasdaq) parts1.push(`Nasdaq ${signedPct(cues.us.nasdaq.changePct)}`);
  if (cues.asia?.nikkei) parts1.push(`Nikkei ${signedPct(cues.asia.nikkei.changePct)}`);
  if (parts1.length > 0) {
    lines.push(chalk.white('  GLOBAL: ') + parts1.map(p => colorByPct(p, extractPct(p))).join(chalk.gray(' | ')));
  }

  // Commodities + DXY + VIX line
  const parts2 = [];
  const crude = cues.commodities?.crudeWTI || cues.commodities?.brentCrude;
  if (crude) parts2.push(`Crude: $${crude.price?.toFixed(0)}(${signedPct(crude.changePct)})`);
  if (cues.currencies?.dollarIndex) parts2.push(`DXY: ${cues.currencies.dollarIndex.price?.toFixed(0)}(${signedPct(cues.currencies.dollarIndex.changePct)})`);
  if (cues.volatility?.vix) parts2.push(`VIX: ${cues.volatility.vix.price?.toFixed(0)}(${signedPct(cues.volatility.vix.changePct)})`);
  if (parts2.length > 0) {
    lines.push(chalk.white('  ') + parts2.join(chalk.gray(' | ')));
  }

  // Sentiment bar
  if (cues.sentimentScore != null) {
    lines.push(chalk.white('  MOOD: ') + displaySentimentBar(cues.sentimentScore));
  }

  return lines;
}

/** Helper: "+0.8%" style string */
function signedPct(val) {
  if (val == null || isNaN(val)) return 'N/A';
  return `${val >= 0 ? '+' : ''}${val.toFixed(1)}%`;
}

/** Extract numeric pct from string like "+0.8%" */
function extractPct(str) {
  const m = str.match(/([+-]?\d+\.?\d*)%/);
  return m ? parseFloat(m[1]) : 0;
}

/** Color a string green/red based on pct value */
function colorByPct(str, pct) {
  if (pct > 0) return chalk.green(str);
  if (pct < 0) return chalk.red(str);
  return chalk.gray(str);
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
// Trade card — redesigned for at-a-glance clarity
// ---------------------------------------------------------------------------

/**
 * Display single trade recommendation as compact scannable card.
 *
 * Layout:
 * ╭──────────────────────────────────────────────────────╮
 * │  ██ CALL  RELIANCE  ██████████░░ 85%  ★★★★☆         │
 * │  ₹2,450 CE  Apr 25 expiry  Lot: 250                 │
 * │  Entry: ₹45  →  T1: ₹65 (+44%)  →  T2: ₹80 (+78%)  │
 * │  SL: ₹32 (-29%)  |  Max Loss: ₹3,250                │
 * │  PE: 28.5  |  52W: ₹2,100-₹2,800  |  MCap: ₹16.5L  │
 * │  RSI: 65  MACD: ↑  Vol: 2.1x  ATR: 2.8%             │
 * │  Patterns: Bullish Engulfing + Support Bounce         │
 * │  WHY: Q4 beat + OI buildup at 2400 support            │
 * │  RISK: Broad market weakness if global reverse         │
 * ╰──────────────────────────────────────────────────────╯
 */
export function displayTradeCard(trade, index = 1) {
  const isCall = trade.type === 'CALL';
  const typeBadge = isCall
    ? chalk.bgGreen.white.bold(` ${trade.type} `)
    : chalk.bgRed.white.bold(` ${trade.type} `);

  const confBlock = displayConfidenceBlock(trade.confidence || 0);
  const stars = displayConfidenceBar(trade.confidence || 0);

  // --- Build card lines ---
  const lines = [];

  // Line 1: Big verdict — type badge + symbol + confidence bar + stars
  lines.push(`  ${typeBadge}  ${chalk.bold.white(trade.symbol)}  ${confBlock}  ${stars}`);

  // Line 2: Strike / expiry / lot
  const strike = trade.strike ? `\u20B9${trade.strike.toLocaleString('en-IN')}` : '';
  const optType = isCall ? 'CE' : 'PE';
  const expiry = trade.expiry || '';
  const lot = trade.lotSize ? `Lot: ${trade.lotSize}` : '';
  const strikeLine = [
    strike ? `${strike} ${optType}` : '',
    expiry ? `${expiry} expiry` : '',
    lot,
  ].filter(Boolean).join('  ');
  if (strikeLine) lines.push(`  ${chalk.white(strikeLine)}`);

  // Line 3: Entry → T1 → T2 flow
  const entry = trade.entry_price || trade.premium;
  const entryStr = entry ? `\u20B9${entry.toLocaleString('en-IN')}` : '—';
  const t1Pct = entry && trade.target1
    ? ` (${((trade.target1 - entry) / entry * 100).toFixed(0)}%)`
    : '';
  const t2Pct = entry && trade.target2
    ? ` (${((trade.target2 - entry) / entry * 100).toFixed(0)}%)`
    : '';
  const t1Str = trade.target1 ? `\u20B9${trade.target1.toLocaleString('en-IN')}` : '—';
  const t2Str = trade.target2 ? `\u20B9${trade.target2.toLocaleString('en-IN')}` : '—';
  lines.push(
    `  ${chalk.gray('Entry:')} ${chalk.white.bold(entryStr)}  ${chalk.gray('\u2192')}  ` +
    `${chalk.gray('T1:')} ${chalk.green(t1Str + t1Pct)}  ${chalk.gray('\u2192')}  ` +
    `${chalk.gray('T2:')} ${chalk.green(t2Str + t2Pct)}`
  );

  // Line 4: SL + Max Loss
  const slPct = entry && trade.stop_loss
    ? ` (${((trade.stop_loss - entry) / entry * 100).toFixed(0)}%)`
    : '';
  const slStr = trade.stop_loss ? `\u20B9${trade.stop_loss.toLocaleString('en-IN')}` : '—';
  const maxLoss = trade.maxLoss ? formatCurrency(trade.maxLoss) : '';
  const slLine = `${chalk.gray('SL:')} ${chalk.red(slStr + slPct)}` +
    (maxLoss ? `  ${chalk.gray('|')}  ${chalk.gray('Max Loss:')} ${chalk.red(maxLoss)}` : '');
  lines.push(`  ${slLine}`);

  // Line 5: Sector tag — compact inline
  const sectorParts = [];
  if (trade.sector) sectorParts.push(trade.sector);
  if (trade.sectorRank != null) sectorParts.push(`#${trade.sectorRank}`);
  if (trade.sectorTrend) {
    const trendIcon = trade.sectorTrend.includes('up') ? '↑' : trade.sectorTrend.includes('down') ? '↓' : '→';
    sectorParts.push(trendIcon);
  }
  if (sectorParts.length > 0) {
    const sectorColor = trade.sectorTrend?.includes('up') ? chalk.green
      : trade.sectorTrend?.includes('down') ? chalk.red
      : chalk.gray;
    lines.push(`  ${chalk.gray('Sector:')} ${sectorColor(sectorParts.join(' '))}`);
  }

  // Line 6: Fundamentals (PE, 52W, MCap) — only if data present
  const fundParts = [];
  if (trade.pe != null) fundParts.push(`PE: ${trade.pe}`);
  if (trade.week52Low != null && trade.week52High != null) {
    fundParts.push(`52W: \u20B9${trade.week52Low.toLocaleString('en-IN')}-\u20B9${trade.week52High.toLocaleString('en-IN')}`);
  }
  if (trade.marketCap != null) fundParts.push(`MCap: ${formatMarketCap(trade.marketCap)}`);
  if (trade.eps != null) fundParts.push(`EPS: \u20B9${trade.eps}`);
  if (fundParts.length > 0) {
    lines.push(`  ${chalk.cyan(fundParts.join('  |  '))}`);
  }

  // Line 6: Technicals summary (RSI, MACD, Vol, ATR) — only if data present
  const techParts = [];
  if (trade.rsi != null) techParts.push(`RSI: ${trade.rsi}`);
  if (trade.macdTrend) techParts.push(`MACD: ${trade.macdTrend.includes('bullish') ? '\u2191' : '\u2193'}`);
  if (trade.volumeRatio != null) techParts.push(`Vol: ${trade.volumeRatio.toFixed(1)}x`);
  if (trade.atrPct != null) techParts.push(`ATR: ${trade.atrPct.toFixed(1)}%`);
  if (techParts.length > 0) {
    lines.push(`  ${chalk.yellow(techParts.join('  '))}`);
  }

  // Line 7: Candlestick patterns — only if present
  if (trade.patterns && trade.patterns.length > 0) {
    const patStr = Array.isArray(trade.patterns) ? trade.patterns.join(' + ') : trade.patterns;
    lines.push(`  ${chalk.gray('Patterns:')} ${chalk.magenta(patStr)}`);
  }

  // Line 8: WHY (reason)
  if (trade.reason) {
    lines.push(`  ${chalk.green.bold('WHY:')} ${chalk.white(trade.reason)}`);
  }

  // Line 9: RISK
  if (trade.risk) {
    lines.push(`  ${chalk.red.bold('RISK:')} ${chalk.yellow(trade.risk)}`);
  }

  // Render as boxen card
  const cardContent = lines.join('\n');
  const borderColor = isCall ? 'green' : 'red';
  console.log(boxen(cardContent, {
    padding: { top: 0, bottom: 0, left: 0, right: 1 },
    margin: { top: 1, bottom: 0, left: 1, right: 0 },
    borderStyle: 'round',
    borderColor,
    title: chalk.gray(`#${index}`),
    titleAlignment: 'left',
  }));
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
// Market pulse — compact index bar
// ---------------------------------------------------------------------------

/**
 * Display Nifty and BankNifty as compact one-liner with severity.
 */
export function displayMarketPulse(indexData) {
  const { nifty, bankNifty } = indexData;

  const niftyPrice = nifty.price ? nifty.price.toLocaleString('en-IN') : '—';
  const bankNiftyPrice = bankNifty.price ? bankNifty.price.toLocaleString('en-IN') : '—';
  const niftyChange = formatPercent(nifty.changePct);
  const bankNiftyChange = formatPercent(bankNifty.changePct);

  const severityBadge = indexData.severity === 'critical'
    ? chalk.bgRed.white.bold(' CRITICAL ')
    : indexData.severity === 'warning'
      ? chalk.bgYellow.black.bold(' WARNING ')
      : chalk.bgGreen.black(' NORMAL ');

  console.log(`\n  ${chalk.bold('NIFTY:')} ${niftyPrice} ${niftyChange}  ${chalk.gray('|')}  ${chalk.bold('BANKNIFTY:')} ${bankNiftyPrice} ${bankNiftyChange}  ${severityBadge}\n`);
}

// ---------------------------------------------------------------------------
// Morning brief — redesigned with global cues bar
// ---------------------------------------------------------------------------

/**
 * Full morning brief: boxed header with global cues, index prices, trade cards.
 *
 * ╔══════════════════════════════════════════════════════════╗
 * ║  TRADEORACLE                        22 Apr 2026  8:30AM ║
 * ╠══════════════════════════════════════════════════════════╣
 * ║  GLOBAL: S&P +0.8% | Nasdaq +1.2% | Nikkei -0.3%       ║
 * ║  Crude: $82(+0.5%) | DXY: 104(-0.3%) | VIX: 15(-5%)   ║
 * ║  MOOD: ████████░░ BULLISH                                ║
 * ╠══════════════════════════════════════════════════════════╣
 * ║  NIFTY: 24,416 (-0.65%)  |  BANKNIFTY: 57,320 (-0.09%) ║
 * ╚══════════════════════════════════════════════════════════╝
 */
/**
 * Display FII/DII summary bar — compact one-liner.
 * Input: fiiDiiData object from getFiiDiiData().
 * Returns formatted string or null.
 */
export function displayFiiDiiBar(fiiDiiData) {
  if (!fiiDiiData) return null;

  const fiiNet = fiiDiiData.fii?.netValue;
  const diiNet = fiiDiiData.dii?.netValue;
  const sentiment = fiiDiiData.sentiment;

  const fmtCr = (val) => {
    if (val == null || isNaN(val)) return 'N/A';
    const sign = val >= 0 ? '+' : '';
    return `${sign}₹${Math.abs(val).toLocaleString('en-IN')} Cr`;
  };

  const fiiLabel = fiiDiiData.fii?.signal === 'BUYING' ? chalk.green('buying')
    : fiiDiiData.fii?.signal === 'SELLING' ? chalk.red('selling')
    : chalk.gray('neutral');
  const diiLabel = fiiDiiData.dii?.signal === 'BUYING' ? chalk.green('buying')
    : fiiDiiData.dii?.signal === 'SELLING' ? chalk.red('selling')
    : chalk.gray('neutral');

  const fiiStr = fiiNet != null ? (fiiNet >= 0 ? chalk.green(fmtCr(fiiNet)) : chalk.red(fmtCr(fiiNet))) : chalk.gray('N/A');
  const diiStr = diiNet != null ? (diiNet >= 0 ? chalk.green(fmtCr(diiNet)) : chalk.red(fmtCr(diiNet))) : chalk.gray('N/A');

  const sentColor = sentiment === 'BULLISH' ? chalk.green : sentiment === 'BEARISH' ? chalk.red : chalk.yellow;

  return `${chalk.white('FII:')} ${fiiStr}(${fiiLabel}) ${chalk.gray('|')} ${chalk.white('DII:')} ${diiStr}(${diiLabel}) ${chalk.gray('|')} ${sentColor(sentiment)}`;
}

/**
 * Display sector strength summary — top 3 + bottom 3.
 * Input: sectorData array from getSectorStrength().
 * Returns formatted string or null.
 */
export function displaySectorBar(sectorData) {
  if (!sectorData || sectorData.length === 0) return null;

  const sorted = [...sectorData].sort((a, b) => (b.momentumScore || 0) - (a.momentumScore || 0));
  const top3 = sorted.slice(0, 3);
  const bot3 = sorted.slice(-3).reverse();

  const fmtSector = (s) => {
    const name = s.sector?.replace('Nifty ', '') || '?';
    const pct = s.todayChange != null ? `${s.todayChange >= 0 ? '+' : ''}${s.todayChange.toFixed(1)}%` : '';
    return pct ? `${name}(${pct})` : name;
  };

  const hotStr = top3.map(s => chalk.green(fmtSector(s))).join(' ');
  const coldStr = bot3.map(s => chalk.red(fmtSector(s))).join(' ');

  return `${chalk.white('HOT:')} ${hotStr}  ${chalk.gray('|')}  ${chalk.white('COLD:')} ${coldStr}`;
}

export function displayMorningBrief(recommendations, globalCues, fiiDiiData, sectorData) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  // Build header block
  const headerLines = [];
  headerLines.push(`  ${chalk.bold.cyan('TRADEORACLE')}${' '.repeat(20)}${chalk.gray(`${dateStr}  ${timeStr}`)}`);

  // Global cues section
  if (globalCues) {
    headerLines.push(chalk.gray('  ' + '\u2500'.repeat(55)));
    const cueLines = displayGlobalCuesBar(globalCues);
    headerLines.push(...cueLines);
  }

  // FII/DII flow
  const fiiBar = displayFiiDiiBar(fiiDiiData);
  if (fiiBar) {
    headerLines.push(chalk.gray('  ' + '\u2500'.repeat(55)));
    headerLines.push('  ' + fiiBar);
  }

  // Sector rotation
  const secBar = displaySectorBar(sectorData);
  if (secBar) {
    headerLines.push('  ' + secBar);
  }

  // Index prices section — extract from globalCues or just show separator
  headerLines.push(chalk.gray('  ' + '\u2500'.repeat(55)));

  const headerContent = headerLines.join('\n');
  console.log(boxen(headerContent, {
    padding: { top: 0, bottom: 0, left: 0, right: 1 },
    margin: { top: 1, bottom: 0, left: 0, right: 0 },
    borderStyle: 'double',
    borderColor: 'cyan',
  }));

  // Trade cards
  if (!recommendations || recommendations.length === 0) {
    console.log(chalk.yellow('\n  No trade recommendations today.\n'));
  } else {
    console.log(chalk.bold.white(`\n  Top ${recommendations.length} Trade Ideas`));
    recommendations.forEach((rec, i) => displayTradeCard(rec, i + 1));
  }

  // Action menu — compact
  console.log('');
  console.log(chalk.gray('  ' + '\u2500'.repeat(55)));
  console.log(`  ${chalk.cyan('[E]')}xecute all  |  ${chalk.cyan('[1-' + (recommendations?.length || 'N') + ']')} specific  |  ${chalk.cyan('[S]')}kip  |  ${chalk.cyan('[D]')}eep #N`);
  console.log('');
}

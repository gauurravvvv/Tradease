import { getQuote, getHistorical } from '../data/market.js';
import { getStockNews } from '../data/news.js';
import {
  getOptionsChain,
  getNearestExpiry,
  getATMStrike,
} from '../data/options.js';
import { analyzeStockQuick, analyzeStockDeep } from '../analysis/claude.js';
import { analyzeTechnicals } from '../analysis/technicals.js';
import { calculateStopLoss, calculateTargets } from '../trading/risk.js';
import { getFiiDiiData } from '../data/fii-dii.js';
import { getGlobalCues } from '../data/global-cues.js';
import { getSectorForStock } from '../analysis/sectors.js';
import {
  displayHeader,
  displayTradeCard,
  displayFiiDiiBar,
  formatCurrency,
  formatPercent,
  formatMarketCap,
  formatVolume,
  displayConfidenceBlock,
} from './display.js';
import ora from 'ora';
import chalk from 'chalk';
import Table from 'cli-table3';

/**
 * Run research on a single symbol.
 *
 * @param {string} symbol - Stock symbol (e.g. 'RELIANCE')
 * @param {string} mode   - 'quick' or 'deep'
 */
export async function runResearch(symbol, mode = 'quick') {
  const sym = symbol.toUpperCase();

  if (mode === 'deep') {
    return runDeepResearch(sym);
  }
  return runQuickResearch(sym);
}

// ---------------------------------------------------------------------------
// Quick research
// ---------------------------------------------------------------------------

async function runQuickResearch(symbol) {
  displayHeader(
    `Quick Research: ${symbol}`,
    'Quote + Technicals + News → AI Analysis',
  );

  const spinner = ora('Fetching data...').start();

  let quote, news;
  try {
    [quote, news] = await Promise.all([getQuote(symbol), getStockNews(symbol)]);
    spinner.succeed('Data fetched');
  } catch (err) {
    spinner.fail(`Data fetch failed: ${err.message}`);
    return null;
  }

  // Display current quote
  displayQuoteCard(quote);

  // Show recent news
  if (news.length > 0) {
    console.log(chalk.bold.white('\n  Recent News:'));
    for (const item of news.slice(0, 5)) {
      const date = item.pubDate
        ? new Date(item.pubDate).toLocaleDateString('en-IN')
        : '';
      console.log(chalk.gray(`    ${date}  ${item.title}`));
    }
  } else {
    console.log(chalk.gray('\n  No recent news found.'));
  }

  // AI analysis
  const aiSpinner = ora('AI analyzing...').start();
  try {
    const analysis = await analyzeStockQuick({
      symbol,
      price: quote.price,
      change: quote.changePct,
      volume: quote.volume,
      technicals: null,
      news: news.slice(0, 10).map(n => n.title),
    });

    aiSpinner.succeed('AI analysis complete');

    const hasUsefulData =
      analysis && analysis.type && analysis.stop_loss && analysis.target1;
    if (hasUsefulData) {
      console.log(chalk.bold.white('\n  AI Recommendation:'));
      displayTradeCard({ symbol, ...analysis }, 1);
      return analysis;
    }
  } catch (err) {
    aiSpinner.warn(`AI unavailable: ${err.message}`);
  }

  // Fallback: fetch history + compute technicals
  try {
    const history = await getHistorical(symbol, 90);
    if (history && history.length >= 20) {
      const technicals = analyzeTechnicals(history);
      console.log(chalk.bold.white('\n  Technicals-Based Recommendation:'));
      const fallback = buildFallbackRecommendation(symbol, quote, technicals);
      displayTradeCard(fallback, 1);
      return fallback;
    }
  } catch (e) {
    /* skip */
  }

  console.log(chalk.yellow('\n  No recommendation available.'));
  return null;
}

// ---------------------------------------------------------------------------
// Deep research
// ---------------------------------------------------------------------------

async function runDeepResearch(symbol) {
  displayHeader(
    `Deep Research: ${symbol}`,
    'Full analysis: 90-day history + Options + All news',
  );

  const spinner = ora('Fetching comprehensive data...').start();

  let quote, history, news, options, fiiDiiData, globalCues, sectorCtx;
  try {
    const results = await Promise.allSettled([
      getQuote(symbol),
      getHistorical(symbol, 90),
      getStockNews(symbol),
      getOptionsChain(symbol),
      getFiiDiiData(),
      getGlobalCues(),
      getSectorForStock(symbol),
    ]);
    quote = results[0].status === 'fulfilled' ? results[0].value : null;
    history = results[1].status === 'fulfilled' ? results[1].value : [];
    news = results[2].status === 'fulfilled' ? results[2].value : [];
    options = results[3].status === 'fulfilled' ? results[3].value : null;
    fiiDiiData = results[4].status === 'fulfilled' ? results[4].value : null;
    globalCues = results[5].status === 'fulfilled' ? results[5].value : null;
    sectorCtx = results[6].status === 'fulfilled' ? results[6].value : null;

    if (!quote) {
      spinner.fail('Could not fetch quote data');
      return null;
    }
    spinner.succeed('All data fetched');
  } catch (err) {
    spinner.fail(`Data fetch failed: ${err.message}`);
    return null;
  }

  // Display current quote
  displayQuoteCard(quote);

  // Display price history summary
  if (history && history.length > 0) {
    displayHistorySummary(history, symbol);
  }

  // Display options chain summary
  if (options) {
    displayOptionsSnapshot(options);
  }

  // Show market context
  if (fiiDiiData || globalCues) {
    console.log(
      chalk.bold.white('\n  MARKET CONTEXT ') + chalk.gray('\u2500'.repeat(36)),
    );
    if (fiiDiiData) {
      const fiiBar = displayFiiDiiBar(fiiDiiData);
      if (fiiBar) console.log(`  ${fiiBar}`);
    }
    if (globalCues) {
      const sentColor =
        globalCues.sentiment === 'BULLISH'
          ? chalk.green
          : globalCues.sentiment === 'BEARISH'
            ? chalk.red
            : chalk.yellow;
      console.log(
        `  Global: ${sentColor(globalCues.sentiment)} (score: ${globalCues.sentimentScore})`,
      );
    }
    if (sectorCtx) {
      const trendColor = sectorCtx.trend?.includes('up')
        ? chalk.green
        : sectorCtx.trend?.includes('down')
          ? chalk.red
          : chalk.yellow;
      console.log(
        `  Sector: ${chalk.white(sectorCtx.sector)} #${sectorCtx.rank} ${trendColor(sectorCtx.trend || '—')} (mom: ${sectorCtx.momentumScore})`,
      );
    }
  }

  // Show recent news
  if (news.length > 0) {
    console.log(chalk.bold.white('\n  News Feed:'));
    for (const item of news.slice(0, 10)) {
      const date = item.pubDate
        ? new Date(item.pubDate).toLocaleDateString('en-IN')
        : '';
      console.log(chalk.gray(`    ${date}  ${item.title}`));
    }
  }

  // Compute technicals
  let technicals = null;
  if (history && history.length >= 20) {
    try {
      technicals = analyzeTechnicals(history);
      displayTechnicalsSummary(technicals);
    } catch (e) {
      /* skip if fails */
    }
  }

  // Build sector context string for AI
  const sectorStr = sectorCtx
    ? `${sectorCtx.sector} rank #${sectorCtx.rank}, trend: ${sectorCtx.trend}, momentum: ${sectorCtx.momentumScore}`
    : null;

  // Deep AI analysis
  const aiSpinner = ora('Running deep AI analysis...').start();
  try {
    const analysis = await analyzeStockDeep({
      symbol,
      price: quote.price,
      change: quote.changePct,
      volume: quote.volume,
      technicals,
      history90d: history,
      optionsChain: options,
      news: news.map(n => ({ title: n.title, summary: n.snippet })),
      sectorContext: sectorStr,
      fiiDii: fiiDiiData ? fiiDiiData.summary : null,
      globalSentiment: globalCues
        ? `${globalCues.sentiment} (${globalCues.sentimentScore})`
        : null,
    });

    aiSpinner.succeed('Deep analysis complete');

    const hasUsefulData =
      analysis && analysis.type && analysis.stop_loss && analysis.target1;
    if (hasUsefulData) {
      aiSpinner.succeed('Deep analysis complete');
      console.log(chalk.bold.white('\n  AI Deep Recommendation:'));
      displayTradeCard({ symbol, ...analysis }, 1);

      if (analysis.reasoning) {
        console.log(chalk.bold.white('\n  Analysis:'));
        console.log(chalk.gray(`  ${analysis.reasoning}`));
      }
      if (analysis.riskFactors && analysis.riskFactors.length > 0) {
        console.log(chalk.bold.red('\n  Risk Factors:'));
        for (const rf of analysis.riskFactors) {
          console.log(chalk.yellow(`    • ${rf}`));
        }
      }
      return analysis;
    } else {
      aiSpinner.warn('AI returned incomplete data — using technicals');
    }
  } catch (err) {
    aiSpinner.warn(`AI unavailable: ${err.message}`);
  }

  // Fallback: build recommendation from technicals
  if (technicals) {
    console.log(chalk.bold.white('\n  Technicals-Based Recommendation:'));
    const fallback = buildFallbackRecommendation(symbol, quote, technicals);
    displayTradeCard(fallback, 1);
    return fallback;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Compact quote card:
 *   RELIANCE  ₹2,450.30  ▲ +1.2%  Vol: 15.9M (1.8x avg)
 *   O: 2,420  H: 2,465  L: 2,410  PC: 2,421
 *   PE: 28.5  EPS: ₹86  52W: ₹2,100-₹2,800  MCap: ₹16.5L Cr
 */
function displayQuoteCard(quote) {
  const changeColor = quote.changePct >= 0 ? chalk.green : chalk.red;
  const arrow = quote.changePct >= 0 ? '\u25B2' : '\u25BC';
  const priceStr =
    quote.price != null
      ? `\u20B9${quote.price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : '—';

  // Line 1: Symbol + price + change + volume
  const volStr = quote.volume != null ? formatVolume(quote.volume) : '';
  const avgVolStr = quote.avgVolume
    ? ` (${(quote.volume / quote.avgVolume).toFixed(1)}x avg)`
    : '';
  const volPart = volStr ? `  Vol: ${volStr}${avgVolStr}` : '';
  console.log(
    `\n  ${chalk.bold.white(quote.symbol)}  ${chalk.bold(priceStr)}  ${changeColor(`${arrow} ${formatPercent(quote.changePct)}`)}${chalk.gray(volPart)}`,
  );

  // Line 2: OHLC + prev close — compact horizontal
  const o = quote.open ? `O: ${quote.open.toLocaleString('en-IN')}` : '';
  const h = quote.dayHigh ? `H: ${quote.dayHigh.toLocaleString('en-IN')}` : '';
  const l = quote.dayLow ? `L: ${quote.dayLow.toLocaleString('en-IN')}` : '';
  const pc = quote.previousClose
    ? `PC: ${quote.previousClose.toLocaleString('en-IN')}`
    : '';
  const ohlcParts = [o, h, l, pc].filter(Boolean);
  if (ohlcParts.length > 0) {
    console.log(chalk.gray(`  ${ohlcParts.join('  ')}`));
  }

  // Line 3: Fundamentals — PE, EPS, 52W, MCap (if available in quote)
  const fundParts = [];
  if (quote.pe != null) fundParts.push(`PE: ${quote.pe.toFixed(1)}`);
  if (quote.eps != null) fundParts.push(`EPS: \u20B9${quote.eps.toFixed(0)}`);
  if (quote.week52Low != null && quote.week52High != null) {
    fundParts.push(
      `52W: \u20B9${quote.week52Low.toLocaleString('en-IN')}-\u20B9${quote.week52High.toLocaleString('en-IN')}`,
    );
  }
  if (quote.marketCap != null)
    fundParts.push(`MCap: ${formatMarketCap(quote.marketCap)}`);
  if (fundParts.length > 0) {
    console.log(chalk.cyan(`  ${fundParts.join('  ')}`));
  }
  console.log('');
}

/**
 * Compact 90-day price summary — 2 lines.
 */
function displayHistorySummary(history, symbol) {
  const closes = history.map(b => b.close).filter(Boolean);
  if (closes.length === 0) return;

  const current = closes[closes.length - 1];
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const avg = closes.reduce((a, b) => a + b, 0) / closes.length;

  const first10 = closes.slice(0, 10);
  const last10 = closes.slice(-10);
  const first10Avg = first10.reduce((a, b) => a + b, 0) / first10.length;
  const last10Avg = last10.reduce((a, b) => a + b, 0) / last10.length;
  const trend =
    last10Avg > first10Avg
      ? chalk.green('\u2191 UPTREND')
      : chalk.red('\u2193 DOWNTREND');

  console.log(
    chalk.bold.white(`\n  90D PRICE `) + chalk.gray('\u2500'.repeat(42)),
  );
  console.log(
    `  H: ${chalk.green(formatCurrency(max))}  L: ${chalk.red(formatCurrency(min))}  Avg: ${chalk.white(formatCurrency(avg))}  ${trend}`,
  );
  console.log(
    `  Range: ${chalk.white((((max - min) / min) * 100).toFixed(1) + '%')}  From avg: ${formatPercent(((current - avg) / avg) * 100)}`,
  );
}

/**
 * Compact options snapshot — top 3 OI each side + PCR.
 */
function displayOptionsSnapshot(options) {
  if (!options) return;

  const expiry = options.expirationDate
    ? new Date(options.expirationDate).toLocaleDateString('en-IN')
    : '—';

  console.log(
    chalk.bold.white(`\n  OPTIONS `) +
      chalk.gray(`(Exp: ${expiry}) ` + '\u2500'.repeat(35)),
  );

  // Top 3 by OI
  const topCalls = (options.calls || [])
    .filter(c => c.openInterest > 0)
    .sort((a, b) => b.openInterest - a.openInterest)
    .slice(0, 3);

  const topPuts = (options.puts || [])
    .filter(p => p.openInterest > 0)
    .sort((a, b) => b.openInterest - a.openInterest)
    .slice(0, 3);

  if (topCalls.length > 0) {
    const callStrs = topCalls.map(
      c =>
        `${c.strike} OI:${(c.openInterest || 0).toLocaleString('en-IN')} IV:${((c.impliedVolatility || 0) * 100).toFixed(0)}%`,
    );
    console.log(
      `  ${chalk.green('CE:')} ${chalk.gray(callStrs.join('  |  '))}`,
    );
  }

  if (topPuts.length > 0) {
    const putStrs = topPuts.map(
      p =>
        `${p.strike} OI:${(p.openInterest || 0).toLocaleString('en-IN')} IV:${((p.impliedVolatility || 0) * 100).toFixed(0)}%`,
    );
    console.log(`  ${chalk.red('PE:')} ${chalk.gray(putStrs.join('  |  '))}`);
  }

  // PCR line
  const totalCallOI = (options.calls || []).reduce(
    (sum, c) => sum + (c.openInterest || 0),
    0,
  );
  const totalPutOI = (options.puts || []).reduce(
    (sum, p) => sum + (p.openInterest || 0),
    0,
  );
  const pcr = totalCallOI > 0 ? (totalPutOI / totalCallOI).toFixed(2) : '—';
  const pcrColor = pcr > 1 ? chalk.green : pcr < 0.7 ? chalk.red : chalk.yellow;

  console.log(
    `  PCR: ${pcrColor(pcr)}  CallOI: ${chalk.gray(totalCallOI.toLocaleString('en-IN'))}  PutOI: ${chalk.gray(totalPutOI.toLocaleString('en-IN'))}`,
  );
}

/**
 * Compact horizontal technicals layout:
 *   TECHNICALS ──────────────────────────────────
 *   RSI: 65 [neutral]  |  MACD: ↑ bullish  |  ATR: 183 (3.7%)
 *   Volume: 0.4x avg [low]  |  Trend: SMA20>50 ↑
 *   Support: ₹3,945  ₹4,450  |  Resistance: ₹5,303
 *   Fib: 38.2%=₹4,671  50%=₹4,506  61.8%=₹4,340
 *   Patterns: Bullish Engulfing (high), Hammer (medium)
 *   Signal: ████████░░ NEUTRAL (43/100)
 */
function displayTechnicalsSummary(t) {
  console.log(
    chalk.bold.white('\n  TECHNICALS ') + chalk.gray('\u2500'.repeat(40)),
  );

  // Line 1: RSI + MACD + ATR
  const rsiColor =
    t.rsi.signal === 'overbought'
      ? chalk.red
      : t.rsi.signal === 'oversold'
        ? chalk.green
        : chalk.yellow;
  const macdArrow = t.macd.trend?.includes('bullish')
    ? chalk.green('\u2191 bullish')
    : t.macd.trend?.includes('bearish')
      ? chalk.red('\u2193 bearish')
      : chalk.yellow(t.macd.trend || '\u2194');
  const atrStr =
    t.atr.value != null
      ? `${t.atr.value.toFixed(0)} (${t.atr.percentage?.toFixed(1) || '—'}%)`
      : '—';

  console.log(
    `  RSI: ${rsiColor(`${t.rsi.value?.toFixed(0)} [${t.rsi.signal}]`)}  ${chalk.gray('|')}  MACD: ${macdArrow}  ${chalk.gray('|')}  ATR: ${chalk.white(atrStr)}`,
  );

  // Line 2: Volume + trend
  const volSignalColor =
    t.volume.signal === 'surge' || t.volume.signal === 'high'
      ? chalk.green
      : t.volume.signal === 'low'
        ? chalk.red
        : chalk.yellow;
  const volStr = `${t.volume.ratio?.toFixed(1) || '—'}x avg [${t.volume.signal}]`;

  const sma20 = t.sma.sma20;
  const sma50 = t.sma.sma50;
  let trendStr = '';
  if (sma20 != null && sma50 != null) {
    trendStr =
      sma20 > sma50
        ? chalk.green('SMA20>50 \u2191')
        : chalk.red('SMA20<50 \u2193');
  }

  console.log(
    `  Volume: ${volSignalColor(volStr)}  ${chalk.gray('|')}  Trend: ${trendStr}`,
  );

  // Line 3: Support + Resistance
  const supports = (t.supportResistance?.supports || []).slice(0, 3);
  const resistances = (t.supportResistance?.resistances || []).slice(0, 3);
  const supStr =
    supports.length > 0
      ? supports.map(s => chalk.green(`\u20B9${s.toFixed(0)}`)).join('  ')
      : '—';
  const resStr =
    resistances.length > 0
      ? resistances.map(r => chalk.red(`\u20B9${r.toFixed(0)}`)).join('  ')
      : '—';
  console.log(
    `  Support: ${supStr}  ${chalk.gray('|')}  Resistance: ${resStr}`,
  );

  // Line 4: Fibonacci levels (if present)
  if (t.fibonacci) {
    const fibParts = [];
    const fl = t.fibonacci.levels || {};
    if (fl['0.236'] != null) fibParts.push(`23.6%=₹${fl['0.236'].toFixed(0)}`);
    if (fl['0.382'] != null) fibParts.push(`38.2%=₹${fl['0.382'].toFixed(0)}`);
    if (fl['0.5'] != null) fibParts.push(`50%=₹${fl['0.5'].toFixed(0)}`);
    if (fl['0.618'] != null) fibParts.push(`61.8%=₹${fl['0.618'].toFixed(0)}`);
    if (fibParts.length > 0) {
      console.log(`  Fib: ${chalk.gray(fibParts.join('  '))}`);
    }
  }

  // Line 5: Candlestick patterns (if present)
  if (t.candlestickPatterns && t.candlestickPatterns.length > 0) {
    const patStr = t.candlestickPatterns
      .map(p => `${p.name} (${p.reliability || 'med'})`)
      .join(', ');
    console.log(`  Patterns: ${chalk.magenta(patStr)}`);
  }

  // Line 6: Overall signal with confidence block
  const signal = t.overallSignal;
  const sigColor = signal.includes('BUY')
    ? chalk.green
    : signal.includes('SELL')
      ? chalk.red
      : chalk.yellow;
  const score = t.score || 0;
  console.log(
    `  Signal: ${displayConfidenceBlock(score)} ${sigColor(signal)} (${score}/100)`,
  );
}

function buildFallbackRecommendation(symbol, quote, technicals) {
  const { overallSignal } = technicals;
  const type = overallSignal.includes('BUY')
    ? 'CALL'
    : overallSignal.includes('SELL')
      ? 'PUT'
      : 'NEUTRAL';
  const atr = technicals.atr?.value || quote.price * 0.02;
  const sl = calculateStopLoss(
    quote.price,
    atr,
    type === 'NEUTRAL' ? 'CALL' : type,
  );
  const targets = calculateTargets(
    quote.price,
    sl,
    type === 'NEUTRAL' ? 'CALL' : type,
  );
  const expiry = getNearestExpiry();
  const stepSize =
    quote.price > 5000
      ? 100
      : quote.price > 1000
        ? 50
        : quote.price > 500
          ? 25
          : 10;
  const strike = getATMStrike(quote.price, stepSize);

  const reasons = [];
  if (technicals.rsi?.signal !== 'neutral')
    reasons.push(`RSI ${technicals.rsi.signal}`);
  if (technicals.macd?.trend) reasons.push(`MACD ${technicals.macd.trend}`);
  if (technicals.volume?.signal !== 'normal')
    reasons.push(`Volume ${technicals.volume.signal}`);

  return {
    symbol,
    name: symbol,
    type,
    confidence: technicals.score || 50,
    strike,
    expiry: expiry.weekly,
    premium: Math.round(atr * 0.8),
    entry_price: quote.price,
    stop_loss: sl,
    target1: targets.target1,
    target2: targets.target2,
    reason: reasons.join(' + ') || 'Technical analysis',
    risk: 'AI unavailable — technicals only',
  };
}

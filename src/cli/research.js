import { getQuote, getHistorical } from '../data/market.js';
import { getStockNews } from '../data/news.js';
import { getOptionsChain, getNearestExpiry, getATMStrike } from '../data/options.js';
import { analyzeStockQuick, analyzeStockDeep } from '../analysis/claude.js';
import { analyzeTechnicals } from '../analysis/technicals.js';
import { calculateStopLoss, calculateTargets } from '../trading/risk.js';
import { displayHeader, displayTradeCard, formatCurrency, formatPercent } from './display.js';
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
  displayHeader(`Quick Research: ${symbol}`, 'Quote + Technicals + News → AI Analysis');

  const spinner = ora('Fetching data...').start();

  let quote, news;
  try {
    [quote, news] = await Promise.all([
      getQuote(symbol),
      getStockNews(symbol),
    ]);
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
      const date = item.pubDate ? new Date(item.pubDate).toLocaleDateString('en-IN') : '';
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

    const hasUsefulData = analysis && analysis.type && analysis.stop_loss && analysis.target1;
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
  } catch (e) { /* skip */ }

  console.log(chalk.yellow('\n  No recommendation available.'));
  return null;
}

// ---------------------------------------------------------------------------
// Deep research
// ---------------------------------------------------------------------------

async function runDeepResearch(symbol) {
  displayHeader(`Deep Research: ${symbol}`, 'Full analysis: 90-day history + Options + All news');

  const spinner = ora('Fetching comprehensive data...').start();

  let quote, history, news, options;
  try {
    [quote, history, news, options] = await Promise.all([
      getQuote(symbol),
      getHistorical(symbol, 90),
      getStockNews(symbol),
      getOptionsChain(symbol),
    ]);
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

  // Show recent news
  if (news.length > 0) {
    console.log(chalk.bold.white('\n  News Feed:'));
    for (const item of news.slice(0, 10)) {
      const date = item.pubDate ? new Date(item.pubDate).toLocaleDateString('en-IN') : '';
      console.log(chalk.gray(`    ${date}  ${item.title}`));
    }
  }

  // Compute technicals
  let technicals = null;
  if (history && history.length >= 20) {
    try {
      technicals = analyzeTechnicals(history);
      displayTechnicalsSummary(technicals);
    } catch (e) { /* skip if fails */ }
  }

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
      sectorContext: null,
    });

    aiSpinner.succeed('Deep analysis complete');

    const hasUsefulData = analysis && analysis.type && analysis.stop_loss && analysis.target1;
    if (hasUsefulData) {
      aiSpinner.succeed('Deep analysis complete');
      console.log(chalk.bold.white('\n  AI Deep Recommendation:'));
      displayTradeCard({ symbol, ...analysis }, 1);

      if (analysis.detailedAnalysis) {
        console.log(chalk.bold.white('\n  Detailed Analysis:'));
        console.log(chalk.gray(`  ${analysis.detailedAnalysis}`));
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

function displayQuoteCard(quote) {
  const changeColor = quote.changePct >= 0 ? chalk.green : chalk.red;

  console.log(`\n  ${chalk.bold.white(quote.symbol)}  ${changeColor(quote.price?.toLocaleString('en-IN'))}  ${formatPercent(quote.changePct)}`);

  const table = new Table({
    style: { head: [], border: ['gray'] },
  });

  table.push(
    { 'Open': `${formatCurrency(quote.open)}` },
    { 'Day High': `${formatCurrency(quote.dayHigh)}` },
    { 'Day Low': `${formatCurrency(quote.dayLow)}` },
    { 'Prev Close': `${formatCurrency(quote.previousClose)}` },
    { 'Volume': `${(quote.volume || 0).toLocaleString('en-IN')}` },
  );

  console.log(table.toString());
}

function displayHistorySummary(history, symbol) {
  const closes = history.map(b => b.close).filter(Boolean);
  if (closes.length === 0) return;

  const current = closes[closes.length - 1];
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const avg = closes.reduce((a, b) => a + b, 0) / closes.length;

  // Simple trend: compare first 10 avg vs last 10 avg
  const first10 = closes.slice(0, 10);
  const last10 = closes.slice(-10);
  const first10Avg = first10.reduce((a, b) => a + b, 0) / first10.length;
  const last10Avg = last10.reduce((a, b) => a + b, 0) / last10.length;
  const trend = last10Avg > first10Avg ? chalk.green('UPTREND') : chalk.red('DOWNTREND');

  console.log(chalk.bold.white(`\n  90-Day Price Summary (${symbol}):`));
  console.log(chalk.gray(`    High: ${formatCurrency(max)}  |  Low: ${formatCurrency(min)}  |  Avg: ${formatCurrency(avg)}`));
  console.log(chalk.gray(`    Current: ${formatCurrency(current)}  |  Trend: ${trend}`));
  console.log(chalk.gray(`    Range: ${((max - min) / min * 100).toFixed(1)}%  |  From 90d avg: ${formatPercent((current - avg) / avg * 100)}`));
}

function displayOptionsSnapshot(options) {
  if (!options) return;

  const expiry = options.expirationDate
    ? new Date(options.expirationDate).toLocaleDateString('en-IN')
    : '—';

  console.log(chalk.bold.white(`\n  Options Snapshot (Expiry: ${expiry}):`));

  // Show top 5 by OI for calls and puts
  const topCalls = (options.calls || [])
    .filter(c => c.openInterest > 0)
    .sort((a, b) => b.openInterest - a.openInterest)
    .slice(0, 5);

  const topPuts = (options.puts || [])
    .filter(p => p.openInterest > 0)
    .sort((a, b) => b.openInterest - a.openInterest)
    .slice(0, 5);

  if (topCalls.length > 0) {
    console.log(chalk.green('    Top CALL OI:'));
    for (const c of topCalls) {
      console.log(chalk.gray(`      Strike: ${c.strike}  OI: ${(c.openInterest || 0).toLocaleString('en-IN')}  IV: ${((c.impliedVolatility || 0) * 100).toFixed(1)}%  Last: ₹${c.lastPrice}`));
    }
  }

  if (topPuts.length > 0) {
    console.log(chalk.red('    Top PUT OI:'));
    for (const p of topPuts) {
      console.log(chalk.gray(`      Strike: ${p.strike}  OI: ${(p.openInterest || 0).toLocaleString('en-IN')}  IV: ${((p.impliedVolatility || 0) * 100).toFixed(1)}%  Last: ₹${p.lastPrice}`));
    }
  }

  // Put-Call ratio
  const totalCallOI = (options.calls || []).reduce((sum, c) => sum + (c.openInterest || 0), 0);
  const totalPutOI = (options.puts || []).reduce((sum, p) => sum + (p.openInterest || 0), 0);
  const pcr = totalCallOI > 0 ? (totalPutOI / totalCallOI).toFixed(2) : '—';
  const pcrColor = pcr > 1 ? chalk.green : pcr < 0.7 ? chalk.red : chalk.yellow;

  console.log(chalk.gray(`    PCR: ${pcrColor(pcr)}  (Total Call OI: ${totalCallOI.toLocaleString('en-IN')} | Put OI: ${totalPutOI.toLocaleString('en-IN')})`));
}

function displayTechnicalsSummary(t) {
  console.log(chalk.bold.white('\n  Technical Indicators:'));
  const rsiColor = t.rsi.signal === 'overbought' ? chalk.red : t.rsi.signal === 'oversold' ? chalk.green : chalk.yellow;
  console.log(chalk.gray(`    RSI(14): ${rsiColor(t.rsi.value?.toFixed(1))} [${t.rsi.signal}]`));
  console.log(chalk.gray(`    MACD: ${t.macd.trend}  |  Histogram: ${t.macd.histogram?.toFixed(2)}`));
  console.log(chalk.gray(`    ATR(14): ${t.atr.value?.toFixed(2)} (${t.atr.percentage?.toFixed(1)}%)`));
  console.log(chalk.gray(`    Volume: ${t.volume.signal} (${t.volume.ratio?.toFixed(1)}x avg)`));
  console.log(chalk.gray(`    SMA: 20=${t.sma.sma20?.toFixed(0)} | 50=${t.sma.sma50?.toFixed(0)} | 200=${t.sma.sma200?.toFixed(0) || '—'}`));
  const signal = t.overallSignal;
  const sigColor = signal.includes('BUY') ? chalk.green : signal.includes('SELL') ? chalk.red : chalk.yellow;
  console.log(chalk.gray(`    Overall: ${sigColor(signal)} (Score: ${t.score}/100)`));
  if (t.supportResistance.supports.length > 0) {
    console.log(chalk.gray(`    Support: ${t.supportResistance.supports.slice(0, 3).map(s => '₹' + s.toFixed(0)).join(', ')}`));
  }
  if (t.supportResistance.resistances.length > 0) {
    console.log(chalk.gray(`    Resistance: ${t.supportResistance.resistances.slice(0, 3).map(r => '₹' + r.toFixed(0)).join(', ')}`));
  }
}

function buildFallbackRecommendation(symbol, quote, technicals) {
  const { overallSignal } = technicals;
  const type = overallSignal.includes('BUY') ? 'CALL' : overallSignal.includes('SELL') ? 'PUT' : 'NEUTRAL';
  const atr = technicals.atr?.value || quote.price * 0.02;
  const sl = calculateStopLoss(quote.price, atr, type === 'NEUTRAL' ? 'CALL' : type);
  const targets = calculateTargets(quote.price, sl, type === 'NEUTRAL' ? 'CALL' : type);
  const expiry = getNearestExpiry();
  const stepSize = quote.price > 5000 ? 100 : quote.price > 1000 ? 50 : quote.price > 500 ? 25 : 10;
  const strike = getATMStrike(quote.price, stepSize);

  const reasons = [];
  if (technicals.rsi?.signal !== 'neutral') reasons.push(`RSI ${technicals.rsi.signal}`);
  if (technicals.macd?.trend) reasons.push(`MACD ${technicals.macd.trend}`);
  if (technicals.volume?.signal !== 'normal') reasons.push(`Volume ${technicals.volume.signal}`);

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

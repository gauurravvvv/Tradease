import { screenStocks } from '../analysis/screener.js';
import { analyzeStocksForTrading } from '../analysis/claude.js';
import {
  displayMorningBrief,
  displayHeader,
  displayTradeCard,
  formatCurrency,
} from './display.js';
import {
  calculateStopLoss,
  calculateTargets,
  calculatePositionSize,
} from '../trading/risk.js';
import { getPortfolioSummary } from '../trading/portfolio.js';
import { enterTrade } from '../trading/manager.js';
import { getNearestExpiry, getATMStrike } from '../data/options.js';
import { getFiiDiiData } from '../data/fii-dii.js';
import { getSectorStrength } from '../analysis/sectors.js';
import { getGlobalCues } from '../data/global-cues.js';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import { notifyScanComplete } from '../utils/notify.js';

/**
 * Run pre-market scan: screen stocks, AI analysis, display brief.
 *
 * @param {object} options
 * @param {boolean} [options.interactive=true] - Prompt for action after display
 * @param {number}  [options.topN=15]          - How many stocks to screen
 * @returns {Promise<object[]>} recommendations
 */
export async function runScan(options = {}) {
  const { interactive = true, topN = 15 } = options;

  displayHeader('Tradease Scanner', 'Pre-market F&O scan');

  // Step 1: Screen stocks
  const screenSpinner = ora('Scanning F&O stocks...').start();
  let screened;

  try {
    screened = await screenStocks();
    screenSpinner.succeed(`Screened ${screened.length} stocks`);
  } catch (err) {
    screenSpinner.fail(`Screening failed: ${err.message}`);
    return [];
  }

  if (screened.length === 0) {
    console.log('No stocks passed screening criteria.');
    return [];
  }

  // Step 2: Fetch context data (cached from screening — no extra API calls)
  const [fiiDiiData, sectorData, globalCues] = await Promise.all([
    getFiiDiiData().catch(() => null),
    getSectorStrength().catch(() => []),
    getGlobalCues().catch(() => null),
  ]);

  // Step 3: AI analysis with full market context
  const aiSpinner = ora(
    `AI analyzing top ${screened.length} candidates...`,
  ).start();
  let recommendations;

  try {
    const analysis = await analyzeStocksForTrading(screened, {
      fiiDii: fiiDiiData,
      globalCues,
      sectorRotation:
        sectorData.length > 0
          ? `Top: ${sectorData
              .slice(0, 3)
              .map(s => s.sector)
              .join(', ')} | Bottom: ${sectorData
              .slice(-3)
              .map(s => s.sector)
              .join(', ')}`
          : null,
    });
    const merged = mergeRecommendations(screened, analysis);
    // If AI returned useful data, use it; otherwise fall back to technicals
    const hasAiData = merged.some(r => r.stop_loss && r.target1);
    if (hasAiData) {
      recommendations = merged;
      aiSpinner.succeed(
        `AI returned ${recommendations.length} recommendation(s)`,
      );
    } else {
      recommendations = enrichFromTechnicals(screened);
      aiSpinner.warn('AI returned incomplete data — using technicals');
    }
  } catch (err) {
    aiSpinner.fail(`AI analysis failed: ${err.message}`);
    recommendations = enrichFromTechnicals(screened);
  }

  // Step 4: Display morning brief
  displayMorningBrief(recommendations, globalCues, fiiDiiData, sectorData);
  notifyScanComplete(recommendations.length);

  // Step 5: Interactive prompt
  if (interactive && recommendations.length > 0) {
    const action = await promptAction(recommendations);
    await handleAction(action, recommendations);
  }

  return recommendations;
}

/**
 * Execute trades from scan results.
 * Handles: execute_all, execute_one, deep, skip.
 */
async function handleAction(action, recommendations) {
  if (!action || action.type === 'skip') {
    console.log(chalk.gray('\n  Skipped. No trades entered.\n'));
    return;
  }

  if (action.type === 'deep') {
    const { runResearch } = await import('./research.js');
    await runResearch(action.symbol, 'deep');
    return;
  }

  const toExecute =
    action.type === 'execute_all'
      ? recommendations.filter(r => r.type === 'CALL' || r.type === 'PUT')
      : action.type === 'execute_one'
        ? [action.recommendation]
        : [];

  if (toExecute.length === 0) {
    console.log(chalk.yellow('\n  No executable trades (all NEUTRAL).\n'));
    return;
  }

  console.log(
    chalk.bold.white(`\n  Executing ${toExecute.length} trade(s)...\n`),
  );

  for (const rec of toExecute) {
    try {
      const trade = executeTrade(rec);
      console.log(
        chalk.green(
          `  ✓ Entered ${trade.type} ${trade.symbol} @ ₹${trade.entry_price} | SL: ₹${trade.stop_loss} | Capital: ${formatCurrency(trade.capital_used)}`,
        ),
      );
    } catch (err) {
      console.log(chalk.red(`  ✗ ${rec.symbol}: ${err.message}`));
    }
  }

  // Show updated portfolio
  const portfolio = getPortfolioSummary();
  console.log(
    chalk.gray(
      `\n  Capital: ${formatCurrency(portfolio.availableCapital)} available | ${portfolio.openPositions} position(s) open\n`,
    ),
  );
}

/**
 * Convert a scan recommendation into an enterTrade() call.
 */
/**
 * Auto-execute top recommendations — used by daemon mode.
 * Only enters trades with confidence >= minConfidence and type !== NEUTRAL.
 * @param {Array} recommendations
 * @param {number} [minConfidence=60]
 * @returns {Array} Entered trades
 */
export function autoExecuteTrades(recommendations, minConfidence = 60) {
  const eligible = (recommendations || []).filter(
    r => r.type !== 'NEUTRAL' && (r.confidence || 0) >= minConfidence,
  );

  const entered = [];
  for (const rec of eligible) {
    try {
      const trade = executeTrade(rec);
      logger.trade(
        `[auto-trade] Entered ${trade.type} ${trade.symbol} @ ₹${trade.entry_price} | Conf: ${rec.confidence}%`,
      );
      entered.push(trade);
    } catch (err) {
      logger.warn(`[auto-trade] Skip ${rec.symbol}: ${err.message}`);
    }
  }
  return entered;
}

function executeTrade(rec) {
  const premium =
    rec.premium || Math.round((rec.entry_price || rec.price) * 0.02);
  const entryPrice = rec.entry_price || rec.price;

  return enterTrade({
    symbol: rec.symbol,
    type: rec.type,
    entryPrice,
    premium,
    lotSize: rec.lotSize,
    stopLoss: rec.stop_loss,
    target1: rec.target1,
    target2: rec.target2,
    confidence: rec.confidence || 50,
    reason: rec.reason || 'Scan recommendation',
    expiry: rec.expiry || null,
    strike: rec.strike || null,
  });
}

/**
 * Merge screener data with AI recommendations.
 */
function mergeRecommendations(screened, aiResults) {
  if (!aiResults || !Array.isArray(aiResults)) return screened;

  // Build lookup by symbol
  const aiMap = new Map();
  for (const r of aiResults) {
    if (r.symbol) aiMap.set(r.symbol, r);
  }

  return screened
    .map(stock => {
      const ai = aiMap.get(stock.symbol);
      if (!ai) return null; // AI filtered it out

      return {
        symbol: stock.symbol,
        name: stock.name,
        sector: stock.sector,
        sectorRank: stock.sectorRank,
        sectorTrend: stock.sectorTrend,
        sectorMomentum: stock.sectorMomentum,
        lotSize: stock.lotSize,
        price: stock.price,
        change: stock.change,
        changePct: stock.changePct,
        volume: stock.volume,
        // AI enrichment
        type: ai.type || 'CALL',
        confidence: ai.confidence || 50,
        strike: ai.strike,
        expiry: ai.expiry,
        premium: ai.premium,
        entry_price: ai.entry_price || ai.premium,
        stop_loss: ai.stop_loss,
        target1: ai.target1,
        target2: ai.target2,
        capitalRequired: ai.capitalRequired,
        maxLoss: ai.maxLoss,
        reason: ai.reason,
        risk: ai.risk,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
}

/**
 * Prompt user for action on recommendations.
 */
async function promptAction(recommendations) {
  const { action } = await inquirer.prompt([
    {
      type: 'input',
      name: 'action',
      message: 'Action (E=execute all, 1-N=specific, S=skip, D#=deep):',
      validate: input => {
        const v = input.trim().toUpperCase();
        if (v === 'E' || v === 'S') return true;
        if (
          /^\d+$/.test(v) &&
          parseInt(v) >= 1 &&
          parseInt(v) <= recommendations.length
        )
          return true;
        if (/^D\d+$/.test(v)) {
          const n = parseInt(v.slice(1));
          if (n >= 1 && n <= recommendations.length) return true;
        }
        return `Enter E, S, 1-${recommendations.length}, or D1-D${recommendations.length}`;
      },
    },
  ]);

  const v = action.trim().toUpperCase();

  if (v === 'E') {
    return { type: 'execute_all', recommendations };
  }
  if (v === 'S') {
    return { type: 'skip' };
  }
  if (v.startsWith('D')) {
    const idx = parseInt(v.slice(1)) - 1;
    return { type: 'deep', symbol: recommendations[idx].symbol };
  }

  const idx = parseInt(v) - 1;
  return { type: 'execute_one', recommendation: recommendations[idx] };
}

/**
 * Enrich screened stocks with technicals-based entry/SL/targets when AI unavailable.
 */
function enrichFromTechnicals(screened) {
  const portfolio = getPortfolioSummary();
  const available = portfolio.availableCapital;
  const expiry = getNearestExpiry();

  return screened
    .map(s => {
      const type = s.recommendation || 'CALL';
      const atr = s.technicals?.atr?.value || s.price * 0.02;
      const sl = calculateStopLoss(s.price, atr, type);
      const targets = calculateTargets(s.price, sl, type);
      const pos = calculatePositionSize(available, s.price, s.lotSize);
      const strike = getATMStrike(
        s.price,
        s.price > 5000 ? 100 : s.price > 1000 ? 50 : 25,
      );

      return {
        symbol: s.symbol,
        name: s.name,
        sector: s.sector,
        sectorRank: s.sectorRank,
        sectorTrend: s.sectorTrend,
        sectorMomentum: s.sectorMomentum,
        lotSize: s.lotSize,
        price: s.price,
        change: s.change,
        volume: s.volume,
        type,
        confidence: Math.round(s.score) || 50,
        strike,
        expiry: expiry.weekly,
        premium: Math.round(atr * 0.8),
        entry_price: s.price,
        stop_loss: sl,
        target1: targets.target1,
        target2: targets.target2,
        capitalRequired: pos.capitalRequired,
        maxLoss: pos.maxLoss,
        reason: buildReason(s),
        risk: 'AI analysis unavailable — technicals only',
      };
    })
    .sort((a, b) => b.confidence - a.confidence);
}

function buildReason(stock) {
  const parts = [];
  const t = stock.technicals;
  if (!t) return 'Screener pick';
  if (t.rsi?.signal === 'oversold') parts.push('RSI oversold');
  if (t.rsi?.signal === 'overbought') parts.push('RSI overbought');
  if (t.macd?.trend?.includes('bullish')) parts.push('MACD bullish');
  if (t.macd?.trend?.includes('bearish')) parts.push('MACD bearish');
  if (t.volume?.signal === 'surge') parts.push('Volume surge');
  if (t.volume?.signal === 'high') parts.push('High volume');
  return parts.length > 0 ? parts.join(' + ') : 'Screener pick';
}

import { screenStocks } from '../analysis/screener.js';
import { analyzeStocksForTrading } from '../analysis/claude.js';
import { displayMorningBrief, displayHeader } from './display.js';
import { calculateStopLoss, calculateTargets, calculatePositionSize } from '../trading/risk.js';
import { getPortfolioSummary } from '../trading/portfolio.js';
import { getNearestExpiry, getATMStrike } from '../data/options.js';
import ora from 'ora';
import inquirer from 'inquirer';

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

  displayHeader('TradeOracle Scanner', 'Pre-market F&O scan');

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

  // Step 2: AI analysis
  const aiSpinner = ora(`AI analyzing top ${screened.length} candidates...`).start();
  let recommendations;

  try {
    const analysis = await analyzeStocksForTrading(screened);
    const merged = mergeRecommendations(screened, analysis);
    // If AI returned useful data, use it; otherwise fall back to technicals
    const hasAiData = merged.some(r => r.stop_loss && r.target1);
    if (hasAiData) {
      recommendations = merged;
      aiSpinner.succeed(`AI returned ${recommendations.length} recommendation(s)`);
    } else {
      recommendations = enrichFromTechnicals(screened);
      aiSpinner.warn('AI returned incomplete data — using technicals');
    }
  } catch (err) {
    aiSpinner.fail(`AI analysis failed: ${err.message}`);
    recommendations = enrichFromTechnicals(screened);
  }

  // Step 3: Display morning brief
  displayMorningBrief(recommendations, null);

  // Step 4: Interactive prompt
  if (interactive && recommendations.length > 0) {
    const action = await promptAction(recommendations);
    return { recommendations, action };
  }

  return recommendations;
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
      validate: (input) => {
        const v = input.trim().toUpperCase();
        if (v === 'E' || v === 'S') return true;
        if (/^\d+$/.test(v) && parseInt(v) >= 1 && parseInt(v) <= recommendations.length) return true;
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

  return screened.map(s => {
    const type = s.recommendation || 'CALL';
    const atr = s.technicals?.atr?.value || s.price * 0.02;
    const sl = calculateStopLoss(s.price, atr, type);
    const targets = calculateTargets(s.price, sl, type);
    const pos = calculatePositionSize(available, s.price, s.lotSize);
    const strike = getATMStrike(s.price, s.price > 5000 ? 100 : s.price > 1000 ? 50 : 25);

    return {
      symbol: s.symbol,
      name: s.name,
      sector: s.sector,
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
  }).sort((a, b) => b.confidence - a.confidence);
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

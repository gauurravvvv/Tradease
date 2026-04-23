import { BaseAgent } from './base.js';
import { getOpenTrades, enterTrade } from '../trading/manager.js';
import { getPortfolioSummary } from '../trading/portfolio.js';
import {
  calculateStopLoss,
  calculateTargets,
  calculatePositionSize,
  validateTrade,
} from '../trading/risk.js';
import { getQuote, getHistorical } from '../data/market.js';
import { computeATR } from '../analysis/technicals.js';
import { screenStocks } from '../analysis/screener.js';
import { computeConfluence } from '../analysis/confluence.js';
import { notifyTradeEntry } from '../utils/notify.js';
import { logger } from '../utils/logger.js';
import { TRADING } from '../config/settings.js';

const TEN_MINUTES = 10 * 60 * 1000;
const SCORE_AUTO_ENTER = 70;
const SCORE_BORDERLINE_MIN = 60;
const SCORE_BORDERLINE_MAX = 69;
const RSI_CALL_MAX = 75;
const RSI_PUT_MIN = 25;
const MIN_VOLUME_RATIO = 1.0;

export class TradeStrategist extends BaseAgent {
  constructor() {
    super('trade-strategist', {
      intervalMs: TEN_MINUTES,
      model: 'claude-haiku-4-5-20251001',
    });
    this._screenerCache = null;
    this._screenerCacheTs = 0;
  }

  shouldRun() {
    if (!this.isMarketHours(9, 30, 14, 30)) return false;

    const open = getOpenTrades();
    if (open.length >= TRADING.MAX_POSITIONS) {
      this.log('skip', null, `${open.length} positions open`);
      return false;
    }

    const portfolio = getPortfolioSummary();
    if (portfolio.availableCapital <= 0) {
      this.log('skip', null, 'No available capital');
      return false;
    }

    return true;
  }

  async execute() {
    const candidates = await this._getScreenerResults();
    if (!candidates.length) {
      this.log('scan', null, 'No screener candidates');
      return;
    }

    // Read unconsumed bullish_news signals
    const newsSignals = this.readSignals(['bullish_news']);
    const newsMap = {};
    for (const s of newsSignals) {
      newsMap[s.symbol] = s;
    }

    const consumedIds = [];
    let entered = 0;

    for (const stock of candidates) {
      if (entered > 0) break; // one entry per tick

      const open = getOpenTrades();
      if (open.length >= TRADING.MAX_POSITIONS) break;

      const rec = stock.recommendation;
      if (rec !== 'CALL' && rec !== 'PUT') continue;

      const score = stock.score;
      const hasNews = !!newsMap[stock.symbol];
      const rsi = stock.technicals?.rsi?.value ?? stock.technicals?.rsi;
      const volumeRatio =
        stock.technicals?.volume?.ratio ?? stock.technicals?.volumeRatio ?? 0;

      // RSI filter
      if (rec === 'CALL' && rsi != null && rsi >= RSI_CALL_MAX) continue;
      if (rec === 'PUT' && rsi != null && rsi <= RSI_PUT_MIN) continue;

      // Volume filter
      if (volumeRatio < MIN_VOLUME_RATIO) continue;

      // ── Confluence gate ──
      let confluenceScore = stock.confluence ?? 50;
      try {
        if (confluenceScore === 50) {
          const conf = await computeConfluence(stock.symbol, rec);
          confluenceScore = conf.score;
        }
      } catch {
        /* proceed without confluence */
      }

      // Skip if confluence too low (signals disagree across timeframes)
      if (confluenceScore < 40) {
        this.log(
          'skip_confluence',
          stock.symbol,
          `confluence=${confluenceScore} too low`,
        );
        continue;
      }

      // High confluence lowers auto-entry threshold
      const effectiveThreshold = confluenceScore >= 70 ? 65 : SCORE_AUTO_ENTER;

      // ── High-confidence: rule-based auto-enter ──
      if (score >= effectiveThreshold) {
        const result = await this._enterPosition(
          stock,
          rec,
          score,
          hasNews,
          `rule|conf:${confluenceScore}`,
        );
        if (result) {
          entered++;
          if (hasNews) consumedIds.push(newsMap[stock.symbol].id);
        }
        continue;
      }

      // ── Borderline: only if news signal exists, ask Claude ──
      if (
        score >= SCORE_BORDERLINE_MIN &&
        score <= SCORE_BORDERLINE_MAX &&
        hasNews
      ) {
        const approved = await this._claudeConfirm(
          stock,
          newsMap[stock.symbol],
        );
        if (approved) {
          const result = await this._enterPosition(
            stock,
            rec,
            score,
            true,
            'claude_confirmed',
          );
          if (result) entered++;
        }
        consumedIds.push(newsMap[stock.symbol].id);
      }
    }

    // Consume processed news signals
    if (consumedIds.length) this.consumeSignals(consumedIds);
  }

  /**
   * Attempt trade entry using risk.js for all calculations.
   * Returns true on success, false on skip/failure.
   */
  async _enterPosition(stock, type, score, hasNews, source) {
    try {
      const historical = await getHistorical(stock.symbol, 20);
      const atr = computeATR(historical);
      if (!atr) {
        this.log('skip_entry', stock.symbol, 'No ATR data');
        return false;
      }

      const entryPrice = stock.price;
      const stopLoss = calculateStopLoss(entryPrice, atr, type);
      const { target1, target2 } = calculateTargets(entryPrice, stopLoss, type);

      const portfolio = getPortfolioSummary();
      const lotSize = stock.lotSize;
      const { lots, capitalRequired, maxLoss } = calculatePositionSize(
        portfolio.availableCapital,
        entryPrice,
        lotSize,
      );

      if (lots <= 0) {
        this.log('skip_entry', stock.symbol, 'Position size 0 lots');
        return false;
      }

      const validation = validateTrade(
        { symbol: stock.symbol, capitalRequired, maxLoss, type },
        {
          positions: getOpenTrades(),
          capitalUsed: portfolio.capitalInUse,
          totalCapital: portfolio.totalCapital,
        },
      );

      if (!validation.valid) {
        this.log('skip_entry', stock.symbol, validation.reason);
        return false;
      }

      let confidence = Math.min(score, 100);
      if (hasNews) confidence = Math.min(confidence + 10, 100);

      const rsiVal = stock.technicals?.rsi?.value ?? stock.technicals?.rsi;
      const volVal =
        stock.technicals?.volume?.ratio ?? stock.technicals?.volumeRatio;
      const reason = `[Agent] ${source} | score:${score} | RSI:${rsiVal?.toFixed?.(1) ?? '--'} | vol:${volVal?.toFixed?.(1) ?? '--'}x${hasNews ? ' | news_boost' : ''}`;

      const trade = enterTrade({
        symbol: stock.symbol,
        type,
        entryPrice,
        premium: entryPrice,
        lotSize,
        stopLoss,
        target1,
        target2,
        confidence,
        reason,
      });

      this.writeSignal(stock.symbol, 'entry_signal', confidence, {
        type,
        entryPrice,
        stopLoss,
        target1,
        target2,
        source,
        score,
      });

      this.log('entry', stock.symbol, reason);
      try {
        notifyTradeEntry(stock.symbol, type, entryPrice);
      } catch {}

      logger.info(
        `[trade-strategist] Entered ${type} on ${stock.symbol} @ ₹${entryPrice} | SL:₹${stopLoss} | T1:₹${target1} | T2:₹${target2}`,
      );
      return true;
    } catch (err) {
      this.log('entry_error', stock.symbol, err.message);
      logger.error(
        `[trade-strategist] Entry failed ${stock.symbol}: ${err.message}`,
      );
      return false;
    }
  }

  /**
   * Claude confirmation for borderline candidates (score 60-69 with news).
   * Returns true if Claude approves entry.
   */
  async _claudeConfirm(stock, newsSignal) {
    try {
      const newsData =
        typeof newsSignal.data === 'string'
          ? JSON.parse(newsSignal.data)
          : newsSignal.data;

      const prompt = `F&O entry decision. Respond ONLY with JSON: {"enter":true/false,"reason":"<10 words>"}

Stock: ${stock.symbol} ₹${stock.price}
Score: ${stock.score}/100 (borderline)
Signal: ${stock.recommendation}
RSI: ${(stock.technicals?.rsi?.value ?? stock.technicals?.rsi)?.toFixed?.(1) ?? '--'}
Volume ratio: ${(stock.technicals?.volume?.ratio ?? stock.technicals?.volumeRatio)?.toFixed?.(1) ?? '--'}x
Sector: ${stock.sector}
News: ${newsData.headline || newsData.summary || 'bullish signal'}

Enter this ${stock.recommendation} trade?`;

      const raw = await this.callClaude(prompt);
      const parsed = this.parseJson(raw);
      this.log(
        'claude_confirm',
        stock.symbol,
        `enter:${parsed.enter} reason:${parsed.reason}`,
      );
      return !!parsed.enter;
    } catch (err) {
      this.log('claude_error', stock.symbol, err.message);
      return false;
    }
  }

  /**
   * Get screener results, cached for 10 minutes.
   */
  async _getScreenerResults() {
    const now = Date.now();
    if (this._screenerCache && now - this._screenerCacheTs < TEN_MINUTES) {
      return this._screenerCache;
    }

    try {
      const results = await screenStocks();
      this._screenerCache = results;
      this._screenerCacheTs = now;
      return results;
    } catch (err) {
      logger.error(`[trade-strategist] Screener failed: ${err.message}`);
      return this._screenerCache || [];
    }
  }

  /**
   * Top symbols from screener cache. Used by News Sentinel for watchlist.
   */
  getTopSymbols() {
    if (!this._screenerCache) return [];
    return this._screenerCache.map(s => s.symbol);
  }
}

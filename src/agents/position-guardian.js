import { BaseAgent } from './base.js';
import {
  getOpenTrades,
  exitTrade,
  partialExit,
  stopTrade,
  updateTradePrice,
} from '../trading/manager.js';
import { shouldExit, calculateTrailingStop } from '../trading/risk.js';
import { checkIndexHealth } from '../listeners/index-monitor.js';
import { getQuote } from '../data/market.js';
import { computeATR } from '../analysis/technicals.js';
import { RSI, MACD } from 'technicalindicators';
import { getHistorical } from '../data/market.js';
import {
  notifyTradeExit,
  notifyStopLoss,
  notifyTargetHit,
  notifyIndexCrash,
} from '../utils/notify.js';
import { logger } from '../utils/logger.js';
import { TRADING } from '../config/settings.js';

const WIND_DOWN_MINUTE = 15 * 60 + 15; // 15:15 IST = 925 min
const INDEX_CHECK_INTERVAL = 10 * 60 * 1000; // 10 min in ms
const SL_PROXIMITY_PCT = 0.3; // within 30% of risk distance = "near SL"

export class PositionGuardian extends BaseAgent {
  constructor() {
    super('position-guardian', {
      intervalMs: 2 * 60 * 1000, // 2 minutes
      model: 'claude-haiku-4-5-20251001',
    });
    this._lastIndexCheck = 0;
  }

  shouldRun() {
    if (!this.isMarketHours(9, 15, 15, 20)) return false;
    const trades = getOpenTrades();
    return trades.length > 0;
  }

  async execute() {
    const trades = getOpenTrades();
    if (!trades.length) return;

    const istMin = this.getISTMinutes();

    // ── Index crash check (every 10 min) ──
    const now = Date.now();
    if (now - this._lastIndexCheck >= INDEX_CHECK_INTERVAL) {
      this._lastIndexCheck = now;
      const crashed = await this._checkIndexCrash(trades);
      if (crashed) return; // all positions exited
    }

    // ── Wind-down: exit everything at 15:15 ──
    if (istMin >= WIND_DOWN_MINUTE) {
      await this._exitAll(trades, 'wind-down: market close');
      return;
    }

    // ── Read signals once for all positions ──
    const signals = this.readSignals(['urgent_exit', 'bearish_news']);
    const signalsBySymbol = {};
    for (const sig of signals) {
      if (!signalsBySymbol[sig.symbol]) signalsBySymbol[sig.symbol] = [];
      signalsBySymbol[sig.symbol].push(sig);
    }

    // ── Per-position loop ──
    for (const trade of trades) {
      try {
        await this._manageTrade(trade, signalsBySymbol[trade.symbol] || []);
      } catch (err) {
        logger.error(
          `[position-guardian] Error managing ${trade.symbol}: ${err.message}`,
        );
        this.log('error', trade.symbol, err.message);
      }
    }
  }

  // ─── Private: manage a single trade ───

  async _manageTrade(trade, signals) {
    // Fetch live price
    const quote = await getQuote(trade.symbol);
    const price = quote.price;

    // Update DB
    updateTradePrice(trade.id, price);

    // Compute ATR for risk calcs
    const hist = await getHistorical(trade.symbol);
    const atr = computeATR(hist);

    // Momentum context for adaptive trailing
    let momentum = null;
    if (hist && hist.length >= 26) {
      const closes = hist.map(d => d.close);
      const rsiValues = RSI.calculate({ values: closes, period: 14 });
      const macdValues = MACD.calculate({
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      });
      if (rsiValues.length > 0 && macdValues.length >= 2) {
        momentum = {
          rsi: rsiValues[rsiValues.length - 1],
          macdHistogram: macdValues[macdValues.length - 1].histogram || 0,
          macdPrevHistogram: macdValues[macdValues.length - 2].histogram || 0,
        };
      }
    }

    // Mechanical exit check via risk.js
    const exitCheck = shouldExit(trade, price, atr);

    switch (exitCheck.action) {
      case 'FULL_EXIT': {
        const pnl = this._calcPnl(trade, price);
        if (exitCheck.reason.includes('stop')) {
          stopTrade(trade.id, price);
          notifyStopLoss(trade.symbol, price);
          this.log('stop_loss', trade.symbol, exitCheck.reason);
        } else {
          exitTrade(trade.id, price, exitCheck.reason);
          notifyTradeExit(trade.symbol, trade.type, price, pnl);
          this.log('full_exit', trade.symbol, exitCheck.reason);
        }
        this._consumeSymbolSignals(signals);
        return;
      }

      case 'PARTIAL_T1': {
        if (!trade.t1_hit) {
          partialExit(trade.id, 0.5, price, 'T1 hit');
          notifyTargetHit(trade.symbol, 1, price);
          // Trail SL to breakeven (entry price)
          const newTrail = calculateTrailingStop(
            trade.entry_price,
            price,
            atr,
            trade.type,
            momentum,
          );
          updateTradePrice(trade.id, price); // refresh
          this.log('t1_hit', trade.symbol, `T1=${price}, SL→breakeven`);
        }
        break;
      }

      case 'PARTIAL_T2': {
        if (!trade.t2_hit) {
          partialExit(trade.id, 0.5, price, 'T2 hit');
          notifyTargetHit(trade.symbol, 2, price);
          this.log('t2_hit', trade.symbol, `T2=${price}, SL→T1`);
        }
        break;
      }

      case 'HOLD':
      default: {
        // Update trailing stop if applicable
        if (trade.t1_hit) {
          const trail = calculateTrailingStop(
            trade.entry_price,
            price,
            atr,
            trade.type,
            momentum,
          );
          if (trail && this._trailingStopHit(trade, price, trail)) {
            const pnl = this._calcPnl(trade, price);
            exitTrade(trade.id, price, 'trailing stop hit');
            notifyTradeExit(trade.symbol, trade.type, price, pnl);
            this.log(
              'trailing_exit',
              trade.symbol,
              `trail=${trail} price=${price}`,
            );
            this._consumeSymbolSignals(signals);
            return;
          }
        }
        break;
      }
    }

    // ── Signal-based checks (only for positions still open) ──
    await this._handleSignals(trade, price, atr, signals);
  }

  // ─── Signal handling ───

  async _handleSignals(trade, price, atr, signals) {
    if (!signals.length) return;

    const urgentSignals = signals.filter(s => s.signal_type === 'urgent_exit');
    const pnl = this._calcPnl(trade, price);
    const profitable = pnl > 0;

    // Urgent exit on a profitable position = ambiguous → ask Claude
    if (urgentSignals.length && profitable) {
      await this._askClaudeForDecision(
        trade,
        price,
        atr,
        'urgent_exit_profitable',
        urgentSignals,
      );
      return;
    }

    // Urgent exit on a losing position = just exit
    if (urgentSignals.length && !profitable) {
      exitTrade(trade.id, price, 'urgent exit signal (loss)');
      const actualPnl = this._calcPnl(trade, price);
      notifyTradeExit(trade.symbol, trade.type, price, actualPnl);
      this.log('urgent_exit', trade.symbol, `signal exit, pnl=${actualPnl}`);
      this._consumeSymbolSignals(signals);
      return;
    }

    // Near SL with recovery → ask Claude
    if (
      this._isNearSL(trade, price, atr) &&
      this._showingRecovery(trade, price)
    ) {
      await this._askClaudeForDecision(
        trade,
        price,
        atr,
        'near_sl_recovery',
        signals,
      );
    }
  }

  // ─── Claude call (rare — 0-1x per day) ───

  async _askClaudeForDecision(trade, price, atr, reason, signals) {
    const pnl = this._calcPnl(trade, price);
    const prompt = JSON.stringify({
      task: 'position_decision',
      reason,
      position: {
        sym: trade.symbol,
        type: trade.type,
        entry: trade.entry_price,
        current: price,
        sl: trade.stop_loss,
        t1: trade.target1,
        t2: trade.target2,
        t1_hit: !!trade.t1_hit,
        t2_hit: !!trade.t2_hit,
        pnl,
        atr,
      },
      signals: signals.map(s => ({ type: s.signal_type, data: s.data })),
      question:
        'HOLD or EXIT? Respond JSON: {"action":"HOLD"|"EXIT","reason":"<brief>"}',
    });

    try {
      const raw = await this.callClaude(prompt);
      const decision = this.parseJson(raw);

      if (decision.action === 'EXIT') {
        exitTrade(trade.id, price, `claude: ${decision.reason}`);
        notifyTradeExit(trade.symbol, trade.type, price, pnl);
        this.log('claude_exit', trade.symbol, decision.reason);
      } else {
        this.log('claude_hold', trade.symbol, decision.reason);
      }

      this._consumeSymbolSignals(signals);
    } catch (err) {
      // Claude failure = default to HOLD (conservative)
      logger.warn(
        `[position-guardian] Claude decision failed for ${trade.symbol}: ${err.message}`,
      );
      this.log('claude_error', trade.symbol, err.message);
    }
  }

  // ─── Index crash ───

  async _checkIndexCrash(trades) {
    try {
      const health = await checkIndexHealth();
      if (health.severity === 'crash') {
        notifyIndexCrash('NIFTY', health.niftyChange);
        this.log(
          'index_crash',
          null,
          `nifty=${health.niftyPrice} change=${health.niftyChange}%`,
        );
        await this._exitAll(
          trades,
          `index crash: NIFTY ${health.niftyChange}%`,
        );
        return true;
      }
    } catch (err) {
      logger.error(`[position-guardian] Index check failed: ${err.message}`);
    }
    return false;
  }

  // ─── Exit all positions ───

  async _exitAll(trades, reason) {
    for (const trade of trades) {
      try {
        const quote = await getQuote(trade.symbol);
        const price = quote.price;
        const pnl = this._calcPnl(trade, price);
        exitTrade(trade.id, price, reason);
        notifyTradeExit(trade.symbol, trade.type, price, pnl);
        this.log('exit_all', trade.symbol, reason);
      } catch (err) {
        logger.error(
          `[position-guardian] Failed to exit ${trade.symbol}: ${err.message}`,
        );
        this.log('error', trade.symbol, `exit_all failed: ${err.message}`);
      }
    }
  }

  // ─── Helpers ───

  _calcPnl(trade, price) {
    const dir = trade.type === 'CALL' ? 1 : -1;
    return dir * (price - trade.entry_price) * trade.quantity;
  }

  _isNearSL(trade, price, atr) {
    if (!trade.stop_loss) return false;
    const riskDistance = Math.abs(trade.entry_price - trade.stop_loss);
    const distToSL = Math.abs(price - trade.stop_loss);
    return distToSL <= riskDistance * SL_PROXIMITY_PCT;
  }

  _showingRecovery(trade, price) {
    // Price has moved back toward entry from near the SL
    const dir = trade.type === 'CALL' ? 1 : -1;
    const currentMove = dir * (price - trade.stop_loss);
    const prevMove = dir * ((trade.current_price || price) - trade.stop_loss);
    return currentMove > prevMove;
  }

  _trailingStopHit(trade, price, trailStop) {
    if (!trailStop) return false;
    if (trade.type === 'CALL') return price <= trailStop;
    return price >= trailStop;
  }

  _consumeSymbolSignals(signals) {
    const ids = signals.map(s => s.id);
    if (ids.length) this.consumeSignals(ids);
  }
}

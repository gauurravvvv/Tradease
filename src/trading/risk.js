import { TRADING } from '../config/settings.js';

/**
 * Calculate position size based on capital, price, and lot size.
 * @param {number} capital - Total available capital
 * @param {number} price - Current stock/option price
 * @param {number} lotSize - F&O lot size
 * @returns {{ lots: number, capitalRequired: number, maxLoss: number }}
 */
export function calculatePositionSize(capital, price, lotSize) {
  const maxCapital = capital * TRADING.MAX_CAPITAL_PER_POSITION;
  const oneLotCost = price * lotSize;

  if (oneLotCost <= 0) {
    return { lots: 0, capitalRequired: 0, maxLoss: 0 };
  }

  const lots = Math.floor(maxCapital / oneLotCost);
  const capitalRequired = lots * oneLotCost;
  const maxLoss = capital * TRADING.MAX_LOSS_PER_TRADE;

  return {
    lots,
    capitalRequired: Math.round(capitalRequired * 100) / 100,
    maxLoss: Math.round(maxLoss * 100) / 100,
  };
}

/**
 * Calculate stop-loss based on ATR.
 * @param {number} entryPrice
 * @param {number} atr - ATR value
 * @param {'CALL'|'PUT'} type - Trade direction
 * @returns {number} Stop-loss price
 */
export function calculateStopLoss(entryPrice, atr, type) {
  if (!atr || !entryPrice) return null;
  if (type === 'CALL') {
    return (
      Math.round((entryPrice - atr * TRADING.ATR_STOP_MULTIPLIER) * 100) / 100
    );
  }
  // PUT
  return (
    Math.round((entryPrice + atr * TRADING.ATR_STOP_MULTIPLIER) * 100) / 100
  );
}

/**
 * Calculate target prices based on risk-reward ratios.
 * @param {number} entryPrice
 * @param {number} stopLoss
 * @param {'CALL'|'PUT'} type
 * @returns {{ target1: number, target2: number, riskPerLot: number }}
 */
export function calculateTargets(entryPrice, stopLoss, type) {
  const risk = Math.abs(entryPrice - stopLoss);

  let target1, target2;

  if (type === 'CALL') {
    target1 = entryPrice + risk * TRADING.RISK_REWARD.T1;
    target2 = entryPrice + risk * TRADING.RISK_REWARD.T2;
  } else {
    // PUT
    target1 = entryPrice - risk * TRADING.RISK_REWARD.T1;
    target2 = entryPrice - risk * TRADING.RISK_REWARD.T2;
  }

  return {
    target1: Math.round(target1 * 100) / 100,
    target2: Math.round(target2 * 100) / 100,
    riskPerLot: Math.round(risk * 100) / 100,
  };
}

/**
 * Compute momentum-based ATR multiplier for trailing stop.
 * Strong trend = wide trail (let profits run), weakening = tight trail (protect gains).
 * @param {{ rsi: number, macdHistogram: number, macdPrevHistogram: number }|null} momentum
 * @param {'CALL'|'PUT'} type
 * @returns {number} ATR multiplier
 */
function computeMomentumMultiplier(momentum, type) {
  if (!momentum || !TRADING.ADAPTIVE_TRAIL) return TRADING.TRAILING_STOP_ATR;

  const { rsi, macdHistogram, macdPrevHistogram } = momentum;

  // Exhaustion: RSI extreme for trade direction
  if (type === 'CALL' && rsi != null && rsi > 75)
    return TRADING.ADAPTIVE_TRAIL.EXHAUSTION_MULTIPLIER;
  if (type === 'PUT' && rsi != null && rsi < 25)
    return TRADING.ADAPTIVE_TRAIL.EXHAUSTION_MULTIPLIER;

  const macdExpanding = Math.abs(macdHistogram) > Math.abs(macdPrevHistogram);
  const macdDirection = type === 'CALL' ? macdHistogram > 0 : macdHistogram < 0;

  // Strong trend: MACD expanding in trade direction + RSI mid-range
  if (macdExpanding && macdDirection && rsi != null && rsi > 40 && rsi < 60) {
    return TRADING.ADAPTIVE_TRAIL.STRONG_MULTIPLIER;
  }

  // Normal trend: MACD in trade direction
  if (macdDirection) return TRADING.ADAPTIVE_TRAIL.NORMAL_MULTIPLIER;

  // Weakening: MACD against trade direction or contracting
  return TRADING.ADAPTIVE_TRAIL.WEAK_MULTIPLIER;
}

/**
 * Calculate trailing stop-loss. Only activates after profit exceeds trigger %.
 * @param {number} entryPrice
 * @param {number} currentPrice
 * @param {number} atr
 * @param {'CALL'|'PUT'} type
 * @param {{ rsi: number, macdHistogram: number, macdPrevHistogram: number }|null} momentum
 * @returns {number|null} Trailing stop price, or null if not yet triggered
 */
export function calculateTrailingStop(
  entryPrice,
  currentPrice,
  atr,
  type,
  momentum = null,
) {
  if (!entryPrice || !atr) return null;

  const profitPct =
    type === 'CALL'
      ? ((currentPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - currentPrice) / entryPrice) * 100;

  if (profitPct < TRADING.TRAILING_TRIGGER_PCT) {
    return null;
  }

  const multiplier = computeMomentumMultiplier(momentum, type);

  if (type === 'CALL') {
    return Math.round((currentPrice - atr * multiplier) * 100) / 100;
  }
  return Math.round((currentPrice + atr * multiplier) * 100) / 100;
}

/**
 * Validate whether a new trade should be allowed.
 * @param {Object} trade - Proposed trade { symbol, capitalRequired, type }
 * @param {Object} portfolio - Current portfolio { positions: [], capitalUsed, totalCapital }
 * @returns {{ valid: boolean, reason: string|null }}
 */
export function validateTrade(trade, portfolio) {
  // Check max positions
  if (portfolio.positions.length >= TRADING.MAX_POSITIONS) {
    return {
      valid: false,
      reason: `Max positions (${TRADING.MAX_POSITIONS}) already open`,
    };
  }

  // Check capital available
  const availableCapital = portfolio.totalCapital - portfolio.capitalUsed;
  if (trade.capitalRequired > availableCapital) {
    return {
      valid: false,
      reason: `Insufficient capital. Need ₹${trade.capitalRequired}, have ₹${Math.round(availableCapital)}`,
    };
  }

  // Check max loss per trade not exceeded
  const maxAllowedLoss = portfolio.totalCapital * TRADING.MAX_LOSS_PER_TRADE;
  if (trade.maxLoss && trade.maxLoss > maxAllowedLoss) {
    return {
      valid: false,
      reason: `Max loss ₹${trade.maxLoss} exceeds allowed ₹${Math.round(maxAllowedLoss)} per trade`,
    };
  }

  // Check not already in same symbol
  const alreadyInSymbol = portfolio.positions.some(
    p => p.symbol === trade.symbol,
  );
  if (alreadyInSymbol) {
    return {
      valid: false,
      reason: `Already have open position in ${trade.symbol}`,
    };
  }

  // Check market hours — no new entries after NO_NEW_ENTRY_AFTER (IST)
  const now = new Date();
  const ist = new Date(
    now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
  );
  const [cutoffHour, cutoffMin] =
    TRADING.NO_NEW_ENTRY_AFTER.split(':').map(Number);
  const currentMinutes = ist.getHours() * 60 + ist.getMinutes();
  const cutoffMinutes = cutoffHour * 60 + cutoffMin;

  if (currentMinutes >= cutoffMinutes) {
    return {
      valid: false,
      reason: `No new entries after ${TRADING.NO_NEW_ENTRY_AFTER}`,
    };
  }

  return { valid: true, reason: null };
}

/**
 * Determine whether to exit a trade.
 * @param {Object} trade - Active trade { entryPrice, stopLoss, target1, target2, type, lots, t1Hit }
 * @param {number} currentPrice
 * @param {number} atr - Current ATR
 * @returns {{ shouldExit: boolean, reason: string, action: string }}
 */
export function shouldExit(trade, currentPrice, atr) {
  // Accept both camelCase and snake_case (DB rows use snake_case)
  const entryPrice = trade.entryPrice ?? trade.entry_price;
  const stopLoss = trade.stopLoss ?? trade.stop_loss;
  const target1 = trade.target1;
  const target2 = trade.target2;
  const type = trade.type;

  // Check stop-loss hit
  if (type === 'CALL' && currentPrice <= stopLoss) {
    return {
      shouldExit: true,
      reason: `Stop-loss hit at ₹${stopLoss}`,
      action: 'FULL_EXIT',
    };
  }
  if (type === 'PUT' && currentPrice >= stopLoss) {
    return {
      shouldExit: true,
      reason: `Stop-loss hit at ₹${stopLoss}`,
      action: 'FULL_EXIT',
    };
  }

  // Check trailing stop (skip if no ATR data)
  const trailingStop = atr
    ? calculateTrailingStop(entryPrice, currentPrice, atr, type)
    : null;
  if (trailingStop != null) {
    if (type === 'CALL' && currentPrice <= trailingStop) {
      return {
        shouldExit: true,
        reason: `Trailing stop hit at ₹${trailingStop}`,
        action: 'FULL_EXIT',
      };
    }
    if (type === 'PUT' && currentPrice >= trailingStop) {
      return {
        shouldExit: true,
        reason: `Trailing stop hit at ₹${trailingStop}`,
        action: 'FULL_EXIT',
      };
    }
  }

  // Check target2 hit (exit remaining runner portion)
  if (target2) {
    if (type === 'CALL' && currentPrice >= target2) {
      return {
        shouldExit: true,
        reason: `Target 2 hit at ₹${target2}`,
        action: 'PARTIAL_T2',
      };
    }
    if (type === 'PUT' && currentPrice <= target2) {
      return {
        shouldExit: true,
        reason: `Target 2 hit at ₹${target2}`,
        action: 'PARTIAL_T2',
      };
    }
  }

  // Check target1 hit (partial exit if not already done)
  if (target1 && !trade.t1_hit) {
    if (type === 'CALL' && currentPrice >= target1) {
      return {
        shouldExit: true,
        reason: `Target 1 hit at ₹${target1}`,
        action: 'PARTIAL_T1',
      };
    }
    if (type === 'PUT' && currentPrice <= target1) {
      return {
        shouldExit: true,
        reason: `Target 1 hit at ₹${target1}`,
        action: 'PARTIAL_T1',
      };
    }
  }

  // Check max loss breached (percentage-based safety net)
  const pnlPct = entryPrice
    ? type === 'CALL'
      ? ((currentPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - currentPrice) / entryPrice) * 100
    : 0;

  if (pnlPct <= -(TRADING.MAX_LOSS_PER_TRADE * 100)) {
    return {
      shouldExit: true,
      reason: `Max loss threshold (${TRADING.MAX_LOSS_PER_TRADE * 100}%) breached`,
      action: 'FULL_EXIT',
    };
  }

  return { shouldExit: false, reason: 'Within parameters', action: 'HOLD' };
}

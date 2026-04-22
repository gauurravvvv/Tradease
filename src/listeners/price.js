import { getQuote } from '../data/market.js';
import { TRADING } from '../config/settings.js';

/**
 * Determine if trade should exit based on current price vs stop/target levels.
 *
 * @param {object} trade - Open trade from DB
 * @param {number} currentPrice - Current market price of underlying
 * @returns {{ action: string, reason: string }}
 */
function shouldExit(trade, currentPrice) {
  const { stop_loss, target1, target2, trailing_stop, t1_hit, t2_hit, type, entry_price } = trade;

  // Calculate P&L direction multiplier (CALL profits when price goes up, PUT when down)
  const direction = type === 'CALL' ? 1 : -1;
  const pnlPct = direction * ((currentPrice - entry_price) / entry_price) * 100;

  // 1. Hard stop-loss hit
  if (type === 'CALL' && currentPrice <= stop_loss) {
    return { action: 'FULL_EXIT', reason: `Stop-loss hit at ₹${currentPrice} (SL: ₹${stop_loss})` };
  }
  if (type === 'PUT' && currentPrice >= stop_loss) {
    return { action: 'FULL_EXIT', reason: `Stop-loss hit at ₹${currentPrice} (SL: ₹${stop_loss})` };
  }

  // 2. Trailing stop hit
  if (trailing_stop) {
    if (type === 'CALL' && currentPrice <= trailing_stop) {
      return { action: 'FULL_EXIT', reason: `Trailing stop hit at ₹${currentPrice} (TSL: ₹${trailing_stop})` };
    }
    if (type === 'PUT' && currentPrice >= trailing_stop) {
      return { action: 'FULL_EXIT', reason: `Trailing stop hit at ₹${currentPrice} (TSL: ₹${trailing_stop})` };
    }
  }

  // 3. Target 2 hit — exit remaining
  if (!t2_hit && target2) {
    if (type === 'CALL' && currentPrice >= target2) {
      return { action: 'PARTIAL_T2', reason: `Target 2 hit at ₹${currentPrice} (T2: ₹${target2})` };
    }
    if (type === 'PUT' && currentPrice <= target2) {
      return { action: 'PARTIAL_T2', reason: `Target 2 hit at ₹${currentPrice} (T2: ₹${target2})` };
    }
  }

  // 4. Target 1 hit — partial exit
  if (!t1_hit && target1) {
    if (type === 'CALL' && currentPrice >= target1) {
      return { action: 'PARTIAL_T1', reason: `Target 1 hit at ₹${currentPrice} (T1: ₹${target1})` };
    }
    if (type === 'PUT' && currentPrice <= target1) {
      return { action: 'PARTIAL_T1', reason: `Target 1 hit at ₹${currentPrice} (T1: ₹${target1})` };
    }
  }

  // 5. Check if trailing stop needs update
  if (pnlPct >= TRADING.TRAILING_TRIGGER_PCT) {
    // Price has moved favorably — check if trailing stop needs tightening
    const trailingDistance = entry_price * (TRADING.TRAILING_STOP_ATR / 100);
    let newTrailing;

    if (type === 'CALL') {
      newTrailing = currentPrice - trailingDistance;
      if (!trailing_stop || newTrailing > trailing_stop) {
        return { action: 'UPDATE_TRAILING', reason: `Update trailing stop to ₹${newTrailing.toFixed(2)} (price: ₹${currentPrice})` };
      }
    } else {
      newTrailing = currentPrice + trailingDistance;
      if (!trailing_stop || newTrailing < trailing_stop) {
        return { action: 'UPDATE_TRAILING', reason: `Update trailing stop to ₹${newTrailing.toFixed(2)} (price: ₹${currentPrice})` };
      }
    }
  }

  // 6. Hold
  return { action: 'HOLD', reason: `Price ₹${currentPrice} within range. P&L: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%` };
}

/**
 * Check prices for all open trades, determine actions.
 *
 * @param {object[]} openTrades - Array of open trade objects from DB
 * @returns {Promise<Array<{ trade: object, action: string, reason: string, currentPrice: number }>>}
 */
export async function checkPrices(openTrades) {
  const results = [];

  const priceChecks = await Promise.allSettled(
    openTrades.map(trade => getQuote(trade.symbol))
  );

  for (let i = 0; i < openTrades.length; i++) {
    const trade = openTrades[i];
    const quoteResult = priceChecks[i];

    if (quoteResult.status === 'rejected') {
      console.error(`[price] Failed to fetch quote for ${trade.symbol}: ${quoteResult.reason}`);
      results.push({
        trade,
        action: 'HOLD',
        reason: `Quote fetch failed: ${quoteResult.reason}`,
        currentPrice: trade.current_price || trade.entry_price,
      });
      continue;
    }

    const quote = quoteResult.value;
    const currentPrice = quote.price;
    const { action, reason } = shouldExit(trade, currentPrice);

    results.push({ trade, action, reason, currentPrice });
  }

  return results;
}

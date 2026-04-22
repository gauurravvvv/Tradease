/**
 * Backtesting strategy definitions.
 * Each strategy has a `shouldEnter(technicals, bar)` method that returns
 * { type: 'CALL'|'PUT' } or null.
 */

const STRATEGIES = {
  /**
   * Screener strategy — mirrors live Trade Strategist logic.
   * Score ≥ 70 + directional signal → enter.
   */
  screener: {
    shouldEnter(technicals, bar) {
      const { score, overallSignal, rsi, volume } = technicals;

      // Score threshold
      if (score < 70) return null;

      // Volume filter
      if (volume.ratio < 1.0) return null;

      // RSI filter
      if (overallSignal === 'STRONG_BUY' || overallSignal === 'BUY') {
        if (rsi.value != null && rsi.value >= 75) return null;
        return { type: 'CALL' };
      }
      if (overallSignal === 'STRONG_SELL' || overallSignal === 'SELL') {
        if (rsi.value != null && rsi.value <= 25) return null;
        return { type: 'PUT' };
      }

      return null;
    },
  },

  /**
   * Momentum strategy — RSI + MACD crossover based.
   * Enter CALL when RSI crosses 30 from below + MACD histogram positive.
   * Enter PUT when RSI crosses 70 from above + MACD histogram negative.
   */
  momentum: {
    _prevRsi: {},

    shouldEnter(technicals, bar) {
      const { rsi, macd, volume } = technicals;
      if (!rsi.value || !macd.histogram) return null;
      if (volume.ratio < 0.8) return null;

      const symbol = bar.symbol || 'default';
      const prevRsi = this._prevRsi[symbol];
      this._prevRsi[symbol] = rsi.value;

      // RSI crossing above 30 + MACD positive
      if (prevRsi != null && prevRsi <= 30 && rsi.value > 30 && macd.histogram > 0) {
        return { type: 'CALL' };
      }

      // RSI crossing below 70 + MACD negative
      if (prevRsi != null && prevRsi >= 70 && rsi.value < 70 && macd.histogram < 0) {
        return { type: 'PUT' };
      }

      return null;
    },
  },

  /**
   * Mean reversion strategy — Bollinger Band extremes.
   * Enter CALL when price touches lower BB + RSI < 35.
   * Enter PUT when price touches upper BB + RSI > 65.
   */
  meanreversion: {
    shouldEnter(technicals, bar) {
      const { rsi, bollingerBands, volume } = technicals;
      if (!rsi.value || !bollingerBands.lower) return null;
      if (volume.ratio < 0.8) return null;

      // Price at lower BB + oversold
      if (bollingerBands.percentB != null && bollingerBands.percentB < 0.05 && rsi.value < 35) {
        return { type: 'CALL' };
      }

      // Price at upper BB + overbought
      if (bollingerBands.percentB != null && bollingerBands.percentB > 0.95 && rsi.value > 65) {
        return { type: 'PUT' };
      }

      return null;
    },
  },
};

/**
 * Get a strategy by name.
 * @param {string} name
 * @returns {Object} Strategy object with shouldEnter method
 */
export function getStrategy(name) {
  const strategy = STRATEGIES[name];
  if (!strategy) {
    throw new Error(`Unknown strategy: ${name}. Available: ${Object.keys(STRATEGIES).join(', ')}`);
  }
  return strategy;
}

/**
 * List all available strategy names.
 * @returns {string[]}
 */
export function listStrategies() {
  return Object.keys(STRATEGIES);
}

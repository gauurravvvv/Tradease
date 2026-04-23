import { jest } from '@jest/globals';
import {
  calculatePositionSize,
  calculateStopLoss,
  calculateTargets,
  calculateTrailingStop,
  validateTrade,
  shouldExit,
} from '../src/trading/risk.js';

describe('calculatePositionSize', () => {
  test('single lot when capital limited', () => {
    const result = calculatePositionSize(40000, 500, 100);
    // maxCapital = 40000 * 0.20 = 8000, oneLotCost = 500*100 = 50000 → 0 lots
    expect(result.lots).toBe(0);
  });

  test('multiple lots when capital sufficient', () => {
    const result = calculatePositionSize(200000, 50, 500);
    // maxCapital = 200000 * 0.20 = 40000, oneLotCost = 50*500 = 25000 → 1 lot
    expect(result.lots).toBe(1);
    expect(result.capitalRequired).toBe(25000);
  });

  test('maxLoss is 5% of capital', () => {
    const result = calculatePositionSize(200000, 100, 50);
    expect(result.maxLoss).toBe(10000); // 200000 * 0.05
  });

  test('zero price returns zero', () => {
    const result = calculatePositionSize(200000, 0, 100);
    expect(result.lots).toBe(0);
    expect(result.capitalRequired).toBe(0);
  });
});

describe('calculateStopLoss', () => {
  test('CALL stop loss below entry', () => {
    const sl = calculateStopLoss(100, 5, 'CALL');
    // 100 - 5 * 1.5 = 92.5
    expect(sl).toBe(92.5);
    expect(sl).toBeLessThan(100);
  });

  test('PUT stop loss above entry', () => {
    const sl = calculateStopLoss(100, 5, 'PUT');
    // 100 + 5 * 1.5 = 107.5
    expect(sl).toBe(107.5);
    expect(sl).toBeGreaterThan(100);
  });

  test('larger ATR = wider stop', () => {
    const sl1 = calculateStopLoss(100, 3, 'CALL');
    const sl2 = calculateStopLoss(100, 6, 'CALL');
    expect(sl2).toBeLessThan(sl1);
  });
});

describe('calculateTargets', () => {
  test('CALL targets above entry', () => {
    const { target1, target2 } = calculateTargets(100, 90, 'CALL');
    // risk = 10, T1 = 100 + 10*2 = 120, T2 = 100 + 10*3 = 130
    expect(target1).toBe(120);
    expect(target2).toBe(130);
  });

  test('PUT targets below entry', () => {
    const { target1, target2 } = calculateTargets(100, 110, 'PUT');
    // risk = 10, T1 = 100 - 10*2 = 80, T2 = 100 - 10*3 = 70
    expect(target1).toBe(80);
    expect(target2).toBe(70);
  });

  test('riskPerLot calculated correctly', () => {
    const { riskPerLot } = calculateTargets(100, 92, 'CALL');
    expect(riskPerLot).toBe(8);
  });
});

describe('calculateTrailingStop', () => {
  test('returns null when profit below trigger', () => {
    // TRAILING_TRIGGER_PCT = 1.0, so need >= 1% profit
    const result = calculateTrailingStop(100, 100.5, 5, 'CALL');
    expect(result).toBeNull();
  });

  test('returns trailing stop for CALL when profit above trigger', () => {
    // 2% profit on CALL
    const result = calculateTrailingStop(100, 102, 5, 'CALL');
    expect(result).not.toBeNull();
    expect(result).toBeLessThan(102);
    // 102 - 5 * 0.5 = 99.5
    expect(result).toBe(99.5);
  });

  test('returns trailing stop for PUT when profit above trigger', () => {
    const result = calculateTrailingStop(100, 98, 5, 'PUT');
    expect(result).not.toBeNull();
    expect(result).toBeGreaterThan(98);
    // 98 + 5 * 0.5 = 100.5
    expect(result).toBe(100.5);
  });
});

describe('validateTrade', () => {
  const basePortfolio = {
    positions: [],
    capitalUsed: 0,
    totalCapital: 200000,
  };

  test('valid trade passes (or rejected by market hours)', () => {
    const result = validateTrade(
      { symbol: 'RELIANCE', capitalRequired: 30000, type: 'CALL' },
      basePortfolio,
    );
    // After 15:00 IST, no new entries allowed — that's a valid rejection
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    if (currentMinutes >= 15 * 60) {
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/No new entries after/);
    } else {
      expect(result.valid).toBe(true);
    }
  });

  test('rejects when max positions reached', () => {
    const portfolio = {
      ...basePortfolio,
      positions: [{ symbol: 'A' }, { symbol: 'B' }, { symbol: 'C' }],
    };
    const result = validateTrade(
      { symbol: 'D', capitalRequired: 10000, type: 'CALL' },
      portfolio,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Max positions/);
  });

  test('rejects insufficient capital', () => {
    const portfolio = { ...basePortfolio, capitalUsed: 190000 };
    const result = validateTrade(
      { symbol: 'X', capitalRequired: 20000, type: 'CALL' },
      portfolio,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Insufficient capital/);
  });

  test('rejects duplicate symbol', () => {
    const portfolio = {
      ...basePortfolio,
      positions: [{ symbol: 'RELIANCE' }],
    };
    const result = validateTrade(
      { symbol: 'RELIANCE', capitalRequired: 10000, type: 'CALL' },
      portfolio,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Already have/);
  });
});

describe('shouldExit', () => {
  test('triggers stop-loss for CALL', () => {
    const trade = {
      entryPrice: 100,
      stopLoss: 90,
      target1: 120,
      target2: 130,
      type: 'CALL',
    };
    const result = shouldExit(trade, 89, 5);
    expect(result.shouldExit).toBe(true);
    expect(result.action).toBe('FULL_EXIT');
  });

  test('triggers stop-loss for PUT', () => {
    const trade = {
      entryPrice: 100,
      stopLoss: 110,
      target1: 80,
      target2: 70,
      type: 'PUT',
    };
    const result = shouldExit(trade, 111, 5);
    expect(result.shouldExit).toBe(true);
    expect(result.action).toBe('FULL_EXIT');
  });

  test('triggers T1 partial exit for CALL', () => {
    const trade = {
      entryPrice: 100,
      stopLoss: 90,
      target1: 120,
      target2: 130,
      type: 'CALL',
      t1Hit: false,
    };
    const result = shouldExit(trade, 121, 5);
    expect(result.shouldExit).toBe(true);
    expect(result.action).toBe('PARTIAL_T1');
  });

  test('triggers T2 for CALL', () => {
    const trade = {
      entryPrice: 100,
      stopLoss: 90,
      target1: 120,
      target2: 130,
      type: 'CALL',
      t1Hit: true,
    };
    const result = shouldExit(trade, 131, 5);
    expect(result.shouldExit).toBe(true);
    expect(result.action).toBe('PARTIAL_T2');
  });

  test('holds when within parameters', () => {
    const trade = {
      entryPrice: 100,
      stopLoss: 90,
      target1: 120,
      target2: 130,
      type: 'CALL',
      t1Hit: false,
    };
    const result = shouldExit(trade, 105, 5);
    expect(result.shouldExit).toBe(false);
    expect(result.action).toBe('HOLD');
  });
});

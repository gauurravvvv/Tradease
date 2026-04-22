import { jest } from '@jest/globals';
import { estimatePremium, getNearestExpiry, getATMStrike } from '../src/data/options.js';

describe('estimatePremium', () => {
  test('CALL premium is positive for ATM', () => {
    const premium = estimatePremium(100, 100, 'CALL', 7);
    expect(premium).toBeGreaterThan(0);
  });

  test('PUT premium is positive for ATM', () => {
    const premium = estimatePremium(100, 100, 'PUT', 7);
    expect(premium).toBeGreaterThan(0);
  });

  test('deep OTM CALL has very low premium', () => {
    const atmPremium = estimatePremium(100, 100, 'CALL', 7);
    const otmPremium = estimatePremium(100, 150, 'CALL', 7);
    expect(otmPremium).toBeLessThan(atmPremium);
  });

  test('longer expiry = higher premium', () => {
    const short = estimatePremium(100, 100, 'CALL', 3);
    const long = estimatePremium(100, 100, 'CALL', 30);
    expect(long).toBeGreaterThan(short);
  });

  test('higher IV = higher premium', () => {
    const lowIV = estimatePremium(100, 100, 'CALL', 7, 0.15);
    const highIV = estimatePremium(100, 100, 'CALL', 7, 0.40);
    expect(highIV).toBeGreaterThan(lowIV);
  });

  test('premium never negative', () => {
    const premium = estimatePremium(100, 200, 'CALL', 1, 0.10);
    expect(premium).toBeGreaterThanOrEqual(0);
  });
});

describe('getNearestExpiry', () => {
  test('returns weekly and monthly strings', () => {
    const expiry = getNearestExpiry();
    expect(expiry).toHaveProperty('weekly');
    expect(expiry).toHaveProperty('monthly');
    expect(typeof expiry.weekly).toBe('string');
    expect(typeof expiry.monthly).toBe('string');
    // Format: YYYY-MM-DD
    expect(expiry.weekly).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(expiry.monthly).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('weekly is in the future', () => {
    const expiry = getNearestExpiry();
    const weeklyDate = new Date(expiry.weekly);
    const now = new Date();
    // Weekly should be today or in the future
    expect(weeklyDate.getTime()).toBeGreaterThanOrEqual(now.getTime() - 86400000);
  });

  test('weeklyDate is a Thursday', () => {
    const expiry = getNearestExpiry();
    expect(expiry.weeklyDate.getDay()).toBe(4); // Thursday
  });

  test('monthlyDate is a Thursday', () => {
    const expiry = getNearestExpiry();
    expect(expiry.monthlyDate.getDay()).toBe(4);
  });
});

describe('getATMStrike', () => {
  test('rounds to nearest step', () => {
    expect(getATMStrike(2456, 50)).toBe(2450);
    expect(getATMStrike(2475, 50)).toBe(2500);
    expect(getATMStrike(2499, 50)).toBe(2500);
  });

  test('exact price stays same', () => {
    expect(getATMStrike(2500, 50)).toBe(2500);
    expect(getATMStrike(100, 100)).toBe(100);
  });

  test('works with different step sizes', () => {
    expect(getATMStrike(24350, 100)).toBe(24400);
    expect(getATMStrike(543, 25)).toBe(550);
    expect(getATMStrike(543, 10)).toBe(540);
  });
});

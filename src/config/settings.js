import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export const TRADING = {
  VIRTUAL_CAPITAL: 200000,
  MAX_POSITIONS: 3,
  MAX_CAPITAL_PER_POSITION: 0.2,
  MAX_LOSS_PER_TRADE: 0.05,
  MIN_CONFIDENCE: 70,
  MIN_VOLUME: 1000000,
  ATR_STOP_MULTIPLIER: 1.5,
  TRAILING_STOP_ATR: 0.5,
  TRAILING_TRIGGER_PCT: 1.0,
  PROFIT_BOOKING: {
    T1: 0.5,
    T2: 0.25,
    RUNNER: 0.25,
  },
  ADAPTIVE_TRAIL: {
    STRONG_MULTIPLIER: 1.0,
    NORMAL_MULTIPLIER: 0.7,
    WEAK_MULTIPLIER: 0.4,
    EXHAUSTION_MULTIPLIER: 0.3,
  },
  RISK_REWARD: {
    T1: 2,
    T2: 3,
  },
  NO_NEW_ENTRY_AFTER: '15:00',
  EXIT_ALL_BY: '15:15',
  INDEX_CRASH_THRESHOLD: -1.5,
};

// Cron expressions — all Mon-Fri only (day-of-week field: 1-5)
export const SCHEDULE = {
  PRE_MARKET_SCAN: '30 8 * * 1-5',
  MARKET_OPEN_CHECK: '15 9 * * 1-5',
  TRADE_EXECUTION: '30 9 * * 1-5',
  MARKET_PULSE: '*/30 9-14 * * 1-5',
  POSITION_MONITOR: '* 9-14 * * 1-5',
  WIND_DOWN: '15 15 * * 1-5',
  POST_MARKET: '45 15 * * 1-5',
};

export const DATA = {
  NEWS_FEEDS: [
    'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
    'https://www.moneycontrol.com/rss/marketreports.xml',
  ],
  YAHOO_SUFFIX: '.NS',
  CACHE_TTL_MINUTES: 30,
};

export const DB_PATH = path.join(PROJECT_ROOT, 'data', 'trades.db');

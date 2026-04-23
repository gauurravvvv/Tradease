import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'data', 'config.json');

let _cache = null;

function ensureDir() {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Load persisted config from disk. Returns empty object if no file.
 */
export function loadPersistedConfig() {
  if (_cache) return _cache;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      _cache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      return _cache;
    }
  } catch (err) {
    logger.warn(`[config] Failed to load ${CONFIG_PATH}: ${err.message}`);
  }
  _cache = {};
  return _cache;
}

// Validation rules for trading config values
const TRADING_BOUNDS = {
  VIRTUAL_CAPITAL:        { min: 10000, max: 100000000 },
  MAX_POSITIONS:          { min: 1, max: 20 },
  MAX_CAPITAL_PER_POSITION: { min: 0.01, max: 1 },
  MAX_LOSS_PER_TRADE:     { min: 0.005, max: 0.2 },
  MIN_CONFIDENCE:         { min: 0, max: 100 },
  ATR_STOP_MULTIPLIER:    { min: 0.5, max: 5 },
  TRAILING_TRIGGER_PCT:   { min: 0.1, max: 20 },
  TRAILING_STOP_ATR:      { min: 0.3, max: 5 },
};

/**
 * Validate trading config values. Throws on invalid input.
 */
function validateTradingConfig(data) {
  for (const [key, bounds] of Object.entries(TRADING_BOUNDS)) {
    if (key in data) {
      const val = Number(data[key]);
      if (!Number.isFinite(val)) {
        throw new Error(`Invalid trading config: ${key} must be a finite number, got ${data[key]}`);
      }
      if (val < bounds.min || val > bounds.max) {
        throw new Error(`Invalid trading config: ${key}=${val} out of range [${bounds.min}, ${bounds.max}]`);
      }
    }
  }
  // MAX_POSITIONS must be integer
  if ('MAX_POSITIONS' in data && !Number.isInteger(Number(data.MAX_POSITIONS))) {
    throw new Error('Invalid trading config: MAX_POSITIONS must be an integer');
  }
}

/**
 * Save a config section. Merges with existing config.
 * Validates trading config bounds before saving.
 * @param {string} section - e.g. 'email', 'telegram', 'trading'
 * @param {object} data - config data for that section
 */
export function saveConfigSection(section, data) {
  if (section === 'trading') {
    validateTradingConfig(data);
  }

  const cfg = loadPersistedConfig();
  cfg[section] = data;
  _cache = cfg;
  try {
    ensureDir();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
    logger.debug(`[config] Saved section: ${section}`);
  } catch (err) {
    logger.error(`[config] Failed to save: ${err.message}`);
  }
}

/**
 * Get a specific config section.
 */
export function getConfigSection(section) {
  const cfg = loadPersistedConfig();
  return cfg[section] || null;
}

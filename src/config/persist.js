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

/**
 * Save a config section. Merges with existing config.
 * @param {string} section - e.g. 'email', 'telegram'
 * @param {object} data - config data for that section
 */
export function saveConfigSection(section, data) {
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

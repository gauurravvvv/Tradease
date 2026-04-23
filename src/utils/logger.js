import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_DIR = path.resolve(__dirname, '..', '..', 'data', 'logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Get today's log file path: data/logs/2026-04-22.log
 */
function getLogPath() {
  const date = new Date().toISOString().split('T')[0];
  return path.join(LOG_DIR, `${date}.log`);
}

/**
 * Format a log line: [15:30:45] [INFO] message
 */
function formatLine(level, message) {
  const time = new Date().toLocaleTimeString('en-IN', { hour12: false });
  return `[${time}] [${level}] ${message}\n`;
}

/**
 * Append to today's log file.
 */
function writeToFile(level, message) {
  try {
    fs.appendFileSync(getLogPath(), formatLine(level, message));
  } catch {
    /* silent — logging should never crash the app */
  }
}

/**
 * Logger — writes to both console and file.
 * In daemon mode, file logging captures everything for later review.
 */
export const logger = {
  info(msg) {
    console.log(msg);
    writeToFile('INFO', stripAnsi(msg));
  },
  warn(msg) {
    console.warn(msg);
    writeToFile('WARN', stripAnsi(msg));
  },
  error(msg) {
    console.error(msg);
    writeToFile('ERROR', stripAnsi(msg));
  },
  trade(msg) {
    console.log(msg);
    writeToFile('TRADE', stripAnsi(msg));
  },
  /** File-only — no console output */
  debug(msg) {
    writeToFile('DEBUG', stripAnsi(msg));
  },
};

/**
 * Strip ANSI color codes for clean log files.
 */
function stripAnsi(str) {
  if (typeof str !== 'string') return String(str);
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Clean up logs older than N days.
 * @param {number} keepDays
 */
export function cleanOldLogs(keepDays = 30) {
  try {
    const cutoff = Date.now() - keepDays * 86400000;
    const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log'));
    for (const file of files) {
      const filePath = path.join(LOG_DIR, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    }
  } catch {
    /* silent */
  }
}

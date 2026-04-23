import notifier from 'node-notifier';
import { logger } from './logger.js';
import {
  isTelegramConfigured,
  telegramTradeEntry,
  telegramTradeExit,
  telegramStopLoss,
  telegramTargetHit,
  telegramDailySummary,
  telegramIndexCrash,
  telegramDaemonStart,
} from './telegram.js';
import {
  isEmailConfigured,
  emailTradeEntry,
  emailTradeExit,
  emailStopLoss,
  emailTargetHit,
  emailDailySummary,
  emailMorningSummary,
  emailIndexCrash,
  emailDaemonStart,
  emailDaemonStop,
  emailScanComplete,
} from './emailer.js';

const APP_NAME = 'Tradease';

/**
 * Send desktop notification. Non-blocking, never throws.
 *
 * @param {string} title - Notification title
 * @param {string} message - Notification body
 * @param {'info'|'trade'|'warning'|'critical'} [level='info']
 */
export function notify(title, message, level = 'info') {
  try {
    const sound =
      level === 'critical' ? 'Basso' : level === 'warning' ? 'Ping' : false;

    notifier.notify({
      title: `${APP_NAME} — ${title}`,
      message,
      sound,
      timeout: level === 'critical' ? 15 : 8,
    });

    logger.debug(`[notify] ${level}: ${title} — ${message}`);
  } catch {
    // Notifications should never crash the app
  }
}

// ---------------------------------------------------------------------------
// Convenience methods for common events
// ---------------------------------------------------------------------------

export function notifyTradeEntry(
  symbol,
  type,
  price,
  confidence,
  details = {},
) {
  notify(`${type} Entered`, `${symbol} @ ₹${price}`, 'trade');
  telegramTradeEntry(symbol, type, price, confidence);
  emailTradeEntry(symbol, type, price, confidence, details);
}

export function notifyTradeExit(symbol, type, price, pnl, details = {}) {
  const pnlStr =
    pnl >= 0
      ? `+₹${Math.abs(pnl).toFixed(0)}`
      : `-₹${Math.abs(pnl).toFixed(0)}`;
  notify(
    `${type} Exited`,
    `${symbol} @ ₹${price} | P&L: ${pnlStr}`,
    pnl >= 0 ? 'trade' : 'warning',
  );
  telegramTradeExit(symbol, type, price, pnl);
  emailTradeExit(symbol, type, price, pnl, details);
}

export function notifyStopLoss(symbol, price, details = {}) {
  notify('Stop-Loss Hit', `${symbol} stopped at ₹${price}`, 'warning');
  telegramStopLoss(symbol, price);
  emailStopLoss(symbol, price, details);
}

export function notifyTargetHit(symbol, targetNum, price) {
  notify(`Target ${targetNum} Hit`, `${symbol} reached ₹${price}`, 'trade');
  telegramTargetHit(symbol, targetNum, price);
  emailTargetHit(symbol, targetNum, price);
}

export function notifyIndexCrash(indexName, changePct) {
  notify(
    'INDEX CRASH',
    `${indexName} ${changePct.toFixed(1)}% — exiting all positions`,
    'critical',
  );
  telegramIndexCrash(indexName, changePct);
  emailIndexCrash(indexName, changePct);
}

export function notifyScanComplete(count, topPicks = []) {
  notify('Scan Complete', `${count} trade idea(s) found`, 'info');
  emailScanComplete(count, topPicks);
}

export function notifyDaemonStart() {
  notify('Daemon Started', 'Schedulers and monitors running', 'info');
  telegramDaemonStart();
  emailDaemonStart();
}

export function notifyDaemonStop() {
  notify('Daemon Stopped', 'All jobs halted', 'info');
  emailDaemonStop();
}

export function notifyDailySummary(
  totalPnl,
  winRate,
  trades,
  capital,
  details = {},
) {
  const pnlStr =
    totalPnl >= 0
      ? `+₹${totalPnl.toFixed(0)}`
      : `-₹${Math.abs(totalPnl).toFixed(0)}`;
  notify(
    'Daily Summary',
    `P&L: ${pnlStr} | Win: ${winRate}% | Trades: ${trades}`,
    totalPnl >= 0 ? 'info' : 'warning',
  );
  telegramDailySummary(totalPnl, winRate, trades, capital);
  emailDailySummary({
    totalPnl,
    winRate,
    totalTrades: trades,
    capital,
    ...details,
  });
}

export function notifyMorningSummary(data) {
  notify(
    'Morning Briefing',
    `${data.openPositions?.length || 0} positions open`,
    'info',
  );
  emailMorningSummary(data);
}

import notifier from 'node-notifier';
import { logger } from './logger.js';
import { isTelegramConfigured, telegramTradeEntry, telegramTradeExit, telegramStopLoss, telegramTargetHit, telegramDailySummary, telegramIndexCrash, telegramDaemonStart } from './telegram.js';

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
    const sound = level === 'critical' ? 'Basso' : level === 'warning' ? 'Ping' : false;

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

export function notifyTradeEntry(symbol, type, price, confidence) {
  notify(
    `${type} Entered`,
    `${symbol} @ ₹${price}`,
    'trade'
  );
  telegramTradeEntry(symbol, type, price, confidence);
}

export function notifyTradeExit(symbol, type, price, pnl) {
  const pnlStr = pnl >= 0 ? `+₹${Math.abs(pnl).toFixed(0)}` : `-₹${Math.abs(pnl).toFixed(0)}`;
  notify(
    `${type} Exited`,
    `${symbol} @ ₹${price} | P&L: ${pnlStr}`,
    pnl >= 0 ? 'trade' : 'warning'
  );
  telegramTradeExit(symbol, type, price, pnl);
}

export function notifyStopLoss(symbol, price) {
  notify(
    'Stop-Loss Hit',
    `${symbol} stopped at ₹${price}`,
    'warning'
  );
  telegramStopLoss(symbol, price);
}

export function notifyTargetHit(symbol, targetNum, price) {
  notify(
    `Target ${targetNum} Hit`,
    `${symbol} reached ₹${price}`,
    'trade'
  );
  telegramTargetHit(symbol, targetNum, price);
}

export function notifyIndexCrash(indexName, changePct) {
  notify(
    'INDEX CRASH',
    `${indexName} ${changePct.toFixed(1)}% — exiting all positions`,
    'critical'
  );
  telegramIndexCrash(indexName, changePct);
}

export function notifyScanComplete(count) {
  notify(
    'Scan Complete',
    `${count} trade idea(s) found`,
    'info'
  );
}

export function notifyDaemonStart() {
  notify('Daemon Started', 'Schedulers and monitors running', 'info');
  telegramDaemonStart();
}

export function notifyDaemonStop() {
  notify('Daemon Stopped', 'All jobs halted', 'info');
}

export function notifyDailySummary(totalPnl, winRate, trades, capital) {
  const pnlStr = totalPnl >= 0 ? `+₹${totalPnl.toFixed(0)}` : `-₹${Math.abs(totalPnl).toFixed(0)}`;
  notify(
    'Daily Summary',
    `P&L: ${pnlStr} | Win: ${winRate}% | Trades: ${trades}`,
    totalPnl >= 0 ? 'info' : 'warning'
  );
  telegramDailySummary(totalPnl, winRate, trades, capital);
}

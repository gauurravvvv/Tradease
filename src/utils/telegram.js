import { logger } from './logger.js';

let BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
let CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

/**
 * Configure Telegram bot credentials.
 * @param {string} token - Bot token from @BotFather
 * @param {string} chatId - Chat ID to send messages to
 */
export function configureTelegram(token, chatId) {
  BOT_TOKEN = token;
  CHAT_ID = chatId;
}

/**
 * Check if Telegram is configured.
 */
export function isTelegramConfigured() {
  return !!(BOT_TOKEN && CHAT_ID);
}

/**
 * Send a message via Telegram Bot API.
 * Non-blocking, never throws.
 * @param {string} text - Message text (supports HTML parse mode)
 */
export async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) return;

  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      logger.warn(`[telegram] Send failed: ${err}`);
    }
  } catch (err) {
    logger.warn(`[telegram] Error: ${err.message}`);
  }
}

// ── Convenience methods ──

export function telegramTradeEntry(symbol, type, price, confidence) {
  sendTelegram(
    `🟢 <b>ENTRY: ${type} ${symbol}</b>\n` +
    `💰 Price: ₹${price}\n` +
    `📊 Confidence: ${confidence}%\n` +
    `⏰ ${new Date().toLocaleTimeString('en-IN')}`
  );
}

export function telegramTradeExit(symbol, type, price, pnl) {
  const emoji = pnl >= 0 ? '🟢' : '🔴';
  const pnlStr = pnl >= 0 ? `+₹${Math.abs(pnl).toFixed(0)}` : `-₹${Math.abs(pnl).toFixed(0)}`;
  sendTelegram(
    `${emoji} <b>EXIT: ${type} ${symbol}</b>\n` +
    `💰 Price: ₹${price}\n` +
    `📈 P&L: <b>${pnlStr}</b>\n` +
    `⏰ ${new Date().toLocaleTimeString('en-IN')}`
  );
}

export function telegramStopLoss(symbol, price) {
  sendTelegram(
    `🛑 <b>STOP-LOSS: ${symbol}</b>\n` +
    `💰 Stopped at ₹${price}\n` +
    `⏰ ${new Date().toLocaleTimeString('en-IN')}`
  );
}

export function telegramTargetHit(symbol, targetNum, price) {
  sendTelegram(
    `🎯 <b>TARGET ${targetNum} HIT: ${symbol}</b>\n` +
    `💰 Price: ₹${price}\n` +
    `⏰ ${new Date().toLocaleTimeString('en-IN')}`
  );
}

export function telegramDailySummary(pnl, winRate, trades, capital) {
  const emoji = pnl >= 0 ? '📈' : '📉';
  const pnlStr = pnl >= 0 ? `+₹${pnl.toFixed(0)}` : `-₹${Math.abs(pnl).toFixed(0)}`;
  sendTelegram(
    `${emoji} <b>DAILY SUMMARY</b>\n` +
    `💰 P&L: <b>${pnlStr}</b>\n` +
    `🎯 Win Rate: ${winRate}%\n` +
    `📊 Trades: ${trades}\n` +
    `🏦 Capital: ₹${capital?.toLocaleString('en-IN') || '--'}\n` +
    `📅 ${new Date().toLocaleDateString('en-IN')}`
  );
}

export function telegramIndexCrash(indexName, changePct) {
  sendTelegram(
    `🚨🚨 <b>INDEX CRASH: ${indexName} ${changePct.toFixed(1)}%</b>\n` +
    `⚠️ Exiting all positions!\n` +
    `⏰ ${new Date().toLocaleTimeString('en-IN')}`
  );
}

export function telegramDaemonStart() {
  sendTelegram(
    `🤖 <b>Tradease Daemon Started</b>\n` +
    `✅ All agents active\n` +
    `⏰ ${new Date().toLocaleTimeString('en-IN')}`
  );
}

export function telegramScanComplete(count, topPicks) {
  let msg = `🔍 <b>Scan Complete: ${count} ideas</b>\n`;
  if (topPicks && topPicks.length) {
    msg += '\nTop picks:\n';
    for (const p of topPicks.slice(0, 5)) {
      msg += `  ${p.recommendation === 'CALL' ? '🟢' : '🔴'} ${p.symbol} — Score: ${p.score}\n`;
    }
  }
  msg += `\n⏰ ${new Date().toLocaleTimeString('en-IN')}`;
  sendTelegram(msg);
}

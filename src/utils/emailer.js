import nodemailer from 'nodemailer';
import { logger } from './logger.js';

let _config = {
  host: '',
  port: 587,
  user: '',
  pass: '',
  from: '',
  to: '',
};
let _transporter = null;

// ── Configuration ──

export function configureEmail(cfg) {
  _config = { ..._config, ...cfg };
  _transporter = null; // reset so next send rebuilds
}

export function isEmailConfigured() {
  return !!(
    _config.host &&
    _config.user &&
    _config.pass &&
    _config.from &&
    _config.to
  );
}

export function getEmailConfig() {
  return {
    host: _config.host,
    port: _config.port,
    user: _config.user,
    from: _config.from,
    to: _config.to,
    configured: isEmailConfigured(),
  };
}

function getTransporter() {
  if (_transporter) return _transporter;
  if (!isEmailConfigured()) return null;
  _transporter = nodemailer.createTransport({
    host: _config.host,
    port: _config.port,
    secure: _config.port === 465,
    auth: { user: _config.user, pass: _config.pass },
  });
  return _transporter;
}

// ── Send ──

async function send(subject, html) {
  const t = getTransporter();
  if (!t) return;
  try {
    await t.sendMail({
      from: _config.from,
      to: _config.to,
      subject: `Tradease | ${subject}`,
      html: wrapHTML(subject, html),
    });
    logger.debug(`[email] Sent: ${subject}`);
  } catch (err) {
    logger.warn(`[email] Failed: ${err.message}`);
  }
}

// ── HTML wrapper ──

function wrapHTML(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f8;font-family:'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f8;padding:20px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr><td style="background:linear-gradient(135deg,#0a0a0f,#1a1a2e);padding:20px 24px">
    <span style="font-size:20px;font-weight:700;color:#06b6d4;font-family:monospace">&#9889; TRADEASE</span>
    <span style="float:right;font-size:12px;color:#6b7280;line-height:28px">${istNow()}</span>
  </td></tr>
  <tr><td style="padding:24px">${body}</td></tr>
  <tr><td style="background:#f9fafb;padding:12px 24px;font-size:11px;color:#9ca3af;text-align:center">
    Tradease Autonomous Trading System &mdash; Paper Trading
  </td></tr>
</table>
</td></tr></table></body></html>`;
}

function istNow() {
  return new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function inr(n) {
  if (n == null || isNaN(n)) return '&#8377;0';
  const neg = n < 0;
  return `${neg ? '-' : ''}&#8377;${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function pnlColor(n) {
  return n >= 0 ? '#16a34a' : '#dc2626';
}
function badge(text, bg, color) {
  return `<span style="display:inline-block;padding:4px 12px;border-radius:4px;background:${bg};color:${color};font-size:12px;font-weight:700">${text}</span>`;
}
function row(label, value) {
  return `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px">${label}</td><td style="padding:6px 0;text-align:right;font-weight:600;font-size:13px">${value}</td></tr>`;
}

// ── Trade Entry ──

export function emailTradeEntry(symbol, type, price, confidence, details = {}) {
  const color = type === 'CALL' ? '#16a34a' : '#dc2626';
  const html = `
    <div style="margin-bottom:16px">
      ${badge(type, type === 'CALL' ? '#dcfce7' : '#fee2e2', color)}
      <span style="font-size:20px;font-weight:700;margin-left:10px">${symbol}</span>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb">
      ${row('Entry Price', `&#8377;${price}`)}
      ${confidence ? row('Confidence', `${confidence}%`) : ''}
      ${details.stopLoss ? row('Stop Loss', `&#8377;${details.stopLoss}`) : ''}
      ${details.target1 ? row('Target 1', `&#8377;${details.target1}`) : ''}
      ${details.target2 ? row('Target 2', `&#8377;${details.target2}`) : ''}
      ${details.capitalUsed ? row('Capital Used', inr(details.capitalUsed)) : ''}
      ${details.reason ? row('Reason', `<span style="font-size:11px;color:#6b7280">${details.reason}</span>`) : ''}
    </table>`;
  send(`${type} Entry: ${symbol} @ &#8377;${price}`, html);
}

// ── Trade Exit ──

export function emailTradeExit(symbol, type, price, pnl, details = {}) {
  const pnlStr = pnl >= 0 ? `+${inr(pnl)}` : inr(pnl);
  const html = `
    <div style="margin-bottom:16px">
      ${badge('EXIT', '#f3f4f6', '#374151')}
      <span style="font-size:20px;font-weight:700;margin-left:10px">${symbol}</span>
      <span style="font-size:16px;font-weight:700;margin-left:12px;color:${pnlColor(pnl)}">${pnlStr}</span>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb">
      ${row('Type', type)}
      ${row('Exit Price', `&#8377;${price}`)}
      ${row('P&L', `<span style="color:${pnlColor(pnl)};font-weight:700">${pnlStr}</span>`)}
      ${details.entryPrice ? row('Entry Price', `&#8377;${details.entryPrice}`) : ''}
      ${details.reason ? row('Exit Reason', details.reason) : ''}
      ${details.holdTime ? row('Hold Time', details.holdTime) : ''}
    </table>`;
  send(`Exit: ${symbol} ${pnl >= 0 ? 'Profit' : 'Loss'} ${pnlStr}`, html);
}

// ── Stop-Loss ──

export function emailStopLoss(symbol, price, details = {}) {
  const html = `
    <div style="margin-bottom:16px">
      ${badge('STOP-LOSS', '#fee2e2', '#dc2626')}
      <span style="font-size:20px;font-weight:700;margin-left:10px">${symbol}</span>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb">
      ${row('Stopped At', `&#8377;${price}`)}
      ${details.entryPrice ? row('Entry Price', `&#8377;${details.entryPrice}`) : ''}
      ${details.loss ? row('Loss', `<span style="color:#dc2626">${inr(details.loss)}</span>`) : ''}
    </table>`;
  send(`Stop-Loss Hit: ${symbol} @ &#8377;${price}`, html);
}

// ── Target Hit ──

export function emailTargetHit(symbol, targetNum, price) {
  const html = `
    <div style="margin-bottom:16px">
      ${badge(`TARGET ${targetNum}`, '#dbeafe', '#2563eb')}
      <span style="font-size:20px;font-weight:700;margin-left:10px">${symbol}</span>
    </div>
    <p style="font-size:14px;color:#374151">Target ${targetNum} reached at <strong>&#8377;${price}</strong>. Partial profit booked.</p>`;
  send(`Target ${targetNum} Hit: ${symbol} @ &#8377;${price}`, html);
}

// ── Index Crash ──

export function emailIndexCrash(indexName, changePct) {
  const html = `
    <div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:8px;padding:16px;text-align:center">
      <div style="font-size:24px;font-weight:700;color:#dc2626">&#9888; INDEX CRASH</div>
      <div style="font-size:18px;margin-top:8px">${indexName} <strong>${changePct.toFixed(1)}%</strong></div>
      <div style="font-size:13px;color:#6b7280;margin-top:8px">Emergency exit triggered for all positions</div>
    </div>`;
  send(`CRASH: ${indexName} ${changePct.toFixed(1)}%`, html);
}

// ── Daily Summary ──

export function emailDailySummary(data) {
  const {
    totalPnl = 0,
    winRate = 0,
    totalTrades = 0,
    winners = 0,
    losers = 0,
    capital = 0,
    openPositions = 0,
    realizedPnl = 0,
    unrealizedPnl = 0,
  } = data;
  const pnlStr = totalPnl >= 0 ? `+${inr(totalPnl)}` : inr(totalPnl);
  const html = `
    <div style="text-align:center;margin-bottom:20px">
      <div style="font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:2px">End of Day Report</div>
      <div style="font-size:28px;font-weight:700;color:${pnlColor(totalPnl)};margin-top:8px">${pnlStr}</div>
      <div style="font-size:12px;color:#9ca3af;margin-top:4px">${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb">
      ${row('Total Trades', totalTrades)}
      ${row('Winners / Losers', `<span style="color:#16a34a">${winners}W</span> / <span style="color:#dc2626">${losers}L</span>`)}
      ${row('Win Rate', `${winRate}%`)}
      ${row('Realized P&L', `<span style="color:${pnlColor(realizedPnl)}">${inr(realizedPnl)}</span>`)}
      ${row('Unrealized P&L', `<span style="color:${pnlColor(unrealizedPnl)}">${inr(unrealizedPnl)}</span>`)}
      ${row('Open Positions', openPositions)}
      ${row('Net Worth', `<strong>${inr(capital)}</strong>`)}
    </table>`;
  send(`Daily Report: ${pnlStr}`, html);
}

// ── Morning Summary ──

export function emailMorningSummary(data) {
  const {
    openPositions = [],
    watchlist = [],
    capital = 0,
    availableCapital = 0,
  } = data;
  let posHtml = '';
  if (openPositions.length) {
    posHtml = `<div style="font-size:13px;font-weight:600;margin:12px 0 8px">Open Positions (${openPositions.length})</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:6px;overflow:hidden">
      <tr style="background:#f9fafb"><th style="padding:6px 10px;text-align:left;font-size:11px;color:#6b7280">Symbol</th><th style="padding:6px 10px;text-align:left;font-size:11px;color:#6b7280">Type</th><th style="padding:6px 10px;text-align:right;font-size:11px;color:#6b7280">Entry</th><th style="padding:6px 10px;text-align:right;font-size:11px;color:#6b7280">SL</th><th style="padding:6px 10px;text-align:right;font-size:11px;color:#6b7280">T1</th></tr>
      ${openPositions.map(p => `<tr><td style="padding:6px 10px;font-size:12px;font-weight:600">${p.symbol}</td><td style="padding:6px 10px;font-size:12px;color:${p.type === 'CALL' ? '#16a34a' : '#dc2626'}">${p.type}</td><td style="padding:6px 10px;text-align:right;font-size:12px">&#8377;${p.entry_price}</td><td style="padding:6px 10px;text-align:right;font-size:12px;color:#dc2626">&#8377;${p.stop_loss}</td><td style="padding:6px 10px;text-align:right;font-size:12px;color:#16a34a">&#8377;${p.target1 || '--'}</td></tr>`).join('')}
    </table>`;
  }
  const html = `
    <div style="text-align:center;margin-bottom:16px">
      <div style="font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:2px">Morning Briefing</div>
      <div style="font-size:12px;color:#9ca3af;margin-top:4px">${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb">
      ${row('Net Worth', `<strong>${inr(capital)}</strong>`)}
      ${row('Available Capital', inr(availableCapital))}
      ${row('Open Positions', openPositions.length)}
    </table>
    ${posHtml}`;
  send('Morning Briefing', html);
}

// ── Daemon Start / Stop ──

export function emailDaemonStart() {
  const html = `
    <div style="text-align:center;padding:16px">
      <div style="font-size:32px">&#9889;</div>
      <div style="font-size:16px;font-weight:700;margin-top:8px">Daemon Started</div>
      <div style="font-size:13px;color:#6b7280;margin-top:4px">All agents and schedulers are active</div>
    </div>`;
  send('Daemon Started', html);
}

export function emailDaemonStop() {
  const html = `
    <div style="text-align:center;padding:16px">
      <div style="font-size:32px">&#9209;</div>
      <div style="font-size:16px;font-weight:700;margin-top:8px">Daemon Stopped</div>
      <div style="font-size:13px;color:#6b7280;margin-top:4px">All agents halted</div>
    </div>`;
  send('Daemon Stopped', html);
}

// ── Scan Complete ──

export function emailScanComplete(count, topPicks = []) {
  let picksHtml = '';
  if (topPicks.length) {
    picksHtml = `<div style="font-size:13px;font-weight:600;margin:12px 0 8px">Top Picks</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:6px;overflow:hidden">
      <tr style="background:#f9fafb"><th style="padding:6px 10px;text-align:left;font-size:11px;color:#6b7280">Symbol</th><th style="padding:6px 10px;text-align:left;font-size:11px;color:#6b7280">Signal</th><th style="padding:6px 10px;text-align:right;font-size:11px;color:#6b7280">Score</th><th style="padding:6px 10px;text-align:right;font-size:11px;color:#6b7280">Price</th></tr>
      ${topPicks
        .slice(0, 8)
        .map(
          p =>
            `<tr><td style="padding:6px 10px;font-size:12px;font-weight:600">${p.symbol}</td><td style="padding:6px 10px;font-size:12px;color:${p.recommendation === 'CALL' ? '#16a34a' : '#dc2626'}">${p.recommendation}</td><td style="padding:6px 10px;text-align:right;font-size:12px;font-weight:600">${p.score}</td><td style="padding:6px 10px;text-align:right;font-size:12px">&#8377;${p.price}</td></tr>`,
        )
        .join('')}
    </table>`;
  }
  const html = `
    <div style="margin-bottom:12px">
      ${badge(`${count} IDEAS`, '#dbeafe', '#2563eb')}
    </div>
    <p style="font-size:14px;color:#374151">Pre-market scan complete. ${count} trade idea(s) found.</p>
    ${picksHtml}`;
  send(`Scan Complete: ${count} Ideas`, html);
}

// ── Test email ──

export async function sendTestEmail() {
  const t = getTransporter();
  if (!t) throw new Error('Email not configured');
  await t.sendMail({
    from: _config.from,
    to: _config.to,
    subject: 'Tradease | Test Email',
    html: wrapHTML(
      'Test',
      '<div style="text-align:center;padding:20px"><div style="font-size:32px">&#9889;</div><div style="font-size:16px;font-weight:600;margin-top:8px">Email Connected!</div><div style="font-size:13px;color:#6b7280;margin-top:4px">You will receive trade alerts at this address.</div></div>',
    ),
  });
}

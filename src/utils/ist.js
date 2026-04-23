/**
 * IST (Indian Standard Time) utilities.
 * Uses Intl.DateTimeFormat for reliable timezone conversion regardless of system locale.
 */

const IST_TZ = 'Asia/Kolkata';

// Reusable formatters (created once, used many times)
const _hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: IST_TZ, hour: 'numeric', hour12: false });
const _minFmt = new Intl.DateTimeFormat('en-US', { timeZone: IST_TZ, minute: 'numeric' });
const _dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: IST_TZ, weekday: 'short' });

/**
 * Get current IST hours and minutes as { hour, minute, day }.
 * day: 0=Sun, 1=Mon ... 6=Sat
 */
export function getISTTime(date = new Date()) {
  const hour = parseInt(_hourFmt.format(date), 10);
  const minute = parseInt(_minFmt.format(date), 10);
  const dayStr = _dayFmt.format(date);
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hour, minute, day: dayMap[dayStr] ?? new Date(date.toLocaleString('en-US', { timeZone: IST_TZ })).getDay() };
}

/**
 * Get current IST time as total minutes since midnight.
 */
export function getISTMinutes(date = new Date()) {
  const { hour, minute } = getISTTime(date);
  return hour * 60 + minute;
}

/**
 * Check if current IST time is within market hours (Mon-Fri, between start and end).
 */
export function isMarketHours(startHour = 9, startMin = 15, endHour = 15, endMin = 30, date = new Date()) {
  const { hour, minute, day } = getISTTime(date);
  if (day === 0 || day === 6) return false;
  const mins = hour * 60 + minute;
  return mins >= startHour * 60 + startMin && mins <= endHour * 60 + endMin;
}

/**
 * Check if it's a weekday during broad market hours (9:00-16:00 IST).
 */
export function isMarketOpen(date = new Date()) {
  const { hour, minute, day } = getISTTime(date);
  if (day === 0 || day === 6) return false;
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 && mins < 16 * 60;
}

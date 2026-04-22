import { getQuote } from '../data/market.js';
import { TRADING } from '../config/settings.js';

/**
 * Check health of major indices (Nifty 50 and Bank Nifty).
 *
 * @returns {Promise<{
 *   nifty: { price: number, change: number, changePct: number },
 *   bankNifty: { price: number, change: number, changePct: number },
 *   alert: boolean,
 *   severity: 'normal'|'warning'|'critical'
 * }>}
 */
export async function checkIndexHealth() {
  const [niftyResult, bankNiftyResult] = await Promise.allSettled([
    getQuote('NIFTY'),
    getQuote('BANKNIFTY'),
  ]);

  const nifty = niftyResult.status === 'fulfilled'
    ? {
        price: niftyResult.value.price,
        change: niftyResult.value.change,
        changePct: niftyResult.value.changePct,
      }
    : { price: 0, change: 0, changePct: 0 };

  const bankNifty = bankNiftyResult.status === 'fulfilled'
    ? {
        price: bankNiftyResult.value.price,
        change: bankNiftyResult.value.change,
        changePct: bankNiftyResult.value.changePct,
      }
    : { price: 0, change: 0, changePct: 0 };

  // Thresholds
  const crashThreshold = TRADING.INDEX_CRASH_THRESHOLD; // -1.5%
  const warningThreshold = crashThreshold / 2;          // -0.75%
  const criticalThreshold = crashThreshold * 2;         // -3.0%

  const niftyDrop = nifty.changePct;
  const bankNiftyDrop = bankNifty.changePct;
  const worstDrop = Math.min(niftyDrop, bankNiftyDrop);

  let severity = 'normal';
  let alert = false;

  if (worstDrop <= criticalThreshold) {
    severity = 'critical';
    alert = true;
  } else if (worstDrop <= crashThreshold) {
    severity = 'warning';
    alert = true;
  }

  return { nifty, bankNifty, alert, severity };
}

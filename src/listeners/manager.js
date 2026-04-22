import { checkPrices } from './price.js';
import { checkNewsForPositions } from './news-monitor.js';
import { checkIndexHealth } from './index-monitor.js';
import { getOpenTrades, exitTrade, partialExit, stopTrade, updateTradePrice } from '../trading/manager.js';
import { getQuote } from '../data/market.js';
import { TRADING } from '../config/settings.js';
import { logger } from '../utils/logger.js';
import { notifyIndexCrash, notifyTargetHit } from '../utils/notify.js';

/**
 * Listener orchestrator. Runs periodic checks on open positions.
 * Monitors prices, index health, and news.
 */
export class ListenerManager {
  constructor({ tickIntervalMs = 60_000 } = {}) {
    this.tickIntervalMs = tickIntervalMs;
    this.priceInterval = null;
    this.newsInterval = null;
    this.indexInterval = null;
    this.tickCount = 0;
    this.running = false;
  }

  /**
   * Begin all monitoring. Runs tick() on interval.
   */
  start() {
    if (this.running) {
      logger.info('[listener] Already running');
      return;
    }

    this.running = true;
    this.tickCount = 0;

    logger.info(`[listener] Starting position monitor (interval: ${this.tickIntervalMs / 1000}s)`);

    // Single interval drives all checks via tick()
    this.priceInterval = setInterval(() => this.tick(), this.tickIntervalMs);

    // Run first tick immediately
    this.tick();
  }

  /**
   * Stop all monitoring intervals.
   */
  stop() {
    if (this.priceInterval) {
      clearInterval(this.priceInterval);
      this.priceInterval = null;
    }
    if (this.newsInterval) {
      clearInterval(this.newsInterval);
      this.newsInterval = null;
    }
    if (this.indexInterval) {
      clearInterval(this.indexInterval);
      this.indexInterval = null;
    }

    this.running = false;
    logger.info('[listener] Stopped all monitors');
  }

  /**
   * Single execution cycle. Called every tick.
   */
  async tick() {
    this.tickCount++;
    const ts = new Date().toLocaleTimeString('en-IN');

    try {
      // 1. Get open trades
      const openTrades = getOpenTrades();

      if (!openTrades || openTrades.length === 0) {
        if (this.tickCount % 10 === 0) {
          logger.debug(`[listener] Tick #${this.tickCount} @ ${ts} — No open positions`);
        }
        return;
      }

      logger.debug(`[listener] Tick #${this.tickCount} @ ${ts} — Checking ${openTrades.length} position(s)`);

      // 2. Check index health first — emergency exit if critical
      const indexHealth = await checkIndexHealth();

      if (indexHealth.severity === 'critical') {
        logger.error(`[listener] CRITICAL: Market crash detected! Nifty ${indexHealth.nifty.changePct?.toFixed(2)}%, BankNifty ${indexHealth.bankNifty.changePct?.toFixed(2)}%`);
        logger.error('[listener] Emergency exit ALL positions');
        notifyIndexCrash('Nifty', indexHealth.nifty.changePct || 0);

        for (const trade of openTrades) {
          try {
            let exitPrice = trade.current_price || trade.entry_price;
            try {
              const q = await getQuote(trade.symbol);
              exitPrice = q.price;
            } catch { /* use last known */ }
            const reason = `Emergency exit — index crash (Nifty: ${indexHealth.nifty.changePct?.toFixed(2)}%)`;
            exitTrade(trade.id, exitPrice, reason);
            logger.trade(`[listener] Exited ${trade.symbol} (emergency)`);
          } catch (err) {
            logger.error(`[listener] Failed to exit ${trade.symbol}: ${err.message}`);
          }
        }
        return; // Skip further checks after emergency exit
      }

      if (indexHealth.alert) {
        logger.warn(`[listener] WARNING: Index weakness — Nifty ${indexHealth.nifty.changePct?.toFixed(2)}%, BankNifty ${indexHealth.bankNifty.changePct?.toFixed(2)}%`);
      }

      // 3. Check prices → execute exits if needed
      const priceActions = await checkPrices(openTrades);

      for (const { trade, action, reason, currentPrice } of priceActions) {
        switch (action) {
          case 'FULL_EXIT':
            logger.trade(`[listener] EXIT ${trade.symbol}: ${reason}`);
            try {
              if (reason.includes('Stop-loss') || reason.includes('Trailing stop')) {
                stopTrade(trade.id, currentPrice);
              } else {
                exitTrade(trade.id, currentPrice, reason);
              }
            } catch (err) {
              logger.error(`[listener] Failed to exit ${trade.symbol}: ${err.message}`);
            }
            break;

          case 'PARTIAL_T1':
            logger.trade(`[listener] PARTIAL T1 ${trade.symbol}: ${reason}`);
            notifyTargetHit(trade.symbol, 1, currentPrice);
            try {
              partialExit(trade.id, TRADING.PROFIT_BOOKING.T1, currentPrice, reason);
            } catch (err) {
              logger.error(`[listener] Failed partial T1 ${trade.symbol}: ${err.message}`);
            }
            break;

          case 'PARTIAL_T2':
            logger.trade(`[listener] PARTIAL T2 ${trade.symbol}: ${reason}`);
            notifyTargetHit(trade.symbol, 2, currentPrice);
            try {
              const t2Pct = TRADING.PROFIT_BOOKING.T2 / (1 - TRADING.PROFIT_BOOKING.T1);
              partialExit(trade.id, t2Pct, currentPrice, reason);
            } catch (err) {
              logger.error(`[listener] Failed partial T2 ${trade.symbol}: ${err.message}`);
            }
            break;

          case 'UPDATE_TRAILING':
            logger.debug(`[listener] TRAILING ${trade.symbol}: ${reason}`);
            try {
              updateTradePrice(trade.id, currentPrice);
            } catch (err) {
              logger.error(`[listener] Failed trailing update ${trade.symbol}: ${err.message}`);
            }
            break;

          case 'HOLD':
            break;

          default:
            logger.info(`[listener] ${trade.symbol}: ${action} — ${reason}`);
        }
      }

      // 4. Check news every 5th tick (not every minute)
      if (this.tickCount % 5 === 0) {
        logger.debug(`[listener] Running news check (tick #${this.tickCount})`);

        // Re-fetch open trades in case some were exited above
        const currentTrades = getOpenTrades();
        if (currentTrades.length > 0) {
          const newsAlerts = await checkNewsForPositions(currentTrades);

          for (const { trade, sentiment, sentimentScore, alert, newsItems } of newsAlerts) {
            if (alert) {
              logger.warn(`[listener] NEWS ALERT ${trade.symbol}: sentiment=${sentiment} (score: ${sentimentScore})`);
              for (const item of newsItems.slice(0, 3)) {
                logger.info(`  → ${item.title}`);
              }
            }
          }
        }
      }
    } catch (err) {
      logger.error(`[listener] Tick #${this.tickCount} error: ${err.message}`);
    }
  }
}

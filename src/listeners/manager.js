import { checkPrices } from './price.js';
import { checkNewsForPositions } from './news-monitor.js';
import { checkIndexHealth } from './index-monitor.js';
import { getOpenTrades, exitTrade, partialExit, stopTrade, updateTradePrice } from '../trading/manager.js';
import { getQuote } from '../data/market.js';
import { TRADING } from '../config/settings.js';

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
      console.log('[listener] Already running');
      return;
    }

    this.running = true;
    this.tickCount = 0;

    console.log(`[listener] Starting position monitor (interval: ${this.tickIntervalMs / 1000}s)`);

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
    console.log('[listener] Stopped all monitors');
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
          console.log(`[listener] Tick #${this.tickCount} @ ${ts} — No open positions`);
        }
        return;
      }

      console.log(`[listener] Tick #${this.tickCount} @ ${ts} — Checking ${openTrades.length} position(s)`);

      // 2. Check index health first — emergency exit if critical
      const indexHealth = await checkIndexHealth();

      if (indexHealth.severity === 'critical') {
        console.log(`[listener] CRITICAL: Market crash detected! Nifty ${indexHealth.nifty.changePct?.toFixed(2)}%, BankNifty ${indexHealth.bankNifty.changePct?.toFixed(2)}%`);
        console.log('[listener] Emergency exit ALL positions');

        for (const trade of openTrades) {
          try {
            let exitPrice = trade.current_price || trade.entry_price;
            try {
              const q = await getQuote(trade.symbol);
              exitPrice = q.price;
            } catch { /* use last known */ }
            const reason = `Emergency exit — index crash (Nifty: ${indexHealth.nifty.changePct?.toFixed(2)}%)`;
            exitTrade(trade.id, exitPrice, reason);
            console.log(`[listener] Exited ${trade.symbol} (emergency)`);
          } catch (err) {
            console.error(`[listener] Failed to exit ${trade.symbol}: ${err.message}`);
          }
        }
        return; // Skip further checks after emergency exit
      }

      if (indexHealth.alert) {
        console.log(`[listener] WARNING: Index weakness — Nifty ${indexHealth.nifty.changePct?.toFixed(2)}%, BankNifty ${indexHealth.bankNifty.changePct?.toFixed(2)}%`);
      }

      // 3. Check prices → execute exits if needed
      const priceActions = await checkPrices(openTrades);

      for (const { trade, action, reason, currentPrice } of priceActions) {
        switch (action) {
          case 'FULL_EXIT':
            console.log(`[listener] EXIT ${trade.symbol}: ${reason}`);
            try {
              // Use stopTrade for SL hits, exitTrade for others
              if (reason.includes('Stop-loss') || reason.includes('Trailing stop')) {
                stopTrade(trade.id, currentPrice);
              } else {
                exitTrade(trade.id, currentPrice, reason);
              }
            } catch (err) {
              console.error(`[listener] Failed to exit ${trade.symbol}: ${err.message}`);
            }
            break;

          case 'PARTIAL_T1':
            console.log(`[listener] PARTIAL T1 ${trade.symbol}: ${reason}`);
            try {
              // T1 = book 50% (PROFIT_BOOKING.T1)
              partialExit(trade.id, TRADING.PROFIT_BOOKING.T1, currentPrice, reason);
            } catch (err) {
              console.error(`[listener] Failed partial T1 ${trade.symbol}: ${err.message}`);
            }
            break;

          case 'PARTIAL_T2':
            console.log(`[listener] PARTIAL T2 ${trade.symbol}: ${reason}`);
            try {
              // T2 = book 25% of original (50% of remaining after T1)
              const t2Pct = TRADING.PROFIT_BOOKING.T2 / (1 - TRADING.PROFIT_BOOKING.T1);
              partialExit(trade.id, t2Pct, currentPrice, reason);
            } catch (err) {
              console.error(`[listener] Failed partial T2 ${trade.symbol}: ${err.message}`);
            }
            break;

          case 'UPDATE_TRAILING':
            console.log(`[listener] TRAILING ${trade.symbol}: ${reason}`);
            try {
              // Update trailing stop via direct DB update through updateTradePrice
              // The trailing stop is already computed in the price listener;
              // we update current_price which triggers the trade record update
              updateTradePrice(trade.id, currentPrice);
            } catch (err) {
              console.error(`[listener] Failed trailing update ${trade.symbol}: ${err.message}`);
            }
            break;

          case 'HOLD':
            // Silent unless verbose
            break;

          default:
            console.log(`[listener] ${trade.symbol}: ${action} — ${reason}`);
        }
      }

      // 4. Check news every 5th tick (not every minute)
      if (this.tickCount % 5 === 0) {
        console.log(`[listener] Running news check (tick #${this.tickCount})`);

        // Re-fetch open trades in case some were exited above
        const currentTrades = getOpenTrades();
        if (currentTrades.length > 0) {
          const newsAlerts = await checkNewsForPositions(currentTrades);

          for (const { trade, sentiment, sentimentScore, alert, newsItems } of newsAlerts) {
            if (alert) {
              console.log(`[listener] NEWS ALERT ${trade.symbol}: sentiment=${sentiment} (score: ${sentimentScore})`);
              for (const item of newsItems.slice(0, 3)) {
                console.log(`  → ${item.title}`);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`[listener] Tick #${this.tickCount} error: ${err.message}`);
    }
  }
}

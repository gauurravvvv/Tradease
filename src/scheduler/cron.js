import cron from 'node-cron';
import { SCHEDULE } from '../config/settings.js';

/**
 * Cron job scheduler for Tradease daemon.
 */
export class Scheduler {
  constructor() {
    this.jobs = [];
  }

  /**
   * Register a single cron job.
   *
   * @param {string} name - Human-readable job name
   * @param {string} cronExpression - Valid cron expression (node-cron format)
   * @param {Function} handler - Async function to execute
   */
  registerJob(name, cronExpression, handler) {
    if (!cron.validate(cronExpression)) {
      throw new Error(
        `Invalid cron expression for "${name}": ${cronExpression}`,
      );
    }

    const task = cron.schedule(
      cronExpression,
      async () => {
        const ts = new Date().toLocaleTimeString('en-IN');
        console.log(`[cron] Running "${name}" @ ${ts}`);
        try {
          await handler();
        } catch (err) {
          console.error(`[cron] "${name}" failed: ${err.message}`);
        }
      },
      {
        scheduled: false, // Don't start until start() called
      },
    );

    this.jobs.push({ name, cronExpression, task });
    console.log(`[cron] Registered "${name}" → ${cronExpression}`);
  }

  /**
   * Start all registered cron jobs.
   */
  start() {
    for (const job of this.jobs) {
      job.task.start();
    }
    console.log(`[cron] Started ${this.jobs.length} job(s)`);
  }

  /**
   * Stop all running cron jobs.
   */
  stop() {
    for (const job of this.jobs) {
      job.task.stop();
    }
    console.log(`[cron] Stopped ${this.jobs.length} job(s)`);
  }

  /**
   * Register all standard Tradease jobs.
   *
   * @param {object} handlers - Object with handler functions:
   *   { preMarketScan, marketOpenCheck, tradeExecution, marketPulse, positionMonitor, windDown, postMarket }
   */
  registerAllJobs(handlers) {
    const jobDefs = [
      {
        name: 'Pre-Market Scan',
        schedule: SCHEDULE.PRE_MARKET_SCAN,
        handler: handlers.preMarketScan,
      },
      {
        name: 'Market Open Check',
        schedule: SCHEDULE.MARKET_OPEN_CHECK,
        handler: handlers.marketOpenCheck,
      },
      {
        name: 'Trade Execution',
        schedule: SCHEDULE.TRADE_EXECUTION,
        handler: handlers.tradeExecution,
      },
      {
        name: 'Market Pulse',
        schedule: SCHEDULE.MARKET_PULSE,
        handler: handlers.marketPulse,
      },
      {
        name: 'Position Monitor',
        schedule: SCHEDULE.POSITION_MONITOR,
        handler: handlers.positionMonitor,
      },
      {
        name: 'Wind Down',
        schedule: SCHEDULE.WIND_DOWN,
        handler: handlers.windDown,
      },
      {
        name: 'Post Market',
        schedule: SCHEDULE.POST_MARKET,
        handler: handlers.postMarket,
      },
    ];

    for (const { name, schedule, handler } of jobDefs) {
      if (handler && typeof handler === 'function') {
        this.registerJob(name, schedule, handler);
      } else {
        console.log(`[cron] Skipping "${name}" — no handler provided`);
      }
    }
  }
}

/**
 * Factory: create and configure scheduler with all jobs wired.
 *
 * @param {object} handlers - Handler functions for each job
 * @returns {Scheduler}
 */
export function createScheduler(handlers) {
  const scheduler = new Scheduler();
  scheduler.registerAllJobs(handlers);
  return scheduler;
}

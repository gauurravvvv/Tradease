import { getDb } from '../db/sqlite.js';
import { askClaude } from '../analysis/claude.js';
import { clearMarketCache } from '../data/market.js';
import { logger } from '../utils/logger.js';

/**
 * Base class for autonomous trading agents.
 * Provides: scheduling, Claude calls with model selection, signal DB, token tracking, market hours check.
 */
export class BaseAgent {
  /**
   * @param {string} name - Agent identifier (e.g. 'news-sentinel')
   * @param {object} opts
   * @param {number} opts.intervalMs - Tick interval in ms
   * @param {string} [opts.model] - Claude model to use (null = default, 'claude-haiku-4-5-20251001' for cheap)
   */
  constructor(name, { intervalMs, model = null }) {
    this.name = name;
    this.intervalMs = intervalMs;
    this.model = model;
    this._timer = null;
    this._running = false;
    this._stats = {
      runs: 0,
      skipped: 0,
      errors: 0,
      claudeCalls: 0,
      totalTokens: 0,
    };
    this._lastRun = 0;
    this._lastTickTime = 0;
    this._enabled = true;
  }

  /** Override: return true if agent should execute this tick */
  shouldRun() {
    return true;
  }

  /** Override: main agent logic */
  async execute() {
    throw new Error('execute() not implemented');
  }

  async tick() {
    if (this._running || !this._enabled) return;
    this._running = true;
    try {
      // Detect sleep/suspend gaps
      const now = Date.now();
      if (this._lastTickTime > 0) {
        const gap = now - this._lastTickTime;
        const expectedGap = this.intervalMs * 2.5;
        if (gap > expectedGap) {
          const gapMin = Math.round(gap / 60000);
          logger.warn(
            `[${this.name}] Detected ${gapMin}m gap (system sleep?). Resuming.`,
          );
          this.log(
            'wake_recovery',
            null,
            `Resumed after ${gapMin}m gap (expected ${Math.round(this.intervalMs / 60000)}m interval)`,
          );
          try {
            clearMarketCache();
          } catch {
            /* non-critical */
          }
        }
      }
      this._lastTickTime = now;

      if (!this.shouldRun()) {
        this._stats.skipped++;
        return;
      }
      await this.execute();
      this._stats.runs++;
      this._lastRun = Date.now();
    } catch (err) {
      this._stats.errors++;
      logger.error(`[${this.name}] ${err.message}`);
      this.log('error', null, err.message);
    } finally {
      this._running = false;
    }
  }

  start() {
    logger.info(`[${this.name}] Started (every ${this.intervalMs / 1000}s)`);
    this._lastTickTime = Date.now();
    this.log('started', null, `interval=${this.intervalMs / 1000}s`);
    this.tick();
    this._timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    logger.info(`[${this.name}] Stopped`);
  }

  enable() {
    this._enabled = true;
  }
  disable() {
    this._enabled = false;
  }

  /**
   * Call Claude with token caps and model selection.
   * Returns parsed text. Use sparingly — most decisions should be rule-based.
   */
  async callClaude(prompt) {
    this._stats.claudeCalls++;
    const response = await askClaude(prompt, {
      timeout: 60_000,
      model: this.model,
    });
    const tokensIn = Math.ceil(prompt.length / 4);
    const tokensOut = Math.ceil(response.length / 4);
    this._stats.totalTokens += tokensIn + tokensOut;
    this.log(
      'claude_call',
      null,
      `in:${tokensIn} out:${tokensOut}`,
      tokensIn,
      tokensOut,
    );
    return response;
  }

  /** Parse Claude response as JSON, stripping markdown fences */
  parseJson(raw) {
    const cleaned = raw
      .replace(/```json?\s*/g, '')
      .replace(/```/g, '')
      .trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      // Try extracting first JSON array/object
      const m = cleaned.match(/[\[{][\s\S]*[\]}]/);
      if (m) return JSON.parse(m[0]);
      throw new Error(`JSON parse failed: ${cleaned.slice(0, 100)}`);
    }
  }

  // ── Signal DB ──

  writeSignal(symbol, signalType, confidence, data = {}) {
    const db = getDb();
    db.prepare(
      'INSERT INTO agent_signals (agent, symbol, signal_type, confidence, data) VALUES (?, ?, ?, ?, ?)',
    ).run(this.name, symbol, signalType, confidence, JSON.stringify(data));
  }

  readSignals(signalTypes = null) {
    try {
      const db = getDb();
      if (signalTypes) {
        const ph = signalTypes.map(() => '?').join(',');
        return db
          .prepare(
            `SELECT * FROM agent_signals WHERE consumed = 0 AND signal_type IN (${ph}) ORDER BY created_at DESC`,
          )
          .all(...signalTypes);
      }
      return db
        .prepare(
          'SELECT * FROM agent_signals WHERE consumed = 0 ORDER BY created_at DESC',
        )
        .all();
    } catch (err) {
      logger.error(`[${this.name}] readSignals failed (DB locked?): ${err.message}`);
      return [];
    }
  }

  consumeSignals(ids) {
    if (!ids.length) return;
    const db = getDb();
    const ph = ids.map(() => '?').join(',');
    db.prepare(
      `UPDATE agent_signals SET consumed = 1, consumed_by = ?, consumed_at = datetime('now', '+5 hours', '+30 minutes') WHERE id IN (${ph})`,
    ).run(this.name, ...ids);
  }

  // ── Logging ──

  log(
    action,
    symbol = null,
    details = null,
    tokensIn = 0,
    tokensOut = 0,
    skipped = 0,
  ) {
    try {
      const db = getDb();
      db.prepare(
        'INSERT INTO agent_logs (agent, action, symbol, details, tokens_in, tokens_out, skipped) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(this.name, action, symbol, details, tokensIn, tokensOut, skipped);
    } catch {
      /* logging should never crash agent */
    }
  }

  // ── Market Hours ──

  isMarketHours(startHour = 9, startMin = 0, endHour = 15, endMin = 30) {
    const now = new Date();
    const ist = new Date(
      now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
    );
    const day = ist.getDay();
    if (day === 0 || day === 6) return false;
    const mins = ist.getHours() * 60 + ist.getMinutes();
    return mins >= startHour * 60 + startMin && mins <= endHour * 60 + endMin;
  }

  getISTMinutes() {
    const now = new Date();
    const ist = new Date(
      now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
    );
    return ist.getHours() * 60 + ist.getMinutes();
  }

  getStats() {
    return {
      name: this.name,
      enabled: this._enabled,
      running: this._running,
      lastRun: this._lastRun,
      ...this._stats,
    };
  }
}

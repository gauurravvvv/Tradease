import { getDb } from '../db/sqlite.js';
import { logger } from '../utils/logger.js';
import { notify } from '../utils/notify.js';

/**
 * Orchestrator — starts/stops/syncs all 3 autonomous agents.
 * Lazy-imports agent classes to avoid circular deps.
 */
export class AgentOrchestrator {
  constructor() {
    this.agents = {};     // populated on start()
    this._syncTimer = null;
    this._running = false;
  }

  async start() {
    if (this._running) return;
    this._running = true;
    getDb(); // ensure agent tables exist

    // Lazy-import agents
    const [
      { NewsSentinel },
      { TradeStrategist },
      { PositionGuardian },
    ] = await Promise.all([
      import('./news-sentinel.js'),
      import('./trade-strategist.js'),
      import('./position-guardian.js'),
    ]);

    this.agents = {
      guardian: new PositionGuardian(),
      sentinel: new NewsSentinel(),
      strategist: new TradeStrategist(),
    };

    logger.info('[orchestrator] Starting agents...');

    // Stagger starts to avoid burst
    this.agents.guardian.start();                                    // most critical
    setTimeout(() => this.agents.sentinel.start(), 3_000);          // 3s delay
    setTimeout(() => this.agents.strategist.start(), 10_000);       // 10s delay

    // Sync watchlist: strategist → sentinel every 10 min
    this._syncTimer = setInterval(() => {
      const symbols = this.agents.strategist.getTopSymbols();
      if (symbols.length) this.agents.sentinel.updateWatchlist(symbols);
    }, 10 * 60 * 1000);

    // Initial sync after strategist has first run
    setTimeout(() => {
      const symbols = this.agents.strategist.getTopSymbols();
      if (symbols.length) this.agents.sentinel.updateWatchlist(symbols);
    }, 30_000);

    logger.info('[orchestrator] All agents started');
    notify('Agents Started', '3 autonomous agents running', 'info');
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    for (const agent of Object.values(this.agents)) agent.stop();
    if (this._syncTimer) clearInterval(this._syncTimer);
    this._syncTimer = null;
    logger.info('[orchestrator] All agents stopped');
    notify('Agents Stopped', 'All agents halted', 'info');
  }

  isRunning() { return this._running; }

  /** Get status of all agents */
  getStatus() {
    return {
      running: this._running,
      agents: Object.values(this.agents).map(a => a.getStats()),
    };
  }

  /** Enable/disable a specific agent by name */
  setAgentEnabled(agentName, enabled) {
    const agent = Object.values(this.agents).find(a => a.name === agentName);
    if (!agent) return false;
    enabled ? agent.enable() : agent.disable();
    return true;
  }

  /** Get recent agent logs from DB */
  getRecentLogs(limit = 30) {
    const db = getDb();
    return db.prepare('SELECT * FROM agent_logs ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  /** Get pending (unconsumed) signals */
  getPendingSignals() {
    const db = getDb();
    return db.prepare('SELECT * FROM agent_signals WHERE consumed = 0 ORDER BY created_at DESC').all();
  }

  /** Get hourly stats per agent */
  getHourlyStats() {
    const db = getDb();
    const agents = ['news-sentinel', 'trade-strategist', 'position-guardian'];
    return agents.map(name => {
      const stats = db.prepare(
        `SELECT COUNT(*) as runs, SUM(skipped) as skipped, SUM(tokens_in + tokens_out) as tokens
         FROM agent_logs WHERE agent = ? AND created_at > datetime('now', '-1 hour')`
      ).get(name);
      const errors = db.prepare(
        `SELECT COUNT(*) as count FROM agent_logs WHERE agent = ? AND action = 'error' AND created_at > datetime('now', '-1 hour')`
      ).get(name);
      const last = db.prepare(
        'SELECT action, symbol, details, created_at FROM agent_logs WHERE agent = ? ORDER BY created_at DESC LIMIT 1'
      ).get(name);
      return {
        name,
        runs: stats?.runs || 0,
        skipped: stats?.skipped || 0,
        tokens: stats?.tokens || 0,
        errors: errors?.count || 0,
        lastAction: last?.action || 'idle',
        lastSymbol: last?.symbol || null,
        lastDetail: last?.details || null,
        lastRun: last?.created_at || null,
      };
    });
  }

  /** Get today's agent token usage */
  getTodayTokenUsage() {
    const db = getDb();
    const row = db.prepare(
      `SELECT SUM(tokens_in) as input, SUM(tokens_out) as output, COUNT(*) as calls
       FROM agent_logs WHERE action = 'claude_call' AND created_at > datetime('now', 'start of day')`
    ).get();
    return { input: row?.input || 0, output: row?.output || 0, calls: row?.calls || 0 };
  }
}

// Singleton for dashboard access
let _instance = null;
export function getOrchestrator() { return _instance; }
export function setOrchestrator(orch) { _instance = orch; }

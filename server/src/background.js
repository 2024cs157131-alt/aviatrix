// Round engine + housekeeping. Runs in the dedicated worker process (worker.js), or inside the web process
// when RUN_ENGINE_IN_WEB=true (single-service free hosting). The engine's advisory lock guarantees only one
// engine runs across all processes either way.
import { runEngine } from './engine.js';
import { reconcileStale } from './payments.js';
import { cleanupRateLimits } from './ratelimit.js';
import { verifyBalances } from './ledger.js';
import { q } from './db.js';
import { log } from './log.js';

export function startBackground({ signal }) {
  const timers = [
    setInterval(() => reconcileStale().catch(e => log.error('reconcile', { err: e })), 60_000),
    // Ledger integrity: cached balances must equal SUM(ledger). Any drift is a paging-level alert.
    setInterval(() => verifyBalances({ query: q }).then(rows => {
      if (rows.length) log.error('BALANCE DRIFT DETECTED', { users: rows.slice(0, 20).map(r => r.user_id), count: rows.length });
    }).catch(e => log.error('balance verify', { err: e })), 3600_000),
    setInterval(() => Promise.all([
      cleanupRateLimits(),
      q(`DELETE FROM sessions WHERE expires_at < now()`),
    ]).catch(e => log.error('cleanup', { err: e })), 3600_000),
  ];
  signal.addEventListener('abort', () => timers.forEach(clearInterval));
  return runEngine({ signal });
}

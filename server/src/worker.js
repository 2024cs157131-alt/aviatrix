// Background worker: the round engine (single leader across all instances) plus housekeeping.
import { runEngine } from './engine.js';
import { reconcileStale } from './payments.js';
import { cleanupRateLimits } from './ratelimit.js';
import { verifyBalances } from './ledger.js';
import { q, pool } from './db.js';
import { config } from './config.js';
import { log } from './log.js';

void config.encryptionKey;
const ctrl = new AbortController();

setInterval(() => reconcileStale().catch(e => log.error('reconcile', { err: e })), 60_000);
// Ledger integrity: cached balances must equal SUM(ledger). Any drift is a paging-level alert.
setInterval(() => verifyBalances({ query: q }).then(rows => {
  if (rows.length) log.error('BALANCE DRIFT DETECTED', { users: rows.slice(0, 20).map(r => r.user_id), count: rows.length });
}).catch(e => log.error('balance verify', { err: e })), 3600_000);

setInterval(() => Promise.all([
  cleanupRateLimits(),
  q(`DELETE FROM sessions WHERE expires_at < now()`),
]).catch(e => log.error('cleanup', { err: e })), 3600_000);

runEngine({ signal: ctrl.signal }).then(() => pool.end());
const stop = () => { ctrl.abort(); setTimeout(() => process.exit(0), 3000); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

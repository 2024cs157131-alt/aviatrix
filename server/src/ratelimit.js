import { q } from './db.js';

// Fixed-window limiter backed by Postgres so it holds across every web instance.
export async function hit(key, limit, windowSec) {
  const r = await q(
    `INSERT INTO rate_limits(key, window_start, count) VALUES ($1, now(), 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN now() ELSE rate_limits.window_start END
     RETURNING count`, [key, windowSec]);
  return r.rows[0].count <= limit;
}

/** Express middleware. keyFn(req) -> string|string[] */
export function limit(name, max, windowSec, keyFn) {
  return async (req, res, next) => {
    try {
      const keys = [].concat(keyFn(req)).filter(Boolean);
      for (const k of keys) {
        if (!(await hit(`${name}:${k}`, max, windowSec))) {
          return res.status(429).json({ error: 'rate_limited', message: 'Too many attempts. Wait a moment and try again.' });
        }
      }
      next();
    } catch (e) { next(e); }
  };
}

export async function cleanupRateLimits() {
  await q(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`);
}

/**
 * In-process token bucket for hot, low-stakes paths (bet spam, callback floods). No DB write per request.
 * Per-instance, so the effective limit is max x instances — fine for anti-spam. Security-critical limits
 * (login, STK, withdrawals) stay on the shared Postgres limiter above.
 */
export function memLimit(max, windowSec, keyFn) {
  const buckets = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.t > windowSec * 2000) buckets.delete(k); }, 60000).unref();
  return (req, res, next) => {
    const k = String(keyFn(req));
    const now = Date.now();
    const b = buckets.get(k) || { tokens: max, t: now };
    b.tokens = Math.min(max, b.tokens + ((now - b.t) / 1000) * (max / windowSec));
    b.t = now;
    if (b.tokens < 1) { buckets.set(k, b); return res.status(429).json({ error: 'rate_limited', message: 'Slow down.' }); }
    b.tokens -= 1; buckets.set(k, b);
    next();
  };
}

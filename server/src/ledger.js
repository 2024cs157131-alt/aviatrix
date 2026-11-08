// Append-only ledger. The DB trigger forbids UPDATE/DELETE; idempotency_key is UNIQUE so a replayed
// event can never post twice. Balance = SUM(amount_cents) of the user's posted entries.

export class LedgerError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

/**
 * Lock the user's balance row so concurrent debits for the same user serialize. Call inside a transaction.
 * (Locks user_balances, not users, so logins/profile reads never wait on money movement.)
 */
export async function lockUser(c, userId) {
  const u = await c.query('SELECT disabled FROM users WHERE id = $1', [userId]);
  if (!u.rowCount) throw new LedgerError('no_user');
  if (u.rows[0].disabled) throw new LedgerError('account_disabled');
  await c.query('INSERT INTO user_balances(user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  await c.query('SELECT 1 FROM user_balances WHERE user_id = $1 FOR UPDATE', [userId]);
}

/**
 * Available balance. Reads the trigger-maintained cache, which always equals SUM(ledger) for the user
 * (same transaction, enforced by trigger; verified hourly by verifyBalances()).
 */
export async function balanceOf(c, userId) {
  const r = await c.query('SELECT balance_cents FROM user_balances WHERE user_id = $1', [userId]);
  return Number(r.rows[0]?.balance_cents ?? 0);
}

/** Drift check: any user whose cached balance differs from the ledger sum. Should always be empty. */
export async function verifyBalances(c, sinceMinutes = 90) {
  const r = await c.query(
    `SELECT b.user_id, b.balance_cents, COALESCE(SUM(l.amount_cents),0)::bigint AS ledger
       FROM user_balances b LEFT JOIN ledger_entries l ON l.user_id = b.user_id
      WHERE b.updated_at > now() - make_interval(mins => $1)
      GROUP BY b.user_id, b.balance_cents HAVING b.balance_cents <> COALESCE(SUM(l.amount_cents),0)`, [sinceMinutes]);
  return r.rows;
}

/** Funds currently held in withdrawal reserves (pending payouts). */
export async function reservedOf(c, userId) {
  const r = await c.query(
    `SELECT COALESCE(SUM(-l.amount_cents),0)::bigint AS reserved
       FROM ledger_entries l JOIN payments p ON p.id = l.payment_id
      WHERE l.user_id = $1 AND l.type = 'withdrawal_reserved' AND p.status IN ('initiating','pending','needs_review')`, [userId]);
  return Number(r.rows[0].reserved);
}

/**
 * Post one entry. Returns true if inserted, false if this idempotency key was already posted.
 * Debits must be posted with the user row locked (lockUser) and a balance check.
 */
export async function post(c, e) {
  const r = await c.query(
    `INSERT INTO ledger_entries (user_id, type, amount_cents, idempotency_key, payment_id, bet_id, provider, actor_id, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [e.userId, e.type, e.amount, e.key, e.paymentId ?? null, e.betId ?? null, e.provider ?? null, e.actorId ?? null, e.reason ?? null]);
  return r.rowCount === 1;
}

/** Debit with balance check. Caller must hold lockUser. */
export async function debit(c, e) {
  const bal = await balanceOf(c, e.userId);
  if (bal < e.amount) throw new LedgerError('insufficient_funds');
  const ok = await post(c, { ...e, amount: -e.amount });
  if (!ok) throw new LedgerError('duplicate');
}

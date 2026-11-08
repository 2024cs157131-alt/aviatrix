import { Router } from 'express';
import { q, tx } from '../db.js';
import { createSession, destroySession, requireAdmin, verifyPassword } from '../auth.js';
import { decrypt, verifyTotp } from '../crypto.js';
import { limit } from '../ratelimit.js';
import { getSetting, setSetting, saveCredentials, credentialSummary, PROVIDER_FIELDS, loadCredentials, missingFields } from '../settings.js';
import { balanceOf, reservedOf, post, lockUser, LedgerError } from '../ledger.js';
import { reconcilePayment, resolveWithdrawal, processEvent, publicPayment, registerC2b, assignC2b } from '../payments.js';
import { CASHIA_PAYOUTS_SUPPORTED } from '../providers/cashia.js';

const r = Router();

r.post('/login', limit('admin-login-ip', 10, 900, req => req.ip), limit('admin-login-user', 5, 900, req => String(req.body?.username || '').toLowerCase()),
  async (req, res) => {
    const { username, password, code } = req.body || {};
    const u = (await q(`SELECT id, password_hash, role, disabled, totp_secret_enc, totp_last_step FROM users WHERE lower(username)=lower($1)`, [String(username || '')])).rows[0];
    if (!u || u.role !== 'admin' || u.disabled || !verifyPassword(String(password || ''), u.password_hash)) {
      return res.status(401).json({ error: 'bad_login', message: 'Invalid admin credentials.' });
    }
    // Two-factor is mandatory for admins (they control payouts and provider keys).
    if (!u.totp_secret_enc) return res.status(403).json({ error: 'totp_not_set', message: 'Two-factor not set up. Run `npm run create-admin -- <username>` on the server.' });
    const step = verifyTotp(decrypt(u.totp_secret_enc), code, u.totp_last_step);
    if (step == null) return res.status(401).json({ error: 'bad_code', message: 'Invalid or reused authenticator code.' });
    const upd = await q('UPDATE users SET totp_last_step=$2 WHERE id=$1 AND (totp_last_step IS NULL OR totp_last_step < $2)', [u.id, step]);
    if (!upd.rowCount) return res.status(401).json({ error: 'bad_code', message: 'Code already used.' });
    await createSession(res, u.id, 'admin');
    await audit(u.id, 'login', {});
    res.json({ ok: true });
  });

// Everything below requires an admin session with role=admin, re-checked on every request.
r.use(requireAdmin());

async function audit(actorId, action, detail) {
  await q('INSERT INTO admin_audit(actor_id, action, detail) VALUES ($1,$2,$3)', [actorId, action, detail]);
}
const h = fn => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) { res.status(e.status || 400).json({ error: e.code || 'error', message: e.message }); }
};

r.post('/logout', async (req, res) => { await destroySession(req, res, 'admin'); res.json({ ok: true }); });
r.get('/session', h(async req => ({ admin: { id: req.admin.id, username: req.admin.username } })));

// --- providers & credentials
r.get('/providers', h(async () => {
  const [prov, lic, creds] = await Promise.all([getSetting('providers'), getSetting('licence'), credentialSummary()]);
  const status = {};
  for (const p of ['mpesa', 'cashia']) {
    status[p] = {};
    for (const env of ['sandbox', 'production']) {
      const c = await loadCredentials(p, env).catch(() => null);
      status[p][env] = { configured: !!c, missing: missingFields(p, c) };
    }
  }
  return { providers: prov, licence: lic, credentials: creds, fields: PROVIDER_FIELDS, status, cashiaPayoutsSupported: CASHIA_PAYOUTS_SUPPORTED };
}));

r.put('/providers', h(async req => {
  const cur = await getSetting('providers');
  const lic = await getSetting('licence');
  const next = structuredClone(cur);
  for (const p of ['mpesa', 'cashia']) {
    const inp = req.body?.[p];
    if (!inp) continue;
    if (typeof inp.enabled === 'boolean') next[p].enabled = inp.enabled;
    if (inp.environment) {
      if (!['sandbox', 'production'].includes(inp.environment)) throw Object.assign(new Error('bad environment'), { code: 'bad_env' });
      if (inp.environment === 'production' && !lic?.licensed) {
        throw Object.assign(new Error('Production payments stay off until the operator licence flag is set.'), { code: 'licence_required' });
      }
      next[p].environment = inp.environment;
    }
    if (next[p].enabled) {
      const c = await loadCredentials(p, next[p].environment);
      const miss = missingFields(p, c);
      if (miss.length) throw Object.assign(new Error(`Cannot enable ${p} (${next[p].environment}): missing ${miss.join(', ')}`), { code: 'incomplete_credentials' });
    }
  }
  await setSetting('providers', next, req.admin.id);
  await audit(req.admin.id, 'providers.update', next);
  return next;
}));

r.put('/credentials/:provider/:env', h(async req => {
  const { provider, env } = req.params;
  if (!PROVIDER_FIELDS[provider]) throw Object.assign(new Error('unknown provider'), { code: 'bad_provider' });
  const masks = await saveCredentials(provider, env, req.body || {}, req.admin.id);
  // Audit which fields changed, never their values.
  await audit(req.admin.id, 'credentials.save', { provider, env, fields: Object.keys(req.body || {}).filter(k => req.body[k]) });
  return { masks };
}));

// --- limits, licence, security
r.get('/limits', h(() => getSetting('limits')));
r.put('/limits', h(async req => {
  const keys = ['depositMin', 'depositMax', 'withdrawMin', 'withdrawMax', 'betMin', 'betMax', 'maxPayout'];
  const cur = await getSetting('limits');
  const next = { ...cur };
  for (const k of keys) if (req.body?.[k] != null) {
    const v = Number(req.body[k]);
    if (!Number.isInteger(v) || v < 1) throw Object.assign(new Error(`${k} must be a positive whole number`), { code: 'bad_limit' });
    next[k] = v;
  }
  for (const [a, b] of [['depositMin', 'depositMax'], ['withdrawMin', 'withdrawMax'], ['betMin', 'betMax']]) {
    if (next[a] > next[b]) throw Object.assign(new Error(`${a} cannot exceed ${b}`), { code: 'bad_limit' });
  }
  await setSetting('limits', next, req.admin.id);
  await audit(req.admin.id, 'limits.update', next);
  return next;
}));

r.get('/licence', h(() => getSetting('licence')));
r.put('/licence', h(async req => {
  const { licensed, jurisdiction, licenceNumber, attest } = req.body || {};
  if (licensed && (attest !== true || !jurisdiction || !licenceNumber)) {
    throw Object.assign(new Error('Enter the jurisdiction and licence number and confirm the attestation.'), { code: 'attestation_required' });
  }
  const next = licensed
    ? { licensed: true, jurisdiction: String(jurisdiction), licenceNumber: String(licenceNumber), setBy: req.admin.id, setAt: new Date().toISOString() }
    : { licensed: false, jurisdiction: null, licenceNumber: null, setBy: req.admin.id, setAt: new Date().toISOString() };
  await setSetting('licence', next, req.admin.id);
  if (!licensed) {
    // Turning the licence flag off forces every provider back to sandbox.
    const prov = await getSetting('providers');
    for (const p of Object.keys(prov)) prov[p].environment = 'sandbox';
    await setSetting('providers', prov, req.admin.id);
  }
  await audit(req.admin.id, 'licence.update', next);
  return next;
}));

r.get('/security', h(async () => (await getSetting('security')) || { mpesaCallbackIps: [], cashiaCallbackIps: [] }));
r.put('/security', h(async req => {
  const clean = v => (Array.isArray(v) ? v.map(String).map(s => s.trim()).filter(s => /^[0-9a-fA-F:.]+$/.test(s)) : []);
  const next = { mpesaCallbackIps: clean(req.body?.mpesaCallbackIps), cashiaCallbackIps: clean(req.body?.cashiaCallbackIps) };
  await setSetting('security', next, req.admin.id);
  await audit(req.admin.id, 'security.update', next);
  return next;
}));

// --- payments
r.get('/payments', h(async req => {
  const { status, provider, direction, user } = req.query;
  const rows = (await q(
    `SELECT p.*, u.username FROM payments p LEFT JOIN users u ON u.id=p.user_id
      WHERE ($1::text IS NULL OR p.status=$1) AND ($2::text IS NULL OR p.provider=$2) AND ($3::text IS NULL OR p.direction=$3)
        AND ($4::text IS NULL OR u.username ILIKE $4 OR p.bill_ref ILIKE $4)
        AND ($5::boolean IS NOT TRUE OR p.user_id IS NULL)
      ORDER BY p.created_at DESC LIMIT 200`,
    [status || null, provider || null, direction || null, user ? `%${user}%` : null, req.query.unassigned === '1'])).rows;
  return rows.map(p => ({ ...publicPayment(p), username: p.username, userId: p.user_id, providerRef: p.provider_ref, providerTxn: p.provider_txn,
    billRef: p.bill_ref, verifiedAt: p.verified_at }));
}));

r.get('/payments/:id/events', h(async req => (await q(
  `SELECT id, kind, verified, processed, error, received_at, processed_at, body FROM webhook_events WHERE payment_id=$1 ORDER BY id`, [req.params.id])).rows));

r.post('/payments/:id/reconcile', h(async req => {
  const out = await reconcilePayment(req.params.id, { cashiaTransactionId: req.body?.cashiaTransactionId || undefined });
  await audit(req.admin.id, 'payment.reconcile', { paymentId: req.params.id });
  return out;
}));

r.post('/payments/:id/resolve', h(async req => {
  const { outcome, transactionId, reason } = req.body || {};
  if (!reason) throw Object.assign(new Error('A reason is required.'), { code: 'reason_required' });
  const p = (await q('SELECT direction, status FROM payments WHERE id=$1', [req.params.id])).rows[0];
  if (!p || p.direction !== 'withdrawal' || p.status !== 'needs_review') throw Object.assign(new Error('Only withdrawals in needs_review can be resolved manually.'), { code: 'not_resolvable' });
  const out = await resolveWithdrawal(req.params.id, outcome, transactionId);
  await audit(req.admin.id, 'withdrawal.resolve', { paymentId: req.params.id, outcome, transactionId, reason });
  return out;
}));

r.post('/c2b/register/:env', h(async req => {
  const out = await registerC2b(req.params.env, req.admin.id);
  await audit(req.admin.id, 'c2b.register', { env: req.params.env });
  return out;
}));
r.get('/c2b', h(async () => (await getSetting('c2b')) || {}));

r.post('/payments/:id/assign', h(async req => {
  const { who, reason } = req.body || {};
  if (!reason) throw Object.assign(new Error('A reason is required.'), { code: 'reason_required' });
  const out = await assignC2b(req.params.id, who);
  await audit(req.admin.id, 'c2b.assign', { paymentId: req.params.id, who, reason });
  return out;
}));

r.post('/events/:id/retry', h(async req => {
  await processEvent(Number(req.params.id));
  await audit(req.admin.id, 'event.retry', { eventId: Number(req.params.id) });
  return (await q('SELECT id, processed, error FROM webhook_events WHERE id=$1', [Number(req.params.id)])).rows[0];
}));

// --- users & ledger (read-only, plus adjustments as their own entry type)
r.get('/users', h(async req => (await q(
  `SELECT id, username, role, disabled, created_at FROM users WHERE username ILIKE $1 ORDER BY id DESC LIMIT 50`, [`%${req.query.q || ''}%`])).rows));

r.get('/users/:id', h(async req => {
  const id = Number(req.params.id);
  const u = (await q('SELECT id, username, role, disabled, date_of_birth, created_at FROM users WHERE id=$1', [id])).rows[0];
  if (!u) throw Object.assign(new Error('not found'), { code: 'not_found', status: 404 });
  const ledger = (await q(
    `SELECT l.id, l.type, l.amount_cents, l.provider, l.payment_id, l.bet_id, l.actor_id, l.reason, l.created_at, a.username AS actor
       FROM ledger_entries l LEFT JOIN users a ON a.id=l.actor_id WHERE l.user_id=$1 ORDER BY l.id DESC LIMIT 300`, [id])).rows;
  return { user: u, balance: await balanceOf({ query: q }, id), reserved: await reservedOf({ query: q }, id), ledger };
}));

r.post('/users/:id/adjust', h(async req => {
  const id = Number(req.params.id);
  const kes = Number(req.body?.amount);
  const reason = String(req.body?.reason || '').trim();
  if (!Number.isFinite(kes) || kes === 0 || Math.round(kes * 100) !== kes * 100) throw Object.assign(new Error('Amount must be non-zero with at most 2 decimals.'), { code: 'bad_amount' });
  if (reason.length < 5) throw Object.assign(new Error('Give a reason (5+ characters).'), { code: 'reason_required' });
  const key = `adj:${req.admin.id}:${req.body?.requestId || Date.now()}`;
  await tx(async c => {
    await lockUser(c, id);
    if (kes < 0 && (await balanceOf(c, id)) < -kes * 100) throw new LedgerError('insufficient_funds', 'Adjustment would make the balance negative.');
    await post(c, { userId: id, type: 'adjustment', amount: Math.round(kes * 100), key, actorId: req.admin.id, reason });
    await c.query(`SELECT pg_notify('user', $1)`, [JSON.stringify({ userId: id, t: 'balance' })]);
  });
  await audit(req.admin.id, 'ledger.adjust', { userId: id, amount: kes, reason });
  return { ok: true, balance: await balanceOf({ query: q }, id) };
}));

r.post('/users/:id/disable', h(async req => {
  const id = Number(req.params.id);
  const disabled = !!req.body?.disabled;
  await q('UPDATE users SET disabled=$2 WHERE id=$1 AND role <> \'admin\'', [id, disabled]);
  if (disabled) await q('DELETE FROM sessions WHERE user_id=$1', [id]);
  await audit(req.admin.id, 'user.disable', { userId: id, disabled });
  return { ok: true };
}));

r.get('/audit', h(async () => (await q(
  `SELECT a.id, a.action, a.detail, a.created_at, u.username FROM admin_audit a JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 200`)).rows));

export default r;

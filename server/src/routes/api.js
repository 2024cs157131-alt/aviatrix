import { Router } from 'express';
import { q, tx } from '../db.js';
import { createSession, destroySession, requirePlayer, sessionUser, issueCsrf, hashPassword, verifyPassword } from '../auth.js';
import { limit, memLimit } from '../ratelimit.js';
import { balanceOf, reservedOf } from '../ledger.js';
import { placeBet, cancelBet, cashout, myBets, sessionStats, tableOpen } from '../game.js';
import { startDeposit, startWithdrawal, myPayments, getPayment } from '../payments.js';
import { activeProviders, getSetting } from '../settings.js';
import { CASHIA_PAYOUTS_SUPPORTED } from '../providers/cashia.js';
import { HOUSE_EDGE_BP, GROWTH_PER_MS } from '../fair.js';

const r = Router();
const ip = req => req.ip;

// The client sends intent only. Any attempt to send results is refused outright.
const FORBIDDEN = ['balance', 'payout', 'multiplier', 'mult', 'crash', 'crashPoint', 'credit', 'winnings'];
r.use((req, res, next) => {
  if (req.body && typeof req.body === 'object' && FORBIDDEN.some(k => k in req.body)) {
    return res.status(400).json({ error: 'client_values_rejected', message: 'The server decides balances and payouts.' });
  }
  next();
});

r.get('/csrf', (req, res) => res.json({ token: issueCsrf(req, res) }));

r.get('/config', async (req, res) => {
  const [active, limits] = await Promise.all([activeProviders(), getSetting('limits')]);
  res.json({
    providers: Object.entries(active).map(([name, v]) => ({
      name, environment: v.environment, deposits: true, withdrawals: name === 'mpesa' || CASHIA_PAYOUTS_SUPPORTED,
      ...(name === 'mpesa' ? { paybill: v.creds.shortcode } : {}),   // public business number, not a secret
    })),
    limits, tableOpen: await tableOpen(),
    fair: { houseEdgeBp: HOUSE_EDGE_BP, growthPerMs: GROWTH_PER_MS, clientSeed: (await getSetting('fair'))?.clientSeed ?? null },
  });
});

function ageFrom(dob) {
  const d = new Date(dob + 'T00:00:00Z'); if (isNaN(d)) return -1;
  const n = new Date(); let a = n.getUTCFullYear() - d.getUTCFullYear();
  const m = n.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && n.getUTCDate() < d.getUTCDate())) a--;
  return a;
}

r.post('/register', limit('register', 10, 3600, ip), async (req, res) => {
  const { username, password, dateOfBirth, confirmAge } = req.body || {};
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username || '')) return res.status(400).json({ error: 'bad_username', message: 'Username: 3–20 letters, numbers or _.' });
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 10 characters.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth || '') || ageFrom(dateOfBirth) < 18) return res.status(400).json({ error: 'underage', message: 'You must be 18 or older to play.' });
  if (confirmAge !== true) return res.status(400).json({ error: 'age_unconfirmed', message: 'Confirm you are 18 or older.' });
  try {
    const u = (await q(`INSERT INTO users(username, password_hash, date_of_birth, age_confirmed_at) VALUES ($1,$2,$3,now()) RETURNING id, username`,
      [username, hashPassword(password), dateOfBirth])).rows[0];
    await createSession(res, u.id, 'player');
    res.json({ ok: true, username: u.username });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'taken', message: 'That username is taken.' });
    throw e;
  }
});

r.post('/login',
  limit('login-ip', 20, 900, ip),
  limit('login-user', 8, 900, req => String(req.body?.username || '').toLowerCase()),
  async (req, res) => {
    const { username, password } = req.body || {};
    const u = (await q(`SELECT id, password_hash, disabled, role FROM users WHERE lower(username) = lower($1)`, [String(username || '')])).rows[0];
    const ok = u && verifyPassword(String(password || ''), u.password_hash);
    if (!ok || u.disabled || u.role === 'admin') return res.status(401).json({ error: 'bad_login', message: 'Wrong username or password.' });
    await createSession(res, u.id, 'player');
    res.json({ ok: true });
  });

r.post('/logout', async (req, res) => { await destroySession(req, res, 'player'); res.json({ ok: true }); });

r.get('/me', async (req, res) => {
  const u = await sessionUser(req, 'player');
  if (!u) return res.json({ user: null });
  const [balance, reserved, stats] = await Promise.all([balanceOf({ query: q }, u.id), reservedOf({ query: q }, u.id), sessionStats(u.id)]);
  const acct = (await q('SELECT account_no FROM users WHERE id=$1', [u.id])).rows[0]?.account_no;
  res.json({ user: { id: u.id, username: u.username, accountNo: acct }, balance, reserved, stats });
});

r.get('/rounds/recent', async (req, res) => {
  const rows = (await q(`SELECT id, crash_point, server_seed, server_seed_hash, client_seed, house_edge_bp, crashed_at
                          FROM rounds WHERE status='crashed' ORDER BY id DESC LIMIT 30`)).rows;
  res.json(rows.map(x => ({ roundId: Number(x.id), crash: x.crash_point, serverSeed: x.server_seed, hash: x.server_seed_hash,
    clientSeed: x.client_seed, nonce: Number(x.id), houseEdgeBp: x.house_edge_bp, crashedAt: x.crashed_at })));
});

r.get('/rounds/:id', async (req, res) => {
  const x = (await q(`SELECT * FROM rounds WHERE id=$1`, [Number(req.params.id) || 0])).rows[0];
  if (!x) return res.status(404).json({ error: 'not_found' });
  const out = { roundId: Number(x.id), status: x.status, hash: x.server_seed_hash, clientSeed: x.client_seed, nonce: Number(x.id), houseEdgeBp: x.house_edge_bp };
  if (x.status === 'crashed') Object.assign(out, { crash: x.crash_point, serverSeed: x.server_seed });
  res.json(out);
});

const P = requirePlayer();
const send = fn => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) {
    if (e.code && !/^\d/.test(e.code) && e.code.length < 40) return res.status(e.status || 400).json({ error: e.code, message: e.message });
    throw e;
  }
};

r.get('/bets/mine', P, send(req => myBets(req.user.id)));
r.post('/bets', P, memLimit(20, 10, req => req.user.id), send(req => placeBet(req.user, req.body || {})));
r.post('/bets/:id/cancel', P, memLimit(20, 10, req => req.user.id), send(req => cancelBet(req.user, Number(req.params.id))));
r.post('/bets/:id/cashout', P, memLimit(40, 10, req => req.user.id), send(req => cashout(req.user, Number(req.params.id))));

r.post('/deposits', P, limit('stk', 5, 60, req => req.user.id), limit('stk-ip', 15, 60, ip),
  send(req => startDeposit(req.user, { provider: req.body?.provider, amount: req.body?.amount, phone: req.body?.phone })));
r.post('/withdrawals', P, limit('wd', 3, 60, req => req.user.id), limit('wd-day', 20, 86400, req => req.user.id),
  send(req => startWithdrawal(req.user, { provider: req.body?.provider, amount: req.body?.amount, phone: req.body?.phone })));
r.get('/payments', P, send(req => myPayments(req.user.id)));
r.get('/payments/:id', P, async (req, res) => {
  const p = await getPayment(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  res.json(p);
});

export default r;

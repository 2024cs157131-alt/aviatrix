// TEST-ONLY concurrency check against a running stack on a throwaway DB:
//   N players x 2 bets placed in the same betting window, then simultaneous cashouts mid-flight.
// Verifies: no 5xx, no deadlocks, every accepted bet settled, cached balances == ledger, money conserved.
// Usage: DATABASE_URL=... node server/test/load.mjs [players=500]
import crypto from 'node:crypto';
import pg from 'pg';

const N = Number(process.argv[2] || 500);
const BASE = process.env.BASE || 'http://localhost:3000';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const admin = (await db.query(`SELECT id FROM users WHERE role='admin' LIMIT 1`)).rows[0].id;
const run = crypto.randomBytes(3).toString('hex');
const players = [];
for (let i = 0; i < N; i++) {
  const u = (await db.query(`INSERT INTO users(username, password_hash) VALUES ($1,'x') RETURNING id`, [`ld${run}${i}`])).rows[0];
  await db.query(`INSERT INTO ledger_entries(user_id,type,amount_cents,idempotency_key,actor_id,reason) VALUES ($1,'adjustment',100000,$2,$3,'load test funding')`, [u.id, `load:${u.id}`, admin]);
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO sessions(token_hash,user_id,kind,expires_at) VALUES ($1,$2,'player',now()+interval '1 hour')`, [sha(token), u.id]);
  players.push({ id: u.id, cookie: `sid=${token}; csrf=t${i}`, csrf: `t${i}`, bets: [] });
}
const req = (p, path, body) => fetch(BASE + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: p.cookie, 'X-CSRF-Token': p.csrf, Origin: BASE },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const phase = async () => (await db.query(`SELECT id, status, crash_point FROM rounds ORDER BY id DESC LIMIT 1`)).rows[0];

// Wait for a fresh betting window with enough time left.
for (;;) {
  const r = (await db.query(`SELECT status, betting_ends_at - clock_timestamp() > interval '5 seconds' AS roomy FROM rounds ORDER BY id DESC LIMIT 1`)).rows[0];
  if (r?.status === 'betting' && r.roomy) break;
  await sleep(100);
}
let t0 = Date.now();
const betRes = await Promise.all(players.flatMap(p => ['A', 'B'].map(slot =>
  req(p, '/api/bets', { slot, stake: 100, autoCashout: slot === 'B' ? 1.5 : null }).then(r => { if (r.json.bet) p.bets.push(r.json.bet); return r; }))));
const betMs = Date.now() - t0;
const tally = rs => rs.reduce((m, r) => (m[r.status] = (m[r.status] || 0) + 1, m), {});
console.log(`bets: ${betRes.length} requests in ${betMs} ms`, tally(betRes));
const round = await phase();

while ((await phase()).status === 'betting') await sleep(50);
await sleep(700);
t0 = Date.now();
const coRes = await Promise.all(players.map(p => { const a = p.bets.find(b => b.slot === 'A'); return a ? req(p, `/api/bets/${a.id}/cashout`, {}) : null; }).filter(Boolean));
console.log(`cashouts: ${coRes.length} in ${Date.now() - t0} ms`, tally(coRes), 'crash was', round.id === (await phase()).id ? '(pending)' : '');
while ((await db.query(`SELECT status FROM rounds WHERE id=$1`, [round.id])).rows[0].status !== 'crashed') await sleep(100);
await sleep(300);

const ids = players.map(p => p.id);
const unsettled = (await db.query(`SELECT count(*)::int n FROM bets WHERE user_id = ANY($1) AND status IN ('active','queued')`, [ids])).rows[0].n;
const drift = (await db.query(`SELECT count(*)::int n FROM user_balances b WHERE b.user_id = ANY($1) AND b.balance_cents <>
  (SELECT COALESCE(SUM(amount_cents),0) FROM ledger_entries l WHERE l.user_id=b.user_id)`, [ids])).rows[0].n;
const money = (await db.query(`SELECT
   (SELECT COALESCE(SUM(balance_cents),0) FROM user_balances WHERE user_id = ANY($1))::bigint AS balances,
   (SELECT COALESCE(SUM(payout_cents),0) - COALESCE(SUM(stake_cents),0) FROM bets WHERE user_id = ANY($1) AND status IN ('cashed','lost'))::bigint AS net`, [ids])).rows[0];
const crash = (await db.query(`SELECT crash_point FROM rounds WHERE id=$1`, [round.id])).rows[0].crash_point;
const s = (await db.query(`SELECT status, count(*)::int n FROM bets WHERE user_id = ANY($1) GROUP BY 1`, [ids])).rows;
console.log('round crash', (crash / 100).toFixed(2) + 'x', 'bet outcomes', Object.fromEntries(s.map(r => [r.status, r.n])));
console.log('unsettled bets:', unsettled, '| cache/ledger drift:', drift,
  '| money conserved:', Number(money.balances) === N * 100000 + Number(money.net));
const fivexx = [...betRes, ...coRes].filter(r => r.status >= 500).length;
console.log(fivexx === 0 && unsettled === 0 && drift === 0 ? 'LOAD TEST PASS' : 'LOAD TEST FAIL', '| 5xx:', fivexx);
await db.end();

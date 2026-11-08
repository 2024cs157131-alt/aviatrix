// Round engine. Exactly one worker process runs this at a time (Postgres advisory lock), no matter how
// many web instances exist. Timing comes from timestamps (DB clock), never from counting intervals.
import { tx, q, directClient } from './db.js';
import { crashPoint, newServerSeed, hashSeed, multiplierAt, msForMultiplier, HOUSE_EDGE_BP } from './fair.js';
import { getSetting, setSetting } from './settings.js';
import { lockUser, debit, LedgerError } from './ledger.js';
import { emit, settleCashout, publicBet } from './game.js';
import { randomToken } from './crypto.js';
import { log } from './log.js';

export const BETTING_MS = 7000;
export const COOLDOWN_MS = 3000;
const TICK_MS = 50;
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));

let clockOffset = 0; // dbNow - localNow
async function syncClock() {
  const t0 = Date.now();
  const r = await q(`SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::float8 AS ms`);
  const t1 = Date.now();
  clockOffset = Number(r.rows[0].ms) - (t0 + t1) / 2;
}
const dbNow = () => Date.now() + clockOffset;

async function clientSeed() {
  const fair = (await getSetting('fair')) || {};
  if (fair.clientSeed) return fair.clientSeed;
  const seed = randomToken(16);
  await setSetting('fair', { ...fair, clientSeed: seed }, null);
  return seed;
}

async function createRound() {
  const seed = newServerSeed();
  const cs = await clientSeed();
  return tx(async c => {
    const ins = (await c.query(
      `INSERT INTO rounds(server_seed, server_seed_hash, client_seed, crash_point, house_edge_bp, status, betting_ends_at)
       VALUES ($1,$2,$3,100,$4,'betting', clock_timestamp() + make_interval(secs => $5)) RETURNING id`,
      [seed, hashSeed(seed), cs, HOUSE_EDGE_BP, BETTING_MS / 1000])).rows[0];
    // nonce = round id, so the crash point is computed after the id exists.
    const crash = crashPoint(seed, cs, ins.id, HOUSE_EDGE_BP);
    const round = (await c.query(`UPDATE rounds SET crash_point=$2 WHERE id=$1 RETURNING *`, [ins.id, crash])).rows[0];
    await emit(c, 'room', publicRoundEvent(round, 'betting'));
    await acceptQueued(c, round);
    return round;
  });
}

async function acceptQueued(c, round) {
  const qd = (await c.query(
    `SELECT b.*, u.username FROM bets b JOIN users u ON u.id=b.user_id WHERE b.status='queued' ORDER BY b.user_id, b.id FOR UPDATE OF b`)).rows;
  const limits = await getSetting('limits');
  for (const b of qd) {
    await c.query('SAVEPOINT qb');
    try {
      if (b.stake_cents < limits.betMin * 100 || b.stake_cents > limits.betMax * 100) throw new LedgerError('stake_out_of_range');
      await lockUser(c, b.user_id);
      await c.query(`UPDATE bets SET round_id=$2, status='active' WHERE id=$1`, [b.id, round.id]);
      await debit(c, { userId: b.user_id, type: 'bet_debit', amount: Number(b.stake_cents), key: `bet:${b.id}`, betId: b.id });
      await c.query('RELEASE SAVEPOINT qb');
      await emit(c, 'room', { t: 'bet', roundId: round.id, user: b.username.slice(0, 2) + '***' + b.username.slice(-1), slot: b.slot, stake: Number(b.stake_cents) });
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT qb');
      await c.query(`UPDATE bets SET status='rejected', reject_reason=$2, settled_at=now() WHERE id=$1`, [b.id, e.code || 'error']);
    }
    await emit(c, 'user', { userId: b.user_id, t: 'balance', betId: Number(b.id) });
  }
}

export function publicRoundEvent(r, phase) {
  const e = {
    t: phase, roundId: Number(r.id), hash: r.server_seed_hash, clientSeed: r.client_seed, nonce: Number(r.id),
    houseEdgeBp: r.house_edge_bp, bettingEndsAt: new Date(r.betting_ends_at).getTime(),
    startedAt: r.started_at ? new Date(r.started_at).getTime() : null,
  };
  if (phase === 'crashed') Object.assign(e, { crash: r.crash_point, serverSeed: r.server_seed, crashedAt: new Date(r.crashed_at).getTime() });
  return e; // crash point and server seed are only included once crashed
}

async function startRound(id) {
  return tx(async c => {
    const r = (await c.query(
      `UPDATE rounds SET status='running', started_at=clock_timestamp() WHERE id=$1 AND status='betting' RETURNING *`, [id])).rows[0];
    if (r) await emit(c, 'room', publicRoundEvent(r, 'running'));
    return r;
  });
}

async function settleAutos(roundId, upTo) {
  const limits = await getSetting('limits');
  await tx(async c => {
    const r = (await c.query(`SELECT status, crash_point FROM rounds WHERE id=$1 FOR UPDATE`, [roundId])).rows[0];
    if (r.status !== 'running') return;
    const due = (await c.query(
      `SELECT b.*, u.username FROM bets b JOIN users u ON u.id=b.user_id
        WHERE b.round_id=$1 AND b.status='active' AND b.auto_cashout IS NOT NULL AND b.auto_cashout <= $2 AND b.auto_cashout < $3 ORDER BY b.user_id, b.id`,
      [roundId, upTo, r.crash_point])).rows;
    for (const b of due) await settleCashout(c, b, b.auto_cashout, limits.maxPayout, b.username);
  });
}

async function crashRound(roundId) {
  const limits = await getSetting('limits');
  return tx(async c => {
    const r = (await c.query(`SELECT * FROM rounds WHERE id=$1 FOR UPDATE`, [roundId])).rows[0];
    if (r.status === 'crashed') return r;
    // Any auto target strictly below the crash is paid at its target, even if no tick landed on it.
    const due = (await c.query(
      `SELECT b.*, u.username FROM bets b JOIN users u ON u.id=b.user_id
        WHERE b.round_id=$1 AND b.status='active' AND b.auto_cashout IS NOT NULL AND b.auto_cashout < $2 ORDER BY b.user_id, b.id`, [roundId, r.crash_point])).rows;
    for (const b of due) await settleCashout(c, b, b.auto_cashout, limits.maxPayout, b.username);
    const lost = (await c.query(
      `UPDATE bets SET status='lost', payout_cents=0, settled_at=now() WHERE round_id=$1 AND status='active' RETURNING user_id`, [roundId])).rows;
    const done = (await c.query(`UPDATE rounds SET status='crashed', crashed_at=clock_timestamp() WHERE id=$1 RETURNING *`, [roundId])).rows[0];
    await emit(c, 'room', publicRoundEvent(done, 'crashed'));
    for (const uid of new Set(lost.map(x => x.user_id))) await emit(c, 'user', { userId: uid, t: 'balance' });
    return done;
  });
}

async function runRound(round) {
  await syncClock();
  if (round.status === 'betting') {
    await sleep(new Date(round.betting_ends_at).getTime() - dbNow());
    round = await startRound(round.id) || (await q('SELECT * FROM rounds WHERE id=$1', [round.id])).rows[0];
  }
  if (round.status === 'running') {
    const started = new Date(round.started_at).getTime();
    const crashMs = round.crash_point <= 100 ? 0 : msForMultiplier(round.crash_point);
    // No new bets can join a running round, so the set of auto targets is fixed now.
    const targets = (await q(
      `SELECT DISTINCT auto_cashout FROM bets WHERE round_id=$1 AND status='active' AND auto_cashout IS NOT NULL ORDER BY 1`,
      [round.id])).rows.map(r => r.auto_cashout);
    for (;;) {
      const elapsed = dbNow() - started;
      if (elapsed >= crashMs) break;
      const m = multiplierAt(elapsed);
      await q('SELECT pg_notify($1,$2)', ['tick', JSON.stringify({ roundId: Number(round.id), m, e: Math.floor(elapsed) })]);
      if (targets.length && targets[0] <= m) {
        await settleAutos(round.id, m);
        while (targets.length && targets[0] <= m) targets.shift();
      }
      await sleep(Math.min(TICK_MS, crashMs - elapsed));
    }
    round = await crashRound(round.id);
  }
  await sleep(new Date(round.crashed_at).getTime() + COOLDOWN_MS - dbNow());
}

export async function runEngine({ signal } = {}) {
  // Session-level advisory lock needs a direct connection (not through a transaction pooler).
  const lockClient = directClient();
  await lockClient.connect();
  // Leader election: only one engine anywhere. Others wait and take over if the leader dies.
  for (;;) {
    const got = (await lockClient.query('SELECT pg_try_advisory_lock(727002) AS ok')).rows[0].ok;
    if (got) break;
    if (signal?.aborted) { await lockClient.end(); return; }
    await sleep(2000);
  }
  log.info('engine leader acquired');
  try {
    while (!signal?.aborted) {
      try {
        let round = (await q(`SELECT * FROM rounds WHERE status <> 'crashed' ORDER BY id DESC LIMIT 1`)).rows[0];
        if (!round) round = await createRound();
        await runRound(round);
      } catch (e) {
        log.error('engine error', { err: e });
        await sleep(1000);
      }
    }
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock(727002)').catch(() => {});
    await lockClient.end().catch(() => {});
  }
}

export { publicBet, crashRound, createRound, startRound };

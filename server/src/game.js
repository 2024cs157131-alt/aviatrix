import { tx, q } from './db.js';
import { lockUser, debit, post, LedgerError } from './ledger.js';
import { multiplierAt } from './fair.js';
import { getSetting, activeProviders } from './settings.js';

export class GameError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const maskName = n => (n.length <= 3 ? n[0] + '**' : n.slice(0, 2) + '***' + n.slice(-1));

export async function emit(c, channel, payload) {
  await c.query('SELECT pg_notify($1, $2)', [channel, JSON.stringify(payload)]);
}

// Table is read-only while no payment provider is active (spec: "neither on").
let tableCache = { at: 0, open: false };
export async function tableOpen() {
  if (Date.now() - tableCache.at < 5000) return tableCache.open;
  const open = Object.keys(await activeProviders()).length > 0;
  tableCache = { at: Date.now(), open };
  return open;
}

function validateIntent({ slot, stake, autoCashout }, limits) {
  if (!['A', 'B'].includes(slot)) throw new GameError('bad_slot');
  const stakeKes = Number(stake);
  if (!Number.isFinite(stakeKes) || Math.round(stakeKes * 100) !== stakeKes * 100) throw new GameError('bad_stake', 'Stake must be a number with at most 2 decimals.');
  if (stakeKes < limits.betMin || stakeKes > limits.betMax) throw new GameError('stake_out_of_range', `Stake must be between KES ${limits.betMin} and KES ${limits.betMax}.`);
  let auto = null;
  if (autoCashout != null && autoCashout !== '') {
    const a = Number(autoCashout);
    if (!Number.isFinite(a) || a < 1.01 || a > 1000000) throw new GameError('bad_auto', 'Auto cashout must be at least 1.01×.');
    auto = Math.floor(a * 100 + 1e-9);
  }
  return { slot, stakeCents: Math.round(stakeKes * 100), auto };
}

/**
 * Client sends intent only: slot, stake (KES), optional autoCashout (×).
 * If the current round is taking bets, the stake is debited now. Otherwise the bet is queued for the
 * next round with no debit; the engine debits it when the next round opens (or rejects it).
 */
export async function placeBet(user, intent) {
  if (!(await tableOpen())) throw new GameError('table_closed', 'The table is read-only right now.');
  const limits = await getSetting('limits');
  const { slot, stakeCents, auto } = validateIntent(intent, limits);
  return tx(async c => {
    const r = await c.query(
      `SELECT id, status, (clock_timestamp() < betting_ends_at) AS open FROM rounds
        WHERE status <> 'crashed' ORDER BY id DESC LIMIT 1 FOR SHARE`);
    const round = r.rows[0];
    await lockUser(c, user.id);
    if (round && round.status === 'betting' && round.open) {
      const dup = await c.query(`SELECT 1 FROM bets WHERE user_id=$1 AND round_id=$2 AND slot=$3 AND status='active'`, [user.id, round.id, slot]);
      if (dup.rowCount) throw new GameError('slot_busy', `Bet ${slot} is already placed this round.`);
      const b = (await c.query(
        `INSERT INTO bets(user_id, round_id, slot, stake_cents, auto_cashout, status) VALUES ($1,$2,$3,$4,$5,'active') RETURNING *`,
        [user.id, round.id, slot, stakeCents, auto])).rows[0];
      await debit(c, { userId: user.id, type: 'bet_debit', amount: stakeCents, key: `bet:${b.id}`, betId: b.id });
      await emit(c, 'room', { t: 'bet', roundId: round.id, user: maskName(user.username), slot, stake: stakeCents });
      await emit(c, 'user', { userId: user.id, t: 'balance' });
      return { bet: publicBet(b), queued: false };
    }
    const existing = await c.query(`SELECT 1 FROM bets WHERE user_id=$1 AND slot=$2 AND status='queued'`, [user.id, slot]);
    if (existing.rowCount) throw new GameError('slot_busy', `Bet ${slot} is already queued for the next round.`);
    const b = (await c.query(
      `INSERT INTO bets(user_id, slot, stake_cents, auto_cashout, status) VALUES ($1,$2,$3,$4,'queued') RETURNING *`,
      [user.id, slot, stakeCents, auto])).rows[0];
    return { bet: publicBet(b), queued: true };
  });
}

export async function cancelBet(user, betId) {
  return tx(async c => {
    const b = (await c.query(`SELECT * FROM bets WHERE id=$1 AND user_id=$2 FOR UPDATE`, [betId, user.id])).rows[0];
    if (!b) throw new GameError('not_found');
    if (b.status === 'queued') {
      await c.query(`UPDATE bets SET status='cancelled', settled_at=now() WHERE id=$1`, [b.id]);
      return { cancelled: true };
    }
    if (b.status !== 'active') throw new GameError('not_cancellable');
    const r = (await c.query(`SELECT status, (clock_timestamp() < betting_ends_at) AS open FROM rounds WHERE id=$1 FOR SHARE`, [b.round_id])).rows[0];
    if (r.status !== 'betting' || !r.open) throw new GameError('not_cancellable', 'Betting has closed for this round.');
    await c.query(`UPDATE bets SET status='cancelled', settled_at=now() WHERE id=$1`, [b.id]);
    await post(c, { userId: user.id, type: 'bet_refund', amount: Number(b.stake_cents), key: `refund:${b.id}`, betId: b.id });
    await emit(c, 'room', { t: 'cancel', roundId: b.round_id, user: maskName(user.username), slot: b.slot });
    await emit(c, 'user', { userId: user.id, t: 'balance' });
    return { cancelled: true };
  });
}

export function payoutFor(stakeCents, mult, maxPayoutKes) {
  return Math.min(Math.floor((stakeCents * mult) / 100), maxPayoutKes * 100);
}

/** Pay out a bet at `mult`. Caller must hold the round row lock. */
export async function settleCashout(c, bet, mult, maxPayoutKes, username) {
  const payout = payoutFor(Number(bet.stake_cents), mult, maxPayoutKes);
  const u = await c.query(
    `UPDATE bets SET status='cashed', cashout_mult=$2, payout_cents=$3, settled_at=now() WHERE id=$1 AND status='active'`,
    [bet.id, mult, payout]);
  if (!u.rowCount) return null;
  await post(c, { userId: bet.user_id, type: 'cashout_credit', amount: payout, key: `cashout:${bet.id}`, betId: bet.id });
  await emit(c, 'room', { t: 'cashout', roundId: bet.round_id, user: maskName(username), slot: bet.slot, mult, payout });
  await emit(c, 'user', { userId: bet.user_id, t: 'balance', betId: bet.id });
  return payout;
}

/** Manual cash out. The server decides the multiplier from its own clock; client sends only the bet id. */
export async function cashout(user, betId) {
  const limits = await getSetting('limits');
  return tx(async c => {
    const b = (await c.query(`SELECT * FROM bets WHERE id=$1 AND user_id=$2`, [betId, user.id])).rows[0];
    if (!b || !b.round_id) throw new GameError('not_found');
    const r = (await c.query(
      `SELECT id, status, crash_point, EXTRACT(EPOCH FROM (clock_timestamp() - started_at)) * 1000 AS elapsed
         FROM rounds WHERE id=$1 FOR SHARE`, [b.round_id])).rows[0];
    // FOR SHARE: thousands of cashouts in one round run in parallel. The crash transaction takes FOR UPDATE,
    // so it waits for in-flight cashouts; each cashout independently refuses if the server clock has reached
    // the crash point, so a share lock never lets a late cashout through.
    const fresh = (await c.query(`SELECT * FROM bets WHERE id=$1 FOR UPDATE`, [b.id])).rows[0];
    if (fresh.status !== 'active') throw new GameError('not_active', 'This bet is already settled.');
    if (r.status !== 'running') throw new GameError('not_running', 'The round is not in flight.');
    let m = multiplierAt(Number(r.elapsed));
    if (m >= r.crash_point) throw new GameError('too_late', 'Crashed before your cash out reached the server.');
    // An auto target already passed is paid at the target, exactly as the engine would.
    if (fresh.auto_cashout && fresh.auto_cashout <= m) m = fresh.auto_cashout;
    const payout = await settleCashout(c, fresh, m, limits.maxPayout, user.username);
    return { mult: m, payout };
  });
}

export function publicBet(b) {
  return {
    id: Number(b.id), roundId: b.round_id ? Number(b.round_id) : null, slot: b.slot, stake: Number(b.stake_cents),
    autoCashout: b.auto_cashout, status: b.status, cashoutMult: b.cashout_mult, payout: b.payout_cents == null ? null : Number(b.payout_cents),
    rejectReason: b.reject_reason, createdAt: b.created_at,
  };
}

export async function myBets(userId, limit = 50) {
  const r = await q(
    `SELECT b.*, r.crash_point, r.status AS round_status FROM bets b LEFT JOIN rounds r ON r.id = b.round_id
      WHERE b.user_id = $1 ORDER BY b.id DESC LIMIT $2`, [userId, limit]);
  return r.rows.map(b => ({ ...publicBet(b), crash: b.round_status === 'crashed' ? b.crash_point : null }));
}

export async function sessionStats(userId) {
  // "Session" = the current sign-in session's lifetime is fuzzy; we report the last 24h of play.
  const r = await q(
    `SELECT COALESCE(SUM(stake_cents),0)::bigint AS wagered,
            COALESCE(SUM(payout_cents),0)::bigint AS returned,
            MAX(cashout_mult) AS best
       FROM bets WHERE user_id=$1 AND status IN ('cashed','lost') AND created_at > now() - interval '24 hours'`, [userId]);
  const s = r.rows[0];
  return { wagered: Number(s.wagered), returned: Number(s.returned), net: Number(s.returned) - Number(s.wagered), best: s.best };
}

export { LedgerError };

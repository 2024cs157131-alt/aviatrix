// Deposit / withdrawal orchestration. Balance moves ONLY on a verified provider callback:
//   deposit:    pending (0) -> [verified callback + provider status check] -> deposit_confirmed (+amount)
//   withdrawal: withdrawal_reserved (-amount) -> payout -> [verified result] -> withdrawal_paid (0) | withdrawal_failed (+amount)
import { q, tx } from './db.js';
import { encrypt, callbackToken, safeEqual, hmacHex } from './crypto.js';
import { lockUser, balanceOf, post, LedgerError } from './ledger.js';
import { activeProviders, getSetting, setSetting, loadCredentials, missingFields } from './settings.js';
import { normalizeKenyanPhone, maskPhone } from './phone.js';
import { config } from './config.js';
import { log } from './log.js';
import * as mpesa from './providers/mpesa.js';
import * as cashia from './providers/cashia.js';
import { emit } from './game.js';

export class PaymentError extends Error {
  constructor(code, message, status = 400) { super(message || code); this.code = code; this.status = status; }
}

const cashiaToken = (creds, paymentId) => hmacHex(creds.webhookSecret, `cashia:${paymentId}`).slice(0, 40);

async function validate(user, { provider, amount, phone }, dir) {
  const active = await activeProviders();
  if (!active[provider]) throw new PaymentError('provider_unavailable', 'That payment method is not available right now.');
  if (dir === 'withdrawal' && provider === 'cashia' && !cashia.CASHIA_PAYOUTS_SUPPORTED) {
    throw new PaymentError('cashia_payout_unavailable', 'Cashia withdrawals are not available yet. Choose M-Pesa.');
  }
  const limits = await getSetting('limits');
  const kes = Number(amount);
  if (!Number.isInteger(kes)) throw new PaymentError('bad_amount', 'Enter a whole number of shillings.');
  const [min, max] = dir === 'deposit' ? [limits.depositMin, limits.depositMax] : [limits.withdrawMin, limits.withdrawMax];
  if (kes < min || kes > max) throw new PaymentError('amount_out_of_range', `Amount must be between KES ${min} and KES ${max}.`);
  const msisdn = normalizeKenyanPhone(phone);
  if (!msisdn) throw new PaymentError('bad_phone', 'Enter a Kenyan number like 07XXXXXXXX, 01XXXXXXXX or 2547XXXXXXXX.');
  return { kes, msisdn, env: active[provider].environment, creds: active[provider].creds };
}

const pub = p => ({
  id: p.id, provider: p.provider, direction: p.direction, amount: Number(p.amount_cents), status: p.status,
  phone: p.phone_masked, failureReason: p.failure_reason, checkoutUrl: p.status === 'pending' ? p.checkout_url : null,
  createdAt: p.created_at, environment: p.environment, channel: p.channel,
});

// ---------------------------------------------------------------- deposits

export async function startDeposit(user, input) {
  const { kes, msisdn, env, creds } = await validate(user, input, 'deposit');
  const provider = input.provider;
  const p = await tx(async c => {
    const row = (await c.query(
      `INSERT INTO payments(user_id, provider, environment, direction, channel, amount_cents, phone_enc, phone_masked, status)
       VALUES ($1,$2,$3,'deposit',$7,$4,$5,$6,'initiating') RETURNING *`,
      [user.id, provider, env, kes * 100, encrypt(msisdn), maskPhone(msisdn), provider === 'mpesa' ? 'stk' : 'checkout'])).rows[0];
    await post(c, { userId: user.id, type: 'deposit_pending', amount: 0, key: `dep_pending:${row.id}`, paymentId: row.id, provider });
    return row;
  });
  log.info('deposit initiating', { paymentId: p.id, provider, env, amount: kes });
  try {
    if (provider === 'mpesa') {
      const base = creds.callbackBaseUrl;
      const r = await mpesa.stkPush(creds, env, {
        amount: kes, phone: msisdn, accountRef: `D${p.id.replace(/-/g, '').slice(0, 11)}`,
        callbackUrl: `${base}/api/hooks/mp/stk/${p.id}/${callbackToken(p.id, 'stk')}`,
      });
      const u = (await q(`UPDATE payments SET status='pending', provider_ref=$2, updated_at=now() WHERE id=$1 RETURNING *`, [p.id, r.checkoutRequestId])).rows[0];
      log.info('stk sent', { paymentId: p.id, checkoutRequestId: r.checkoutRequestId });
      return pub(u);
    }
    const base = creds.callbackBaseUrl;
    const r = await cashia.createHostedCheckout(creds, {
      requestId: p.id, amount: kes,
      webhookUrl: `${base}/api/hooks/cs/${p.id}/${cashiaToken(creds, p.id)}`,
      successRedirectUrl: `${config.publicOrigin}/?cashier=return&payment=${p.id}`,
      errorRedirectUrl: `${config.publicOrigin}/?cashier=error&payment=${p.id}`,
    });
    const u = (await q(`UPDATE payments SET status='pending', provider_ref=$2, checkout_url=$3, updated_at=now() WHERE id=$1 RETURNING *`,
      [p.id, r.requestId || p.id, r.url])).rows[0];
    log.info('cashia checkout created', { paymentId: p.id, sessionId: r.sessionId });
    return pub(u);
  } catch (e) {
    if (e.definitive) {
      await failDeposit(p.id, e.message);
      throw new PaymentError(e.code, e.message, 502);
    }
    // Unknown outcome (timeout etc.): keep it open; a callback or reconciliation will settle it.
    await q(`UPDATE payments SET status='needs_review', failure_reason=$2, updated_at=now() WHERE id=$1`, [p.id, e.message]);
    log.warn('deposit outcome unknown', { paymentId: p.id, err: e.message });
    return pub((await q('SELECT * FROM payments WHERE id=$1', [p.id])).rows[0]);
  }
}

async function failDeposit(paymentId, reason) {
  await tx(async c => {
    const p = (await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [paymentId])).rows[0];
    if (!p || p.status === 'confirmed' || p.status === 'failed') return;
    await c.query(`UPDATE payments SET status='failed', failure_reason=$2, updated_at=now() WHERE id=$1`, [p.id, String(reason).slice(0, 300)]);
    await post(c, { userId: p.user_id, type: 'deposit_failed', amount: 0, key: `dep_failed:${p.id}`, paymentId: p.id, provider: p.provider });
    await emit(c, 'user', { userId: p.user_id, t: 'payment', paymentId: p.id });
  });
  log.info('deposit failed', { paymentId, reason });
}

/** Credit exactly once. Idempotency on both the provider reference and the provider transaction id. */
async function confirmDeposit(paymentId, { providerRef, providerTxn, amountKes }) {
  return tx(async c => {
    const p = (await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [paymentId])).rows[0];
    if (!p || p.direction !== 'deposit') throw new PaymentError('not_found');
    if (p.status === 'confirmed') return { duplicate: true };
    if (!p.user_id) {
      await c.query(`UPDATE payments SET status='needs_review', verified_at=COALESCE(verified_at, now()), updated_at=now() WHERE id=$1`, [p.id]);
      return { unassigned: true };
    }
    if (amountKes != null && Math.round(amountKes * 100) !== Number(p.amount_cents)) {
      await c.query(`UPDATE payments SET status='needs_review', failure_reason=$2, updated_at=now() WHERE id=$1`,
        [p.id, `amount mismatch: provider reported ${amountKes}`]);
      return { mismatch: true };
    }
    const dupTxn = providerTxn && (await c.query(`SELECT 1 FROM payments WHERE provider=$1 AND provider_txn=$2 AND id<>$3`, [p.provider, providerTxn, p.id])).rowCount;
    if (dupTxn) throw new PaymentError('replay', 'provider transaction already used by another payment');
    await c.query(`UPDATE payments SET status='confirmed', provider_ref=COALESCE(provider_ref,$2), provider_txn=$3, failure_reason=NULL,
                     verified_at=COALESCE(verified_at, now()), updated_at=now() WHERE id=$1`,
      [p.id, providerRef, providerTxn]);
    const posted = await post(c, {
      userId: p.user_id, type: 'deposit_confirmed', amount: Number(p.amount_cents),
      key: `deposit:${p.provider}:${providerRef || p.provider_ref || p.id}`, paymentId: p.id, provider: p.provider,
    });
    await emit(c, 'user', { userId: p.user_id, t: 'balance' });
    await emit(c, 'user', { userId: p.user_id, t: 'payment', paymentId: p.id });
    log.info('deposit confirmed', { paymentId: p.id, provider: p.provider, providerTxn, posted });
    return { confirmed: true };
  });
}

// ---------------------------------------------------------------- withdrawals

export async function startWithdrawal(user, input) {
  const { kes, msisdn, env, creds } = await validate(user, input, 'withdrawal');
  const provider = input.provider;
  const p = await tx(async c => {
    await lockUser(c, user.id);
    const bal = await balanceOf(c, user.id);
    if (bal < kes * 100) throw new PaymentError('insufficient_funds', 'Amount is more than your withdrawable balance.');
    const row = (await c.query(
      `INSERT INTO payments(user_id, provider, environment, direction, channel, amount_cents, phone_enc, phone_masked, status)
       VALUES ($1,$2,$3,'withdrawal','b2c',$4,$5,$6,'initiating') RETURNING *`,
      [user.id, provider, env, kes * 100, encrypt(msisdn), maskPhone(msisdn)])).rows[0];
    await post(c, { userId: user.id, type: 'withdrawal_reserved', amount: -kes * 100, key: `wd_reserve:${row.id}`, paymentId: row.id, provider });
    await emit(c, 'user', { userId: user.id, t: 'balance' });
    return row;
  });
  log.info('withdrawal reserved', { paymentId: p.id, provider, env, amount: kes });
  try {
    const base = creds.callbackBaseUrl;
    const r = await mpesa.b2c(creds, env, {
      amount: kes, phone: msisdn,
      resultUrl: `${base}/api/hooks/mp/b2c/${p.id}/${callbackToken(p.id, 'b2c')}`,
      timeoutUrl: `${base}/api/hooks/mp/b2c-timeout/${p.id}/${callbackToken(p.id, 'b2c-timeout')}`,
    });
    const u = (await q(`UPDATE payments SET status='pending', provider_ref=$2, updated_at=now() WHERE id=$1 RETURNING *`,
      [p.id, r.originatorConversationId || r.conversationId])).rows[0];
    log.info('b2c accepted', { paymentId: p.id, ref: u.provider_ref });
    return pub(u);
  } catch (e) {
    if (e.definitive) { await failWithdrawal(p.id, e.message); throw new PaymentError(e.code, e.message, 502); }
    // Could have been paid: never auto-release an unknown outcome. Admin resolves from the M-Pesa portal.
    await q(`UPDATE payments SET status='needs_review', failure_reason=$2, updated_at=now() WHERE id=$1`, [p.id, e.message]);
    log.warn('withdrawal outcome unknown', { paymentId: p.id, err: e.message });
    return pub((await q('SELECT * FROM payments WHERE id=$1', [p.id])).rows[0]);
  }
}

async function failWithdrawal(paymentId, reason) {
  await tx(async c => {
    const p = (await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [paymentId])).rows[0];
    if (!p || p.direction !== 'withdrawal' || p.status === 'confirmed' || p.status === 'failed') return;
    await c.query(`UPDATE payments SET status='failed', failure_reason=$2, updated_at=now() WHERE id=$1`, [p.id, String(reason).slice(0, 300)]);
    await post(c, { userId: p.user_id, type: 'withdrawal_failed', amount: Number(p.amount_cents), key: `wd_failed:${p.id}`, paymentId: p.id, provider: p.provider });
    await emit(c, 'user', { userId: p.user_id, t: 'balance' });
    await emit(c, 'user', { userId: p.user_id, t: 'payment', paymentId: p.id });
  });
  log.info('withdrawal failed, reserve released', { paymentId, reason });
}

async function completeWithdrawal(paymentId, transactionId) {
  await tx(async c => {
    const p = (await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [paymentId])).rows[0];
    if (!p || p.direction !== 'withdrawal' || p.status === 'confirmed') return;
    if (p.status === 'failed') throw new PaymentError('conflict', 'payout reported paid after reserve was released — needs manual review');
    await c.query(`UPDATE payments SET status='confirmed', provider_txn=$2, failure_reason=NULL, updated_at=now() WHERE id=$1`, [p.id, transactionId]);
    await post(c, { userId: p.user_id, type: 'withdrawal_paid', amount: 0, key: `wd_paid:${p.id}`, paymentId: p.id, provider: p.provider });
    await emit(c, 'user', { userId: p.user_id, t: 'payment', paymentId: p.id });
  });
  log.info('withdrawal paid', { paymentId, transactionId });
}

// ---------------------------------------------------------------- callbacks

async function storeEvent(provider, kind, paymentId, body, verified, environment = null) {
  const safeBody = mpesa.redact(body);
  const r = await q(`INSERT INTO webhook_events(provider, kind, payment_id, verified, body, environment) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [provider, kind, paymentId, verified, safeBody, environment]);
  return r.rows[0].id;
}

async function markEvent(id, error) {
  await q(`UPDATE webhook_events SET processed = $2, error = $3, processed_at = now() WHERE id = $1`, [id, !error, error || null]);
}

async function paymentById(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return (await q('SELECT * FROM payments WHERE id=$1', [id])).rows[0] || null;
}

async function ipAllowed(provider, ip) {
  const sec = (await getSetting('security')) || {};
  const list = sec[`${provider}CallbackIps`];
  return !Array.isArray(list) || list.length === 0 || list.includes(ip);
}

/** Entry point for every provider callback route. Returns HTTP status to send. */
export async function receiveCallback({ provider, kind, paymentId, token, body, ip }) {
  const p = await paymentById(paymentId);
  let verified = false;
  if (p && p.provider === provider) {
    if (provider === 'mpesa') {
      const purpose = { stk: 'stk', b2c_result: 'b2c', b2c_timeout: 'b2c-timeout', txstatus: 'txstatus', txstatus_timeout: 'txstatus-timeout' }[kind];
      verified = safeEqual(token, callbackToken(p.id, purpose)) && (await ipAllowed('mpesa', ip));
    } else {
      const creds = await loadCredentials('cashia', p.environment);
      verified = !!creds && safeEqual(token, cashiaToken(creds, p.id)) && (await ipAllowed('cashia', ip));
    }
  }
  const eventId = await storeEvent(provider, kind, p ? p.id : null, body, verified);
  if (!verified) {
    log.warn('callback rejected', { provider, kind, paymentId, eventId });
    await markEvent(eventId, 'verification failed');
    return 403;
  }
  // Acknowledge fast; Daraja expects a quick 200. Processing is idempotent and retryable by admin.
  setImmediate(() => processEvent(eventId, body).catch(e => log.error('callback processing error', { eventId, err: e.message })));
  return 200;
}

/**
 * Process one verified callback. `rawBody` is the original body (stored copy is redacted, but redaction
 * never touches the fields used here). Safe to run repeatedly: every path is idempotent.
 */
export async function processEvent(eventId, rawBody) {
  const ev = (await q('SELECT * FROM webhook_events WHERE id=$1', [eventId])).rows[0];
  if (!ev?.verified) throw new PaymentError('not_verified', 'Only verified callbacks can be processed.');
  const body = rawBody || ev.body;
  const p = await paymentById(ev.payment_id);
  try {
    if (ev.provider === 'mpesa' && ev.kind === 'stk') await processStk(p, body);
    else if (ev.provider === 'mpesa' && ev.kind === 'b2c_result') await processB2c(p, body);
    else if (ev.provider === 'mpesa' && ev.kind === 'b2c_timeout') {
      await q(`UPDATE payments SET status='needs_review', failure_reason='B2C queue timeout — check M-Pesa portal', updated_at=now()
               WHERE id=$1 AND status IN ('initiating','pending')`, [p.id]);
    } else if (ev.provider === 'mpesa' && ev.kind === 'txstatus') await processTxStatus(p, body);
    else if (ev.provider === 'mpesa' && ev.kind === 'txstatus_timeout') {
      await q(`UPDATE payments SET status='needs_review', failure_reason='Transaction status query timed out — retry verification', updated_at=now()
               WHERE id=$1 AND status <> 'confirmed'`, [p.id]);
    } else if (ev.provider === 'mpesa' && ev.kind === 'c2b_confirm') await processC2bConfirm(eventId, body);
    else if (ev.provider === 'cashia') await processCashia(p, body);
    await markEvent(eventId, null);
  } catch (e) {
    await markEvent(eventId, e.message);
    throw e;
  }
}

async function processStk(p, body) {
  const cb = mpesa.parseStkCallback(body);
  if (!cb) throw new PaymentError('bad_payload', 'not an STK callback');
  if (p.provider_ref && cb.checkoutRequestId !== p.provider_ref) throw new PaymentError('ref_mismatch', 'CheckoutRequestID does not match payment');
  if (cb.resultCode !== '0') { await failDeposit(p.id, cb.resultDesc || `ResultCode ${cb.resultCode}`); return; }
  // Second, independent check with Safaricom before crediting.
  const creds = await loadCredentials('mpesa', p.environment);
  const status = await mpesa.stkQuery(creds, p.environment, cb.checkoutRequestId);
  if (!status.done || !status.success) {
    await q(`UPDATE payments SET status='needs_review', failure_reason=$2, updated_at=now() WHERE id=$1 AND status<>'confirmed'`,
      [p.id, `STK query did not confirm: ${status.resultDesc || status.resultCode}`]);
    throw new PaymentError('unconfirmed', 'STK query did not confirm success; retry reconciliation later');
  }
  await confirmDeposit(p.id, { providerRef: cb.checkoutRequestId, providerTxn: cb.receipt, amountKes: cb.amount });
}

async function processB2c(p, body) {
  const r = mpesa.parseB2cResult(body);
  if (!r) throw new PaymentError('bad_payload', 'not a B2C result');
  if (p.provider_ref && r.originatorConversationId !== p.provider_ref && r.conversationId !== p.provider_ref) {
    throw new PaymentError('ref_mismatch', 'conversation id does not match payment');
  }
  if (r.resultCode === '0') {
    if (Number.isFinite(r.amount) && r.amount * 100 !== Number(p.amount_cents)) {
      await q(`UPDATE payments SET status='needs_review', failure_reason='B2C amount mismatch', updated_at=now() WHERE id=$1`, [p.id]);
      return;
    }
    await completeWithdrawal(p.id, r.transactionId);
  } else {
    await failWithdrawal(p.id, r.resultDesc || `ResultCode ${r.resultCode}`);
  }
}

async function processCashia(p, body, overrideTxnId) {
  const txnId = overrideTxnId || cashia.transactionIdFrom(body);
  if (!txnId) {
    await q(`UPDATE payments SET status='needs_review', failure_reason='Cashia callback had no transaction id', updated_at=now() WHERE id=$1 AND status<>'confirmed'`, [p.id]);
    throw new PaymentError('no_txn', 'callback has no transaction id; reconcile with the id from the Cashia dashboard');
  }
  const creds = await loadCredentials('cashia', p.environment);
  const txn = await cashia.getTransaction(creds, txnId);
  if (txn.requestIdentifier && txn.requestIdentifier !== p.id) throw new PaymentError('ref_mismatch', 'Cashia transaction belongs to a different request');
  if (!cashia.isPaid(txn)) {
    const s = String(txn.status || '').toLowerCase();
    if (['failed', 'cancelled', 'canceled', 'rejected', 'expired'].includes(s)) { await failDeposit(p.id, `Cashia status ${s}`); return; }
    throw new PaymentError('unconfirmed', `Cashia status is ${txn.status}/${txn.requestStatus}; not crediting yet`);
  }
  const amt = Number(txn.amount ?? txn.externalSourceAmount);
  await confirmDeposit(p.id, { providerRef: p.id, providerTxn: String(txn.id || txnId), amountKes: Number.isFinite(amt) ? amt : null });
}

// ---------------------------------------------------------------- reconciliation

/** Ask the provider directly. Used by admin "retry reconciliation" and by the worker for stale deposits. */
export async function reconcilePayment(paymentId, { cashiaTransactionId } = {}) {
  const p = await paymentById(paymentId);
  if (!p) throw new PaymentError('not_found', 'payment not found', 404);
  if (p.status === 'confirmed' || p.status === 'failed') return pub(p);
  if (p.provider === 'mpesa' && p.channel === 'c2b') {
    await requestTxStatus(p);
    return pub(await paymentById(p.id));
  }
  if (p.provider === 'mpesa' && p.direction === 'deposit') {
    if (!p.provider_ref) throw new PaymentError('no_ref', 'No CheckoutRequestID — the STK push never reached Safaricom.');
    const creds = await loadCredentials('mpesa', p.environment);
    const s = await mpesa.stkQuery(creds, p.environment, p.provider_ref);
    if (s.done && s.success) {
      // Receipt number arrives only in the callback; key on the CheckoutRequestID (unique per STK push).
      await confirmDeposit(p.id, { providerRef: p.provider_ref, providerTxn: null, amountKes: null });
    } else if (s.done) await failDeposit(p.id, s.resultDesc || `ResultCode ${s.resultCode}`);
  } else if (p.provider === 'cashia' && p.direction === 'deposit') {
    await processCashia(p, {}, cashiaTransactionId);
  } else {
    throw new PaymentError('manual', 'Withdrawals are reconciled by re-processing their stored B2C result, or resolved manually.');
  }
  return pub(await paymentById(p.id));
}

/** Admin manual resolution for a withdrawal stuck in needs_review (after checking the M-Pesa org portal). */
export async function resolveWithdrawal(paymentId, outcome, transactionId) {
  if (outcome === 'paid') await completeWithdrawal(paymentId, transactionId || null);
  else if (outcome === 'failed') await failWithdrawal(paymentId, 'resolved as failed by admin');
  else throw new PaymentError('bad_outcome');
  return pub(await paymentById(paymentId));
}

export async function reconcileStale() {
  const rows = (await q(
    `SELECT id FROM payments WHERE direction='deposit' AND provider='mpesa' AND channel='stk' AND status IN ('pending','needs_review')
       AND provider_ref IS NOT NULL AND updated_at < now() - interval '2 minutes' AND created_at > now() - interval '2 days'
     ORDER BY created_at LIMIT 20`)).rows;
  for (const r of rows) await reconcilePayment(r.id).catch(e => log.warn('auto-reconcile', { paymentId: r.id, err: e.message }));
}

// ---------------------------------------------------------------- paybill C2B

// Static per-environment token for the registered C2B URLs (they can't carry a per-payment token).
const c2bToken = env => callbackToken(`c2b-${env}`, 'c2b');

export async function registerC2b(env, actorId) {
  const creds = await loadCredentials('mpesa', env);
  if (!creds || missingFields('mpesa', creds).length) throw new PaymentError('incomplete_credentials', `Save complete M-Pesa ${env} credentials first.`);
  const t = c2bToken(env);
  const base = creds.callbackBaseUrl;
  const urls = { confirmationUrl: `${base}/api/hooks/mp/c2b/${env}/confirm/${t}`, validationUrl: `${base}/api/hooks/mp/c2b/${env}/validate/${t}` };
  const res = await mpesa.c2bRegister(creds, env, urls);
  const cur = (await getSetting('c2b')) || {};
  await setSetting('c2b', { ...cur, [env]: { registeredAt: new Date().toISOString(), shortcode: creds.shortcode, response: res.ResponseDescription || null } }, actorId);
  log.info('c2b urls registered', { env, shortcode: creds.shortcode });
  return { registered: true, shortcode: creds.shortcode, response: res.ResponseDescription || null };
}

const accountFrom = ref => String(ref || '').replace(/\s+/g, '');
const looksLikePhone = m => /^254[17]\d{8}$/.test(m);

/**
 * Paybill Validation / Confirmation from Safaricom. Returns { status, body } — Daraja reads ResultCode.
 * Validation (only sent if Safaricom enabled external validation on your paybill) rejects unknown accounts
 * and out-of-limit amounts BEFORE the customer's money moves.
 * Confirmation records the payment idempotently by TransID, then a Transaction Status query verifies it
 * with Safaricom; the balance is credited only when that verified result comes back.
 */
export async function receiveC2b({ env, kind, token, body, ip }) {
  const reject = (code, desc) => ({ status: 200, body: { ResultCode: code, ResultDesc: desc } });
  const accept = { status: 200, body: { ResultCode: '0', ResultDesc: 'Accepted' } };
  const verified = ['sandbox', 'production'].includes(env) && safeEqual(token, c2bToken(env)) && (await ipAllowed('mpesa', ip));
  const eventId = await storeEvent('mpesa', `c2b_${kind}`, null, body, verified, ['sandbox', 'production'].includes(env) ? env : null);
  if (!verified) { await markEvent(eventId, 'verification failed'); return { status: 403, body: { ResultCode: 'C2B00016', ResultDesc: 'Rejected' } }; }

  const c = mpesa.parseC2b(body);
  const creds = await loadCredentials('mpesa', env);
  if (!c || !creds || c.shortcode !== String(creds.shortcode)) {
    await markEvent(eventId, 'bad payload or shortcode mismatch');
    return kind === 'validate' ? reject('C2B00016', 'Rejected') : accept;
  }
  if (kind === 'validate') {
    const prov = (await getSetting('providers'))?.mpesa;
    const limits = await getSetting('limits');
    const user = (await q(`SELECT id, disabled FROM users WHERE account_no=$1 AND role='player'`, [accountFrom(c.billRef)])).rows[0];
    let out = accept;
    if (!prov?.enabled || prov.environment !== env) out = reject('C2B00016', 'Rejected');
    else if (!user || user.disabled) out = reject('C2B00012', 'Rejected');
    else if (!(c.amount >= limits.depositMin && c.amount <= limits.depositMax)) out = reject('C2B00013', 'Rejected');
    await markEvent(eventId, out === accept ? null : `rejected ${out.body.ResultCode}`);
    return out;
  }
  // confirm: acknowledge immediately, process asynchronously (idempotent)
  setImmediate(() => processEvent(eventId, body).catch(e => log.error('c2b processing error', { eventId, err: e.message })));
  return accept;
}

async function processC2bConfirm(eventId, body) {
  const ev = (await q('SELECT * FROM webhook_events WHERE id=$1', [eventId])).rows[0];
  const env = ev.environment;
  const c = mpesa.parseC2b(body);
  const cents = Math.round(c.amount * 100);
  if (!(cents > 0)) throw new PaymentError('bad_amount', 'C2B amount is not positive');
  const user = (await q(`SELECT id FROM users WHERE account_no=$1 AND role='player'`, [accountFrom(c.billRef)])).rows[0];
  const p = await tx(async cl => {
    const ins = (await cl.query(
      `INSERT INTO payments(user_id, provider, environment, direction, channel, amount_cents, phone_enc, phone_masked, status, provider_ref, bill_ref)
       VALUES ($1,'mpesa',$2,'deposit','c2b',$3,$4,$5,'pending',$6,$7)
       ON CONFLICT (provider, provider_ref) WHERE provider_ref IS NOT NULL DO NOTHING RETURNING *`,
      [user?.id ?? null, env, cents, encrypt(c.msisdn), looksLikePhone(c.msisdn) ? maskPhone(c.msisdn) : 'hidden by M-Pesa', c.transId, c.billRef.slice(0, 40)])).rows[0];
    if (!ins) return null; // replayed confirmation: already recorded
    if (ins.user_id) await post(cl, { userId: ins.user_id, type: 'deposit_pending', amount: 0, key: `dep_pending:${ins.id}`, paymentId: ins.id, provider: 'mpesa' });
    await cl.query('UPDATE webhook_events SET payment_id=$2 WHERE id=$1', [ev.id, ins.id]);
    return ins;
  });
  if (!p) { log.info('c2b confirmation replay ignored', { transId: c.transId }); return; }
  log.info('c2b recorded', { paymentId: p.id, transId: c.transId, matched: !!p.user_id, amount: c.amount });
  await requestTxStatus(p);
}

async function requestTxStatus(p) {
  const creds = await loadCredentials('mpesa', p.environment);
  try {
    await mpesa.transactionStatus(creds, p.environment, {
      transactionId: p.provider_ref,
      resultUrl: `${creds.callbackBaseUrl}/api/hooks/mp/txstatus/${p.id}/${callbackToken(p.id, 'txstatus')}`,
      timeoutUrl: `${creds.callbackBaseUrl}/api/hooks/mp/txstatus-timeout/${p.id}/${callbackToken(p.id, 'txstatus-timeout')}`,
    });
  } catch (e) {
    await q(`UPDATE payments SET status='needs_review', failure_reason=$2, updated_at=now() WHERE id=$1 AND status<>'confirmed'`,
      [p.id, `Could not start verification: ${e.message}`]);
    log.warn('txstatus request failed', { paymentId: p.id, err: e.message });
  }
}

async function processTxStatus(p, body) {
  const r = mpesa.parseTxStatus(body);
  if (!r) throw new PaymentError('bad_payload', 'not a transaction status result');
  const ok = r.resultCode === '0' && String(r.status).toLowerCase() === 'completed' && r.receipt === p.provider_ref
    && r.amount != null && Math.round(r.amount * 100) === Number(p.amount_cents);
  if (!ok) {
    await q(`UPDATE payments SET status='needs_review', failure_reason=$2, updated_at=now() WHERE id=$1 AND status<>'confirmed'`,
      [p.id, `Verification mismatch: ${r.resultDesc || ''} status=${r.status} amount=${r.amount}`.slice(0, 300)]);
    throw new PaymentError('unverified', 'Transaction status did not confirm this payment');
  }
  await q(`UPDATE payments SET verified_at=COALESCE(verified_at, now()), updated_at=now() WHERE id=$1`, [p.id]);
  if (!p.user_id) {
    await q(`UPDATE payments SET status='needs_review', failure_reason=$2, updated_at=now() WHERE id=$1 AND status<>'confirmed'`,
      [p.id, `Verified, but account "${p.bill_ref}" matches no player — assign it`]);
    return;
  }
  await confirmDeposit(p.id, { providerRef: p.provider_ref, providerTxn: p.provider_ref, amountKes: r.amount });
}

/** Admin: attach a verified-but-unmatched paybill payment to a player, then credit it. */
export async function assignC2b(paymentId, who) {
  const p = await tx(async c => {
    const row = (await c.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [paymentId])).rows[0];
    if (!row || row.channel !== 'c2b' || row.user_id) throw new PaymentError('not_assignable', 'Only unassigned paybill payments can be assigned.');
    if (!row.verified_at) throw new PaymentError('not_verified', 'Verify the payment with Safaricom first (retry verification).');
    const u = (await c.query(`SELECT id FROM users WHERE role='player' AND (account_no=$1 OR lower(username)=lower($1))`, [String(who || '').trim()])).rows[0];
    if (!u) throw new PaymentError('no_user', 'No player with that account number or username.');
    await c.query('UPDATE payments SET user_id=$2, updated_at=now() WHERE id=$1', [row.id, u.id]);
    await post(c, { userId: u.id, type: 'deposit_pending', amount: 0, key: `dep_pending:${row.id}`, paymentId: row.id, provider: 'mpesa' });
    return row;
  });
  await confirmDeposit(p.id, { providerRef: p.provider_ref, providerTxn: p.provider_ref, amountKes: null });
  return pub(await paymentById(p.id));
}

export async function myPayments(userId) {
  return (await q('SELECT * FROM payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30', [userId])).rows.map(pub);
}

export async function getPayment(userId, id) {
  const p = await paymentById(id);
  return p && p.user_id === userId ? pub(p) : null;
}

export { pub as publicPayment };
export { LedgerError };

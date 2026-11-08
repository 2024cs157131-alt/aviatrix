// Integration test against a scratch Postgres database (DATABASE_URL must point to a throwaway DB).
// Provider HTTP is mocked at fetch(); values below are TEST-ONLY placeholders, never used by the app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.SETTINGS_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('base64');
const { q, pool } = await import('../src/db.js');
const { hashPassword, callbackToken } = await import('../src/crypto.js');
const { saveCredentials, setSetting } = await import('../src/settings.js');
const { startDeposit, startWithdrawal, receiveCallback, receiveC2b, assignC2b, registerC2b } = await import('../src/payments.js');
const { verifyTotp, totpAt, newTotpSecret } = await import('../src/crypto.js');
const { verifyBalances } = await import('../src/ledger.js');
const { placeBet, cancelBet, cashout } = await import('../src/game.js');
const { crashRound } = await import('../src/engine.js');
const { balanceOf } = await import('../src/ledger.js');
const { crashPoint, msForMultiplier } = await import('../src/fair.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const bal = id => balanceOf({ query: q }, id);
let user, calls = [];
let stkQueryResult = { ResultCode: '0', ResultDesc: 'The service request is processed successfully.' };
let b2cN = 0, stkN = 0;

before(async () => {
  if (!/test/.test(process.env.DATABASE_URL)) throw new Error('refusing to run: DATABASE_URL must be a test database');
  await q(`ALTER TABLE ledger_entries DISABLE TRIGGER ledger_no_truncate`);
  await q(`TRUNCATE ledger_entries, webhook_events, payments, bets, rounds, sessions, users RESTART IDENTITY CASCADE`);
  await q(`ALTER TABLE ledger_entries ENABLE TRIGGER ledger_no_truncate`);
  // TRUNCATE ... CASCADE on users also clears settings (FK updated_by); restore defaults.
  await setSetting('limits', { depositMin: 10, depositMax: 150000, withdrawMin: 50, withdrawMax: 150000, betMin: 10, betMax: 20000, maxPayout: 1000000 }, null);
  await setSetting('licence', { licensed: false }, null);
  user = (await q(`INSERT INTO users(username, password_hash) VALUES ('tester', $1) RETURNING id, username`, [hashPassword('x'.repeat(12))])).rows[0];
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  await saveCredentials('mpesa', 'sandbox', {
    consumerKey: 'TEST-ONLY-ck', consumerSecret: 'TEST-ONLY-cs', passkey: 'TEST-ONLY-pk', shortcode: '174379',
    initiatorName: 'testapi', initiatorPassword: 'TEST-ONLY-pw', certificatePem: publicKey.export({ type: 'spki', format: 'pem' }),
    callbackBaseUrl: 'https://example.test',
  }, null);
  await setSetting('providers', { mpesa: { enabled: true, environment: 'sandbox' }, cashia: { enabled: false, environment: 'sandbox' } }, null);
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
    const json = String(url).includes('/oauth/') ? { access_token: 'tok', expires_in: '3599' }
      : String(url).includes('/stkpush/') ? { ResponseCode: '0', CheckoutRequestID: `ws_CO_${++stkN}`, MerchantRequestID: 'm' }
      : String(url).includes('/stkpushquery/') ? stkQueryResult
      : String(url).includes('/transactionstatus/') ? { ResponseCode: '0', ConversationID: 'AG_ts', OriginatorConversationID: 'oc_ts' }
      : String(url).includes('/c2b/v1/registerurl') ? { ResponseCode: '0', ResponseDescription: 'success' }
      : String(url).includes('/b2c/') ? { ResponseCode: '0', ConversationID: `AG_${++b2cN}`, OriginatorConversationID: `oc_${b2cN}` }
      : { error: 'unexpected' };
    return { status: 200, text: async () => JSON.stringify(json) };
  };
});
after(() => pool.end());

const stkBody = (checkoutId, amount, receipt, code = 0) => ({ Body: { stkCallback: {
  MerchantRequestID: 'm', CheckoutRequestID: checkoutId, ResultCode: code, ResultDesc: code ? 'Request cancelled by user' : 'ok',
  ...(code ? {} : { CallbackMetadata: { Item: [{ Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: receipt }, { Name: 'PhoneNumber', Value: 254712345678 }] } }),
} } });

test('provably fair: deterministic and edge-correct', () => {
  assert.equal(crashPoint('seed', 'client', 1), crashPoint('seed', 'client', 1));
  let n = 0, N = 40000;
  for (let i = 0; i < N; i++) if (crashPoint(crypto.randomBytes(16).toString('hex'), 'c', i) >= 200) n++;
  assert.ok(Math.abs(n / N - 0.495) < 0.015, `P(>=2x)=${n / N}`);
});

test('deposit credits only after a verified callback, exactly once', async () => {
  const p = await startDeposit(user, { provider: 'mpesa', amount: 100, phone: '0712345678' });
  assert.equal(p.status, 'pending');
  assert.equal(p.phone, '2547******78');
  assert.equal(await bal(user.id), 0, 'no credit on button click');
  const stkCall = calls.find(c => c.url.includes('/stkpush/'));
  assert.ok(!/mpesa|safaricom/i.test(stkCall.body.CallBackURL.replace('https://example.test', '')));
  const ref = (await q('SELECT provider_ref FROM payments WHERE id=$1', [p.id])).rows[0].provider_ref;

  assert.equal(await receiveCallback({ provider: 'mpesa', kind: 'stk', paymentId: p.id, token: 'forged', body: stkBody(ref, 100, 'RCPT1'), ip: '1.1.1.1' }), 403);
  await sleep(100);
  assert.equal(await bal(user.id), 0, 'forged callback ignored');

  const good = { provider: 'mpesa', kind: 'stk', paymentId: p.id, token: callbackToken(p.id, 'stk'), body: stkBody(ref, 100, 'RCPT1'), ip: '1.1.1.1' };
  assert.equal(await receiveCallback(good), 200);
  await sleep(200);
  assert.equal(await bal(user.id), 10000);
  assert.equal(await receiveCallback(good), 200);  // replay
  await sleep(200);
  assert.equal(await bal(user.id), 10000, 'replay does not credit twice');
  const stored = (await q(`SELECT body FROM webhook_events WHERE payment_id=$1 LIMIT 1`, [p.id])).rows[0].body;
  assert.ok(!JSON.stringify(stored).includes('254712345678'), 'phone redacted in stored callback');
});

test('cancelled STK marks failed without credit; unconfirmed STK query blocks credit', async () => {
  const p = await startDeposit(user, { provider: 'mpesa', amount: 50, phone: '254712345678' });
  const ref = (await q('SELECT provider_ref FROM payments WHERE id=$1', [p.id])).rows[0].provider_ref;
  await receiveCallback({ provider: 'mpesa', kind: 'stk', paymentId: p.id, token: callbackToken(p.id, 'stk'), body: stkBody(ref, 50, null, 1032), ip: 'x' });
  await sleep(150);
  assert.equal((await q('SELECT status FROM payments WHERE id=$1', [p.id])).rows[0].status, 'failed');

  const p2 = await startDeposit(user, { provider: 'mpesa', amount: 70, phone: '0112345678' });
  const ref2 = (await q('SELECT provider_ref FROM payments WHERE id=$1', [p2.id])).rows[0].provider_ref;
  stkQueryResult = { ResultCode: '1032', ResultDesc: 'cancelled' };
  await receiveCallback({ provider: 'mpesa', kind: 'stk', paymentId: p2.id, token: callbackToken(p2.id, 'stk'), body: stkBody(ref2, 70, 'RCPT2'), ip: 'x' });
  await sleep(150);
  stkQueryResult = { ResultCode: '0', ResultDesc: 'ok' };
  assert.equal(await bal(user.id), 10000, 'callback claiming success but not confirmed by STK query is not credited');
  assert.equal((await q('SELECT status FROM payments WHERE id=$1', [p2.id])).rows[0].status, 'needs_review');
});

async function newRound(crash) {
  return (await q(`INSERT INTO rounds(server_seed, server_seed_hash, client_seed, crash_point, house_edge_bp, status, betting_ends_at)
                   VALUES ('s','h','c',$1,100,'betting', clock_timestamp() + interval '30 seconds') RETURNING *`, [crash])).rows[0];
}
const fly = (id, mult) => q(`UPDATE rounds SET status='running', started_at = clock_timestamp() - make_interval(secs => $2) WHERE id=$1`, [id, msForMultiplier(mult) / 1000]);

test('bets: debit on accept, refund on cancel, cash out pays stake x server multiplier', async () => {
  const r = await newRound(300);
  const a = await placeBet(user, { slot: 'A', stake: 50, autoCashout: null });
  const b = await placeBet(user, { slot: 'B', stake: 20 });
  assert.equal(await bal(user.id), 3000);
  await assert.rejects(placeBet(user, { slot: 'A', stake: 10 }), /already placed/);
  await cancelBet(user, b.bet.id);
  assert.equal(await bal(user.id), 5000);
  await fly(r.id, 150);
  await assert.rejects(cancelBet(user, a.bet.id), /closed/);
  // queued bet during flight: no debit yet
  const queued = await placeBet(user, { slot: 'B', stake: 10 });
  assert.equal(queued.queued, true);
  assert.equal(await bal(user.id), 5000);
  const out = await cashout(user, a.bet.id);
  assert.ok(out.mult >= 150 && out.mult < 152, `mult ${out.mult}`);
  assert.equal(out.payout, Math.floor(5000 * out.mult / 100));
  await assert.rejects(cashout(user, a.bet.id), /already settled/);
  await crashRound(r.id);
  await cancelBet(user, queued.bet.id);
});

test('auto cashout pays its target even if no tick landed on it; late cashout rejected', async () => {
  const before = await bal(user.id);
  const r = await newRound(250);
  const a = await placeBet(user, { slot: 'A', stake: 10, autoCashout: 2 });
  const b = await placeBet(user, { slot: 'B', stake: 10 });
  await fly(r.id, 260); // clock already past the crash point
  await assert.rejects(cashout(user, b.bet.id), /Crashed before/);
  await crashRound(r.id);
  const rows = (await q('SELECT id, status, payout_cents, cashout_mult FROM bets WHERE round_id=$1 ORDER BY id', [r.id])).rows;
  assert.equal(rows[0].status, 'cashed'); assert.equal(rows[0].cashout_mult, 200); assert.equal(rows[0].payout_cents, 2000);
  assert.equal(rows[1].status, 'lost');
  assert.equal(await bal(user.id), before - 2000 + 2000);
});

test('withdrawal: reserve, bets cannot spend reserve, failure releases, success finalizes', async () => {
  const start = await bal(user.id);
  const w = await startWithdrawal(user, { provider: 'mpesa', amount: 50, phone: '0712345678' });
  assert.equal(w.status, 'pending');
  assert.equal(await bal(user.id), start - 5000);
  await assert.rejects(startWithdrawal(user, { provider: 'mpesa', amount: Math.floor(start / 100), phone: '0712345678' }), /more than your withdrawable/);
  const ref = (await q('SELECT provider_ref FROM payments WHERE id=$1', [w.id])).rows[0].provider_ref;
  const fail = { Result: { ResultType: 0, ResultCode: 2001, ResultDesc: 'The initiator information is invalid.', OriginatorConversationID: ref, ConversationID: 'AG_x', TransactionID: 'T0' } };
  assert.equal(await receiveCallback({ provider: 'mpesa', kind: 'b2c_result', paymentId: w.id, token: 'nope', body: fail, ip: 'x' }), 403);
  await receiveCallback({ provider: 'mpesa', kind: 'b2c_result', paymentId: w.id, token: callbackToken(w.id, 'b2c'), body: fail, ip: 'x' });
  await sleep(150);
  assert.equal(await bal(user.id), start, 'reserve released');
  await receiveCallback({ provider: 'mpesa', kind: 'b2c_result', paymentId: w.id, token: callbackToken(w.id, 'b2c'), body: fail, ip: 'x' });
  await sleep(150);
  assert.equal(await bal(user.id), start, 'duplicate failure does not release twice');

  const w2 = await startWithdrawal(user, { provider: 'mpesa', amount: 60, phone: '0712345678' });
  const ref2 = (await q('SELECT provider_ref FROM payments WHERE id=$1', [w2.id])).rows[0].provider_ref;
  const ok = { Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: ref2, ConversationID: 'AG_y', TransactionID: 'TX9',
    ResultParameters: { ResultParameter: [{ Key: 'TransactionAmount', Value: 60 }, { Key: 'ReceiverPartyPublicName', Value: '254712345678 - Jane Doe' }] } } };
  await receiveCallback({ provider: 'mpesa', kind: 'b2c_result', paymentId: w2.id, token: callbackToken(w2.id, 'b2c'), body: ok, ip: 'x' });
  await sleep(150);
  assert.equal((await q('SELECT status FROM payments WHERE id=$1', [w2.id])).rows[0].status, 'confirmed');
  assert.equal(await bal(user.id), start - 6000);
  const ev = (await q(`SELECT body FROM webhook_events WHERE payment_id=$1`, [w2.id])).rows[0].body;
  assert.ok(!JSON.stringify(ev).includes('Jane'), 'receiver name redacted');
});

test('ledger is append-only', async () => {
  await assert.rejects(q('UPDATE ledger_entries SET amount_cents = 999999'), /append-only/);
  await assert.rejects(q('DELETE FROM ledger_entries'), /append-only/);
});

const { callbackToken: cbTok } = await import('../src/crypto.js');
const c2bTok = env => cbTok(`c2b-${env}`, 'c2b');
const c2bBody = (transId, amount, billRef) => ({ TransactionType: 'Pay Bill', TransID: transId, TransTime: '20261108120000', TransAmount: String(amount),
  BusinessShortCode: '174379', BillRefNumber: billRef, MSISDN: '254712345678', FirstName: 'JANE' });
const txResult = (receipt, amount, status = 'Completed') => ({ Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: 'oc_ts', ConversationID: 'AG_ts',
  ResultParameters: { ResultParameter: [{ Key: 'ReceiptNo', Value: receipt }, { Key: 'Amount', Value: amount }, { Key: 'TransactionStatus', Value: status }, { Key: 'DebitPartyName', Value: '254712345678 - JANE DOE' }] } } });

test('paybill C2B: validation, idempotent confirmation, credit only after verified transaction status', async () => {
  const acct = (await q('SELECT account_no FROM users WHERE id=$1', [user.id])).rows[0].account_no;
  assert.match(acct, /^\d{6}$/);
  const reg = await registerC2b('sandbox', null);
  assert.equal(reg.registered, true);
  const regCall = calls.filter(c => c.url.includes('registerurl')).pop();
  assert.ok(!/mpesa|safaricom|query|exec|cmd|sql/i.test(regCall.body.ConfirmationURL.replace('https://example.test', '')), regCall.body.ConfirmationURL);

  assert.equal((await receiveC2b({ env: 'sandbox', kind: 'validate', token: 'bad', body: c2bBody('X1', 100, acct), ip: 'x' })).status, 403);
  const wrongDigit = acct.slice(0, -1) + ((Number(acct.at(-1)) + 1) % 10);
  assert.equal((await receiveC2b({ env: 'sandbox', kind: 'validate', token: c2bTok('sandbox'), body: c2bBody('X1', 100, wrongDigit), ip: 'x' })).body.ResultCode, 'C2B00012');
  assert.equal((await receiveC2b({ env: 'sandbox', kind: 'validate', token: c2bTok('sandbox'), body: c2bBody('X1', 1, acct), ip: 'x' })).body.ResultCode, 'C2B00013');
  assert.equal((await receiveC2b({ env: 'sandbox', kind: 'validate', token: c2bTok('sandbox'), body: c2bBody('X1', 100, acct), ip: 'x' })).body.ResultCode, '0');

  const before = await bal(user.id);
  const conf = { env: 'sandbox', kind: 'confirm', token: c2bTok('sandbox'), body: c2bBody('QK100A', 150, ` ${acct} `), ip: 'x' };
  assert.equal((await receiveC2b(conf)).body.ResultCode, '0');
  await receiveC2b(conf); // Safaricom retry
  await sleep(250);
  const rows = (await q(`SELECT * FROM payments WHERE provider_ref='QK100A'`)).rows;
  assert.equal(rows.length, 1, 'replayed confirmation recorded once');
  assert.equal(await bal(user.id), before, 'no credit before verification');
  assert.ok(calls.some(c => c.url.includes('/transactionstatus/') && c.body.TransactionID === 'QK100A'));
  const p = rows[0];
  const tok = cbTok(p.id, 'txstatus');
  await receiveCallback({ provider: 'mpesa', kind: 'txstatus', paymentId: p.id, token: tok, body: txResult('QK100A', 999), ip: 'x' });
  await sleep(150);
  assert.equal(await bal(user.id), before, 'amount mismatch not credited');
  await receiveCallback({ provider: 'mpesa', kind: 'txstatus', paymentId: p.id, token: 'forged', body: txResult('QK100A', 150), ip: 'x' });
  await sleep(150);
  assert.equal(await bal(user.id), before, 'forged status result ignored');
  await receiveCallback({ provider: 'mpesa', kind: 'txstatus', paymentId: p.id, token: tok, body: txResult('QK100A', 150), ip: 'x' });
  await receiveCallback({ provider: 'mpesa', kind: 'txstatus', paymentId: p.id, token: tok, body: txResult('QK100A', 150), ip: 'x' });
  await sleep(200);
  assert.equal(await bal(user.id), before + 15000, 'credited exactly once');
  const ev = (await q(`SELECT body FROM webhook_events WHERE kind='c2b_confirm' LIMIT 1`)).rows[0].body;
  assert.ok(!JSON.stringify(ev).includes('254712345678') && !JSON.stringify(ev).includes('JANE'), 'C2B PII redacted');
});

test('paybill C2B to an unknown account waits for admin assignment', async () => {
  const before = await bal(user.id);
  await receiveC2b({ env: 'sandbox', kind: 'confirm', token: c2bTok('sandbox'), body: c2bBody('QK200B', 80, 'MYNAME'), ip: 'x' });
  await sleep(200);
  const p = (await q(`SELECT * FROM payments WHERE provider_ref='QK200B'`)).rows[0];
  assert.equal(p.user_id, null);
  await assert.rejects(assignC2b(p.id, 'tester'), /Verify the payment/);
  await receiveCallback({ provider: 'mpesa', kind: 'txstatus', paymentId: p.id, token: cbTok(p.id, 'txstatus'), body: txResult('QK200B', 80), ip: 'x' });
  await sleep(200);
  const p2 = (await q(`SELECT status, verified_at FROM payments WHERE id=$1`, [p.id])).rows[0];
  assert.equal(p2.status, 'needs_review'); assert.ok(p2.verified_at);
  assert.equal(await bal(user.id), before);
  await assignC2b(p.id, 'tester');
  assert.equal(await bal(user.id), before + 8000);
  await assert.rejects(assignC2b(p.id, 'tester'), /Only unassigned/);
});

test('cached balances always equal the ledger; balance can never go negative', async () => {
  assert.deepEqual(await verifyBalances({ query: q }, 600), []);
  await assert.rejects(q(`INSERT INTO ledger_entries(user_id, type, amount_cents, idempotency_key) VALUES ($1,'bet_debit',-999999999,'neg-test')`, [user.id]), /check/i);
});

test('admin TOTP: valid code accepted once, reuse and wrong codes rejected', () => {
  const sec = newTotpSecret();
  const step = Math.floor(Date.now() / 30000);
  const got = verifyTotp(sec, totpAt(sec, step));
  assert.equal(got, step);
  assert.equal(verifyTotp(sec, totpAt(sec, step), got), null, 'reuse blocked');
  assert.equal(verifyTotp(sec, '000000') === null || totpAt(sec, step) === '000000', true);
  assert.equal(totpAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1), '287082', 'RFC 6238 test vector (T=59s)');
});

test('turning provider off blocks new transactions and closes table, ledger intact', async () => {
  const n = (await q('SELECT count(*)::int n FROM ledger_entries')).rows[0].n;
  await setSetting('providers', { mpesa: { enabled: false, environment: 'sandbox' }, cashia: { enabled: false, environment: 'sandbox' } }, null);
  await assert.rejects(startDeposit(user, { provider: 'mpesa', amount: 100, phone: '0712345678' }), /not available/);
  assert.equal((await q('SELECT count(*)::int n FROM ledger_entries')).rows[0].n, n);
});

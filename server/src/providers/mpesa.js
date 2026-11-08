// Safaricom Daraja (official) — OAuth, STK Push (Lipa na M-Pesa Online), STK Query, B2C.
// Credentials are passed in per call from the decrypted settings; nothing is cached on disk.
import crypto from 'node:crypto';

const BASE = { sandbox: 'https://sandbox.safaricom.co.ke', production: 'https://api.safaricom.co.ke' };

export class ProviderError extends Error {
  constructor(code, message, { definitive = false, detail } = {}) {
    super(message || code); this.code = code; this.definitive = definitive; this.detail = detail;
  }
}

const tokens = new Map(); // `${env}:${sha(consumerKey)}` -> { token, exp }

async function call(url, opts, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
    return { status: res.status, json };
  } catch (e) {
    // Network failure or timeout: outcome unknown (the request may have been processed).
    throw new ProviderError('network', `M-Pesa request failed: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
  } finally { clearTimeout(t); }
}

export async function accessToken(creds, env) {
  const k = `${env}:${crypto.createHash('sha256').update(creds.consumerKey + creds.consumerSecret).digest('hex')}`;
  const hit = tokens.get(k);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const basic = Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString('base64');
  const r = await call(`${BASE[env]}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${basic}` } });
  if (r.status !== 200 || !r.json.access_token) throw new ProviderError('auth_failed', 'M-Pesa OAuth failed — check consumer key/secret and environment.', { definitive: true });
  tokens.set(k, { token: r.json.access_token, exp: Date.now() + Number(r.json.expires_in || 3599) * 1000 });
  return r.json.access_token;
}

// Daraja timestamps are East Africa Time (UTC+3, no DST): YYYYMMDDHHmmss
export function darajaTimestamp(d = new Date()) {
  const e = new Date(d.getTime() + 3 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${e.getUTCFullYear()}${p(e.getUTCMonth() + 1)}${p(e.getUTCDate())}${p(e.getUTCHours())}${p(e.getUTCMinutes())}${p(e.getUTCSeconds())}`;
}
const stkPassword = (shortcode, passkey, ts) => Buffer.from(`${shortcode}${passkey}${ts}`).toString('base64');

/** STK push. amount = whole KES. Returns { checkoutRequestId, merchantRequestId }. */
export async function stkPush(creds, env, { amount, phone, accountRef, callbackUrl }) {
  const token = await accessToken(creds, env);
  const ts = darajaTimestamp();
  const body = {
    BusinessShortCode: creds.shortcode,
    Password: stkPassword(creds.shortcode, creds.passkey, ts),
    Timestamp: ts,
    TransactionType: 'CustomerPayBillOnline',
    Amount: amount,
    PartyA: phone,
    PartyB: creds.shortcode,
    PhoneNumber: phone,
    CallBackURL: callbackUrl,
    AccountReference: accountRef.slice(0, 12),
    TransactionDesc: 'Deposit',
  };
  const r = await call(`${BASE[env]}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (r.status === 200 && String(r.json.ResponseCode) === '0') {
    return { checkoutRequestId: r.json.CheckoutRequestID, merchantRequestId: r.json.MerchantRequestID };
  }
  throw new ProviderError('stk_rejected', r.json.errorMessage || r.json.ResponseDescription || `STK push rejected (HTTP ${r.status})`, { definitive: true });
}

/** STK query: authoritative status of a checkout request. Returns { done, success, resultCode, resultDesc }. */
export async function stkQuery(creds, env, checkoutRequestId) {
  const token = await accessToken(creds, env);
  const ts = darajaTimestamp();
  const r = await call(`${BASE[env]}/mpesa/stkpushquery/v1/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ BusinessShortCode: creds.shortcode, Password: stkPassword(creds.shortcode, creds.passkey, ts), Timestamp: ts, CheckoutRequestID: checkoutRequestId }),
  });
  if (r.status === 200 && r.json.ResultCode !== undefined) {
    const code = String(r.json.ResultCode);
    return { done: true, success: code === '0', resultCode: code, resultDesc: r.json.ResultDesc };
  }
  // e.g. 500.001.1001 "The transaction is being processed" -> not final yet
  return { done: false, success: false, resultCode: r.json.errorCode, resultDesc: r.json.errorMessage };
}

export function securityCredential(certPem, initiatorPassword) {
  return crypto.publicEncrypt({ key: certPem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(initiatorPassword)).toString('base64');
}

/** B2C payout. amount = whole KES. Returns { conversationId, originatorConversationId }. */
export async function b2c(creds, env, { amount, phone, resultUrl, timeoutUrl, remarks }) {
  const token = await accessToken(creds, env);
  const body = {
    InitiatorName: creds.initiatorName,
    SecurityCredential: securityCredential(creds.certificatePem, creds.initiatorPassword),
    CommandID: 'BusinessPayment',
    Amount: amount,
    PartyA: creds.b2cShortcode || creds.shortcode, // the paybill, unless Safaricom issued a separate B2C shortcode
    PartyB: phone,
    Remarks: (remarks || 'Withdrawal').slice(0, 100),
    QueueTimeOutURL: timeoutUrl,
    ResultURL: resultUrl,
    Occasion: 'Withdrawal',
  };
  const r = await call(`${BASE[env]}/mpesa/b2c/v1/paymentrequest`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (r.status === 200 && String(r.json.ResponseCode) === '0') {
    return { conversationId: r.json.ConversationID, originatorConversationId: r.json.OriginatorConversationID };
  }
  // A non-zero ResponseCode is a synchronous rejection: Safaricom did not accept the payout.
  if (r.status >= 400 && r.status < 500 || (r.json.ResponseCode && String(r.json.ResponseCode) !== '0')) {
    throw new ProviderError('b2c_rejected', r.json.errorMessage || r.json.ResponseDescription || `B2C rejected (HTTP ${r.status})`, { definitive: true });
  }
  throw new ProviderError('b2c_unknown', `B2C returned HTTP ${r.status}`);
}

/**
 * C2B: register the paybill's Confirmation and Validation URLs (official /mpesa/c2b/v1/registerurl).
 * responseType 'Completed' = if our validation URL is unreachable, Safaricom completes the payment anyway
 * (safer for customers; unmatched payments land in admin for assignment).
 * Note: in production Safaricom lets you register once per shortcode; changing URLs later is done through them.
 */
export async function c2bRegister(creds, env, { confirmationUrl, validationUrl, responseType = 'Completed' }) {
  const token = await accessToken(creds, env);
  const r = await call(`${BASE[env]}/mpesa/c2b/v1/registerurl`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ShortCode: creds.shortcode, ResponseType: responseType, ConfirmationURL: confirmationUrl, ValidationURL: validationUrl }),
  });
  const ok = r.status === 200 && (String(r.json.ResponseCode) === '0' || /success/i.test(r.json.ResponseDescription || ''));
  if (!ok) throw new ProviderError('c2b_register_failed', r.json.errorMessage || r.json.ResponseDescription || `C2B register failed (HTTP ${r.status})`, { definitive: true });
  return r.json;
}

/**
 * Transaction Status query (official /mpesa/transactionstatus/v1/query). Asynchronous: Safaricom posts the
 * authoritative result to resultUrl. Used to independently verify every paybill (C2B) payment before credit.
 */
export async function transactionStatus(creds, env, { transactionId, resultUrl, timeoutUrl }) {
  const token = await accessToken(creds, env);
  const body = {
    Initiator: creds.initiatorName,
    SecurityCredential: securityCredential(creds.certificatePem, creds.initiatorPassword),
    CommandID: 'TransactionStatusQuery',
    TransactionID: transactionId,
    PartyA: creds.shortcode,
    IdentifierType: '4',
    ResultURL: resultUrl,
    QueueTimeOutURL: timeoutUrl,
    Remarks: 'Deposit verification',
    Occasion: 'Deposit',
  };
  const r = await call(`${BASE[env]}/mpesa/transactionstatus/v1/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (r.status === 200 && String(r.json.ResponseCode) === '0') return { conversationId: r.json.ConversationID, originatorConversationId: r.json.OriginatorConversationID };
  throw new ProviderError('txstatus_rejected', r.json.errorMessage || r.json.ResponseDescription || `Transaction status query failed (HTTP ${r.status})`);
}

// --- Callback parsing (Daraja does not sign callbacks; authenticity comes from the per-payment URL token,
//     optional source-IP allowlist, cross-checked references, and an STK Query for deposits). ---

export function parseStkCallback(body) {
  const cb = body?.Body?.stkCallback;
  if (!cb) return null;
  const items = Object.fromEntries((cb.CallbackMetadata?.Item || []).map(i => [i.Name, i.Value]));
  return {
    merchantRequestId: cb.MerchantRequestID, checkoutRequestId: cb.CheckoutRequestID,
    resultCode: String(cb.ResultCode), resultDesc: cb.ResultDesc,
    amount: items.Amount != null ? Number(items.Amount) : null, receipt: items.MpesaReceiptNumber || null,
  };
}

export function parseB2cResult(body) {
  const r = body?.Result;
  if (!r) return null;
  return {
    resultCode: String(r.ResultCode), resultDesc: r.ResultDesc,
    conversationId: r.ConversationID, originatorConversationId: r.OriginatorConversationID, transactionId: r.TransactionID,
    amount: Number((r.ResultParameters?.ResultParameter || []).find(p => p.Key === 'TransactionAmount')?.Value ?? NaN),
  };
}

/** C2B Validation / Confirmation body (paybill payment made from the customer's phone). */
export function parseC2b(body) {
  if (!body?.TransID) return null;
  return {
    transId: String(body.TransID), transType: body.TransactionType, shortcode: String(body.BusinessShortCode ?? ''),
    amount: Number(body.TransAmount), billRef: String(body.BillRefNumber ?? '').trim(), msisdn: String(body.MSISDN ?? ''),
    time: body.TransTime,
  };
}

/** Transaction Status result. */
export function parseTxStatus(body) {
  const r = body?.Result;
  if (!r) return null;
  const p = Object.fromEntries((r.ResultParameters?.ResultParameter || []).map(x => [x.Key, x.Value]));
  return {
    resultCode: String(r.ResultCode), resultDesc: r.ResultDesc,
    receipt: p.ReceiptNo != null ? String(p.ReceiptNo) : null, status: p.TransactionStatus ?? null,
    amount: p.Amount != null ? Number(p.Amount) : null,
  };
}

/** Redact MSISDNs and names before storing a callback body. */
export function redact(body) {
  const SENSITIVE = /^(PhoneNumber|PartyA|PartyB|MSISDN|ReceiverPartyPublicName|DebitPartyName|CreditPartyName|FirstName|MiddleName|LastName)$/i;
  return JSON.parse(JSON.stringify(body ?? {}, function (k, v) {
    if (SENSITIVE.test(k)) return '[redacted]';
    // Daraja metadata is [{Name|Key, Value}] — redact Value when the Name/Key is sensitive.
    if (k === 'Value' && (SENSITIVE.test(this?.Name || '') || SENSITIVE.test(this?.Key || ''))) return '[redacted]';
    return v;
  }));
}

// Cashia Payment Gateway — only the endpoints in Cashia's published Merchant API Documentation (v1.0.9):
//   POST /v1/hosted-checkout          create a hosted checkout session
//   GET  /v1/transactions/:id         authoritative transaction status
// Auth: X-Cashia-Key-ID / Nonce / Timestamp / Hash / Signature (HMAC-SHA256, hex), per that document.
//
// NOT implemented, on purpose: payouts. Cashia's public documentation names "Payout to M-Pesa phone number"
// in its version history but does not publish the endpoint, fields, or result callback. Per the build rules
// ("do not invent endpoints"), cashiaPayout() refuses until the spec from Cashia is added here.
import crypto from 'node:crypto';
import { ProviderError } from './mpesa.js';

const hmacHex = (secret, s) => crypto.createHmac('sha256', secret).update(s).digest('hex');

async function signed(creds, method, path, bodyObj) {
  const url = `${creds.apiBaseUrl}${path}`;
  const host = new URL(url).host;
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const headers = {
    'Content-Type': 'application/json',
    'X-Cashia-Key-ID': creds.apiKey,
    'X-Cashia-Timestamp': timestamp,
    'X-Cashia-Nonce': nonce,
    'X-Cashia-Hash': hmacHex(creds.apiSecret, body),
    'X-Cashia-Signature': hmacHex(creds.apiSecret, `${host}${method}${timestamp}${nonce}${creds.apiKey}`),
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { method, headers, body: bodyObj ? body : undefined, signal: ctrl.signal });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
    return { status: res.status, json };
  } catch (e) {
    throw new ProviderError('network', `Cashia request failed: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
  } finally { clearTimeout(t); }
}

/** Returns { sessionId, url, requestId }. amount in whole KES. */
export async function createHostedCheckout(creds, { requestId, amount, webhookUrl, successRedirectUrl, errorRedirectUrl }) {
  const r = await signed(creds, 'POST', '/v1/hosted-checkout', {
    requestId, currency: 'KES', amount, webhookUrl, successRedirectUrl, errorRedirectUrl,
    orderDetails: [{ name: 'Wallet deposit', currency: 'KES', quantity: 1, description: 'Account top-up', price: amount }],
    deliveryDetails: { currency: 'KES', fee: 0 },
  });
  if (r.status >= 200 && r.status < 300 && r.json.url) return { sessionId: r.json.sessionId, url: r.json.url, requestId: r.json.requestId };
  throw new ProviderError('checkout_rejected', r.json.error || `Cashia checkout failed (HTTP ${r.status})`, { definitive: r.status >= 400 && r.status < 500 });
}

export async function getTransaction(creds, transactionId) {
  const r = await signed(creds, 'GET', `/v1/transactions/${encodeURIComponent(transactionId)}`);
  if (r.status === 200) return r.json.process || r.json;
  throw new ProviderError('lookup_failed', r.json.error || `Cashia transaction lookup failed (HTTP ${r.status})`);
}

// Cashia's published doc shows `status`/`requestStatus` fields but not their full value set.
// CONFIRM AGAINST CASHIA SWAGGER (swagger.cashia.com) BEFORE PRODUCTION and adjust if needed.
export const CASHIA_PAID_STATUSES = new Set(['completed', 'success', 'successful', 'paid']);

export function isPaid(txn) {
  const s = String(txn?.status ?? '').toLowerCase();
  const rs = String(txn?.requestStatus ?? '').toLowerCase();
  return CASHIA_PAID_STATUSES.has(s) && (!rs || CASHIA_PAID_STATUSES.has(rs));
}

/** Pull a transaction id out of a Cashia callback body (field naming is not published; we try the documented shapes). */
export function transactionIdFrom(body) {
  return body?.transactionId || body?.process?.id || body?.data?.transactionId || body?.data?.id || body?.id || null;
}

export async function cashiaPayout() {
  throw new ProviderError('cashia_payout_unavailable',
    'Cashia withdrawals are not available: Cashia has not published its payout API. Use M-Pesa for withdrawals.', { definitive: true });
}
export const CASHIA_PAYOUTS_SUPPORTED = false;

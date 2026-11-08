import { q } from './db.js';
import { encrypt, decrypt } from './crypto.js';

// Field definitions. `secret: true` fields are write-only: never returned to any client.
export const PROVIDER_FIELDS = {
  mpesa: [
    { name: 'consumerKey', label: 'Consumer key', secret: true, required: true },
    { name: 'consumerSecret', label: 'Consumer secret', secret: true, required: true },
    { name: 'passkey', label: 'STK passkey (Lipa na M-Pesa Online)', secret: true, required: true },
    { name: 'shortcode', label: 'Paybill number (used for STK, C2B and B2C)', secret: false, required: true },
    { name: 'initiatorName', label: 'API initiator name (B2C + transaction status)', secret: false, required: true },
    { name: 'initiatorPassword', label: 'API initiator password', secret: true, required: true },
    { name: 'b2cShortcode', label: 'B2C shortcode — leave blank to pay out from the paybill', secret: false, required: false },
    { name: 'certificatePem', label: 'Safaricom public certificate (PEM) for SecurityCredential', secret: false, required: true, multiline: true },
    { name: 'callbackBaseUrl', label: 'Callback base URL (https://your-domain)', secret: false, required: true },
  ],
  cashia: [
    { name: 'merchantId', label: 'Merchant ID', secret: false, required: true },
    { name: 'apiKey', label: 'API key (Key ID)', secret: true, required: true },
    { name: 'apiSecret', label: 'API secret', secret: true, required: true },
    { name: 'webhookSecret', label: 'Webhook secret', secret: true, required: true },
    { name: 'apiBaseUrl', label: 'API base URL (from Cashia for this environment)', secret: false, required: true },
    { name: 'callbackBaseUrl', label: 'Callback base URL (https://your-domain)', secret: false, required: true },
  ],
};

export async function getSetting(key, c = { query: q }) {
  const r = await c.query('SELECT value FROM settings WHERE key = $1', [key]);
  return r.rows[0]?.value ?? null;
}

export async function setSetting(key, value, actorId, c = { query: q }) {
  await c.query(
    `INSERT INTO settings(key, value, updated_at, updated_by) VALUES ($1,$2,now(),$3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), actorId]);
}

const last4 = v => (v ? '••••' + String(v).slice(-4) : null);

/** Admin view: masks only. Secrets are never returned. */
export async function credentialSummary() {
  const r = await q('SELECT provider, environment, masks, updated_at FROM provider_credentials');
  return r.rows;
}

/**
 * Save credentials for (provider, environment). Any field submitted non-empty overwrites the stored value;
 * blank fields keep the existing value. Stores ciphertext + last-four masks.
 */
export async function saveCredentials(provider, environment, input, actorId) {
  const defs = PROVIDER_FIELDS[provider];
  if (!defs) throw new Error('unknown provider');
  if (!['sandbox', 'production'].includes(environment)) throw new Error('bad environment');
  const existing = await loadCredentials(provider, environment).catch(() => null) || {};
  const next = { ...existing };
  for (const f of defs) {
    const v = input?.[f.name];
    if (typeof v === 'string' && v.trim() !== '') next[f.name] = f.multiline ? v.trim() : v.trim();
  }
  for (const f of ['callbackBaseUrl', 'apiBaseUrl']) {
    if (next[f] && !/^https:\/\//.test(next[f]) && environment === 'production') throw new Error(`${f} must be https in production`);
    if (next[f]) next[f] = next[f].replace(/\/+$/, '');
  }
  const masks = {};
  for (const f of defs) {
    if (next[f.name] == null) continue;
    masks[f.name] = f.secret ? last4(next[f.name]) : (f.multiline ? `PEM (${next[f.name].length} chars)` : next[f.name]);
  }
  await q(
    `INSERT INTO provider_credentials(provider, environment, fields_enc, masks, updated_at, updated_by)
     VALUES ($1,$2,$3,$4,now(),$5)
     ON CONFLICT (provider, environment) DO UPDATE SET fields_enc = EXCLUDED.fields_enc, masks = EXCLUDED.masks,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [provider, environment, encrypt(JSON.stringify(next)), masks, actorId]);
  return masks;
}

/** Server-internal only: decrypted credentials, used inside the process that calls the provider. */
export async function loadCredentials(provider, environment) {
  const r = await q('SELECT fields_enc FROM provider_credentials WHERE provider = $1 AND environment = $2', [provider, environment]);
  if (!r.rowCount) return null;
  return JSON.parse(decrypt(r.rows[0].fields_enc));
}

export function missingFields(provider, creds) {
  return PROVIDER_FIELDS[provider].filter(f => f.required && !creds?.[f.name]).map(f => f.name);
}

/** Provider is usable for new transactions: enabled, credentials complete, and production gated on licence. */
export async function activeProviders() {
  const [prov, lic] = await Promise.all([getSetting('providers'), getSetting('licence')]);
  const out = {};
  for (const p of ['mpesa', 'cashia']) {
    const s = prov?.[p];
    if (!s?.enabled) continue;
    if (s.environment === 'production' && !lic?.licensed) continue;
    const creds = await loadCredentials(p, s.environment);
    if (!creds || missingFields(p, creds).length) continue;
    out[p] = { environment: s.environment, creds };
  }
  return out;
}

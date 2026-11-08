import crypto from 'node:crypto';
import { config } from './config.js';

// AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url).
export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', config.encryptionKey, iv);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(blob) {
  const [v, iv, tag, ct] = String(blob).split('.');
  if (v !== 'v1') throw new Error('unknown ciphertext version');
  const d = crypto.createDecipheriv('aes-256-gcm', config.encryptionKey, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256hex = s => crypto.createHash('sha256').update(s).digest('hex');
export const hmacHex = (key, s) => crypto.createHmac('sha256', key).update(s).digest('hex');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Password hashing with scrypt (memory-hard, built in).
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(pw, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64url')}$${dk.toString('base64url')}`;
}
export function verifyPassword(pw, stored) {
  const [alg, salt, dk] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64url'), 32, SCRYPT);
  return crypto.timingSafeEqual(got, Buffer.from(dk, 'base64url'));
}

// Per-payment callback token: lets us authenticate provider callbacks that are not themselves signed
// (Daraja does not sign STK/B2C callbacks). Key is derived from the master key, so it never leaves the server.
const callbackKey = () => crypto.createHmac('sha256', config.encryptionKey).update('callback-token-v1').digest();
export const callbackToken = (paymentId, purpose) => hmacHex(callbackKey(), `${purpose}:${paymentId}`).slice(0, 40);

// ---- TOTP (RFC 6238, SHA-1, 30 s, 6 digits) for admin two-factor.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret() {
  const bytes = crypto.randomBytes(20);
  let bits = '', out = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
function b32decode(s) {
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(ch); if (v < 0) throw new Error('bad base32'); bits += v.toString(2).padStart(5, '0'); }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export function totpAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}
/** Returns the matched time step (to store and block reuse), or null. Accepts +/-1 step of clock drift. */
export function verifyTotp(secret, code, lastStep = null) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const now = Math.floor(Date.now() / 30000);
  for (const step of [now - 1, now, now + 1]) {
    if (lastStep != null && step <= lastStep) continue;
    if (safeEqual(totpAt(secret, step), code)) return step;
  }
  return null;
}

// ---- WebSocket tickets: lets a browser on the site domain open an authenticated socket to the API domain
// (cookies don't travel cross-site). Stateless HMAC, valid 60 s: `${userId}.${expiry}.${mac}`.
const wsKey = () => crypto.createHmac('sha256', config.encryptionKey).update('ws-ticket-v1').digest();
export function issueWsTicket(userId) {
  const exp = Math.floor(Date.now() / 1000) + 60;
  return `${userId}.${exp}.${hmacHex(wsKey(), `${userId}.${exp}`)}`;
}
export function readWsTicket(t) {
  const [uid, exp, mac] = String(t || '').split('.');
  if (!uid || !exp || !mac || Number(exp) < Date.now() / 1000) return null;
  return safeEqual(mac, hmacHex(wsKey(), `${uid}.${exp}`)) ? Number(uid) : null;
}

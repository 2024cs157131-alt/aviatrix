import { parse as parseCookie, serialize } from 'cookie';
import { q } from './db.js';
import { config } from './config.js';
import { randomToken, sha256hex, safeEqual, hashPassword, verifyPassword } from './crypto.js';

const COOKIE = { player: 'sid', admin: 'asid' };
const TTL_H = { player: 24 * 7, admin: 8 };
const secure = config.isProd || config.publicOrigin.startsWith('https://');
const cookieName = n => (secure ? `__Host-${n}` : n);  // __Host- requires Secure, Path=/, no Domain

export function cookies(req) {
  return req._cookies || (req._cookies = parseCookie(req.headers.cookie || ''));
}

export async function createSession(res, userId, kind) {
  const token = randomToken();
  await q(`INSERT INTO sessions(token_hash, user_id, kind, expires_at) VALUES ($1,$2,$3, now() + make_interval(hours => $4))`,
    [sha256hex(token), userId, kind, TTL_H[kind]]);
  res.append('Set-Cookie', serialize(cookieName(COOKIE[kind]), token, {
    httpOnly: true, secure, sameSite: kind === 'admin' ? 'strict' : 'lax', path: '/', maxAge: TTL_H[kind] * 3600,
  }));
}

export async function destroySession(req, res, kind) {
  const t = cookies(req)[cookieName(COOKIE[kind])];
  if (t) await q('DELETE FROM sessions WHERE token_hash = $1', [sha256hex(t)]);
  res.append('Set-Cookie', serialize(cookieName(COOKIE[kind]), '', { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 0 }));
}

export async function sessionUser(req, kind) {
  const t = cookies(req)[cookieName(COOKIE[kind])];
  if (!t) return null;
  const r = await q(
    `SELECT u.id, u.username, u.role, u.disabled FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.kind = $2 AND s.expires_at > now()`, [sha256hex(t), kind]);
  const u = r.rows[0];
  if (!u || u.disabled) return null;
  if (kind === 'admin' && u.role !== 'admin') return null;
  return u;
}

export function requirePlayer() {
  return async (req, res, next) => {
    try {
      const u = await sessionUser(req, 'player');
      if (!u) return res.status(401).json({ error: 'auth_required', message: 'Sign in first.' });
      req.user = u; next();
    } catch (e) { next(e); }
  };
}

/** Checked on every admin request: valid admin session AND role = admin in the DB right now. */
export function requireAdmin() {
  return async (req, res, next) => {
    try {
      const u = await sessionUser(req, 'admin');
      if (!u) return res.status(401).json({ error: 'admin_required' });
      req.admin = u; next();
    } catch (e) { next(e); }
  };
}

// CSRF: double-submit token (cookie readable by our JS, must be echoed in X-CSRF-Token) + Origin check.
const CSRF_COOKIE = cookieName('csrf');
export function issueCsrf(req, res) {
  let t = cookies(req)[CSRF_COOKIE];
  if (!t) {
    t = randomToken(24);
    res.append('Set-Cookie', serialize(CSRF_COOKIE, t, { httpOnly: false, secure, sameSite: 'strict', path: '/' }));
  }
  return t;
}

export function csrfProtect() {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && origin !== config.publicOrigin) return res.status(403).json({ error: 'bad_origin' });
    const c = cookies(req)[CSRF_COOKIE];
    const h = req.headers['x-csrf-token'];
    if (!c || !h || !safeEqual(c, h)) return res.status(403).json({ error: 'csrf' });
    next();
  };
}

export { hashPassword, verifyPassword };
export const getCookieName = cookieName;
export const COOKIES = COOKIE;

import crypto from 'node:crypto';
// Process configuration comes only from the host's environment / secret store.
// No provider keys live here: those are entered by the admin and stored encrypted in the DB.
function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  isProd,
  port: Number(process.env.PORT || 3000),
  databaseUrl: required('DATABASE_URL'),
  databaseDirectUrl: process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL,
  poolMax: Number(process.env.PG_POOL_MAX || 20),
  // TLS to the database. DATABASE_SSL_CA = the provider's CA certificate (PEM) for providers that sign with
  // their own CA (Supabase, Aiven), so the connection is verified instead of trusting any certificate.
  databaseSsl: process.env.DATABASE_SSL === 'true' || process.env.DATABASE_SSL_CA
    ? { rejectUnauthorized: process.env.DATABASE_SSL_INSECURE !== 'true', ...(process.env.DATABASE_SSL_CA ? { ca: process.env.DATABASE_SSL_CA.replace(/\\n/g, '\n') } : {}) }
    : undefined,
  // 32-byte key, base64. Used to encrypt provider secrets and phone numbers at rest.
  // Either 32 random bytes in base64 (44 chars ending in '='), or any random password of 40+ characters
  // (e.g. from a password manager), which is turned into a 32-byte key with SHA-256.
  get encryptionKey() {
    const raw = required('SETTINGS_ENCRYPTION_KEY').trim();
    if (/^[A-Za-z0-9+/]{43}=$/.test(raw)) return Buffer.from(raw, 'base64');
    if (raw.length >= 40) return crypto.createHash('sha256').update(raw, 'utf8').digest();
    throw new Error('SETTINGS_ENCRYPTION_KEY must be a random password of at least 40 characters (or 32 bytes base64)');
  },
  // Public HTTPS origin, e.g. https://play.example.com — used for CSRF Origin checks and redirect URLs.
  publicOrigin: process.env.PUBLIC_ORIGIN || (isProd ? required('PUBLIC_ORIGIN') : 'http://localhost:5173'),
  trustProxy: process.env.TRUST_PROXY ?? '1',
  // Split deploy (static site on Vercel/CDN, API elsewhere): the browser connects its WebSocket straight to
  // the backend, e.g. wss://api.example.co.ke/ws. Leave empty when site and API share one domain.
  publicWsUrl: process.env.PUBLIC_WS_URL || null,
};

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
  databaseSsl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: process.env.DATABASE_SSL_INSECURE !== 'true' } : undefined,
  // 32-byte key, base64. Used to encrypt provider secrets and phone numbers at rest.
  get encryptionKey() {
    const key = Buffer.from(required('SETTINGS_ENCRYPTION_KEY'), 'base64');
    if (key.length !== 32) throw new Error('SETTINGS_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
    return key;
  },
  // Public HTTPS origin, e.g. https://play.example.com — used for CSRF Origin checks and redirect URLs.
  publicOrigin: process.env.PUBLIC_ORIGIN || (isProd ? required('PUBLIC_ORIGIN') : 'http://localhost:5173'),
  trustProxy: process.env.TRUST_PROXY ?? '1',
};

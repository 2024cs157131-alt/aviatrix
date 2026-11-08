import pg from 'pg';
import { config } from './config.js';

// BIGINT -> JS number. All money values are cents well within 2^53.
pg.types.setTypeParser(20, v => Number(v));

// Pooled connection (can point at PgBouncer / Neon pooler / Supabase pooler in transaction mode).
export const pool = new pg.Pool({
  connectionString: config.databaseUrl, ssl: config.databaseSsl, max: config.poolMax,
  idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, statement_timeout: 15000,
});
pool.on('error', () => {}); // idle-client errors are retried by the next checkout

// Direct (session) connection for LISTEN/NOTIFY, advisory locks and migrations — these break through
// a transaction-mode pooler. Falls back to DATABASE_URL when no separate direct URL is configured.
export const directClient = () => new pg.Client({ connectionString: config.databaseDirectUrl, ssl: config.databaseSsl });

export const q = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function notify(channel, payload) {
  await pool.query('SELECT pg_notify($1, $2)', [channel, JSON.stringify(payload)]);
}

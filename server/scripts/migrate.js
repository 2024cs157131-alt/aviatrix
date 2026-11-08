// Applies server/migrations/*.sql in order, once each, inside a transaction, under an advisory lock
// so concurrent deploys can't race.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../src/config.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const client = new pg.Client({ connectionString: config.databaseDirectUrl, ssl: config.databaseSsl });
await client.connect();
try {
  await client.query('SELECT pg_advisory_lock(727001)');
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
      await client.query('COMMIT');
      console.log('applied', f);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  }
  console.log('migrations up to date');
} finally {
  await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
  await client.end();
}

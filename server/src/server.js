import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { csrfProtect } from './auth.js';
import api from './routes/api.js';
import admin from './routes/admin.js';
import hooks from './routes/hooks.js';
import { attachRealtime } from './realtime.js';
import { log } from './log.js';
import { pool } from './db.js';

void config.encryptionKey; // fail fast if the key is missing or malformed

// Hosts without a release step (e.g. Render free): apply migrations at boot. Safe with several instances —
// the migrator holds an advisory lock and skips already-applied files.
if (process.env.MIGRATE_ON_START === 'true') await import('../scripts/migrate.js');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);

app.get('/healthz', async (req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); });

// HTTPS only in production.
app.use((req, res, next) => {
  if (config.isProd && !req.secure) return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  next();
});

app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss: ws:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  next();
});

// Provider callbacks: public POST routes, verified inside. Mounted before CSRF.
app.use('/api/hooks', express.json({ limit: '64kb' }), hooks);

app.use('/api', express.json({ limit: '32kb' }), csrfProtect());
app.use('/api/admin', admin);
app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

// Static client
const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
if (fs.existsSync(clientDir)) {
  app.use(express.static(clientDir, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api|\/ws).*/, (req, res) => res.sendFile(path.join(clientDir, 'index.html')));
}

app.use((err, req, res, next) => {
  log.error('unhandled', { err, path: req.path });
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'server_error', message: 'Something went wrong.' });
});

const server = http.createServer(app);
attachRealtime(server);
server.listen(config.port, () => log.info('web listening', { port: config.port }));

// Single-service hosting: run the round engine + housekeeping in this process instead of a separate worker.
const bg = new AbortController();
if (process.env.RUN_ENGINE_IN_WEB === 'true') {
  const { startBackground } = await import('./background.js');
  startBackground({ signal: bg.signal }).catch(e => log.error('engine stopped', { err: e }));
  log.info('round engine running inside web process');
}

const stop = () => { bg.abort(); server.close(() => pool.end().then(() => process.exit(0))); setTimeout(() => process.exit(0), 5000).unref(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

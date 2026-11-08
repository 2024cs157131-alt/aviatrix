// WebSocket fan-out. Every web instance LISTENs on Postgres channels written by the engine and by other
// instances, and relays to its own sockets. Sockets are read-only: all actions go through the HTTPS API.
import { WebSocketServer } from 'ws';
import pg from 'pg';
import { config } from './config.js';
import { q } from './db.js';
import { sessionUser } from './auth.js';
import { publicRoundEvent } from './engine.js';
import { log } from './log.js';

export function attachRealtime(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const byUser = new Map(); // userId -> Set<ws>
  let state = null;         // last round event
  let lastTick = null;

  server.on('upgrade', async (req, socket, head) => {
    if (!req.url.startsWith('/ws')) return socket.destroy();
    const origin = req.headers.origin;
    if (config.isProd && origin !== config.publicOrigin) return socket.destroy();
    const user = await sessionUser(req, 'player').catch(() => null);
    wss.handleUpgrade(req, socket, head, ws => { ws.userId = user?.id ?? null; wss.emit('connection', ws); });
  });

  wss.on('connection', async ws => {
    if (ws.userId) { if (!byUser.has(ws.userId)) byUser.set(ws.userId, new Set()); byUser.get(ws.userId).add(ws); }
    ws.on('close', () => byUser.get(ws.userId)?.delete(ws));
    ws.on('message', () => {}); // ignore; no actions over WS
    ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
    try {
      const snap = await snapshot();
      ws.send(JSON.stringify({ t: 'snapshot', ...snap, tick: lastTick && snap.round?.roundId === lastTick.roundId ? lastTick : null, serverNow: Date.now() }));
    } catch (e) { log.error('snapshot', { err: e }); }
  });

  // Slow or stalled clients are skipped instead of buffering unbounded memory on the server.
  const MAX_BUFFER = 512 * 1024;
  const broadcast = msg => {
    const s = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === 1 && c.bufferedAmount < MAX_BUFFER) c.send(s);
  };

  // Room feed batching: with thousands of bets per round, one message per bet per socket is O(bets x sockets).
  // Instead, each instance flushes at most one 'feed' message every 250 ms with the latest events (capped).
  let pending = [];
  let dropped = 0;
  setInterval(() => {
    if (!pending.length) return;
    const items = pending.slice(-60);
    dropped += pending.length - items.length;
    pending = [];
    broadcast({ t: 'feed', items, dropped });
    dropped = 0;
  }, 250).unref();

  async function snapshot() {
    const cur = (await q(`SELECT * FROM rounds ORDER BY id DESC LIMIT 1`)).rows[0];
    const round = cur ? publicRoundEvent(cur, cur.status) : null;
    const history = (await q(`SELECT id, crash_point FROM rounds WHERE status='crashed' ORDER BY id DESC LIMIT 30`)).rows
      .map(x => ({ roundId: Number(x.id), crash: x.crash_point }));
    const feed = cur ? (await q(
      `SELECT b.slot, b.stake_cents, b.status, b.cashout_mult, b.payout_cents, u.username FROM bets b JOIN users u ON u.id=b.user_id
        WHERE b.round_id=$1 AND b.status IN ('active','cashed','lost') ORDER BY b.id DESC LIMIT 100`, [cur.id])).rows
      .map(b => ({ user: b.username.length <= 3 ? b.username[0] + '**' : b.username.slice(0, 2) + '***' + b.username.slice(-1),
        slot: b.slot, stake: Number(b.stake_cents), status: b.status, mult: b.cashout_mult, payout: b.payout_cents == null ? null : Number(b.payout_cents) })) : [];
    return { round, history, feed };
  }

  // Dedicated LISTEN connection with reconnect.
  async function listen() {
    const c = new pg.Client({ connectionString: config.databaseDirectUrl, ssl: config.databaseSsl });
    c.on('error', e => { log.error('listen client error', { err: e }); setTimeout(listen, 2000); });
    c.on('notification', n => {
      let p; try { p = JSON.parse(n.payload); } catch { return; }
      if (n.channel === 'tick') { lastTick = p; broadcast({ t: 'tick', ...p, serverNow: Date.now() }); }
      else if (n.channel === 'room') {
        if (['betting', 'running', 'crashed'].includes(p.t)) {
          state = p; if (p.t !== 'running') lastTick = null;
          if (p.t === 'betting') pending = [];
          broadcast(p);
        } else pending.push(p); // bet / cashout / cancel
      } else if (n.channel === 'user') {
        const set = byUser.get(p.userId);
        if (set) { const s = JSON.stringify({ t: 'me', kind: p.t, paymentId: p.paymentId, betId: p.betId }); for (const w of set) if (w.readyState === 1) w.send(s); }
      }
    });
    try {
      await c.connect();
      await c.query('LISTEN tick'); await c.query('LISTEN room'); await c.query('LISTEN "user"');
    } catch (e) { log.error('listen connect failed', { err: e }); setTimeout(listen, 2000); }
  }
  listen();

  const hb = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
  }, 30000);
  wss.on('close', () => clearInterval(hb));
  return wss;
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, kes, mult } from './api.js';
import { connect } from './ws.js';
import Graph from './components/Graph.jsx';
import BetPanel from './components/BetPanel.jsx';
import Cashier from './components/Cashier.jsx';
import AuthModal from './components/AuthModal.jsx';
import AgeGate from './components/AgeGate.jsx';
import RoundInfo from './components/RoundInfo.jsx';

// Room feed reducer: one event at a time (events arrive batched from the server).
function applyRoom(f, m) {
  if (m.t === 'bet') return [{ user: m.user, slot: m.slot, stake: m.stake, status: 'active' }, ...f];
  const i = f.findIndex(x => x.user === m.user && x.slot === m.slot && x.status === 'active');
  if (m.t === 'cancel') return i < 0 ? f : f.filter((_, j) => j !== i);
  if (m.t === 'cashout') {
    const row = { user: m.user, slot: m.slot, stake: i >= 0 ? f[i].stake : null, status: 'cashed', mult: m.mult, payout: m.payout };
    return i >= 0 ? f.map((x, j) => (j === i ? row : x)) : [row, ...f];
  }
  return f;
}

export default function App() {
  const [config, setConfig] = useState(null);
  const [me, setMe] = useState({ user: null });
  const [round, setRound] = useState(null);
  const [ticks, setTicks] = useState([]);
  const [history, setHistory] = useState([]);
  const [feed, setFeed] = useState([]);
  const [myBets, setMyBets] = useState([]);
  const [live, setLive] = useState(false);
  const [modal, setModal] = useState(null); // 'auth' | 'cashier' | {round}
  const [offset, setOffset] = useState(0);
  const [toast, setToast] = useState(null);
  const [ready, setReady] = useState(false);
  const wsRef = useRef(null);
  const refreshTimer = useRef(null);

  const notify = useCallback((msg, kind = 'info') => { setToast({ msg, kind, at: Date.now() }); }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); }, [toast]);

  const loadMe = useCallback(async () => {
    const m = await api('/me').catch(() => ({ user: null }));
    setMe(m);
    if (m.user) setMyBets(await api('/bets/mine').catch(() => []));
    else setMyBets([]);
  }, []);
  const refreshSoon = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(loadMe, 120);
  }, [loadMe]);

  useEffect(() => {
    api('/config').then(setConfig).catch(() => {});
    loadMe().finally(() => setReady(true));
    const id = setInterval(() => api('/config').then(setConfig).catch(() => {}), 30000);
    return () => clearInterval(id);
  }, [loadMe]);

  useEffect(() => {
    if (!ready) return;
    const onMsg = m => {
      if (m.serverNow) setOffset(m.serverNow - Date.now());
      switch (m.t) {
        case 'snapshot':
          setRound(m.round); setHistory(m.history); setFeed(m.feed);
          setTicks(m.tick && m.round?.t === 'running' ? [{ e: 0, m: 100 }, { e: m.tick.e, m: m.tick.m }] : []);
          break;
        case 'betting': setRound(m); setTicks([]); setFeed([]); refreshSoon(); break;
        case 'running': setRound(m); setTicks([{ e: 0, m: 100 }]); break;
        case 'tick': setTicks(t => (t.length > 4000 ? t : [...t, { e: m.e, m: m.m }])); break;
        case 'crashed':
          setRound(m);
          setHistory(h => [{ roundId: m.roundId, crash: m.crash }, ...h.filter(x => x.roundId !== m.roundId)].slice(0, 30));
          setFeed(f => f.map(x => (x.status === 'active' ? { ...x, status: 'lost' } : x)));
          refreshSoon();
          break;
        case 'feed': setFeed(f => m.items.reduce(applyRoom, f).slice(0, 100)); break;
        case 'bet': case 'cancel': case 'cashout': setFeed(f => applyRoom(f, m)); break;
        case 'me': refreshSoon(); break;
      }
    };
    wsRef.current = connect(onMsg, setLive);
    return () => wsRef.current?.close();
  }, [refreshSoon, ready]);

  // Reconnect the socket after login/logout so the server knows who to send balance events to.
  const userId = me.user?.id;
  const seenUser = useRef(undefined);
  useEffect(() => {
    if (!ready) return;
    if (seenUser.current !== undefined && seenUser.current !== (userId ?? null)) wsRef.current?.reconnect();
    seenUser.current = userId ?? null;
  }, [userId, ready]);

  // Cashia redirect back: show the cashier so the player can watch the pending payment.
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.get('cashier')) { setModal({ cashier: true, paymentId: p.get('payment') }); window.history.replaceState(null, '', '/'); }
  }, []);

  const current = ticks.length ? ticks[ticks.length - 1].m : 100;
  const logout = async () => { await api('/logout', { method: 'POST' }); await loadMe(); };

  return (
    <AgeGate>
      <div className="app">
        <header className="top">
          <div className="brand">Crash <span className={`dot ${live ? 'on' : ''}`} title={live ? 'Live' : 'Reconnecting…'} /></div>
          <div className="spacer" />
          {me.user ? (
            <>
              <div className="balance" title={me.reserved ? `${kes(me.reserved)} held for pending withdrawals` : ''}>
                <span className="muted">Balance</span> <strong>{kes(me.balance)}</strong>
                {me.reserved > 0 && <span className="muted small"> · {kes(me.reserved)} pending out</span>}
              </div>
              <button className="btn primary" onClick={() => setModal({ cashier: true })}>Cashier</button>
              <button className="btn ghost" onClick={logout}>{me.user.username} · Sign out</button>
            </>
          ) : (
            <button className="btn primary" onClick={() => setModal('auth')}>Sign in / Register</button>
          )}
        </header>

        {config && !config.tableOpen && (
          <div className="banner">Payments are currently disabled. The table is read-only.</div>
        )}

        <div className="history">
          {history.map(h => (
            <button key={h.roundId} className={`chip ${h.crash >= 200 ? (h.crash >= 1000 ? 'hi' : 'mid') : 'lo'}`} onClick={() => setModal({ round: h.roundId })}>
              {mult(h.crash)}
            </button>
          ))}
        </div>

        <main className="grid">
          <section className="stage">
            <Graph round={round} ticks={ticks} offset={offset} />
            <div className="fairline small muted">
              {round && <>Round #{round.roundId} · seed hash <code>{round.hash?.slice(0, 16)}…</code> · <a href="/fair">verify</a></>}
            </div>
            <div className="panels">
              {['A', 'B'].map(slot => (
                <BetPanel key={slot} slot={slot} round={round} current={current} me={me} config={config}
                  bets={myBets} onChange={refreshSoon} onNeedAuth={() => setModal('auth')} notify={notify} />
              ))}
            </div>
          </section>

          <aside className="side">
            <h3>Room <span className="muted small">{feed.length} bets</span></h3>
            <ul className="feed">
              {feed.map((f, i) => (
                <li key={i} className={f.status}>
                  <span>{f.user}</span>
                  <span className="muted">{f.stake != null ? kes(f.stake) : ''}</span>
                  <span>{f.status === 'cashed' ? <b className="win">{mult(f.mult)} · {kes(f.payout)}</b> : f.status === 'lost' ? <span className="loss">bust</span> : '…'}</span>
                </li>
              ))}
              {!feed.length && <li className="muted">No bets yet this round.</li>}
            </ul>
          </aside>
        </main>

        {me.user && (
          <section className="mine">
            <div className="stats">
              <div><span className="muted">Wagered (24h)</span><b>{kes(me.stats?.wagered)}</b></div>
              <div><span className="muted">Returned</span><b>{kes(me.stats?.returned)}</b></div>
              <div><span className="muted">Net</span><b className={me.stats?.net >= 0 ? 'win' : 'loss'}>{kes(me.stats?.net)}</b></div>
              <div><span className="muted">Best cashout</span><b>{me.stats?.best ? mult(me.stats.best) : '—'}</b></div>
            </div>
            <h3>My bets</h3>
            <div className="tablewrap">
              <table>
                <thead><tr><th>Round</th><th>Bet</th><th>Stake</th><th>Auto</th><th>Cashed</th><th>Crash</th><th>Payout</th><th>Status</th></tr></thead>
                <tbody>
                  {myBets.map(b => (
                    <tr key={b.id}>
                      <td>{b.roundId ? <a href="#" onClick={e => { e.preventDefault(); setModal({ round: b.roundId }); }}>#{b.roundId}</a> : '—'}</td>
                      <td>{b.slot}</td><td>{kes(b.stake)}</td><td>{b.autoCashout ? mult(b.autoCashout) : '—'}</td>
                      <td>{b.cashoutMult ? mult(b.cashoutMult) : '—'}</td><td>{b.crash ? mult(b.crash) : '—'}</td>
                      <td className={b.payout > 0 ? 'win' : ''}>{b.payout != null ? kes(b.payout) : '—'}</td>
                      <td>{b.status}{b.rejectReason ? ` (${b.rejectReason.replace(/_/g, ' ')})` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <footer className="foot small muted">
          18+ only. Gambling involves risk of loss — play only with money you can afford to lose. House edge {config ? (config.fair.houseEdgeBp / 100).toFixed(2) : '1.00'}%. <a href="/fair">Provably fair</a>.
        </footer>

        {modal === 'auth' && <AuthModal onClose={() => setModal(null)} onDone={async () => { setModal(null); await loadMe(); }} />}
        {modal?.cashier && <Cashier config={config} me={me} initialPaymentId={modal.paymentId} onClose={() => setModal(null)} onChange={refreshSoon} />}
        {modal?.round && <RoundInfo roundId={modal.round} onClose={() => setModal(null)} />}
        {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
      </div>
    </AgeGate>
  );
}

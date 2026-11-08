import React, { useEffect, useState } from 'react';
import { api, mult } from '../api.js';
import { crashPoint, sha256 } from '../fair.js';

export default function FairPage() {
  const [f, setF] = useState({ serverSeed: '', clientSeed: '', nonce: '', hash: '', edge: '100' });
  const [out, setOut] = useState(null);
  const [recent, setRecent] = useState([]);
  useEffect(() => {
    api('/rounds/recent').then(setRecent).catch(() => {});
    const id = new URLSearchParams(location.search).get('round');
    if (id) api(`/rounds/${id}`).then(r => r.serverSeed && setF({ serverSeed: r.serverSeed, clientSeed: r.clientSeed, nonce: String(r.nonce), hash: r.hash, edge: String(r.houseEdgeBp) })).catch(() => {});
  }, []);
  const set = k => e => setF({ ...f, [k]: e.target.value.trim() });
  async function verify(e) {
    e?.preventDefault();
    const c = await crashPoint(f.serverSeed, f.clientSeed, Number(f.nonce), Number(f.edge));
    const h = await sha256(f.serverSeed);
    setOut({ c, h, hashOk: !f.hash || h === f.hash });
  }
  return (
    <div className="app narrow">
      <header className="top"><a className="brand" href="/">Crash</a></header>
      <h1>Provably fair</h1>
      <p>Before betting closes, the server commits to <code>sha256(serverSeed)</code> and shows it. The crash point is fixed from that moment. After the crash, the server seed is revealed so anyone can check:</p>
      <pre className="code">{`h = HMAC_SHA256(key = serverSeed, message = clientSeed + ":" + nonce)
X = (first 13 hex chars of h as an integer) / 2^52
crash = max(1.00, floor((1 - houseEdge) / (1 - X) * 100) / 100)
houseEdge = 1.00%   nonce = round number   multiplier(t) = e^(0.00006 · t_ms)`}</pre>
      <p className="small muted">With a 1% edge, the chance the round reaches any target m is 0.99 / m, so every cash-out target has an expected return of 99%.</p>
      <form className="form" onSubmit={verify}>
        <label>Server seed<input value={f.serverSeed} onChange={set('serverSeed')} /></label>
        <label>Server seed hash (committed)<input value={f.hash} onChange={set('hash')} /></label>
        <label>Client seed<input value={f.clientSeed} onChange={set('clientSeed')} /></label>
        <label>Nonce<input value={f.nonce} onChange={set('nonce')} /></label>
        <label>House edge (basis points)<input value={f.edge} onChange={set('edge')} /></label>
        <button className="btn primary">Verify</button>
      </form>
      {out && <p className={out.hashOk ? 'win' : 'loss'}>Crash = <b>{mult(out.c)}</b> · sha256 {out.hashOk ? 'matches commitment ✓' : 'does NOT match ✗'}</p>}
      <h3>Recent rounds</h3>
      <div className="tablewrap"><table>
        <thead><tr><th>#</th><th>Crash</th><th>Seed</th><th /></tr></thead>
        <tbody>{recent.map(r => <tr key={r.roundId}><td>{r.roundId}</td><td>{mult(r.crash)}</td><td><code>{r.serverSeed.slice(0, 16)}…</code></td>
          <td><button className="btn sm" onClick={() => { setF({ serverSeed: r.serverSeed, clientSeed: r.clientSeed, nonce: String(r.nonce), hash: r.hash, edge: String(r.houseEdgeBp) }); setOut(null); }}>Load</button></td></tr>)}</tbody>
      </table></div>
    </div>
  );
}

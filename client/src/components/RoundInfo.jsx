import React, { useEffect, useState } from 'react';
import { api, mult } from '../api.js';
import { crashPoint, sha256 } from '../fair.js';

export default function RoundInfo({ roundId, onClose }) {
  const [r, setR] = useState(null);
  const [check, setCheck] = useState(null);
  useEffect(() => {
    api(`/rounds/${roundId}`).then(async x => {
      setR(x);
      if (x.serverSeed) {
        const [h, c] = await Promise.all([sha256(x.serverSeed), crashPoint(x.serverSeed, x.clientSeed, x.nonce, x.houseEdgeBp)]);
        setCheck({ hashOk: h === x.hash, crashOk: c === x.crash, c });
      }
    }).catch(() => {});
  }, [roundId]);
  return (
    <div className="modal" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="card">
        <button className="x" onClick={onClose} aria-label="Close">×</button>
        <h2>Round #{roundId}</h2>
        {!r ? <p>Loading…</p> : (
          <dl className="kv">
            <dt>Crash</dt><dd>{r.crash ? mult(r.crash) : 'not revealed yet'}</dd>
            <dt>Server seed hash</dt><dd><code>{r.hash}</code></dd>
            <dt>Server seed</dt><dd><code>{r.serverSeed || 'revealed after the crash'}</code></dd>
            <dt>Client seed</dt><dd><code>{r.clientSeed}</code></dd>
            <dt>Nonce</dt><dd>{r.nonce}</dd>
            {check && <><dt>Verified in your browser</dt><dd className={check.hashOk && check.crashOk ? 'win' : 'loss'}>
              hash {check.hashOk ? '✓' : '✗'} · crash {check.crashOk ? '✓' : `✗ (computed ${mult(check.c)})`}</dd></>}
          </dl>
        )}
        <p className="small"><a href={`/fair?round=${roundId}`}>Open the verifier</a></p>
      </div>
    </div>
  );
}

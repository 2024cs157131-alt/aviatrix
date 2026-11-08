import React, { useEffect, useRef, useState } from 'react';
import { mult } from '../api.js';

// Renders only server-supplied multiplier ticks. The client never extrapolates past the last tick.
export default function Graph({ round, ticks, offset }) {
  const canvas = useRef(null);
  const [now, setNow] = useState(Date.now());
  const [size, setSize] = useState(0);
  useEffect(() => {
    const ro = new ResizeObserver(() => setSize(canvas.current?.clientWidth || 0));
    if (canvas.current) ro.observe(canvas.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 100); return () => clearInterval(id); }, []);

  useEffect(() => {
    const c = canvas.current; if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const pad = { l: 44, b: 26, t: 16, r: 16 };
    const last = ticks[ticks.length - 1] || { e: 0, m: 100 };
    const finalM = round?.t === 'crashed' ? Math.max(round.crash, last.m) : last.m;
    const maxE = Math.max(8000, last.e * 1.15);
    const maxM = Math.max(200, finalM * 1.15);
    const X = e => pad.l + (e / maxE) * (w - pad.l - pad.r);
    const Y = m => h - pad.b - ((m - 100) / (maxM - 100)) * (h - pad.b - pad.t);

    g.strokeStyle = 'rgba(255,255,255,0.07)'; g.fillStyle = 'rgba(255,255,255,0.4)'; g.font = '11px system-ui'; g.lineWidth = 1;
    const step = maxM > 1000 ? 500 : maxM > 500 ? 100 : maxM > 300 ? 50 : 25;
    for (let m = 100; m <= maxM; m += step) {
      g.beginPath(); g.moveTo(pad.l, Y(m)); g.lineTo(w - pad.r, Y(m)); g.stroke();
      g.fillText(mult(m), 4, Y(m) + 4);
    }
    for (let s = 0; s * 1000 <= maxE; s += maxE > 30000 ? 10 : 2) g.fillText(`${s}s`, X(s * 1000) - 6, h - 8);

    // Trace the published curve e^(k·t) from 0 up to the last server tick only — never beyond it.
    const pts = [];
    if (ticks.length > 1) {
      const steps = Math.max(2, Math.ceil((X(last.e) - X(0)) / 3));
      for (let i = 0; i <= steps; i++) {
        const e = (last.e * i) / steps;
        pts.push([e, Math.min(last.m, 100 * Math.exp(0.00006 * e))]);
      }
      pts.push([last.e, last.m]);
    }
    if (pts.length > 1) {
      const crashed = round?.t === 'crashed';
      const grad = g.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, crashed ? 'rgba(248,81,73,0.05)' : 'rgba(46,160,67,0.05)');
      grad.addColorStop(1, crashed ? 'rgba(248,81,73,0.35)' : 'rgba(46,160,67,0.35)');
      g.beginPath(); g.moveTo(X(0), Y(100));
      for (const [e, m] of pts) g.lineTo(X(e), Y(m));
      g.lineTo(X(last.e), Y(100)); g.closePath(); g.fillStyle = grad; g.fill();
      g.beginPath(); g.moveTo(X(0), Y(100));
      for (const [e, m] of pts) g.lineTo(X(e), Y(m));
      g.strokeStyle = crashed ? '#f85149' : '#3fb950'; g.lineWidth = 3; g.lineJoin = 'round'; g.stroke();
    }
  }, [ticks, round, size]);

  let label, sub, cls = '';
  if (!round) { label = '—'; sub = 'Connecting…'; }
  else if (round.t === 'betting') {
    const left = Math.max(0, round.bettingEndsAt - (now + offset));
    label = (left / 1000).toFixed(1) + 's'; sub = 'Place your bets'; cls = 'wait';
  } else if (round.t === 'running') {
    label = mult(ticks.length ? ticks[ticks.length - 1].m : 100); sub = 'In flight'; cls = 'run';
  } else { label = mult(round.crash); sub = 'Crashed'; cls = 'bust'; }

  return (
    <div className="graph">
      <canvas ref={canvas} />
      <div className={`big ${cls}`}><div className="m">{label}</div><div className="s">{sub}</div></div>
    </div>
  );
}

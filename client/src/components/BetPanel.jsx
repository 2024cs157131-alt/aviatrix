import React, { useEffect, useRef, useState } from 'react';
import { api, kes, mult } from '../api.js';

const QUICK = [50, 100, 500, 1000];

export default function BetPanel({ slot, round, current, me, config, bets, onChange, onNeedAuth, notify }) {
  const min = config?.limits?.betMin ?? 10, max = config?.limits?.betMax ?? 20000;
  const [stake, setStake] = useState(String(min));
  const [autoOn, setAutoOn] = useState(false);
  const [autoTarget, setAutoTarget] = useState('2.00');
  const [autoBet, setAutoBet] = useState(false);
  const [busy, setBusy] = useState(false);

  const roundId = round?.roundId;
  const phase = round?.t;
  const queued = bets.find(b => b.slot === slot && b.status === 'queued');
  const active = bets.find(b => b.slot === slot && b.status === 'active' && b.roundId === roundId);
  const settled = bets.find(b => b.slot === slot && b.roundId === roundId && ['cashed', 'lost'].includes(b.status));
  const mine = queued || active;

  const clamp = v => Math.min(max, Math.max(min, Math.round(v * 100) / 100));
  const setS = v => setStake(String(clamp(v)));

  async function place() {
    if (!me.user) return onNeedAuth();
    setBusy(true);
    try {
      const r = await api('/bets', { method: 'POST', body: { slot, stake: Number(stake), autoCashout: autoOn ? Number(autoTarget) : null } });
      if (r.queued) notify(`Bet ${slot} queued for the next round. You'll be charged when it's accepted.`);
      onChange();
    } catch (e) {
      notify(e.message, 'err');
      if (['insufficient_funds', 'stake_out_of_range', 'table_closed'].includes(e.code)) setAutoBet(false);
    } finally { setBusy(false); }
  }
  async function cancel() {
    setBusy(true);
    try { await api(`/bets/${mine.id}/cancel`, { method: 'POST' }); onChange(); }
    catch (e) { notify(e.message, 'err'); } finally { setBusy(false); }
  }
  async function doCashout() {
    setBusy(true);
    try { const r = await api(`/bets/${active.id}/cashout`, { method: 'POST' }); notify(`Cashed out at ${mult(r.mult)} · ${kes(r.payout)}`, 'ok'); onChange(); }
    catch (e) { notify(e.message, 'err'); onChange(); } finally { setBusy(false); }
  }

  // Auto bet: when a new round opens for betting and this slot has nothing live, place the same bet.
  const lastAutoRound = useRef(null);
  useEffect(() => {
    if (!autoBet || phase !== 'betting' || !roundId || lastAutoRound.current === roundId) return;
    const t = setTimeout(() => {
      lastAutoRound.current = roundId;
      const has = bets.some(b => b.slot === slot && (b.status === 'queued' || (b.roundId === roundId && b.status === 'active')));
      if (!has) place();
    }, 400); // let the queued-bet acceptance land first
    return () => clearTimeout(t);
  }, [autoBet, phase, roundId, bets]); // eslint-disable-line react-hooks/exhaustive-deps

  const disabled = !config?.tableOpen;
  let button;
  if (!me.user) button = <button className="btn big-btn" onClick={onNeedAuth}>Sign in to bet</button>;
  else if (active && phase === 'running') {
    button = <button className="btn big-btn cash" disabled={busy} onClick={doCashout}>Cash out<br /><small>{kes(Math.floor(active.stake * current / 100))}</small></button>;
  } else if (active && phase === 'betting') button = <button className="btn big-btn warn" disabled={busy} onClick={cancel}>Cancel bet<br /><small>{kes(active.stake)}</small></button>;
  else if (queued) button = <button className="btn big-btn warn" disabled={busy} onClick={cancel}>Cancel<br /><small>waiting for next round</small></button>;
  else {
    const next = phase !== 'betting';
    button = <button className="btn big-btn go" disabled={busy || disabled} onClick={place}>
      {next ? 'Bet next round' : 'Bet'}<br /><small>KES {Number(stake || 0).toLocaleString()}</small></button>;
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <b>Bet {slot}</b>
        {settled && <span className={settled.status === 'cashed' ? 'win small' : 'loss small'}>
          {settled.status === 'cashed' ? `Won ${kes(settled.payout)} at ${mult(settled.cashoutMult)}` : `Lost ${kes(settled.stake)}`}</span>}
      </div>
      <div className="row">
        <div className="stake">
          <button className="btn sm" disabled={!!mine} onClick={() => setS(Number(stake) / 2)}>½</button>
          <input inputMode="decimal" value={stake} disabled={!!mine} onChange={e => setStake(e.target.value.replace(/[^\d.]/g, ''))}
            onBlur={() => setS(Number(stake) || min)} aria-label={`Stake for bet ${slot}`} />
          <button className="btn sm" disabled={!!mine} onClick={() => setS(Number(stake) * 2)}>2×</button>
        </div>
        {button}
      </div>
      <div className="quick">
        {QUICK.map(v => <button key={v} className="btn sm" disabled={!!mine} onClick={() => setS(v)}>{v}</button>)}
      </div>
      <div className="row small">
        <label className="toggle"><input type="checkbox" checked={autoOn} disabled={!!mine} onChange={e => setAutoOn(e.target.checked)} /> Auto cash out at</label>
        <input className="auto" inputMode="decimal" value={autoTarget} disabled={!autoOn || !!mine}
          onChange={e => setAutoTarget(e.target.value.replace(/[^\d.]/g, ''))}
          onBlur={() => setAutoTarget(Math.max(1.01, Number(autoTarget) || 2).toFixed(2))} />×
        <label className="toggle right"><input type="checkbox" checked={autoBet} onChange={e => setAutoBet(e.target.checked)} /> Auto bet</label>
      </div>
    </div>
  );
}

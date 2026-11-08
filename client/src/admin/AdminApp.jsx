import React, { useCallback, useEffect, useState } from 'react';
import { api, kes } from '../api.js';

const A = (path, opts) => api(`/admin${path}`, opts);
const TABS = ['Providers', 'Credentials', 'Limits', 'Payments', 'Users', 'Audit'];

export default function AdminApp() {
  const [admin, setAdmin] = useState(undefined);
  const [tab, setTab] = useState('Providers');
  const load = useCallback(() => A('/session').then(r => setAdmin(r.admin)).catch(() => setAdmin(null)), []);
  useEffect(() => { load(); }, [load]);
  if (admin === undefined) return <div className="app narrow"><p>Loading…</p></div>;
  if (!admin) return <Login onDone={load} />;
  return (
    <div className="app admin">
      <header className="top">
        <div className="brand">Crash · Admin</div><div className="spacer" />
        <span className="muted">{admin.username}</span>
        <button className="btn ghost" onClick={async () => { await A('/logout', { method: 'POST' }); load(); }}>Sign out</button>
      </header>
      <nav className="tabs">{TABS.map(t => <button key={t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{t}</button>)}</nav>
      {tab === 'Providers' && <Providers />}
      {tab === 'Credentials' && <Credentials />}
      {tab === 'Limits' && <Limits />}
      {tab === 'Payments' && <Payments />}
      {tab === 'Users' && <Users />}
      {tab === 'Audit' && <Audit />}
    </div>
  );
}

function useMsg() {
  const [m, setM] = useState(null);
  const wrap = fn => async (...a) => { setM(null); try { await fn(...a); setM({ ok: true, t: 'Saved.' }); } catch (e) { setM({ ok: false, t: e.message }); } };
  const el = m && <p className={m.ok ? 'win' : 'error'}>{m.t}</p>;
  return [wrap, el];
}

function Login({ onDone }) {
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [code, setCode] = useState(''); const [err, setErr] = useState(null);
  return (
    <div className="gate"><form className="card form" onSubmit={async e => { e.preventDefault(); setErr(null);
      try { await A('/login', { method: 'POST', body: { username: u, password: p, code } }); onDone(); } catch (x) { setErr(x.message); setCode(''); } }}>
      <h2>Admin sign in</h2>
      <label>Username<input value={u} onChange={e => setU(e.target.value)} autoComplete="username" /></label>
      <label>Password<input type="password" value={p} onChange={e => setP(e.target.value)} autoComplete="current-password" /></label>
      <label>Authenticator code<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} /></label>
      {err && <p className="error">{err}</p>}
      <button className="btn primary wide">Sign in</button>
    </form></div>
  );
}

function Providers() {
  const [d, setD] = useState(null);
  const [wrap, msg] = useMsg();
  const [lic, setLic] = useState({ jurisdiction: '', licenceNumber: '', attest: false });
  const [sec, setSec] = useState(null);
  const load = () => { A('/providers').then(setD); A('/security').then(setSec); };
  useEffect(load, []);
  if (!d) return <p>Loading…</p>;
  const save = wrap(async next => { await A('/providers', { method: 'PUT', body: next }); load(); });
  const preset = { 'M-Pesa only': [true, false], 'Cashia only': [false, true], 'Both': [true, true], 'Neither': [false, false] };
  return (
    <section className="card wide-card">
      <h3>Payment providers</h3>
      <div className="seg">
        {Object.entries(preset).map(([k, [m, c]]) => <button key={k} className="btn" onClick={() => save({ mpesa: { enabled: m }, cashia: { enabled: c } })}>{k}</button>)}
      </div>
      <table><thead><tr><th>Provider</th><th>Enabled</th><th>Environment</th><th>Sandbox creds</th><th>Production creds</th></tr></thead>
        <tbody>{['mpesa', 'cashia'].map(p => (
          <tr key={p}>
            <td><b>{p === 'mpesa' ? 'M-Pesa (Daraja)' : 'Cashia'}</b>{p === 'cashia' && !d.cashiaPayoutsSupported && <div className="small warn-text">Deposits only — payout API not published by Cashia</div>}</td>
            <td><label className="toggle"><input type="checkbox" checked={d.providers[p].enabled} onChange={e => save({ [p]: { enabled: e.target.checked } })} /> {d.providers[p].enabled ? 'On' : 'Off'}</label></td>
            <td><select value={d.providers[p].environment} onChange={e => save({ [p]: { environment: e.target.value } })}>
              <option value="sandbox">sandbox</option><option value="production" disabled={!d.licence?.licensed}>production{!d.licence?.licensed ? ' (licence flag required)' : ''}</option></select></td>
            {['sandbox', 'production'].map(env => <td key={env} className="small">{d.status[p][env].configured ? (d.status[p][env].missing.length ? <span className="warn-text">missing: {d.status[p][env].missing.join(', ')}</span> : <span className="win">complete</span>) : <span className="muted">not set</span>}</td>)}
          </tr>))}</tbody></table>
      {msg}
      <p className="small muted">Turning a provider off hides it from the cashier and blocks new transactions. Existing payments and ledger lines are kept; callbacks for in-flight payments are still processed.</p>

      <C2bRegister />

      <h3>Operator licence (gates production payments)</h3>
      {d.licence?.licensed ? (
        <div>
          <p>Licensed for <b>{d.licence.jurisdiction}</b> · licence no. <b>{d.licence.licenceNumber}</b> · set {new Date(d.licence.setAt).toLocaleString()}</p>
          <button className="btn warn" onClick={wrap(async () => { await A('/licence', { method: 'PUT', body: { licensed: false } }); load(); })}>Clear licence flag (forces sandbox)</button>
        </div>
      ) : (
        <form className="form" onSubmit={e => { e.preventDefault(); wrap(async () => { await A('/licence', { method: 'PUT', body: { licensed: true, ...lic } }); load(); })(); }}>
          <label>Jurisdiction served<input value={lic.jurisdiction} onChange={e => setLic({ ...lic, jurisdiction: e.target.value })} placeholder="e.g. Kenya (BCLB)" /></label>
          <label>Licence number<input value={lic.licenceNumber} onChange={e => setLic({ ...lic, licenceNumber: e.target.value })} /></label>
          <label className="toggle"><input type="checkbox" checked={lic.attest} onChange={e => setLic({ ...lic, attest: e.target.checked })} />
            I confirm the operator holds a valid gambling licence for this jurisdiction. This flag does not replace that licence.</label>
          <button className="btn primary">Set licence flag</button>
        </form>
      )}

      {sec && <>
        <h3>Callback source IP allowlist (optional)</h3>
        <p className="small muted">Comma-separated. Leave empty to rely on per-payment callback tokens only. Use the IPs Safaricom / Cashia publish for your account.</p>
        <form className="form" onSubmit={e => { e.preventDefault(); const f = new FormData(e.target);
          wrap(async () => { setSec(await A('/security', { method: 'PUT', body: { mpesaCallbackIps: f.get('m').split(','), cashiaCallbackIps: f.get('c').split(',') } })); })(); }}>
          <label>M-Pesa<input name="m" defaultValue={sec.mpesaCallbackIps?.join(', ')} /></label>
          <label>Cashia<input name="c" defaultValue={sec.cashiaCallbackIps?.join(', ')} /></label>
          <button className="btn">Save allowlist</button>
        </form>
      </>}
    </section>
  );
}

function C2bRegister() {
  const [st, setSt] = useState({});
  const [wrap, msg] = useMsg();
  const load = () => A('/c2b').then(setSt).catch(() => {});
  useEffect(() => { load(); }, []);
  return (
    <>
      <h3>Paybill (C2B) URLs</h3>
      <p className="small muted">Registers this server's validation and confirmation URLs for your paybill with Safaricom, so customers can pay with
        Business no. + their account no. In production Safaricom allows this once per shortcode; later changes go through Safaricom.</p>
      <div className="row">
        {['sandbox', 'production'].map(env => (
          <div key={env} className="row">
            <button className="btn" onClick={wrap(async () => { await A(`/c2b/register/${env}`, { method: 'POST' }); load(); })}>Register {env} URLs</button>
            <span className="small muted">{st[env] ? `registered ${new Date(st[env].registeredAt).toLocaleString()} (paybill ${st[env].shortcode})` : 'not registered'}</span>
          </div>
        ))}
      </div>
      {msg}
    </>
  );
}

function Credentials() {
  const [d, setD] = useState(null);
  const load = () => A('/providers').then(setD);
  useEffect(() => { load(); }, []);
  if (!d) return <p>Loading…</p>;
  return (
    <div className="credgrid">
      {['mpesa', 'cashia'].flatMap(p => ['sandbox', 'production'].map(env => (
        <CredForm key={p + env} provider={p} env={env} fields={d.fields[p]} masks={d.credentials.find(c => c.provider === p && c.environment === env)?.masks || {}} onSaved={load} />
      )))}
    </div>
  );
}

function CredForm({ provider, env, fields, masks, onSaved }) {
  const [v, setV] = useState({});
  const [wrap, msg] = useMsg();
  return (
    <form className="card form" onSubmit={e => { e.preventDefault(); wrap(async () => { await A(`/credentials/${provider}/${env}`, { method: 'PUT', body: v }); setV({}); onSaved(); })(); }}>
      <h3>{provider === 'mpesa' ? 'M-Pesa' : 'Cashia'} · {env}</h3>
      <p className="small muted">Write-only. Blank fields keep their stored value. Saved secrets show only their last four characters.</p>
      {fields.map(f => (
        <label key={f.name}>{f.label}{masks[f.name] && <span className="muted small"> — current: {masks[f.name]}</span>}
          {f.multiline
            ? <textarea rows={3} value={v[f.name] || ''} onChange={e => setV({ ...v, [f.name]: e.target.value })} placeholder="-----BEGIN CERTIFICATE-----" />
            : <input type={f.secret ? 'password' : 'text'} autoComplete="off" value={v[f.name] || ''} onChange={e => setV({ ...v, [f.name]: e.target.value })} />}
        </label>
      ))}
      {msg}
      <button className="btn primary">Save {env} credentials</button>
    </form>
  );
}

function Limits() {
  const [l, setL] = useState(null);
  const [wrap, msg] = useMsg();
  useEffect(() => { A('/limits').then(setL); }, []);
  if (!l) return <p>Loading…</p>;
  const F = [['depositMin', 'Deposit min'], ['depositMax', 'Deposit max'], ['withdrawMin', 'Withdrawal min'], ['withdrawMax', 'Withdrawal max'], ['betMin', 'Bet min'], ['betMax', 'Bet max'], ['maxPayout', 'Max payout per bet']];
  return (
    <form className="card form wide-card" onSubmit={e => { e.preventDefault(); wrap(async () => setL(await A('/limits', { method: 'PUT', body: l })))(); }}>
      <h3>Limits (KES)</h3>
      <div className="two">{F.map(([k, label]) => <label key={k}>{label}<input inputMode="numeric" value={l[k]} onChange={e => setL({ ...l, [k]: e.target.value.replace(/\D/g, '') })} /></label>)}</div>
      {msg}
      <button className="btn primary">Save limits</button>
    </form>
  );
}

function Payments() {
  const [rows, setRows] = useState([]);
  const [f, setF] = useState({ status: '', provider: '', direction: '', user: '', unassigned: '' });
  const [open, setOpen] = useState(null);
  const load = () => A('/payments?' + new URLSearchParams(Object.entries(f).filter(([, v]) => v))).then(setRows);
  useEffect(() => { load(); }, [f]); // eslint-disable-line
  const sel = (k, opts) => <select value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })}><option value="">{k}: all</option>{opts.map(o => <option key={o}>{o}</option>)}</select>;
  return (
    <section className="card wide-card">
      <div className="row">{sel('status', ['initiating', 'pending', 'confirmed', 'failed', 'needs_review'])}{sel('provider', ['mpesa', 'cashia'])}{sel('direction', ['deposit', 'withdrawal'])}
        <label className="toggle small"><input type="checkbox" checked={f.unassigned === '1'} onChange={e => setF({ ...f, unassigned: e.target.checked ? '1' : '' })} /> Unassigned paybill only</label>
        <input placeholder="username or account no." value={f.user} onChange={e => setF({ ...f, user: e.target.value })} /><button className="btn" onClick={load}>Refresh</button></div>
      <div className="tablewrap"><table>
        <thead><tr><th>When</th><th>User</th><th>Dir</th><th>Provider</th><th>Env</th><th>Amount</th><th>Phone</th><th>Status</th><th>Ref</th><th /></tr></thead>
        <tbody>{rows.map(p => (
          <React.Fragment key={p.id}>
            <tr>
              <td className="small">{new Date(p.createdAt).toLocaleString()}</td><td>{p.username || <span className="warn-text">unassigned ({p.billRef || '—'})</span>}</td><td>{p.direction}</td><td>{p.provider}{p.channel ? ` · ${p.channel}` : ''}</td><td>{p.environment}</td>
              <td>{kes(p.amount)}</td><td>{p.phone}</td><td className={`st ${p.status}`}>{p.status}</td><td className="small"><code>{p.providerTxn || p.providerRef || '—'}</code></td>
              <td><button className="btn sm" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'Close' : 'Details'}</button></td>
            </tr>
            {open === p.id && <tr><td colSpan={10}><PaymentDetail p={p} onChange={load} /></td></tr>}
          </React.Fragment>
        ))}</tbody>
      </table></div>
    </section>
  );
}

function PaymentDetail({ p, onChange }) {
  const [events, setEvents] = useState([]);
  const [wrap, msg] = useMsg();
  const [txnId, setTxnId] = useState('');
  const [res, setRes] = useState({ outcome: 'paid', transactionId: '', reason: '' });
  const [asg, setAsg] = useState({ who: '', reason: '' });
  const load = () => A(`/payments/${p.id}/events`).then(setEvents);
  useEffect(() => { load(); }, []); // eslint-disable-line
  const open = !['confirmed', 'failed'].includes(p.status);
  return (
    <div className="detail">
      <p className="small">Payment <code>{p.id}</code>{p.failureReason && <> · <span className="warn-text">{p.failureReason}</span></>}</p>
      {open && p.direction === 'deposit' && (
        <div className="row">
          {p.provider === 'cashia' && <input placeholder="Cashia transaction id (if callback lacked one)" value={txnId} onChange={e => setTxnId(e.target.value)} />}
          <button className="btn" onClick={wrap(async () => { await A(`/payments/${p.id}/reconcile`, { method: 'POST', body: { cashiaTransactionId: txnId || undefined } }); onChange(); load(); })}>
            {p.channel === 'c2b' ? 'Retry verification with M-Pesa (transaction status)' : `Retry reconciliation with ${p.provider === 'mpesa' ? 'M-Pesa (STK query)' : 'Cashia'}`}</button>
        </div>
      )}
      {p.channel === 'c2b' && !p.userId && (
        <form className="row" onSubmit={e => { e.preventDefault(); wrap(async () => { await A(`/payments/${p.id}/assign`, { method: 'POST', body: asg }); onChange(); })(); }}>
          <span className="small">Paid to account "<b>{p.billRef}</b>" {p.verifiedAt ? <span className="win">verified by M-Pesa</span> : <span className="warn-text">not yet verified</span>}</span>
          <input placeholder="Player account no. or username" value={asg.who} onChange={e => setAsg({ ...asg, who: e.target.value })} />
          <input placeholder="Reason (required)" value={asg.reason} onChange={e => setAsg({ ...asg, reason: e.target.value })} />
          <button className="btn warn" disabled={!p.verifiedAt}>Assign & credit</button>
        </form>
      )}
      {p.status === 'needs_review' && p.direction === 'withdrawal' && (
        <form className="row" onSubmit={e => { e.preventDefault(); wrap(async () => { await A(`/payments/${p.id}/resolve`, { method: 'POST', body: res }); onChange(); })(); }}>
          <select value={res.outcome} onChange={e => setRes({ ...res, outcome: e.target.value })}><option value="paid">Mark paid (M-Pesa shows it sent)</option><option value="failed">Mark failed (release reserve)</option></select>
          <input placeholder="M-Pesa transaction id" value={res.transactionId} onChange={e => setRes({ ...res, transactionId: e.target.value })} />
          <input placeholder="Reason (required)" value={res.reason} onChange={e => setRes({ ...res, reason: e.target.value })} />
          <button className="btn warn">Resolve</button>
        </form>
      )}
      {msg}
      <h4>Callbacks</h4>
      {!events.length && <p className="small muted">No callbacks received.</p>}
      <ul className="events">{events.map(ev => (
        <li key={ev.id}>
          <span>#{ev.id} {ev.kind} · {new Date(ev.received_at).toLocaleString()}</span>
          <span className={ev.verified ? 'win' : 'loss'}>{ev.verified ? 'verified' : 'rejected'}</span>
          <span className={ev.processed ? 'win' : 'warn-text'}>{ev.processed ? 'processed' : ev.error || 'pending'}</span>
          {ev.verified && !ev.processed && <button className="btn sm" onClick={wrap(async () => { await A(`/events/${ev.id}/retry`, { method: 'POST' }); load(); onChange(); })}>Retry</button>}
          <details><summary className="small">body</summary><pre className="code small">{JSON.stringify(ev.body, null, 2)}</pre></details>
        </li>
      ))}</ul>
    </div>
  );
}

function Users() {
  const [qs, setQs] = useState(''); const [rows, setRows] = useState([]); const [sel, setSel] = useState(null);
  useEffect(() => { const t = setTimeout(() => A('/users?q=' + encodeURIComponent(qs)).then(setRows), 250); return () => clearTimeout(t); }, [qs]);
  return (
    <section className="card wide-card">
      <input placeholder="Search username" value={qs} onChange={e => setQs(e.target.value)} />
      <ul className="plist">{rows.map(u => <li key={u.id}><a href="#" onClick={e => { e.preventDefault(); setSel(u.id); }}>{u.username}</a><span className="muted">{u.role}{u.disabled ? ' · disabled' : ''}</span><span className="small muted">{new Date(u.created_at).toLocaleDateString()}</span></li>)}</ul>
      {sel && <UserDetail id={sel} />}
    </section>
  );
}

function UserDetail({ id }) {
  const [d, setD] = useState(null);
  const [adj, setAdj] = useState({ amount: '', reason: '' });
  const [wrap, msg] = useMsg();
  const load = () => A(`/users/${id}`).then(setD);
  useEffect(() => { load(); }, [id]); // eslint-disable-line
  if (!d) return <p>Loading…</p>;
  return (
    <div className="detail">
      <h3>{d.user.username} <span className="muted small">#{d.user.id}</span></h3>
      <p>Balance <b>{kes(d.balance)}</b> · held for withdrawals {kes(d.reserved)}</p>
      {d.user.role !== 'admin' && <button className="btn sm" onClick={wrap(async () => { await A(`/users/${id}/disable`, { method: 'POST', body: { disabled: !d.user.disabled } }); load(); })}>{d.user.disabled ? 'Enable account' : 'Disable account'}</button>}
      <form className="row" onSubmit={e => { e.preventDefault(); wrap(async () => { await A(`/users/${id}/adjust`, { method: 'POST', body: { ...adj, amount: Number(adj.amount), requestId: crypto.randomUUID() } }); setAdj({ amount: '', reason: '' }); load(); })(); }}>
        <input placeholder="Adjustment KES (+/-)" value={adj.amount} onChange={e => setAdj({ ...adj, amount: e.target.value })} />
        <input placeholder="Reason (required)" value={adj.reason} onChange={e => setAdj({ ...adj, reason: e.target.value })} />
        <button className="btn">Post adjustment</button>
      </form>
      {msg}
      <p className="small muted">Ledger lines are append-only and cannot be edited. Corrections are new adjustment lines with your admin id and reason.</p>
      <div className="tablewrap"><table>
        <thead><tr><th>#</th><th>When</th><th>Type</th><th>Amount</th><th>Provider</th><th>Ref</th><th>Actor / reason</th></tr></thead>
        <tbody>{d.ledger.map(l => <tr key={l.id}><td>{l.id}</td><td className="small">{new Date(l.created_at).toLocaleString()}</td><td>{l.type}</td>
          <td className={l.amount_cents > 0 ? 'win' : l.amount_cents < 0 ? 'loss' : ''}>{kes(l.amount_cents)}</td><td>{l.provider || ''}</td>
          <td className="small"><code>{l.payment_id ? l.payment_id.slice(0, 8) : l.bet_id ? `bet ${l.bet_id}` : ''}</code></td><td className="small">{l.actor ? `${l.actor}: ${l.reason}` : ''}</td></tr>)}</tbody>
      </table></div>
    </div>
  );
}

function Audit() {
  const [rows, setRows] = useState([]);
  useEffect(() => { A('/audit').then(setRows); }, []);
  return (
    <section className="card wide-card"><div className="tablewrap"><table>
      <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Detail</th></tr></thead>
      <tbody>{rows.map(r => <tr key={r.id}><td className="small">{new Date(r.created_at).toLocaleString()}</td><td>{r.username}</td><td>{r.action}</td><td className="small"><code>{JSON.stringify(r.detail)}</code></td></tr>)}</tbody>
    </table></div></section>
  );
}

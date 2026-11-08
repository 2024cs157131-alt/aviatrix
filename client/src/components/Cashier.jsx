import React, { useEffect, useState } from 'react';
import { api, kes } from '../api.js';

const LABEL = { mpesa: 'M-Pesa', cashia: 'Cashia' };
const FINAL = ['confirmed', 'failed'];

export default function Cashier({ config, me, initialPaymentId, onClose, onChange }) {
  const [tab, setTab] = useState('deposit');
  const providers = (config?.providers || []).filter(p => (tab === 'deposit' ? p.deposits : p.withdrawals));
  const [provider, setProvider] = useState(null);
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [payment, setPayment] = useState(null);
  const [list, setList] = useState([]);
  const lim = config?.limits || {};
  const [min, max] = tab === 'deposit' ? [lim.depositMin, lim.depositMax] : [lim.withdrawMin, lim.withdrawMax];

  useEffect(() => { if (!providers.find(p => p.name === provider)) setProvider(providers[0]?.name || null); }, [tab, config]); // eslint-disable-line
  useEffect(() => { api('/payments').then(setList).catch(() => {}); }, [payment?.status]);
  useEffect(() => { if (initialPaymentId) api(`/payments/${initialPaymentId}`).then(setPayment).catch(() => {}); }, [initialPaymentId]);

  // Poll the server for the real status. Balance only changes once the provider callback is verified.
  useEffect(() => {
    if (!payment || FINAL.includes(payment.status)) return;
    const id = setInterval(async () => {
      try { const p = await api(`/payments/${payment.id}`); setPayment(p); if (FINAL.includes(p.status)) onChange(); } catch {}
    }, 3000);
    return () => clearInterval(id);
  }, [payment?.id, payment?.status]); // eslint-disable-line

  if (!me.user) return <Shell onClose={onClose}><p>Sign in to use the cashier.</p></Shell>;

  async function submit(e) {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      const p = await api(tab === 'deposit' ? '/deposits' : '/withdrawals', { method: 'POST', body: { provider, amount: Number(amount), phone } });
      setPayment(p);
      if (p.provider === 'cashia' && p.checkoutUrl) window.open(p.checkoutUrl, '_blank', 'noopener');
      onChange();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <Shell onClose={onClose}>
      <div className="tabs">
        {['deposit', 'withdraw'].map(t => <button key={t} className={`tab ${tab === (t === 'withdraw' ? 'withdrawal' : t) ? 'on' : ''}`}
          onClick={() => { setTab(t === 'withdraw' ? 'withdrawal' : t); setPayment(null); setErr(null); }}>{t === 'deposit' ? 'Deposit' : 'Withdraw'}</button>)}
      </div>
      <p className="small muted">Balance {kes(me.balance)}{me.reserved ? ` · ${kes(me.reserved)} pending withdrawal` : ''}</p>

      {tab === 'deposit' && !payment && providers.some(p => p.name === 'mpesa' && p.paybill) && me.user.accountNo && (
        <div className="paybill">
          <b>Pay with M-Pesa Paybill</b>
          <div className="pb-row"><span>Business no.</span><code>{providers.find(p => p.name === 'mpesa').paybill}</code></div>
          <div className="pb-row"><span>Account no.</span><code>{me.user.accountNo}</code></div>
          <p className="small muted">Your balance updates automatically once M-Pesa confirms the payment. Use exactly this account number.</p>
          <p className="small muted center">— or get a prompt on your phone —</p>
        </div>
      )}

      {payment ? <Status p={payment} onNew={() => setPayment(null)} /> : !providers.length ? (
        <p className="banner">{tab === 'deposit' ? 'Deposits' : 'Withdrawals'} are not available right now.</p>
      ) : (
        <form onSubmit={submit} className="form">
          {providers.length > 1 && (
            <div className="seg">
              {providers.map(p => <button type="button" key={p.name} className={`btn ${provider === p.name ? 'primary' : ''}`} onClick={() => setProvider(p.name)}>{LABEL[p.name]}</button>)}
            </div>
          )}
          {providers.length === 1 && <p className="small">Using <b>{LABEL[providers[0].name]}</b></p>}
          {providers.some(p => p.environment === 'sandbox' && p.name === provider) && <p className="small warn-text">Sandbox mode — no real money moves.</p>}
          <label>Amount (KES {min}–{max?.toLocaleString()})
            <input inputMode="numeric" required value={amount} onChange={e => setAmount(e.target.value.replace(/\D/g, ''))} />
          </label>
          <label>{provider === 'cashia' ? 'Phone number' : 'M-Pesa phone number'}
            <input inputMode="tel" required placeholder="07XX XXX XXX" value={phone} onChange={e => setPhone(e.target.value)} />
          </label>
          {err && <p className="error">{err}</p>}
          <button className="btn primary wide" disabled={busy || !provider}>{busy ? 'Sending…' : tab === 'deposit' ? 'Deposit' : 'Withdraw'}</button>
        </form>
      )}

      {list.length > 0 && (
        <>
          <h4>Recent</h4>
          <ul className="plist">
            {list.slice(0, 8).map(p => (
              <li key={p.id}><span>{p.direction === 'deposit' ? '↓' : '↑'} {LABEL[p.provider]}</span><span>{kes(p.amount)}</span><span className={`st ${p.status}`}>{p.status.replace('_', ' ')}</span></li>
            ))}
          </ul>
        </>
      )}
    </Shell>
  );
}

function Status({ p, onNew }) {
  const dep = p.direction === 'deposit';
  let msg;
  if (p.status === 'confirmed') msg = dep ? `${kes(p.amount)} received and added to your balance.` : `${kes(p.amount)} sent to ${p.phone}.`;
  else if (p.status === 'failed') msg = `${dep ? 'Deposit' : 'Withdrawal'} failed${p.failureReason ? `: ${p.failureReason}` : ''}.${dep ? '' : ' The amount is back in your balance.'}`;
  else if (p.status === 'needs_review') msg = 'We are confirming this with the provider. Your balance updates once it is confirmed.';
  else if (dep && p.provider === 'mpesa') msg = `Check your phone (${p.phone}) and enter your M-Pesa PIN. Waiting for M-Pesa to confirm…`;
  else if (dep && p.provider === 'cashia') msg = <>Complete payment in the Cashia window. {p.checkoutUrl && <a href={p.checkoutUrl} target="_blank" rel="noopener noreferrer">Open Cashia checkout</a>} Waiting for Cashia to confirm…</>;
  else msg = `Sending ${kes(p.amount)} to ${p.phone}. Waiting for confirmation…`;
  return (
    <div className={`status ${p.status}`}>
      {!['confirmed', 'failed'].includes(p.status) && <div className="spinner" />}
      <p>{msg}</p>
      {['confirmed', 'failed'].includes(p.status) && <button className="btn" onClick={onNew}>New transaction</button>}
    </div>
  );
}

function Shell({ children, onClose }) {
  return (
    <div className="modal" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="card"><button className="x" onClick={onClose} aria-label="Close">×</button><h2>Cashier</h2>{children}</div>
    </div>
  );
}

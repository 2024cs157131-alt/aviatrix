import React, { useState } from 'react';
import { api } from '../api.js';

export default function AuthModal({ onClose, onDone }) {
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ username: '', password: '', dateOfBirth: '', confirmAge: false });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = k => e => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function submit(e) {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      await api(mode === 'login' ? '/login' : '/register', { method: 'POST', body: mode === 'login' ? { username: f.username, password: f.password } : f });
      await onDone();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal" onClick={e => e.target === e.currentTarget && onClose()}>
      <form className="card form" onSubmit={submit}>
        <button type="button" className="x" onClick={onClose} aria-label="Close">×</button>
        <h2>{mode === 'login' ? 'Sign in' : 'Create account'}</h2>
        <label>Username<input autoComplete="username" required value={f.username} onChange={set('username')} /></label>
        <label>Password<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'login' ? 1 : 10} value={f.password} onChange={set('password')} /></label>
        {mode === 'register' && (
          <>
            <label>Date of birth<input type="date" required value={f.dateOfBirth} onChange={set('dateOfBirth')} /></label>
            <label className="toggle"><input type="checkbox" checked={f.confirmAge} onChange={set('confirmAge')} required /> I am 18 or older and gambling is legal where I live.</label>
          </>
        )}
        {err && <p className="error">{err}</p>}
        <button className="btn primary wide" disabled={busy}>{busy ? '…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        <p className="small muted center">
          {mode === 'login' ? <>New here? <a href="#" onClick={e => { e.preventDefault(); setMode('register'); }}>Create an account</a></>
            : <>Have an account? <a href="#" onClick={e => { e.preventDefault(); setMode('login'); }}>Sign in</a></>}
        </p>
      </form>
    </div>
  );
}

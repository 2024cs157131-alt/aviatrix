import React, { useState } from 'react';

const KEY = 'age_gate_18';
const read = () => { try { return sessionStorage.getItem(KEY) === 'yes'; } catch { return false; } };

// First gate shown before the table. Registration separately requires a date of birth showing 18+.
export default function AgeGate({ children }) {
  const [ok, setOk] = useState(read);
  const [left, setLeft] = useState(false);
  if (ok) return children;
  return (
    <div className="gate">
      <div className="card">
        <h1>Crash</h1>
        {left ? <p>This site is for adults only.</p> : (
          <>
            <p>This is a real-money gambling game. You must be <b>18 or older</b> to continue.</p>
            <div className="seg">
              <button className="btn primary" onClick={() => { try { sessionStorage.setItem(KEY, 'yes'); } catch {} setOk(true); }}>I am 18 or older</button>
              <button className="btn" onClick={() => setLeft(true)}>I am under 18</button>
            </div>
            <p className="small muted">Gamble responsibly. Only play with money you can afford to lose.</p>
          </>
        )}
      </div>
    </div>
  );
}

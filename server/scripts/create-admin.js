// Usage: npm run create-admin -- <username>
// Reads the password from stdin (no echo in shell history). Promotes an existing user or creates one.
import readline from 'node:readline';
import { q, pool } from '../src/db.js';
import { hashPassword, encrypt, newTotpSecret } from '../src/crypto.js';

const username = process.argv[2];
if (!/^[A-Za-z0-9_]{3,20}$/.test(username || '')) { console.error('usage: npm run create-admin -- <username>'); process.exit(1); }

const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
const ask = p => new Promise(r => rl.question(p, r));
const pw = (await ask('Admin password (min 14 chars): ')).trim();
rl.close();
if (pw.length < 14) { console.error('password too short'); process.exit(1); }

const secret = newTotpSecret();
await q(`INSERT INTO users(username, password_hash, role, totp_secret_enc) VALUES ($1,$2,'admin',$3)
         ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin',
           totp_secret_enc = EXCLUDED.totp_secret_enc, totp_last_step = NULL`, [username, hashPassword(pw), encrypt(secret)]);
await q(`DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = $1)`, [username]);
console.error(`admin ${username} ready.`);
console.error('Add this to your authenticator app (Google Authenticator, Authy, 1Password), then clear your terminal:');
console.error(`  secret: ${secret}`);
console.error(`  otpauth://totp/Crash%20Admin:${encodeURIComponent(username)}?secret=${secret}&issuer=Crash%20Admin&digits=6&period=30`);
await pool.end();

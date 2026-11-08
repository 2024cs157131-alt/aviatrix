// Usage: npm run set-backend -- https://your-backend.up.railway.app
// Points vercel.json's /api proxy and CSP connect-src at your backend domain. Commit and push afterwards.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = process.argv[2] || '';
let host;
try { const u = new URL(arg); if (u.protocol !== 'https:') throw 0; host = u.host; }
catch { console.error('usage: npm run set-backend -- https://your-backend.up.railway.app'); process.exit(1); }

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vercel.json');
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
const api = cfg.rewrites.find(r => r.source === '/api/:path*');
api.destination = `https://${host}/api/:path*`;
for (const h of cfg.headers) for (const kv of h.headers) {
  if (kv.key === 'Content-Security-Policy') kv.value = kv.value.replace(/connect-src [^;]*/, `connect-src 'self' wss://${host}`);
}
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
console.log(`vercel.json now proxies /api to https://${host} and allows wss://${host}`);

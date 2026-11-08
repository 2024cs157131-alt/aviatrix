// Independent client-side verifier — same published function as the server.
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

export async function sha256(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }

export async function crashPoint(serverSeed, clientSeed, nonce, houseEdgeBp = 100) {
  const key = await crypto.subtle.importKey('raw', enc.encode(serverSeed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const h = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${clientSeed}:${nonce}`)));
  const r = parseInt(h.slice(0, 13), 16);
  const X = r / 2 ** 52;
  const raw = Math.floor(((1 - houseEdgeBp / 10000) / (1 - X)) * 100);
  return Math.min(100000000, Math.max(100, raw));
}

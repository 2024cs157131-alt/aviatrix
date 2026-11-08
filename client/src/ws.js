import { api } from './api.js';

// Read-only live feed. Reconnects with backoff. All actions go over HTTPS.
// wsUrl: null = same host as the page; otherwise the backend's wss:// URL (split deploy, e.g. site on Vercel).
// When signed in on a split deploy, a fresh 60 s ticket authenticates each (re)connection.
export function connect({ wsUrl, signedIn }, onMessage, onStatus) {
  let ws, closed = false, wait = 500;
  const open = async () => {
    let url = wsUrl || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    if (wsUrl && signedIn) {
      try { url += (url.includes('?') ? '&' : '?') + 'ticket=' + encodeURIComponent((await api('/ws-ticket', { method: 'POST' })).ticket); } catch {}
    }
    if (closed) return;
    ws = new WebSocket(url);
    ws.onopen = () => { wait = 500; onStatus?.(true); };
    ws.onmessage = e => { try { onMessage(JSON.parse(e.data)); } catch {} };
    ws.onclose = () => { onStatus?.(false); if (!closed) setTimeout(open, (wait = Math.min(wait * 2, 8000))); };
  };
  open();
  return { close() { closed = true; ws?.close(); }, reconnect() { ws?.close(); } };
}

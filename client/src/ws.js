// Read-only live feed. Reconnects with backoff. All actions go over HTTPS.
export function connect(onMessage, onStatus) {
  let ws, closed = false, wait = 500;
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { wait = 500; onStatus?.(true); };
    ws.onmessage = e => { try { onMessage(JSON.parse(e.data)); } catch {} };
    ws.onclose = () => { onStatus?.(false); if (!closed) setTimeout(open, (wait = Math.min(wait * 2, 8000))); };
  };
  open();
  return { close() { closed = true; ws?.close(); }, reconnect() { ws?.close(); } };
}

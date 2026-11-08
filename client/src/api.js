let csrf = null;
async function token() {
  if (csrf) return csrf;
  const r = await fetch('/api/csrf', { credentials: 'same-origin' });
  csrf = (await r.json()).token;
  return csrf;
}

export class ApiError extends Error {
  constructor(status, body) { super(body?.message || body?.error || `HTTP ${status}`); this.status = status; this.code = body?.error; }
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = await token(); }
  const r = await fetch(`/api${path}`, { method, headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (r.status === 403 && data.error === 'csrf') csrf = null;
  if (!r.ok) throw new ApiError(r.status, data);
  return data;
}

export const kes = cents => 'KES ' + (Number(cents || 0) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const mult = h => (Number(h) / 100).toFixed(2) + '×';

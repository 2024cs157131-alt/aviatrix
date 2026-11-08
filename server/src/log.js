// Structured logger that scrubs anything that looks like a phone number, token or secret.
const SECRET_KEYS = /pass|secret|key|token|credential|pin|authorization|cookie|signature/i;
const PHONE = /\b(?:\+?254|0)([17]\d{8})\b/g;

export const maskPhone = p => (p ? String(p).replace(/^(\d{4})\d+(\d{2})$/, '$1******$2') : p);

function scrub(v, depth = 0) {
  if (v == null || depth > 5) return v;
  if (typeof v === 'string') return v.replace(PHONE, m => maskPhone(m.replace(/^\+/, '')));
  if (Array.isArray(v)) return v.map(x => scrub(x, depth + 1));
  if (typeof v === 'object') {
    if (v instanceof Error) return { message: scrub(v.message), name: v.name };
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = SECRET_KEYS.test(k) ? '[redacted]' : scrub(val, depth + 1);
    return o;
  }
  return v;
}

function out(level, msg, data) {
  const line = { t: new Date().toISOString(), level, msg, ...(data ? scrub(data) : {}) };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}

export const log = {
  info: (m, d) => out('info', m, d),
  warn: (m, d) => out('warn', m, d),
  error: (m, d) => out('error', m, d),
};

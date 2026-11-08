import crypto from 'node:crypto';

// Published constants. The client verifier (client/src/fair.js) implements the identical function.
export const HOUSE_EDGE_BP = 100;           // 1.00% house edge
export const GROWTH_PER_MS = 0.00006;       // multiplier(t) = e^(GROWTH_PER_MS * t_ms)
export const MAX_CRASH = 100000000;         // 1,000,000.00x cap (hundredths)

/**
 * crash = f(serverSeed, clientSeed, nonce)
 *   h  = HMAC_SHA256(key = serverSeed, msg = `${clientSeed}:${nonce}`)
 *   r  = first 52 bits of h as an integer;  X = r / 2^52  (uniform in [0,1))
 *   crash = max(1.00, floor( (1 - edge) / (1 - X) * 100 ) / 100)
 * P(crash >= m) = (1 - edge) / m for m >= 1, so expected return of any cashout target is (1 - edge).
 * Returned in hundredths.
 */
export function crashPoint(serverSeed, clientSeed, nonce, houseEdgeBp = HOUSE_EDGE_BP) {
  const h = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`).digest('hex');
  const r = parseInt(h.slice(0, 13), 16);           // 52 bits
  const X = r / 2 ** 52;
  const edge = houseEdgeBp / 10000;
  const raw = Math.floor(((1 - edge) / (1 - X)) * 100);
  return Math.min(MAX_CRASH, Math.max(100, raw));
}

export const newServerSeed = () => crypto.randomBytes(32).toString('hex');
export const hashSeed = seed => crypto.createHash('sha256').update(seed).digest('hex');

// Multiplier in hundredths at elapsed ms (floored, so displayed value never overstates).
export const multiplierAt = ms => (ms <= 0 ? 100 : Math.floor(100 * Math.exp(GROWTH_PER_MS * ms)));
// Elapsed ms at which the multiplier reaches m (hundredths).
export const msForMultiplier = m => Math.ceil(Math.log(m / 100) / GROWTH_PER_MS);

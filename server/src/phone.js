// Kenyan MSISDN normalisation: accepts 07XXXXXXXX, 01XXXXXXXX, 2547XXXXXXXX, 2541XXXXXXXX (+ optional '+').
export function normalizeKenyanPhone(input) {
  const s = String(input || '').replace(/[\s-]/g, '').replace(/^\+/, '');
  let m;
  if ((m = s.match(/^0([17]\d{8})$/))) return '254' + m[1];
  if ((m = s.match(/^254([17]\d{8})$/))) return '254' + m[1];
  return null;
}
export { maskPhone } from './log.js';

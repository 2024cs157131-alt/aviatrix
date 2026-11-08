// Public provider callbacks. The ONLY unauthenticated write routes in the app.
// Note: paths avoid the words "mpesa"/"safaricom" — Daraja rejects callback URLs containing them.
import { Router } from 'express';
import { receiveCallback, receiveC2b } from '../payments.js';
import { memLimit } from '../ratelimit.js';

const r = Router();
r.use(memLimit(300, 10, req => req.ip));

const mp = kind => async (req, res) => {
  const status = await receiveCallback({ provider: 'mpesa', kind, paymentId: req.params.pid, token: req.params.token, body: req.body, ip: req.ip });
  res.status(status).json(status === 200 ? { ResultCode: 0, ResultDesc: 'Accepted' } : { ResultCode: 1, ResultDesc: 'Rejected' });
};

r.post('/mp/stk/:pid/:token', mp('stk'));
r.post('/mp/b2c/:pid/:token', mp('b2c_result'));
r.post('/mp/b2c-timeout/:pid/:token', mp('b2c_timeout'));
r.post('/mp/txstatus/:pid/:token', mp('txstatus'));
r.post('/mp/txstatus-timeout/:pid/:token', mp('txstatus_timeout'));

// Paybill (C2B) URLs registered with Safaricom: /mp/c2b/<env>/(validate|confirm)/<token>
r.post('/mp/c2b/:env/:kind/:token', async (req, res) => {
  if (!['validate', 'confirm'].includes(req.params.kind)) return res.status(404).json({ ResultCode: 'C2B00016', ResultDesc: 'Rejected' });
  const out = await receiveC2b({ env: req.params.env, kind: req.params.kind, token: req.params.token, body: req.body, ip: req.ip });
  res.status(out.status).json(out.body);
});
r.post('/cs/:pid/:token', async (req, res) => {
  const status = await receiveCallback({ provider: 'cashia', kind: 'cashia', paymentId: req.params.pid, token: req.params.token, body: req.body, ip: req.ip });
  res.status(status).json({ ok: status === 200 });
});

export default r;

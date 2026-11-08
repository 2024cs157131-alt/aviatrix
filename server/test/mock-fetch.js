// TEST-ONLY preload: fakes Daraja HTTP so the full stack can run where Safaricom is unreachable.
// Usage: node --import ./server/test/mock-fetch.js server/src/server.js   (never in production)
if (process.env.NODE_ENV === 'production') throw new Error('mock-fetch must never load in production');
let n = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  const json = u.includes('/oauth/') ? { access_token: 'tok', expires_in: '3599' }
    : u.includes('/stkpushquery/') ? { ResultCode: '0', ResultDesc: 'ok' }
    : u.includes('/stkpush/') ? { ResponseCode: '0', CheckoutRequestID: `ws_CO_${Date.now()}_${++n}`, MerchantRequestID: 'm' }
    : u.includes('/transactionstatus/') ? { ResponseCode: '0', ConversationID: 'AG_ts', OriginatorConversationID: 'oc_ts' }
    : u.includes('/c2b/v1/registerurl') ? { ResponseCode: '0', ResponseDescription: 'success' }
    : u.includes('/b2c/') ? { ResponseCode: '0', ConversationID: `AG_${++n}`, OriginatorConversationID: `oc_${Date.now()}_${n}` }
    : { error: 'unmocked' };
  return { status: 200, text: async () => JSON.stringify(json) };
};

#!/usr/bin/env bash
# TEST-ONLY end-to-end smoke test over HTTP. Run the web server with server/test/mock-fetch.js preloaded,
# the worker running, and an admin "boss" / "AdminPassword-12345" on a throwaway database.
# TOTP_SECRET must hold the secret printed by create-admin.
set -e
B=http://localhost:3000/api; O="Origin: http://localhost:3000"
rm -f /tmp/pj /tmp/aj
P="-s -b /tmp/pj -c /tmp/pj"; AD="-s -b /tmp/aj -c /tmp/aj"
j() { node -pe "JSON.parse(require('fs').readFileSync(0))$1"; }
T=$(curl $P $B/csrf | j .token)
TA=$(curl $AD $B/csrf | j .token)
H=(-H "Content-Type: application/json" -H "X-CSRF-Token: $T" -H "$O")
HA=(-H "Content-Type: application/json" -H "X-CSRF-Token: $TA" -H "$O")
say() { echo; echo "--- $1"; }

say "POST without CSRF token"; curl -s -X POST $B/login -H "Content-Type: application/json" -d '{}'
say "register underage"; curl $P "${H[@]}" -X POST $B/register -d '{"username":"kid","password":"aaaaaaaaaaaa","dateOfBirth":"2015-01-01","confirmAge":true}'
U="p$RANDOM"
say "register $U"; curl $P "${H[@]}" -X POST $B/register -d "{\"username\":\"$U\",\"password\":\"correct-horse-9\",\"dateOfBirth\":\"1995-04-02\",\"confirmAge\":true}"
say "admin login without 2FA code"; curl $AD "${HA[@]}" -X POST $B/admin/login -d '{"username":"boss","password":"AdminPassword-12345"}'
CODE=$(node --input-type=module -e "import {totpAt} from './server/src/crypto.js'; console.log(totpAt('$TOTP_SECRET', Math.floor(Date.now()/30000)))")
say "admin login with 2FA"; curl $AD "${HA[@]}" -X POST $B/admin/login -d "{\"username\":\"boss\",\"password\":\"AdminPassword-12345\",\"code\":\"$CODE\"}"
say "player session on admin route"; curl $P $B/admin/limits
say "admin turns everything off"; curl $AD "${HA[@]}" -X PUT $B/admin/providers -d '{"mpesa":{"enabled":false},"cashia":{"enabled":false}}' >/dev/null; sleep 6; echo ok
say "bet while table closed"; curl $P "${H[@]}" -X POST $B/bets -d '{"slot":"A","stake":10}'
PEM=$(node -e "const c=require('crypto');console.log(JSON.stringify(c.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'pem'})))")
say "save M-Pesa sandbox creds (TEST-ONLY values)"; curl $AD "${HA[@]}" -X PUT $B/admin/credentials/mpesa/sandbox -d "{\"consumerKey\":\"TESTONLY-ck-abcd\",\"consumerSecret\":\"TESTONLY-cs-wxyz\",\"passkey\":\"TESTONLY-pk-1234\",\"shortcode\":\"174379\",\"initiatorName\":\"testapi\",\"initiatorPassword\":\"TESTONLY-pw-9876\",\"certificatePem\":$PEM,\"callbackBaseUrl\":\"https://example.test\"}"
say "admin provider view leaks no secrets"; curl $AD $B/admin/providers | grep -o 'TESTONLY[^"]*' || echo "(none found — only masks)"
say "switch to production without licence"; curl $AD "${HA[@]}" -X PUT $B/admin/providers -d '{"mpesa":{"environment":"production"}}'
say "enable Cashia without creds"; curl $AD "${HA[@]}" -X PUT $B/admin/providers -d '{"cashia":{"enabled":true}}'
say "enable M-Pesa"; curl $AD "${HA[@]}" -X PUT $B/admin/providers -d '{"mpesa":{"enabled":true}}'
sleep 6
say "public config"; curl -s $B/config
say "deposit bad phone"; curl $P "${H[@]}" -X POST $B/deposits -d '{"provider":"mpesa","amount":500,"phone":"0612"}'
say "deposit via disabled provider"; curl $P "${H[@]}" -X POST $B/deposits -d '{"provider":"cashia","amount":500,"phone":"0712345678"}'
say "deposit below min"; curl $P "${H[@]}" -X POST $B/deposits -d '{"provider":"mpesa","amount":5,"phone":"0712345678"}'
DEP=$(curl $P "${H[@]}" -X POST $B/deposits -d '{"provider":"mpesa","amount":500,"phone":"0712345678"}')
say "deposit 500"; echo "$DEP"
PID=$(echo "$DEP" | j .id)
say "balance before callback"; curl $P $B/me
say "client tries to send a balance"; curl $P "${H[@]}" -X POST $B/bets -d '{"slot":"A","stake":10,"balance":99999}'
TOKEN=$(node --input-type=module -e "import {callbackToken} from './server/src/crypto.js'; console.log(callbackToken('$PID','stk'))")
REF=$(psql -h /tmp/pg -p 5433 -U postgres crash -tAc "select provider_ref from payments where id='$PID'")
CB="{\"Body\":{\"stkCallback\":{\"MerchantRequestID\":\"m\",\"CheckoutRequestID\":\"$REF\",\"ResultCode\":0,\"ResultDesc\":\"ok\",\"CallbackMetadata\":{\"Item\":[{\"Name\":\"Amount\",\"Value\":500},{\"Name\":\"MpesaReceiptNumber\",\"Value\":\"RCP$RANDOM\"},{\"Name\":\"PhoneNumber\",\"Value\":254712345678}]}}}}"
say "forged STK callback"; curl -s -X POST $B/hooks/mp/stk/$PID/badtoken -H "Content-Type: application/json" -d "$CB"
say "real STK callback"; curl -s -X POST $B/hooks/mp/stk/$PID/$TOKEN -H "Content-Type: application/json" -d "$CB"
say "replayed STK callback"; curl -s -X POST $B/hooks/mp/stk/$PID/$TOKEN -H "Content-Type: application/json" -d "$CB"
sleep 1
say "balance after verified callback"; curl $P $B/me
# wait for betting phase
for i in $(seq 1 40); do S=$(psql -h /tmp/pg -p 5433 -U postgres crash -tAc "select status from rounds order by id desc limit 1"); [ "$S" = betting ] && break; sleep 0.5; done
say "place bet A 100 (auto 1.01) and B 50"; curl $P "${H[@]}" -X POST $B/bets -d '{"slot":"A","stake":100,"autoCashout":1.01}'; echo; BB=$(curl $P "${H[@]}" -X POST $B/bets -d '{"slot":"B","stake":50}'); echo "$BB"
BID=$(echo "$BB" | j .bet.id)
for i in $(seq 1 40); do S=$(psql -h /tmp/pg -p 5433 -U postgres crash -tAc "select status from rounds order by id desc limit 1"); [ "$S" != betting ] && break; sleep 0.25; done
sleep 0.3
say "cash out B (manual)"; curl $P "${H[@]}" -X POST $B/bets/$BID/cashout
sleep 1
for i in $(seq 1 120); do S=$(psql -h /tmp/pg -p 5433 -U postgres crash -tAc "select status from rounds order by id desc limit 1"); [ "$S" = betting ] && break; sleep 0.5; done
say "my bets"; curl $P $B/bets/mine | node -e "const b=JSON.parse(require('fs').readFileSync(0));for(const x of b.slice(0,2))console.log(x.slot,x.status,'stake',x.stake,'cash',x.cashoutMult,'crash',x.crash,'payout',x.payout)"
say "me"; curl $P $B/me
say "withdraw too much"; curl $P "${H[@]}" -X POST $B/withdrawals -d '{"provider":"mpesa","amount":100000,"phone":"0712345678"}'
W=$(curl $P "${H[@]}" -X POST $B/withdrawals -d '{"provider":"mpesa","amount":200,"phone":"0112345678"}')
say "withdraw 200"; echo "$W"
say "me (reserved)"; curl $P $B/me
WID=$(echo "$W" | j .id)
WT=$(node --input-type=module -e "import {callbackToken} from './server/src/crypto.js'; console.log(callbackToken('$WID','b2c'))")
WREF=$(psql -h /tmp/pg -p 5433 -U postgres crash -tAc "select provider_ref from payments where id='$WID'")
say "B2C success result"; curl -s -X POST $B/hooks/mp/b2c/$WID/$WT -H "Content-Type: application/json" -d "{\"Result\":{\"ResultType\":0,\"ResultCode\":0,\"ResultDesc\":\"ok\",\"OriginatorConversationID\":\"$WREF\",\"ConversationID\":\"AG\",\"TransactionID\":\"TX$RANDOM\",\"ResultParameters\":{\"ResultParameter\":[{\"Key\":\"TransactionAmount\",\"Value\":200}]}}}"
sleep 1
say "payment status"; curl $P $B/payments/$WID
say "me after payout"; curl $P $B/me
ACCT=$(curl $P $B/me | j .user.accountNo)
C2BT=$(node --input-type=module -e "import {callbackToken} from './server/src/crypto.js'; console.log(callbackToken('c2b-sandbox','c2b'))")
say "paybill validation for account $ACCT"; curl -s -X POST $B/hooks/mp/c2b/sandbox/validate/$C2BT -H "Content-Type: application/json" -d "{\"TransID\":\"QX1\",\"TransAmount\":\"100\",\"BusinessShortCode\":\"174379\",\"BillRefNumber\":\"$ACCT\",\"MSISDN\":\"254712345678\"}"
say "paybill validation bad account"; curl -s -X POST $B/hooks/mp/c2b/sandbox/validate/$C2BT -H "Content-Type: application/json" -d '{"TransID":"QX2","TransAmount":"100","BusinessShortCode":"174379","BillRefNumber":"999999","MSISDN":"254712345678"}'
say "paybill validation forged token"; curl -s -X POST $B/hooks/mp/c2b/sandbox/validate/nope -H "Content-Type: application/json" -d '{}'
UID_=$(psql -h /tmp/pg -p 5433 -U postgres crash -tAc "select id from users where username='$U'")
say "admin adjustment without reason"; curl $AD "${HA[@]}" -X POST $B/admin/users/$UID_/adjust -d '{"amount":10}'
say "admin adjustment"; curl $AD "${HA[@]}" -X POST $B/admin/users/$UID_/adjust -d '{"amount":10,"reason":"goodwill credit test","requestId":"r1"}'
say "ledger"; curl $AD $B/admin/users/$UID_ | node -e "const d=JSON.parse(require('fs').readFileSync(0));for(const l of d.ledger.reverse())console.log(l.type.padEnd(20),String(l.amount_cents).padStart(8),l.provider||'',l.reason||'');console.log('balance',d.balance)"
say "turn M-Pesa off -> deposit blocked, ledger kept"; curl $AD "${HA[@]}" -X PUT $B/admin/providers -d '{"mpesa":{"enabled":false}}' >/dev/null; curl $P "${H[@]}" -X POST $B/deposits -d '{"provider":"mpesa","amount":500,"phone":"0712345678"}'
echo; curl -s $B/config; echo
curl $AD "${HA[@]}" -X PUT $B/admin/providers -d '{"mpesa":{"enabled":true}}' >/dev/null
echo; echo DONE

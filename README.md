# Crash: real-money crash game with M-Pesa and Cashia

There is one crash table with two independent bets per round, a provably fair crash point, and an append-only ledger. Deposits and withdrawals are real, through Safaricom Daraja (M-Pesa) and Cashia. The admin enters provider keys at runtime in the admin console.

> **Licensing.** This is real-money gambling software. Production payments stay switched off until an admin sets the operator-licence flag, giving the jurisdiction and licence number. That flag is a software gate only. It does not replace the licence itself (in Kenya, from the BCLB).

## Architecture

```
browser ──HTTPS──▶ web (Express)  ── /api/*        player API (session cookie + CSRF)
                 │                ── /api/admin/*  admin API (separate admin session, role checked per request)
                 │                ── /api/hooks/*  provider callbacks (the only unauthenticated writes)
                 └──WSS──▶ web    ── /ws           read-only live feed
web ◀── LISTEN/NOTIFY ──▶ Postgres ◀── worker (round engine, single leader via advisory lock)
```

* **Server-authoritative rounds.** The worker creates each round, commits `sha256(serverSeed)` before betting opens, and drives timing from DB timestamps rather than `setInterval` counts. Clients only see the hash, the server's tick multipliers and accepted cashouts. The crash point and server seed are sent only after the crash.
* **Cashout.** `POST /api/bets/:id/cashout` locks the round row, computes the multiplier from `clock_timestamp() - started_at`, and rejects the cashout if that multiplier is at or above the crash point. Auto cashouts pay exactly their target whenever the target is below the crash, even if no tick landed on it.
* **Multiple web instances.** Every instance shares the database. Only one worker holds the engine lock. Others wait and take over if it dies.
* **Ledger.** `ledger_entries` is append-only, enforced by a DB trigger. Balance is `SUM(amount_cents)`. Every entry has a UNIQUE idempotency key such as `deposit:mpesa:<CheckoutRequestID>`, `bet:<id>` or `wd_reserve:<payment>`. Entry types: `deposit_pending`, `deposit_confirmed`, `deposit_failed`, `bet_debit`, `bet_refund`, `cashout_credit`, `withdrawal_reserved`, `withdrawal_paid`, `withdrawal_failed` and `adjustment`. `bet_refund` was added for cancelling a bet before takeoff. Reserves are subtracted at reservation time, so bets can never spend them.

## Provably fair

```
h     = HMAC_SHA256(key = serverSeed, msg = clientSeed + ":" + nonce)     nonce = round id
X     = int(first 13 hex of h) / 2^52
crash = max(1.00, floor((1 − 0.01) / (1 − X) × 100) / 100)               house edge 1.00%
multiplier(t) = e^(0.00006 · t_ms)
```

`/fair` verifies any round in the browser, and the same function lives in `server/src/fair.js` and `client/src/fair.js`.

## Payments

### M-Pesa (Safaricom Daraja, official): everything runs on your paybill
One paybill number is used for all three flows: STK push, paybill (C2B) deposits and B2C payouts.

* **Paybill deposit (C2B):** each player has a 6-digit account number with a Luhn check digit (shown in the cashier), so a mistyped account is rejected rather than crediting someone else. The customer goes to *Lipa na M-Pesa → Paybill*, enters your business number and their account number, and pays.
  * **Register URLs:** Admin → Providers → *Register sandbox/production URLs* calls `/mpesa/c2b/v1/registerurl` with `ResponseType=Completed`. In production Safaricom only lets you register once per shortcode, so register after your domain is final.
  * **Validation:** if Safaricom enabled external validation on your paybill, unknown accounts (`C2B00012`) and out-of-limit amounts (`C2B00013`) are rejected before the money moves.
  * **Confirmation:** the payment is recorded idempotently by `TransID`, so Safaricom retries don't duplicate it. Nothing is credited yet. The server then runs a **Transaction Status query** (`/mpesa/transactionstatus/v1/query`) for that `TransID`. The balance is credited only when Safaricom's result returns `Completed` with a matching receipt and amount.
  * **Unknown account:** a payment to an account number that doesn't exist (possible when validation isn't enabled) is kept as *unassigned*. Once it has been verified with Safaricom, an admin can assign it to the right player under Payments → *Unassigned paybill only*, giving a reason. This is audited.
  * The C2B URLs carry a static secret token per environment. Combined with the optional IP allowlist, it rejects forged callbacks.
* **STK push deposit:** (`/mpesa/stkpush/v1/processrequest`). The balance is credited only after a callback that (1) carries the per-payment HMAC token in its URL, (2) matches the stored `CheckoutRequestID`, and (3) is confirmed by an independent **STK Query**, with the amount checked. Replays are no-ops: the payment row is locked and the idempotency key and receipt number are both unique. Deposits stuck pending are re-queried every minute by the worker.
* **Withdrawal:** B2C from the paybill (`/mpesa/b2c/v1/paymentrequest`, `CommandID=BusinessPayment`, `PartyA` = your paybill). Safaricom must enable B2C on your shortcode when you go live. If they issue a separate B2C shortcode instead, enter it in the optional field. The amount is reserved first. A result with `ResultCode 0` finalises the payout. A failure releases the reserve. A timeout or unknown outcome moves the payment to `needs_review` and is **never** auto-released. The admin resolves it after checking the M-Pesa org portal.
* Daraja does not sign its callbacks. Their authenticity rests on the unguessable per-payment URL token, an optional source-IP allowlist (set in admin), reference matching, and the STK Query for deposits.
* Callback paths avoid the words "mpesa" and "safaricom", because Daraja rejects URLs containing them.
* **Admin fields:** consumer key/secret, passkey, paybill number, API initiator name/password (used for B2C and transaction-status queries), an optional separate B2C shortcode, the **Safaricom public certificate (PEM)** used to encrypt the initiator password into the `SecurityCredential` (download it from the Daraja portal: sandbox and production certificates differ), and the callback base URL.

### Cashia
Only what Cashia's published *Merchant API Documentation v1.0.9* defines is used:
* Request signing: `X-Cashia-Key-ID`, `-Nonce`, `-Timestamp`, `-Hash` (HMAC of the body), and `-Signature` (HMAC of `host + METHOD + timestamp + nonce + keyId`).
* **Deposit:** `POST /v1/hosted-checkout`. The player completes payment on Cashia's page. The webhook URL carries an HMAC token keyed by the admin's *webhook secret*. Before crediting, the server calls `GET /v1/transactions/:id`, checks the status, the amount and that `requestIdentifier` equals our payment id.
* **Withdrawals: not available.** Cashia's public docs mention payouts to M-Pesa in their changelog but don't publish the endpoint or fields. To avoid inventing an API, `cashiaPayout()` refuses, the admin console says so, and the cashier only offers M-Pesa for withdrawals. Once Cashia sends you the payout spec, implement it in `server/src/providers/cashia.js` and set `CASHIA_PAYOUTS_SUPPORTED = true`.
* **Confirm before production:** check the exact success status strings (`CASHIA_PAID_STATUSES`) and the webhook body's transaction-id field against Cashia's Swagger for your account. Cashia's live API host is "TBD" in their docs, so the admin enters the base URL per environment, e.g. `http://pre-prod.cashia.com/api` for test.

### Provider switch
In the admin console you can run M-Pesa only, Cashia only, both, or neither. With neither, the table is read-only. Turning a provider off hides it and blocks new transactions without deleting anything. In-flight callbacks still settle. Sandbox and production credentials are separate records. Switching to production requires the licence flag, and clearing the flag forces everything back to sandbox.

## Built for scale (target: 1M+ registered players)
* **Hot-path locking.** Cashouts take a `FOR SHARE` lock on the round, so thousands run in parallel. Each one checks the server clock against the crash point itself, so the shared lock never lets a late cashout through. Only the crash and auto-cashout transactions take `FOR UPDATE`. Multi-user settlement locks users in id order to avoid deadlocks.
* **O(1) balances.** The ledger stays the source of truth. A trigger keeps `user_balances` equal to `SUM(ledger)` inside the same transaction, so debits never scan history. `CHECK (balance_cents >= 0)` makes a negative balance impossible at the database level, and the worker re-verifies cache against ledger every hour, logging `BALANCE DRIFT DETECTED` if they ever disagree.
* **Fan-out.** The room feed is batched (≤ 1 message per 250 ms per instance, capped at 60 items) rather than one message per bet per socket. Slow WebSocket clients are skipped instead of buffering server memory. Add web instances behind the load balancer to hold more sockets.
* **Connections.** `DATABASE_URL` can point at a transaction-mode pooler (PgBouncer, Neon pooler, Supabase Supavisor). `DATABASE_DIRECT_URL` is the direct connection used for LISTEN/NOTIFY, the engine's advisory lock and migrations. Tune `PG_POOL_MAX` per process.
* **Rate limits.** Login, STK push and withdrawals use the shared Postgres limiter, because those are security-critical. Bets, cashouts and callbacks use an in-process token bucket, so the hot path doesn't write a rate-limit row per request.
* **Load test** (`server/test/load.mjs`): 500 players placing 1,000 bets in one betting window, then 500 simultaneous cashouts mid-flight, on one web process and one local Postgres. Result: all 200 OK, bets in ~2.4 s, cashouts in ~1.1 s, 0 unsettled bets, 0 balance drift, money conserved.
* **Next steps as you grow:** read replicas for history and admin queries; monthly partitioning of `ledger_entries`, `bets` and `webhook_events` once they pass ~100M rows; a CDN in front of the static client; Redis only if WebSocket fan-out across many instances needs it.

## Database: what to use
Use **PostgreSQL** (this app depends on its transactions, row locks, triggers, LISTEN/NOTIFY and advisory locks). Free tiers, as of Nov 2026:

| | Free storage | Catch for this app |
|---|---|---|
| **Neon** | 1 GB per project, 100 CU-hours/month | The round engine never lets the DB sleep. 0.25 CU × ~730 h ≈ 183 CU-h, so free compute runs out mid-month. Has a pooler plus direct URL. |
| **Supabase** | 500 MB | 2 projects. Pooler plus direct URL fit `DATABASE_URL` / `DATABASE_DIRECT_URL`. No backups on free. |
| **Aiven** | 1 GB, always on, 1 GB RAM | Max 20 connections and no pooler: set `PG_POOL_MAX=6`. No HA. |

For **development and staging**, Aiven (always on) or Supabase work. For **production with real money and a million customers, don't use a free tier.** You need high availability, point-in-time recovery and more than 1 GB of disk. A ledger for 1M players grows by gigabytes per month. Neon Launch, Supabase Pro or a managed Postgres near Kenya (e.g. AWS RDS in `af-south-1`) all work with this code unchanged.

**Hosting note:** Safaricom posts callbacks to your server. Hosts whose free tier sleeps when idle will miss deposits. Run web and worker on an always-on plan.

## Security
* **Admin two-factor (TOTP) is mandatory.** `npm run create-admin -- <name>` prints a secret to add to an authenticator app. Codes are single-use, and a reused code is rejected. Running the command again rotates the secret and kills existing sessions.
* Provider secrets and phone numbers are encrypted at rest with AES-256-GCM, using `SETTINGS_ENCRYPTION_KEY` from the host's secret store. They are decrypted only inside the process calling the provider. Credential forms are write-only and show last-four masks.
* Sessions are opaque random tokens, stored hashed, in `__Host-` Secure HttpOnly cookies. Admin sessions are separate (SameSite=Strict, 8 h) and the role is re-checked on every request. Admin accounts can't sign in as players.
* CSRF uses a double-submit token plus an Origin check on every browser POST.
* Rate limits are Postgres-backed, so they hold across instances: login, register, STK push, withdrawals, bets and callbacks.
* The server refuses bodies carrying `balance`, `payout`, `multiplier`, etc. The client sends intent only.
* Logs scrub phone numbers and anything that looks like a secret. Stored callback bodies have MSISDNs and receiver names redacted.
* HTTPS redirect, HSTS, CSP and frame-deny headers. Age gate before the table, plus date-of-birth (18+) at registration.

## Run it

```bash
npm ci
export DATABASE_URL=postgres://...  SETTINGS_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")  PUBLIC_ORIGIN=http://localhost:3000
npm run migrate
npm run create-admin -- boss        # prompts for a password (14+ chars), prints the 2FA secret
npm run build                       # client → client/dist
npm start                           # web on :3000
npm run worker                      # round engine (separate process)
```
Then open `/admin` (password + authenticator code), add sandbox credentials, enable M-Pesa, click *Register sandbox URLs* for paybill deposits, and play at `/`.

**Tests** (they need a throwaway DB whose name contains `test`). There are 12 integration tests, including paybill C2B, unassigned-payment assignment, balance-cache integrity and TOTP:
`DATABASE_URL=postgres://…/crash_test npm test`. They cover provably-fair distribution, verified-callback-only crediting, forged and replayed callbacks, STK-query mismatch, bet/cancel/cashout/auto-cashout, late cashout rejection, the withdrawal reserve/release/finalise path, append-only enforcement and the provider kill-switch. `server/test/e2e.sh` runs the same flows over HTTP against a running stack, with `server/test/mock-fetch.js` preloaded so Safaricom can be faked locally. That file refuses to load in production.

## Deploy option A: frontend on Vercel, backend on an always-on host

Vercel only serves static files and short-lived functions. It **cannot** run the round worker, hold WebSockets, or reliably receive M-Pesa callbacks. So the site goes on Vercel, and the API and worker run on any host that keeps a Node process running (a Docker host or VM using the `Dockerfile`).

1. **Backend** (e.g. `https://api.yourdomain.co.ke`): deploy the Docker image twice, once as web and once as worker (`node server/src/worker.js`). Set these in its secret store:
   * `DATABASE_URL`, `DATABASE_DIRECT_URL`, `SETTINGS_ENCRYPTION_KEY`, `NODE_ENV=production`
   * `PUBLIC_ORIGIN=https://<your-vercel-domain>`: the site players open. Used for CSRF and Origin checks.
   * `PUBLIC_WS_URL=wss://api.yourdomain.co.ke/ws`: the browser connects its live feed straight to the backend.
   * `TRUST_PROXY=2` (Vercel plus your host's load balancer), so rate limits see the player's real IP.
2. **Vercel:** `vercel.json` already sets the build (`npm run build` → `client/dist`). Replace both `REPLACE-WITH-YOUR-BACKEND-DOMAIN` placeholders with your backend domain: one in the `/api` rewrite, one in the CSP `connect-src`. Vercel then proxies `/api/*` on the same domain, so session cookies, CSRF and admin all work unchanged.
3. **Live feed sign-in:** Vercel can't proxy WebSockets, so the socket goes directly to the backend. A signed-in player's socket is authenticated with a 60-second HMAC ticket from `POST /api/ws-ticket`, because cookies don't cross domains.
4. **M-Pesa / Cashia callback base URL** (admin → Credentials): use the **backend** domain directly, not Vercel. That's one fewer hop, and no proxy timeouts on Safaricom's callbacks.

## Deploy option B: single host (zero-downtime)
1. Build the image (`Dockerfile`). It excludes tests and contains no secrets.
2. Set `DATABASE_URL`, `SETTINGS_ENCRYPTION_KEY`, `PUBLIC_ORIGIN` (https) and `NODE_ENV=production` in the host's secret store.
3. Release step: `node server/scripts/migrate.js`. Migrations are forward-only and run under an advisory lock.
4. Run N × `web` (default CMD) behind your TLS load balancer on one domain, plus ≥ 1 × `worker` (`node server/src/worker.js`). Extra workers sit as hot standbys.
5. Set the Daraja callback base URL and the Cashia callback base URL to that same public HTTPS domain.

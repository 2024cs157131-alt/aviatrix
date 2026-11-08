# Crash: real-money crash game with M-Pesa and Cashia

There is one crash table with two independent bets per round, a provably fair crash point, and an append-only ledger. Deposits and withdrawals are real, through Safaricom Daraja (M-Pesa) and Cashia. The admin enters provider keys at runtime in the admin console.

> **Licensing.** This is real-money gambling software. Production payments stay switched off until an admin sets the operator-licence flag, giving the jurisdiction and licence number. That flag is a software gate only. It does not replace the licence itself (in Kenya, from the BCLB).

> **Hosting it now?** Follow [Your setup: Vercel + Railway + Neon](#your-setup-vercel-site--railway-backend--neon-database). Other options are further down.

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

## Your setup: Vercel (site) + Railway (backend) + Neon (database)

Players open the Vercel domain. Vercel forwards `/api/*` to Railway, and the live feed connects straight to Railway. Railway runs two services: `web` (the API) and `worker` (the round engine). M-Pesa posts its callbacks directly to Railway. All data lives in Neon.

```
player ──https──▶ Vercel (site) ──/api──▶ Railway web ──▶ Neon
       └──wss (live feed)─────────────▶ Railway web
Safaricom ──callbacks──────────────────▶ Railway web
                                         Railway worker ──▶ Neon
```

Do the steps in this order: each one gives you a value the next one needs.

### Step 1: Neon (database)
1. neon.com → **New project**. Pick a **Europe** region and use a Europe region on Railway too (Railway: EU West), so the backend and database sit close together.
2. **Connect** → copy two connection strings:
   * **Pooled** (hostname contains `-pooler`) → you'll use this as `DATABASE_URL`
   * **Direct** (turn *Connection pooling* off) → `DATABASE_DIRECT_URL`
3. Remember the free-plan limit: the engine keeps Neon busy all the time, so the free 100 compute-hours run out after about 2½ weeks. That's fine while you build. Upgrade to Neon's paid plan before launch.

### Step 2: Encryption key
On your computer:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
Save it in a password manager. Lose it, and saved provider keys can't be read. Never commit it.

### Step 3: Railway `web` service
1. railway.com → **New Project → Deploy from GitHub repo → `aviatrix`**. Rename the service **`web`**. This needs the Hobby plan.
2. **Settings:**
   * **Region:** EU West
   * **Networking → Generate Domain.** Copy it, e.g. `https://aviatrix-web.up.railway.app`. This is your **backend domain**.
   * **Deploy → Pre-deploy command:** `npm run migrate`
   * **Deploy → Healthcheck path:** `/healthz`
3. **Variables:**

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon **pooled** string |
| `DATABASE_DIRECT_URL` | Neon **direct** string |
| `DATABASE_SSL` | `true` |
| `SETTINGS_ENCRYPTION_KEY` | key from step 2 |
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | `2` |
| `PUBLIC_WS_URL` | `wss://<backend domain>/ws` |
| `PUBLIC_ORIGIN` | for now `https://<backend domain>`; you'll change it to the Vercel domain in step 6 |

Deploy. The logs should show `applied 001_init.sql`, `applied 002_paybill_scale.sql`, then `web listening`.

### Step 4: Railway `worker` service
1. In the same project: **+ New → GitHub Repo → `aviatrix`**. Name it **`worker`** and set the region to EU West.
2. **Variables:** the same as `web`. Railway's *Shared Variables* save retyping.
3. **Settings → Deploy → Custom start command:** `node server/src/worker.js`. No domain, and no pre-deploy command.
4. The logs show `engine leader acquired`. Rounds are now running. Keep exactly one worker.

### Step 5: Vercel (site): already imported, just point it at Railway
The repo is already connected to Vercel, and every push to `main` redeploys it automatically. Until this step, the site loads but `/api` points at a placeholder, so sign-in and the game don't work yet.
1. Point `vercel.json` at your backend domain, in any one of these ways:
   * **Computer:** `npm ci && npm run set-backend -- https://<backend domain>`, then `git commit -am "Point Vercel at Railway backend" && git push`
   * **GitHub website:** open `vercel.json` → ✏️ Edit. Replace `REPLACE-WITH-YOUR-BACKEND-DOMAIN` in **both** places with your backend domain *without* `https://` (e.g. `aviatrix-web.up.railway.app`). Commit to `main`.
   * **Ask Claude:** send the backend domain and it will make and push the change.
2. Vercel redeploys on its own within a minute or two. In the project settings, check that **Framework Preset = Other** and that the build/output overrides are **off**, so `vercel.json` is what's used.
3. Copy the Vercel domain, e.g. `https://aviatrix.vercel.app`. This is your **site domain**.

### Step 6: Connect Railway to the site domain
On **both** `web` and `worker`, set `PUBLIC_ORIGIN=https://<site domain>`, with no trailing slash. Redeploy both.
From now on, players and admins use the **site domain** only. Logins and forms on the bare Railway domain are refused on purpose.

### Step 7: Admin account (from your computer, once)
```bash
DATABASE_URL='<Neon DIRECT string>' SETTINGS_ENCRYPTION_KEY='<key>' npm run create-admin -- yourname
```
(Windows PowerShell: run `$env:DATABASE_URL='...'; $env:SETTINGS_ENCRYPTION_KEY='...'` first, then `npm run create-admin -- yourname`.)
Choose a password of 14+ characters. Add the printed **2FA secret** to your authenticator app, then clear the terminal.

### Step 8: M-Pesa (sandbox)
Open `https://<site domain>/admin` and sign in with username, password and authenticator code.
1. **Credentials → M-Pesa · sandbox:** your Daraja sandbox keys, paybill, passkey, initiator, and the pasted sandbox certificate.
   **Callback base URL = `https://<backend domain>`** (Railway, *not* Vercel), so Safaricom reaches the backend directly.
2. **Limits:** set your minimums and maximums.
3. **Providers:** M-Pesa **On**, environment sandbox, then **Register sandbox URLs** (paybill C2B).
4. Open `https://<site domain>`, register a player, and make a test deposit from the **Cashier**. The balance moves only after Safaricom's callback. Watch the Railway **web → Logs** for `stk sent` → `deposit confirmed`.

### Step 9: Before taking real money
* **Neon:** upgrade to a paid plan (so compute never runs out, and you get point-in-time restore). Test one restore.
* **Safaricom:** Go Live with your production Daraja app. Ask them to enable B2C on your paybill and C2B validation.
* **Admin:** enter your BCLB licence (Providers → Operator licence), production credentials and certificate. Switch M-Pesa to production, then **Register production URLs**. This is allowed once per paybill, so do it after your final domains are set.
* **Optional custom domains:** e.g. `play.yourdomain.co.ke` on Vercel and `api.yourdomain.co.ke` on Railway. If you add them, rerun `npm run set-backend` and update `PUBLIC_ORIGIN`, `PUBLIC_WS_URL` and the callback base URL, *before* registering production URLs.

### If something's wrong
| Symptom | Cause / fix |
|---|---|
| Site loads but shows "Connecting…" forever | `PUBLIC_WS_URL` is wrong, or `vercel.json` still has the placeholder. Rerun `set-backend`, push, and check the browser console for a CSP error. |
| Every login/POST says `bad_origin` or `csrf` | `PUBLIC_ORIGIN` on Railway ≠ the Vercel address in the browser bar. |
| `/api/...` returns 404 or a Vercel error page | The `vercel.json` rewrite still points at the placeholder or an old domain. |
| Worker logs `engine error` about the connection | Check `DATABASE_DIRECT_URL` (it must be the non-pooler Neon string) and `DATABASE_SSL=true`. |
| Everything stops mid-month | Neon free compute-hours ran out. Upgrade Neon. |

## Which service does what (Vercel, Neon, Railway, Render)

The app has three parts, and each needs a different kind of host:

| Part | What it needs | Can use |
|---|---|---|
| **Website** (React files) | Static hosting | **Vercel**, or the backend serves it itself |
| **Backend**: API + round engine + M-Pesa callbacks | A Node process that is **always on** | **Railway** (Hobby), **Render** (paid, or free with the workaround below), any VPS. **Not Vercel.** |
| **Database** | PostgreSQL | **Neon**, Railway Postgres, Supabase, Aiven |

So Vercel and Neon don't replace Railway or Render. A typical setup is **Vercel (site) + Railway or Render (backend) + Neon (database)**.

### Using Neon as the database
1. Create a Neon project in the region closest to your backend.
2. Copy **two** connection strings from *Connect*:
   * **Pooled** (hostname contains `-pooler`) → `DATABASE_URL`
   * **Direct** (no `-pooler`) → `DATABASE_DIRECT_URL`. This is needed for live updates, the engine lock and migrations.
3. Set `DATABASE_SSL=true`. Neon's certificate is publicly trusted, so the connection is fully verified.
4. **Free-plan catch:** the round engine queries the database every second of the day, so Neon never gets to sleep. The free plan's 100 compute-hours a month run out after roughly 2½ weeks at the smallest size (0.25 CU × 24 h × 31 days ≈ 186 CU-hours). After that the database stops until the next month. Use Neon free for development. For a live game, move to Neon's paid plan; at the smallest size that's on the order of $20/month in compute.

## Free option: Render, single service (testing only)

Render's free tier has two problems for this app: free web services sleep after 15 minutes without traffic, and background workers aren't free. The workaround:
* **`RUN_ENGINE_IN_WEB=true`** runs the round engine inside the web service, so no separate worker is needed.
* **`MIGRATE_ON_START=true`** applies database migrations when the service boots, because there's no release step on free.
* **An uptime monitor** pings the site every 5 minutes so it never goes idle long enough to sleep.

Steps:
1. **Database first.** Use Neon (above) or Aiven. Don't use Render's free Postgres, because it expires.
2. Render → **New → Web Service** → connect the `aviatrix` repo → runtime **Docker** → instance type **Free**.
3. **Environment variables:** `DATABASE_URL`, `DATABASE_DIRECT_URL`, `DATABASE_SSL=true`, `SETTINGS_ENCRYPTION_KEY` (generate it as in Railway step 1), `NODE_ENV=production`, `TRUST_PROXY=1`, `RUN_ENGINE_IN_WEB=true`, `MIGRATE_ON_START=true`, and `PUBLIC_ORIGIN=https://<your-service>.onrender.com`.
4. **Health check path:** `/healthz`. Deploy, and the logs should show `round engine running inside web process`.
5. **Keep it awake:** create a free account on an uptime-monitoring service (for example UptimeRobot) and add an HTTP monitor on `https://<your-service>.onrender.com/healthz` every 5 minutes. Render's 750 free hours a month cover one service running all month, as long as it's your only free service.
6. **Admin and M-Pesa:** same as Railway steps 5–6 above. Use the Neon **direct** URL as `DATABASE_URL` when running `create-admin` from your computer.

**Don't take real money on this setup.** The free instance has a fraction of a CPU, and it still restarts on deploys. If it's ever asleep or restarting when Safaricom sends a paybill confirmation, that payment arrives in your paybill without being recorded, and you'd have to credit it by hand. STK deposits recover automatically, because the engine re-checks pending ones every minute once it's running. Move to an always-on paid instance (Railway Hobby or Render Starter) before launch.

## Host the backend now: step by step (Railway)

This puts the **whole app** (API, worker, database, and the game site itself) on Railway. It runs on one HTTPS domain, so you can play and test straight away. Vercel is optional; see the next section.

**Why Railway:** it deploys this repo's `Dockerfile` straight from GitHub, keeps processes running 24/7, supports WebSockets, and gives you HTTPS. It needs the **Hobby plan ($5/month, which includes $5 of usage)**. Web + worker + Postgres for a small launch should cost roughly $5–10/month. Check the usage page after the first week.
**Why not Render's free tier:** free web services sleep after 15 minutes idle, so you'd miss M-Pesa callbacks, and background workers have no free tier.

### 0. Before you start
* This repo on GitHub, and a Railway account (sign in with GitHub). Upgrade to Hobby.
* Node.js 20+ on your computer. You need it once, to create the admin account.
* Your Daraja sandbox app from developer.safaricom.co.ke: consumer key/secret, test paybill shortcode + passkey, initiator name + password, and the **sandbox certificate** (`.cer`, from the Daraja docs).
* An authenticator app on your phone (Google Authenticator, Authy, Microsoft Authenticator).

### 1. Make the encryption key, and keep it safe
On your computer:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
Save the output in a password manager. **If you lose it, every saved provider key becomes unreadable.** If it leaks, someone with database access can read them. Never commit it.

### 2. Create the project and database
1. Railway → **New Project → Deploy from GitHub repo** → pick `aviatrix`. Railway finds the `Dockerfile` and starts building. Rename this service **`web`**.
2. In the same project: **+ New → Database → PostgreSQL**.

### 3. Configure the `web` service
Open **web → Variables** and add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (a Railway reference: private network, no password copying) |
| `SETTINGS_ENCRYPTION_KEY` | the key from step 1 |
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | `1` |
| `PUBLIC_ORIGIN` | `https://<your web domain>` (fill in after step 4) |

Then **web → Settings**:
* **Networking → Generate Domain.** You get `https://<something>.up.railway.app`. Put that exact URL into `PUBLIC_ORIGIN`, with no trailing slash.
* **Deploy → Pre-deploy command:** `npm run migrate` (creates and updates tables before each release).
* **Deploy → Healthcheck path:** `/healthz`
* Leave the start command empty. The Dockerfile already runs the web server.

Redeploy. Open the domain: you should see the 18+ gate and the table in read-only mode.

### 4. Add the `worker` service (round engine)
1. **+ New → GitHub Repo → `aviatrix`** again, and name it **`worker`**.
2. **Variables:** the same `DATABASE_URL`, `SETTINGS_ENCRYPTION_KEY`, `NODE_ENV`, `PUBLIC_ORIGIN` as `web`. Railway's *Shared Variables* save retyping.
3. **Settings → Deploy → Custom start command:** `node server/src/worker.js`. Don't generate a domain and don't add a pre-deploy command.

The worker logs `engine leader acquired`, and rounds start. Run exactly one worker. A second would only wait as a standby.

### 5. Create your admin account (from your computer, once)
1. Railway → **Postgres → Variables**: copy **`DATABASE_PUBLIC_URL`**. This is reachable from outside Railway; the private URL isn't.
2. On your computer:
```bash
git clone https://github.com/2024cs157131-alt/aviatrix && cd aviatrix && npm ci
DATABASE_URL='<DATABASE_PUBLIC_URL>' SETTINGS_ENCRYPTION_KEY='<key from step 1>' npm run create-admin -- yourname
```
(On Windows PowerShell, set the two variables with `$env:DATABASE_URL='...'` and `$env:SETTINGS_ENCRYPTION_KEY='...'` first, then run `npm run create-admin -- yourname`.)

3. Type a password of 14+ characters. The command prints a **2FA secret**: add it to your authenticator app (*Enter a setup key*, time-based), then clear the terminal. The **same encryption key** must be used here as on Railway, or 2FA won't verify.

### 6. Connect M-Pesa (sandbox first)
Go to `https://<your domain>/admin` and sign in with username, password and authenticator code.
1. **Credentials → M-Pesa · sandbox:** fill in every field. **Callback base URL** = `https://<your domain>`. For the **certificate**, open the sandbox `.cer` in a text editor and paste it (`-----BEGIN CERTIFICATE-----…`). Save. Afterwards you'll only ever see `••••` + last four characters.
2. **Limits:** set deposit, withdrawal and bet min/max.
3. **Providers:** tick **M-Pesa → On** (environment: sandbox), then click **Register sandbox URLs** under *Paybill (C2B) URLs*.
4. Open the site, register a player, and in **Cashier** try an STK deposit (follow the Daraja sandbox test instructions). The balance changes only when Safaricom's callback arrives. Watch **web → Logs** for `stk sent` → `deposit confirmed`. Problems show in **Admin → Payments → Details → Callbacks**.

### 7. Going live (production)
1. Get your production Daraja app approved by Safaricom ("Go Live"). Ask them to enable **B2C on your paybill** and, if you want unknown account numbers rejected up front, **C2B external validation**.
2. **Admin → Providers → Operator licence:** enter your BCLB licence number and jurisdiction. Production stays locked until this is set.
3. **Credentials → M-Pesa · production:** production keys plus the **production** certificate (it's different from the sandbox one).
4. Switch M-Pesa's environment to **production**, then click **Register production URLs**. Safaricom allows this once per paybill, so do it only after your final domain is set.
5. Optional but recommended: add Safaricom's published callback IPs under *Callback source IP allowlist*. Set `TRUST_PROXY` correctly first (Railway: `1`; behind Vercel: `2`), or the allowlist will see the wrong IPs.
6. Move the database to a paid plan with backups (Railway Postgres backups or a managed provider) before taking real money. Test a restore once.

### 8. Custom domain (optional)
**web → Settings → Networking → Custom Domain** (e.g. `play.yourdomain.co.ke`). Add the CNAME Railway shows at your DNS provider. Then update `PUBLIC_ORIGIN` on both services and the M-Pesa **Callback base URL** in admin, *before* registering production C2B URLs.

### Troubleshooting
| Symptom | Fix |
|---|---|
| `Missing required environment variable …` in logs | Add it on **both** web and worker. |
| `SETTINGS_ENCRYPTION_KEY must be 32 bytes` | Regenerate with the command in step 1. Paste it without quotes or spaces. |
| Every POST returns `bad_origin` / `csrf` | `PUBLIC_ORIGIN` must exactly equal the address in the browser bar (https, no trailing slash). |
| Table stays read-only | Admin → Providers: M-Pesa must be **On** with complete credentials for the selected environment. |
| Multiplier never moves | The worker isn't running or can't reach the DB. Check **worker → Logs** for `engine leader acquired`. |
| Admin: "Invalid or reused authenticator code" | The phone clock must be automatic. Each code works once, so wait for the next one. Re-running create-admin rotates the secret. |
| Deposits stay *pending* | Callback base URL is wrong or not https. Look in Admin → Payments → Details → Callbacks for received or rejected events. The worker re-checks pending STK deposits every minute. |
| Database on Supabase/Aiven | Set `DATABASE_SSL_CA` to their CA certificate (PEM). On Neon set `DATABASE_SSL=true`. Aiven free allows only 20 connections, so set `PG_POOL_MAX=6`. |

**Scaling later:** raise **web → Settings → Replicas** for more players. Keep `worker` at 1. Move Postgres up a plan as the ledger grows.

## Deploy option A: frontend on Vercel, backend on an always-on host

> Do the Railway steps above first. Then, to serve the site from Vercel, change these on **both** Railway services: `PUBLIC_ORIGIN=https://<your-vercel-domain>`, `PUBLIC_WS_URL=wss://<your railway web domain>/ws`, `TRUST_PROXY=2`. Keep the M-Pesa callback base URL on the Railway domain.

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

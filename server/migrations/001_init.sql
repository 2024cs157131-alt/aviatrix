-- Core schema. Money is stored in integer cents (KES * 100). Multipliers in hundredths (1.00x = 100).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE CHECK (username ~ '^[A-Za-z0-9_]{3,20}$'),
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player','admin')),
  date_of_birth DATE,
  age_confirmed_at TIMESTAMPTZ,
  disabled      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,            -- sha256 of the cookie value; raw token never stored
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('player','admin')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- Plain (non-secret) operator settings.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id)
);

-- Provider credentials: one record per (provider, environment). Secrets are AES-256-GCM ciphertext.
CREATE TABLE provider_credentials (
  provider    TEXT NOT NULL CHECK (provider IN ('mpesa','cashia')),
  environment TEXT NOT NULL CHECK (environment IN ('sandbox','production')),
  fields_enc  TEXT NOT NULL,                -- encrypted JSON of all fields
  masks       JSONB NOT NULL DEFAULT '{}',  -- last-four masks for display only
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT REFERENCES users(id),
  PRIMARY KEY (provider, environment)
);

CREATE TABLE rounds (
  id               BIGSERIAL PRIMARY KEY,   -- also the nonce
  server_seed      TEXT NOT NULL,           -- never sent to clients before status = 'crashed'
  server_seed_hash TEXT NOT NULL,
  client_seed      TEXT NOT NULL,
  crash_point      INTEGER NOT NULL CHECK (crash_point >= 100),  -- hundredths; secret until crash
  house_edge_bp    INTEGER NOT NULL,        -- basis points
  status           TEXT NOT NULL CHECK (status IN ('betting','running','crashed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  betting_ends_at  TIMESTAMPTZ NOT NULL,
  started_at       TIMESTAMPTZ,
  crashed_at       TIMESTAMPTZ
);
CREATE INDEX rounds_status_idx ON rounds(status) WHERE status <> 'crashed';

CREATE TABLE bets (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  round_id      BIGINT REFERENCES rounds(id),  -- NULL while queued for the next round
  slot          TEXT NOT NULL CHECK (slot IN ('A','B')),
  stake_cents   BIGINT NOT NULL CHECK (stake_cents > 0),
  auto_cashout  INTEGER CHECK (auto_cashout IS NULL OR auto_cashout >= 101),
  status        TEXT NOT NULL CHECK (status IN ('queued','active','cashed','lost','cancelled','rejected')),
  cashout_mult  INTEGER,
  payout_cents  BIGINT,
  reject_reason TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX bets_one_live_per_slot ON bets(user_id, round_id, slot) WHERE status IN ('active','cashed','lost');
CREATE UNIQUE INDEX bets_one_queued_per_slot ON bets(user_id, slot) WHERE status = 'queued';
CREATE INDEX bets_round_idx ON bets(round_id, status);
CREATE INDEX bets_user_idx ON bets(user_id, id DESC);

-- Payments with providers (deposits and withdrawals).
CREATE TABLE payments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        BIGINT NOT NULL REFERENCES users(id),
  provider       TEXT NOT NULL CHECK (provider IN ('mpesa','cashia')),
  environment    TEXT NOT NULL CHECK (environment IN ('sandbox','production')),
  direction      TEXT NOT NULL CHECK (direction IN ('deposit','withdrawal')),
  amount_cents   BIGINT NOT NULL CHECK (amount_cents > 0),
  phone_enc      TEXT NOT NULL,            -- encrypted full MSISDN (needed for payout / reconciliation)
  phone_masked   TEXT NOT NULL,            -- 2547******89
  status         TEXT NOT NULL CHECK (status IN ('initiating','pending','confirmed','failed','needs_review')),
  provider_ref   TEXT,                     -- CheckoutRequestID / OriginatorConversationID / Cashia requestId
  provider_txn   TEXT,                     -- M-Pesa receipt / B2C TransactionID / Cashia transaction id
  failure_reason TEXT,
  checkout_url   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payments_provider_ref_uq ON payments(provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE UNIQUE INDEX payments_provider_txn_uq ON payments(provider, provider_txn) WHERE provider_txn IS NOT NULL;
CREATE INDEX payments_user_idx ON payments(user_id, created_at DESC);
CREATE INDEX payments_status_idx ON payments(status, created_at DESC);

-- Every inbound provider callback, stored (with phone numbers redacted) so admin can retry reconciliation.
CREATE TABLE webhook_events (
  id           BIGSERIAL PRIMARY KEY,
  provider     TEXT NOT NULL,
  kind         TEXT NOT NULL,             -- stk | b2c_result | b2c_timeout | cashia
  payment_id   UUID REFERENCES payments(id),
  verified     BOOLEAN NOT NULL DEFAULT FALSE,
  processed    BOOLEAN NOT NULL DEFAULT FALSE,
  error        TEXT,
  body         JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX webhook_events_payment_idx ON webhook_events(payment_id);

-- Append-only ledger. Balance = SUM(amount_cents) for the user.
CREATE TABLE ledger_entries (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id),
  type            TEXT NOT NULL CHECK (type IN (
                    'deposit_pending','deposit_confirmed','deposit_failed',
                    'bet_debit','bet_refund','cashout_credit',
                    'withdrawal_reserved','withdrawal_paid','withdrawal_failed',
                    'adjustment')),
  amount_cents    BIGINT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payment_id      UUID REFERENCES payments(id),
  bet_id          BIGINT REFERENCES bets(id),
  provider        TEXT,
  actor_id        BIGINT REFERENCES users(id),
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (type <> 'adjustment' OR (actor_id IS NOT NULL AND reason IS NOT NULL AND length(reason) > 0)),
  CHECK (type NOT IN ('deposit_pending','deposit_failed','withdrawal_paid') OR amount_cents = 0),
  CHECK (type NOT IN ('deposit_confirmed','cashout_credit','bet_refund','withdrawal_failed') OR amount_cents > 0),
  CHECK (type NOT IN ('bet_debit','withdrawal_reserved') OR amount_cents < 0)
);
CREATE INDEX ledger_user_idx ON ledger_entries(user_id, id DESC);

CREATE FUNCTION ledger_no_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_no_update BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_no_mutation();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_mutation();

-- Shared rate-limit counters (works across web instances).
CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER NOT NULL
);

CREATE TABLE admin_audit (
  id         BIGSERIAL PRIMARY KEY,
  actor_id   BIGINT NOT NULL REFERENCES users(id),
  action     TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO settings(key, value) VALUES
  ('providers', '{"mpesa":{"enabled":false,"environment":"sandbox"},"cashia":{"enabled":false,"environment":"sandbox"}}'),
  ('limits', '{"depositMin":10,"depositMax":150000,"withdrawMin":50,"withdrawMax":150000,"betMin":10,"betMax":20000,"maxPayout":1000000}'),
  ('licence', '{"licensed":false,"jurisdiction":null,"licenceNumber":null,"setBy":null,"setAt":null}'),
  ('fair', '{"clientSeed":null}');

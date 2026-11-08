-- Paybill C2B deposits, cached balances for scale, admin TOTP.

-- 1) Paybill account numbers: numeric, with a Luhn check digit so a mistyped account is rejected
--    instead of crediting someone else. Account = (10000 + user id) followed by its Luhn digit.
CREATE FUNCTION luhn_digit(base TEXT) RETURNS INT AS $$
DECLARE s INT := 0; d INT; i INT; dbl BOOLEAN := TRUE;
BEGIN
  FOR i IN REVERSE length(base)..1 LOOP
    d := substr(base, i, 1)::INT;
    IF dbl THEN d := d * 2; IF d > 9 THEN d := d - 9; END IF; END IF;
    s := s + d; dbl := NOT dbl;
  END LOOP;
  RETURN (10 - (s % 10)) % 10;
END $$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION account_no_for(uid BIGINT) RETURNS TEXT AS $$
  SELECT (10000 + uid)::TEXT || luhn_digit((10000 + uid)::TEXT)::TEXT
$$ LANGUAGE sql IMMUTABLE;

ALTER TABLE users ADD COLUMN account_no TEXT UNIQUE;
UPDATE users SET account_no = account_no_for(id);
CREATE FUNCTION set_account_no() RETURNS trigger AS $$
BEGIN NEW.account_no := account_no_for(NEW.id); RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER users_account_no BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION set_account_no();

-- 2) C2B: a paybill payment may arrive for an account that doesn't exist (if Safaricom validation isn't on).
--    It is kept with user_id NULL for an admin to assign. verified_at = provider confirmed the money arrived.
ALTER TABLE payments ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE payments ADD COLUMN channel TEXT NOT NULL DEFAULT 'stk' CHECK (channel IN ('stk','c2b','b2c','checkout'));
ALTER TABLE payments ADD COLUMN bill_ref TEXT;
ALTER TABLE payments ADD COLUMN verified_at TIMESTAMPTZ;
UPDATE payments SET channel = CASE WHEN direction = 'withdrawal' THEN 'b2c' WHEN provider = 'cashia' THEN 'checkout' ELSE 'stk' END;
CREATE INDEX payments_unassigned_idx ON payments(created_at DESC) WHERE user_id IS NULL;

-- 3) Cached balance. The ledger stays the source of truth; this row is maintained by trigger in the same
--    transaction as every ledger insert, so SUM(ledger) == balance_cents always. The CHECK is a last line
--    of defence: no code path can drive a balance negative. The worker re-verifies drift hourly.
CREATE TABLE user_balances (
  user_id       BIGINT PRIMARY KEY REFERENCES users(id),
  balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO user_balances(user_id, balance_cents)
  SELECT u.id, COALESCE(SUM(l.amount_cents), 0) FROM users u LEFT JOIN ledger_entries l ON l.user_id = u.id GROUP BY u.id;

-- UPDATE first: an INSERT ... ON CONFLICT would CHECK the negative candidate row before resolving the conflict.
CREATE FUNCTION ledger_apply_balance() RETURNS trigger AS $$
BEGIN
  UPDATE user_balances SET balance_cents = balance_cents + NEW.amount_cents, updated_at = now() WHERE user_id = NEW.user_id;
  IF NOT FOUND THEN
    INSERT INTO user_balances(user_id, balance_cents, updated_at) VALUES (NEW.user_id, NEW.amount_cents, now());
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_balance AFTER INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_apply_balance();

CREATE FUNCTION user_balance_row() RETURNS trigger AS $$
BEGIN INSERT INTO user_balances(user_id) VALUES (NEW.id) ON CONFLICT DO NOTHING; RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER users_balance_row AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION user_balance_row();

ALTER TABLE webhook_events ADD COLUMN environment TEXT;

-- 4) Admin two-factor (TOTP). Secret is AES-GCM ciphertext; last_step blocks code reuse.
ALTER TABLE users ADD COLUMN totp_secret_enc TEXT;
ALTER TABLE users ADD COLUMN totp_last_step BIGINT;

-- 5) Indexes for hot paths at volume.
CREATE INDEX bets_round_active_auto_idx ON bets(round_id, auto_cashout) WHERE status = 'active';
CREATE INDEX ledger_payment_idx ON ledger_entries(payment_id) WHERE payment_id IS NOT NULL;

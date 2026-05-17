-- ============================================================
-- Vroomie Monetization & API Schema
-- Run this in your Supabase SQL editor
-- ============================================================

-- ── Subscription Plans (reference table) ────────────────────

CREATE TABLE IF NOT EXISTS subscription_plans (
  id            TEXT PRIMARY KEY,           -- 'FREE' | 'AI_ENABLED_MONTHLY' | 'AI_ENABLED_YEARLY'
  name          TEXT NOT NULL,
  price         INTEGER NOT NULL DEFAULT 0, -- in INR (paise stored, display in rupees)
  currency      TEXT NOT NULL DEFAULT 'INR',
  duration_days INTEGER,                    -- NULL = lifetime / free
  api_calls_per_day    INTEGER DEFAULT 100,
  api_calls_per_month  INTEGER DEFAULT 1000,
  rpm_limit     INTEGER DEFAULT 10,
  features      JSONB,
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO subscription_plans (id, name, price, currency, duration_days, api_calls_per_day, api_calls_per_month, rpm_limit, features)
VALUES
  ('FREE', 'Free', 0, 'INR', NULL, 100, 1000, 10,
   '["Basic anomaly detection", "1,000 API calls/month", "Community support"]'),
  ('AI_ENABLED_MONTHLY', 'AI Enabled — Monthly', 100, 'INR', 30, 5000, 50000, 60,
   '["AI/ML detection engine", "50,000 API calls/month", "Priority support", "Advanced reports"]'),
  ('AI_ENABLED_YEARLY', 'AI Enabled — Yearly', 700, 'INR', 365, 5000, 50000, 60,
   '["AI/ML detection engine", "50,000 API calls/month", "Priority support", "Advanced reports", "Save 42%"]')
ON CONFLICT (id) DO NOTHING;

-- ── Subscriptions ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id       TEXT NOT NULL REFERENCES subscription_plans(id),
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'cancelled', 'expired', 'trial', 'past_due')),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ,
  payment_id    TEXT,                       -- Razorpay payment_id of last successful charge
  razorpay_subscription_id TEXT,           -- For recurring subscriptions
  metadata      JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id)                          -- One active subscription per user
);

-- ── Payment Transactions ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS payment_transactions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id               TEXT NOT NULL REFERENCES subscription_plans(id),
  amount                INTEGER NOT NULL,   -- in paise (INR)
  currency              TEXT NOT NULL DEFAULT 'INR',
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'captured', 'failed', 'refunded')),
  razorpay_order_id     TEXT UNIQUE,
  razorpay_payment_id   TEXT,
  razorpay_signature    TEXT,
  failure_reason        TEXT,
  gateway               TEXT DEFAULT 'razorpay',
  metadata              JSONB,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ── API Keys ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS api_keys (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key_hash            TEXT NOT NULL UNIQUE,  -- SHA-256 of the actual key
  key_prefix          TEXT NOT NULL,          -- First 8 chars shown in UI: 'vrm_xxxx'
  name                TEXT,                   -- User-given label e.g. 'My App'
  plan_tier           TEXT NOT NULL DEFAULT 'free'
                        CHECK (plan_tier IN ('free', 'growth', 'enterprise')),
  is_active           BOOLEAN DEFAULT TRUE,
  last_used_at        TIMESTAMPTZ,
  monthly_calls_used  INTEGER DEFAULT 0,
  monthly_reset_at    TIMESTAMPTZ DEFAULT DATE_TRUNC('month', NOW()) + INTERVAL '1 month',
  allowed_origins     TEXT[],                -- CORS whitelist
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  revoked_at          TIMESTAMPTZ
);

-- ── Indexes ──────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id   ON subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status    ON subscriptions (status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_expires   ON subscriptions (expires_at);
CREATE INDEX IF NOT EXISTS idx_payment_txn_user_id     ON payment_transactions (user_id);
CREATE INDEX IF NOT EXISTS idx_payment_txn_order_id    ON payment_transactions (razorpay_order_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash       ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id        ON api_keys (user_id);

-- ── Updated-at trigger ────────────────────────────────────────

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_subscriptions_updated_at ON subscriptions;
CREATE TRIGGER set_subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_payment_txn_updated_at ON payment_transactions;
CREATE TRIGGER set_payment_txn_updated_at
  BEFORE UPDATE ON payment_transactions
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ── Row Level Security ────────────────────────────────────────

ALTER TABLE subscriptions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys             ENABLE ROW LEVEL SECURITY;

-- Users can read their own data
CREATE POLICY "Users view own subscription"
  ON subscriptions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users view own transactions"
  ON payment_transactions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users view own API keys"
  ON api_keys FOR SELECT
  USING (auth.uid() = user_id);

-- Service role bypasses RLS for server-side writes (webhook handler etc.)
-- No INSERT/UPDATE policies for anon — server-side only via service role key

-- ── Subscription expiry auto-expire (pg_cron or external job) ───────────────
-- Run this periodically to expire stale subscriptions:
-- UPDATE subscriptions SET status = 'expired'
--   WHERE status = 'active' AND expires_at < NOW();

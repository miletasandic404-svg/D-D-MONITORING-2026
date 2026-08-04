BEGIN;

CREATE TABLE IF NOT EXISTS payment_transactions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID REFERENCES users(id) ON DELETE SET NULL,
  organization_id           UUID REFERENCES organizations(id) ON DELETE SET NULL,
  provider                  TEXT NOT NULL CHECK (provider IN ('stripe', 'paypal')),
  provider_payment_id       TEXT,
  provider_order_id         TEXT,
  provider_capture_id       TEXT,
  plan_id                   TEXT NOT NULL,
  expected_amount           INTEGER NOT NULL CHECK (expected_amount >= 0),
  paid_amount               INTEGER CHECK (paid_amount IS NULL OR paid_amount >= 0),
  currency                  TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status                    TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'paid', 'failed', 'cancelled', 'refunded', 'chargeback')
  ),
  activation_status         TEXT NOT NULL DEFAULT 'pending' CHECK (
    activation_status IN ('pending', 'active', 'failed')
  ),
  activation_attempts       INTEGER NOT NULL DEFAULT 0 CHECK (activation_attempts >= 0),
  next_activation_retry_at  TIMESTAMPTZ,
  last_activation_error     TEXT,
  activated_organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  activated_at              TIMESTAMPTZ,
  raw_provider_payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_transactions_activation_consistency CHECK (
    activation_status <> 'active'
    OR (activated_organization_id IS NOT NULL AND activated_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_transactions_provider_payment
  ON payment_transactions(provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_transactions_provider_order
  ON payment_transactions(provider, provider_order_id)
  WHERE provider_order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_transactions_provider_capture
  ON payment_transactions(provider, provider_capture_id)
  WHERE provider_capture_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_transactions_org_status
  ON payment_transactions(organization_id, status, activation_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_activation_retry
  ON payment_transactions(activation_status, next_activation_retry_at);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_user_created
  ON payment_transactions(user_id, created_at DESC);

COMMIT;

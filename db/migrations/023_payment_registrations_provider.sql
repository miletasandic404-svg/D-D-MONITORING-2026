BEGIN;

ALTER TABLE customer_registrations
  ALTER COLUMN email DROP NOT NULL;

ALTER TABLE customer_registrations
  ADD COLUMN IF NOT EXISTS payment_provider TEXT NOT NULL DEFAULT 'paypal',
  ADD COLUMN IF NOT EXISTS payment_capture_id TEXT;

CREATE INDEX IF NOT EXISTS idx_customer_reg_provider_order
  ON customer_registrations(payment_provider, payment_order_id);

COMMIT;

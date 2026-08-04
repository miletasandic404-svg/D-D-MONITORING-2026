-- Migration 022: Customer Onboarding Support
--
-- Adds columns to organizations for customer contact details and
-- onboarding state tracking, and creates customer_registrations to
-- link payment orders to accounts.
--
-- Safe to run multiple times (all statements are IF NOT EXISTS /
-- DO NOTHING). Wrapped in a transaction.

BEGIN;

-- ── Extend organizations ────────────────────────────────────────────────────

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE;

-- ── Customer registrations (payment → account linkage) ──────────────────────

CREATE TABLE IF NOT EXISTS customer_registrations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email            TEXT        NOT NULL,
  plan_tier        TEXT        NOT NULL DEFAULT 'starter',
  payment_order_id TEXT,
  payment_status   TEXT        NOT NULL DEFAULT 'pending',
  organization_id  UUID        REFERENCES organizations(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_reg_email ON customer_registrations(email);
CREATE INDEX IF NOT EXISTS idx_customer_reg_org   ON customer_registrations(organization_id);

COMMIT;

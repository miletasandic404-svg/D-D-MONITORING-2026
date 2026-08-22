-- =========================================================
-- Migration 037: Add RLS to payment_transactions
--
-- Problem (P0): payment_transactions table had no RLS, exposing
-- financial data (amounts, provider IDs, activation status, raw
-- provider payloads) to any database user.
--
-- Fix: Enable RLS with tenant isolation via current_org_matches()
-- and full access for platform_admin role.
--
-- The table is not currently used by any API route or worker,
-- so no existing code paths are affected. Future code must use
-- queryAsOrg() or queryAsPlatformAdmin() to access this table.
--
-- Safe to run: idempotent (IF NOT EXISTS / IF EXISTS).
-- =========================================================

BEGIN;

ALTER TABLE payment_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_transactions_tenant_isolation ON payment_transactions;
DROP POLICY IF EXISTS payment_transactions_platform_admin ON payment_transactions;

CREATE POLICY payment_transactions_tenant_isolation
  ON payment_transactions
  FOR SELECT
  USING (current_org_matches(organization_id));

CREATE POLICY payment_transactions_platform_admin
  ON payment_transactions
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

COMMIT;

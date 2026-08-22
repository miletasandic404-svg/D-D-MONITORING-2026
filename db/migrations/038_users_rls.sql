-- =========================================================
-- Migration 038: Add RLS to users
--
-- Problem (P0): users table had no RLS, exposing email,
-- display_name, user_type, and organization_id to any database
-- user across all organizations.
--
-- Fix: Enable RLS with tenant isolation via current_org_matches()
-- and full access for platform_admin role.
--
-- Note: users with organization_id = NULL are platform staff.
-- current_org_matches(NULL) returns false for non-admin callers,
-- so platform staff rows are correctly hidden from organizations.
--
-- Existing API routes already use queryAsOrg() / queryAsPlatformAdmin()
-- so no code changes are required.
--
-- Safe to run: idempotent.
-- =========================================================

BEGIN;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_tenant_isolation ON users;
DROP POLICY IF EXISTS users_platform_admin ON users;

CREATE POLICY users_tenant_isolation
  ON users
  FOR SELECT
  USING (current_org_matches(organization_id));

CREATE POLICY users_platform_admin
  ON users
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

COMMIT;

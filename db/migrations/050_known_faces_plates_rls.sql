-- =========================================================
-- Migration 045: Add RLS to known_faces and known_plates
--
-- Problem: known_faces and known_plates tables (migrations 043/044)
-- lacked Row Level Security, allowing cross-tenant access to
-- face enrollment and license plate allowlist/blocklist data.
--
-- Fix: Enable RLS with tenant isolation via current_org_matches()
-- and full access for platform_admin role.
--
-- Safe to run: idempotent (IF NOT EXISTS / IF EXISTS).
-- =========================================================

BEGIN;

-- known_faces RLS
ALTER TABLE known_faces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS known_faces_tenant_isolation ON known_faces;
DROP POLICY IF EXISTS known_faces_platform_admin ON known_faces;

CREATE POLICY known_faces_tenant_isolation
  ON known_faces
  FOR SELECT
  USING (current_org_matches(organization_id));

CREATE POLICY known_faces_platform_admin
  ON known_faces
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- known_plates RLS
ALTER TABLE known_plates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS known_plates_tenant_isolation ON known_plates;
DROP POLICY IF EXISTS known_plates_platform_admin ON known_plates;

CREATE POLICY known_plates_tenant_isolation
  ON known_plates
  FOR SELECT
  USING (current_org_matches(organization_id));

CREATE POLICY known_plates_platform_admin
  ON known_plates
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

COMMIT;
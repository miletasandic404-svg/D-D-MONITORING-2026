-- =========================================================
-- Migration 039: Fix camera_detection_log RLS policy
--
-- Problem (P0): The existing camera_detection_org_isolation policy
-- used raw current_setting('app.current_org_id') instead of the
-- current_org_matches() helper. This caused:
--   1. platform_admin could not see any rows (policy returned false)
--   2. Unhandled error when app.current_org_id was not set
--      (current_setting() without true param raises exception)
--
-- Fix: Drop the broken policy and recreate it using
-- current_org_matches() which correctly handles both tenant
-- isolation and platform_admin bypass.
--
-- The existing media_node_worker policy (USING true) is NOT changed.
--
-- Safe to run: idempotent (DROP IF EXISTS + CREATE).
-- =========================================================

BEGIN;

DROP POLICY IF EXISTS camera_detection_org_isolation ON camera_detection_log;

CREATE POLICY camera_detection_org_isolation
  ON camera_detection_log
  FOR ALL
  USING (current_org_matches(organization_id))
  WITH CHECK (current_org_matches(organization_id));

COMMIT;

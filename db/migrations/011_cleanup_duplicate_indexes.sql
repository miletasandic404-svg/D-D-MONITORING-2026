-- ============================================================
-- Migration 011: Remove duplicate indexes on incidents table
--
-- Purpose: During the database audit, two duplicate/redundant
-- indexes were identified on the `incidents` table:
--
--   1. idx_incidents_camera  (camera_id)
--   2. idx_incidents_camera_id (camera_id) — DUPLICATE of #1
--
--      Both index exactly the same column (camera_id) with no
--      additional columns, partial predicates, or expression.
--      Keeping two identical indexes wastes disk and slows
--      INSERT/UPDATE/DELETE for no benefit.
--
--      Solution: Keep idx_incidents_camera_id (it was created
--      by migration 005 with the table), drop idx_incidents_camera
--      (added later as part of migration 008 or a manual run).
--
--   3. idx_incidents_organization_id (organization_id ALONE)
--   4. idx_incidents_org_status (organization_id, status)
--
--      idx_incidents_org_status is a composite index whose
--      leftmost column is organization_id. PostgreSQL can use
--      a composite index for queries that only filter on the
--      leftmost column(s), so idx_incidents_organization_id
--      is entirely redundant — it never serves a query that
--      idx_incidents_org_status cannot.
--
--      Solution: Drop idx_incidents_organization_id.
--
-- Safe to run at any time — indexes have no effect on data,
-- constraints, or RLS policies. Idempotent (IF EXISTS).
-- ============================================================

BEGIN;

DROP INDEX IF EXISTS idx_incidents_camera;
DROP INDEX IF EXISTS idx_incidents_organization_id;

COMMIT;

-- ============================================================
-- Migration 013: Incidents table hardening
--
-- Fixes discrepancies between migration 005 and actual Neon state:
--   1. Add site_id if missing (originally in migration 005)
--   2. Add resolution_notes if missing (originally in migration 005)
--   3. Set NOT NULL on columns that should never be null
--      (safe: 0 rows in incidents table)
--   4. Add FK for site_id → sites(id)
--
-- All operations are idempotent.
-- ============================================================

BEGIN;

-- =========================================================
-- 1. Add missing columns
-- =========================================================
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS site_id UUID;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS resolution_notes TEXT;

-- =========================================================
-- 2. Add FK for site_id
-- =========================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_incidents_site'
  ) THEN
    ALTER TABLE incidents
      ADD CONSTRAINT fk_incidents_site
      FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE;
  END IF;
END $$;

-- =========================================================
-- 3. Set NOT NULL on core columns (safe: 0 rows)
-- =========================================================
ALTER TABLE incidents ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE incidents ALTER COLUMN camera_id SET NOT NULL;
ALTER TABLE incidents ALTER COLUMN status SET NOT NULL;
ALTER TABLE incidents ALTER COLUMN created_at SET NOT NULL;

COMMIT;

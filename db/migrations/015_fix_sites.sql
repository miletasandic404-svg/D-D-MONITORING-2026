-- =========================================================
-- Migration 015: Sites hardening
-- Add missing columns: timezone, status
-- Add missing index: idx_sites_org
-- Add CHECK constraint for status
-- Idempotent (safe to run multiple times)
-- =========================================================

BEGIN;

-- 1. Add missing timezone column
--    Defined in migration 001 but never created on Neon
ALTER TABLE sites ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

-- 2. Add missing status column
--    Defined in migration 001 but never created on Neon
ALTER TABLE sites ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

-- 3. Add CHECK constraint for status values
--    Prevents invalid status values from being inserted
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_sites_status'
      AND conrelid = 'sites'::regclass
  ) THEN
    ALTER TABLE sites
      ADD CONSTRAINT chk_sites_status
      CHECK (status IN ('active', 'inactive', 'maintenance', 'archived'));
  END IF;
END $$;

-- 4. Add missing index on organization_id
--    Essential for tenant-filtered queries
CREATE INDEX IF NOT EXISTS idx_sites_org ON sites(organization_id);

COMMIT;

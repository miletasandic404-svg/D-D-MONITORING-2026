-- =========================================================
-- Migration 014: Cameras hardening
-- Add missing FK, SET NOT NULL, SET DEFAULT
-- Idempotent (safe to run multiple times)
-- =========================================================

BEGIN;

-- 1. Add FK: cameras.organization_id → organizations(id) ON DELETE CASCADE
--    (intended by migration 001 but never created on Neon)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_cameras_organization'
      AND conrelid = 'cameras'::regclass
  ) THEN
    ALTER TABLE cameras
      ADD CONSTRAINT fk_cameras_organization
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 2. SET NOT NULL on organization_id
--    Safe: verified 0 NULL values exist
ALTER TABLE cameras ALTER COLUMN organization_id SET NOT NULL;

-- 3. SET NOT NULL on site_id
--    Safe: verified 0 NULL values exist
ALTER TABLE cameras ALTER COLUMN site_id SET NOT NULL;

-- 4. SET NOT NULL DEFAULT true on enabled
--    Safe: verified 0 NULL values exist
ALTER TABLE cameras ALTER COLUMN enabled SET NOT NULL;
ALTER TABLE cameras ALTER COLUMN enabled SET DEFAULT true;

COMMIT;

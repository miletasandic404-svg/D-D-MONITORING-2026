-- =========================================================
-- Migration 009: Add cameras.status column
-- =========================================================
-- The health dashboard endpoint (GET /api/health/dashboard)
-- queries cameras.status to show online/offline/warning counts.
-- This column never existed in the original schema or any
-- previous migration, causing a SQL error at runtime.
--
-- Safe to run once. Idempotent (IF NOT EXISTS). All existing
-- cameras default to 'online' (sensible default for production
-- cameras that are actively streaming).
-- =========================================================

BEGIN;

ALTER TABLE cameras ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'online';

-- Ensure only valid statuses are stored
ALTER TABLE cameras ADD CONSTRAINT IF NOT EXISTS chk_cameras_status
  CHECK (status IN ('online', 'offline', 'warning'));

COMMIT;

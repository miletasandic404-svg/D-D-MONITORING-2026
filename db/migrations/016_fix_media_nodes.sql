-- =========================================================
-- Migration 016: Media nodes hardening
-- Add missing columns: hostname, capacity, heartbeat_secret, last_heartbeat_at
-- Fix NULL constraints and defaults per migration 006 spec
-- Idempotent (safe to run multiple times)
-- =========================================================

BEGIN;

-- 1. Add missing columns (defined in migration 006 but never created on Neon)
ALTER TABLE media_nodes ADD COLUMN IF NOT EXISTS hostname TEXT NOT NULL DEFAULT '';
ALTER TABLE media_nodes ADD COLUMN IF NOT EXISTS capacity INTEGER NOT NULL DEFAULT 50;
ALTER TABLE media_nodes ADD COLUMN IF NOT EXISTS heartbeat_secret TEXT NOT NULL DEFAULT '';
ALTER TABLE media_nodes ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;

-- 2. SET NOT NULL on existing columns (safe: 0 rows)
ALTER TABLE media_nodes ALTER COLUMN region SET NOT NULL;
ALTER TABLE media_nodes ALTER COLUMN public_hls_url SET NOT NULL;

-- 3. Fix status: align with migration 006 spec (DEFAULT 'online', NOT NULL)
ALTER TABLE media_nodes ALTER COLUMN status SET NOT NULL;
ALTER TABLE media_nodes ALTER COLUMN status SET DEFAULT 'online';

-- 4. SET NOT NULL on created_at (safe: 0 rows)
ALTER TABLE media_nodes ALTER COLUMN created_at SET NOT NULL;

-- 5. Add CHECK constraint for status values
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_media_nodes_status'
      AND conrelid = 'media_nodes'::regclass
  ) THEN
    ALTER TABLE media_nodes
      ADD CONSTRAINT chk_media_nodes_status
      CHECK (status IN ('online', 'degraded', 'offline'));
  END IF;
END $$;

COMMIT;

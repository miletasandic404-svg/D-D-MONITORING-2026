-- Migration 036: DVRIP (Xiongmai) camera support
--
-- The local xiongmai-stream-worker.js (app/workers/xiongmai-stream-worker.js
-- on the media node) consumes cameras rows that bridge a proprietary DVRIP
-- camera into MediaMTX. Its fetchDvripCameras() filters on:
--
--   c.media_node_id = $1
--   c.connection_type = 'dvrip'
--   c.enabled = true
--   c.ip / c.port (passed to the DVRIP TCP client on :34567)
--
-- None of connection_type/ip/port existed on the cameras table in any
-- migration, so a DVRIP camera registered through the wizard was either
-- never inserted or, if inserted, was invisible to the stream worker
-- (WHERE connection_type = 'dvrip' excluded it).
--
-- This migration adds the three missing columns (all nullable, so existing
-- RTSP/ONVIF rows are untouched and keep working) and widens the
-- camera_setup_tasks.mode CHECK to allow the new 'dvrip' task mode consumed
-- by workers/camera-setup-agent.js (runDvrip). Idempotent.

BEGIN;

-- cameras: nullable additions for DVRIP-only cameras (Xiongmai on TCP :34567).
-- Existing RTSP/ONVIF cameras stay NULL here -> no behavior change; the
-- stream worker's `WHERE connection_type = 'dvrip'` still excludes them.
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS connection_type VARCHAR(20);
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS ip INET;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS port INTEGER;

-- camera_setup_tasks: allow the 'dvrip' mode. Mirrors migration 028's
-- drop+recreate CHECK pattern (the constraint must be dropped before re-add).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'camera_setup_tasks_mode_check'
      AND conrelid = 'camera_setup_tasks'::regclass
  ) THEN
    ALTER TABLE camera_setup_tasks DROP CONSTRAINT camera_setup_tasks_mode_check;
  END IF;
END $$;

ALTER TABLE camera_setup_tasks
  ADD CONSTRAINT camera_setup_tasks_mode_check
  CHECK (mode IN ('scan', 'onvif', 'manual', 'probe', 'preview', 'cleanup', 'start_tunnel', 'dvrip'));

COMMIT;

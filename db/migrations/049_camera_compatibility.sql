-- Camera Compatibility Gate
--
-- Adds compatibility_status and compatibility_result columns to the cameras
-- table. These are populated by workers/camera-compatibility-worker.js and
-- consumed by the dashboard / API to show pre-purchase validation results.

BEGIN;

ALTER TABLE cameras
  ADD COLUMN IF NOT EXISTS compatibility_status VARCHAR(20) DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS compatibility_result JSONB;

COMMENT ON COLUMN cameras.compatibility_status IS
  'Compatibility check result: pending | production_ready | video_only | blocked';

COMMENT ON COLUMN cameras.compatibility_result IS
  'Full compatibility check result JSON (discovery, credentials, video, media, ai, audio)';

CREATE INDEX IF NOT EXISTS idx_cameras_compatibility_status
  ON cameras (compatibility_status);

COMMIT;

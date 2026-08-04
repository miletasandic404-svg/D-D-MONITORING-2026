-- Migration 028: Camera Setup Wizard V3 — node health + task modes
--
-- V3 "one-click" wizard needs real-time node health (MediaMTX up? Cloudflare
-- tunnel up?) surfaced in the dashboard, plus new agent task modes:
--   probe        - discover RTSP streams for a selected camera (main/sub)
--   preview      - register camera + MediaMTX path, show live preview
--   cleanup      - remove a wizard-registered camera (user cancelled)
--   start_tunnel - ask the agent to launch cloudflared on the node
--
-- The media_nodes health columns are written by workers/camera-setup-agent.js
-- (the local process next to MediaMTX) via lib/_node_health.js and read back
-- by GET /api/camera-setup/node for the wizard health panel.

BEGIN;

-- 1. Node health columns (idempotent)
ALTER TABLE media_nodes ADD COLUMN IF NOT EXISTS mediamtx_online    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE media_nodes ADD COLUMN IF NOT EXISTS tunnel_online      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE media_nodes ADD COLUMN IF NOT EXISTS health_json        JSONB;
ALTER TABLE media_nodes ADD COLUMN IF NOT EXISTS health_checked_at  TIMESTAMPTZ;

-- 2. Widen camera_setup_tasks.mode CHECK to V3 modes (drop + recreate idempotently)
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
  CHECK (mode IN ('scan', 'onvif', 'manual', 'probe', 'preview', 'cleanup', 'start_tunnel'));

COMMIT;

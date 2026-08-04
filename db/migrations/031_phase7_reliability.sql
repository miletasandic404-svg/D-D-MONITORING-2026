-- =========================================================
-- Migration 031: Phase 7 — camera reliability
--
--   1. Duplicate camera protection (organization_id + rtsp_url):
--      a partial UNIQUE index prevents the same RTSP source from being
--      registered twice within one organization. Exact duplicates that
--      already exist are removed (keeping the earliest row) ONLY when they
--      have no dependent child rows; otherwise the migration fails loudly
--      so the operator can decide — no silent data loss.
--   2. Setup task cancellation: camera_setup_tasks.status gains 'cancelled'
--      so the UI can cancel in-flight setup tasks and the agent can wipe
--      temporary credentials.
--
-- Idempotent: safe to re-run.
-- =========================================================

BEGIN;

-- ── 1. De-duplicate existing exact (organization_id, rtsp_url) rows ─────────
-- Keep the earliest row; delete later duplicates only when they have no
-- children (events, incidents, recordings, snapshots, tokens, view logs).
DO $$
DECLARE
  dup RECORD;
BEGIN
  FOR dup IN
    SELECT c.id, c.organization_id, c.rtsp_url
    FROM cameras c
    WHERE c.rtsp_url IS NOT NULL AND c.rtsp_url <> ''
      AND EXISTS (
        SELECT 1 FROM cameras c2
        WHERE c2.organization_id = c.organization_id
          AND c2.rtsp_url = c.rtsp_url
          AND c2.id <> c.id
          AND c2.id < c.id  -- keep the smallest id, delete the rest
      )
  LOOP
    IF NOT EXISTS (SELECT 1 FROM events WHERE camera_id = dup.id)
       AND NOT EXISTS (SELECT 1 FROM incidents WHERE camera_id = dup.id)
       AND NOT EXISTS (SELECT 1 FROM recordings WHERE camera_id = dup.id)
       AND NOT EXISTS (SELECT 1 FROM snapshots WHERE camera_id = dup.id)
       AND NOT EXISTS (SELECT 1 FROM camera_stream_tokens WHERE camera_id = dup.id)
       AND NOT EXISTS (SELECT 1 FROM camera_view_logs WHERE camera_id = dup.id)
    THEN
      DELETE FROM cameras WHERE id = dup.id;
    END IF;
  END LOOP;
END $$;

-- ── 2. Unique index: one RTSP source per organization ───────────────────────
-- Partial index: cameras without an RTSP URL (e.g. placeholder rows) are not
-- constrained. Existing cameras keep working — the index only affects new
-- registrations.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cameras_org_rtsp
  ON cameras (organization_id, rtsp_url)
  WHERE rtsp_url IS NOT NULL AND rtsp_url <> '';

-- ── 3. Setup task status: allow 'cancelled' ─────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'camera_setup_tasks_status_check'
      AND conrelid = 'camera_setup_tasks'::regclass
  ) THEN
    ALTER TABLE camera_setup_tasks DROP CONSTRAINT camera_setup_tasks_status_check;
  END IF;
END $$;

ALTER TABLE camera_setup_tasks
  ADD CONSTRAINT camera_setup_tasks_status_check
  CHECK (status IN ('pending', 'working', 'done', 'failed', 'cancelled'));

COMMIT;

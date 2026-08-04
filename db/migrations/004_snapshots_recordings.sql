-- =========================================================
-- Phase 3 migration: snapshots, recordings, event-triggered pipeline
-- =========================================================
-- Scope (per docs/PLATFORM_ROADMAP.md, Faza 3):
--   - snapshots: manual/event-triggered still images
--   - recordings: event-triggered video segments
--   - a Postgres NOTIFY trigger so an external recording worker can
--     react to new events in real time without polling the DB
--
-- No backfill needed: new, empty tables. Low-risk relative to 001/002.
-- Idempotent (IF NOT EXISTS everywhere; trigger drop+recreate is safe
-- to re-run).

BEGIN;

-- Per-camera recording policy, needed by the recording worker and
-- retention job below. Sensible defaults so existing cameras keep
-- working (event-triggered recording, 30 day retention) without
-- requiring anyone to configure this immediately.
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS recording_mode VARCHAR(20) NOT NULL DEFAULT 'event'; -- off | event | continuous
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS retention_days INTEGER NOT NULL DEFAULT 30;

CREATE TABLE IF NOT EXISTS snapshots (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id         VARCHAR(20) NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  taken_by_user_id  UUID REFERENCES users(id),
  taken_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  storage_url       TEXT NOT NULL,
  trigger           TEXT NOT NULL DEFAULT 'manual', -- manual | event
  file_size_bytes   BIGINT
);
CREATE INDEX IF NOT EXISTS idx_snapshots_camera ON snapshots(camera_id, taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_org ON snapshots(organization_id, taken_at DESC);

CREATE TABLE IF NOT EXISTS recordings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id             VARCHAR(20) NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id              INTEGER REFERENCES events(id),
  start_time            TIMESTAMPTZ NOT NULL DEFAULT now(),
  end_time              TIMESTAMPTZ,
  storage_url           TEXT,
  duration_seconds      INTEGER,
  size_bytes            BIGINT,
  trigger_reason        TEXT NOT NULL DEFAULT 'event', -- event | manual | continuous
  status                TEXT NOT NULL DEFAULT 'recording', -- recording | completed | failed
  retention_expires_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_recordings_camera ON recordings(camera_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_recordings_org ON recordings(organization_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_recordings_retention ON recordings(retention_expires_at) WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status) WHERE status = 'recording';

-- =========================================================
-- Auto-fill events.organization_id
-- =========================================================
-- Migration 002 added events.organization_id as NOT NULL and backfilled
-- existing rows, but nothing populated it for NEW rows going forward --
-- any INSERT into events that doesn't explicitly set organization_id
-- would fail. This trigger derives it from the camera, so callers only
-- ever need to supply camera_id (as they already did before migration
-- 002 existed).

CREATE OR REPLACE FUNCTION fill_event_organization_id() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.organization_id IS NULL THEN
    SELECT organization_id INTO NEW.organization_id FROM cameras WHERE id = NEW.camera_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fill_event_organization_id ON events;
CREATE TRIGGER trg_fill_event_organization_id
  BEFORE INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION fill_event_organization_id();

-- =========================================================
-- Event -> recording trigger
-- =========================================================
-- Whenever a new row lands in `events`, notify any listening recording
-- worker on the `new_camera_event` channel with enough info to act
-- without an extra query. Workers run NOTIFY/LISTEN (not polling) so
-- this stays cheap even with a high event rate.

CREATE OR REPLACE FUNCTION notify_new_camera_event() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify(
    'new_camera_event',
    json_build_object(
      'event_id', NEW.id,
      'camera_id', NEW.camera_id,
      'organization_id', NEW.organization_id,
      'severity', NEW.severity,
      'event_type', NEW.event_type
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_new_camera_event ON events;
CREATE TRIGGER trg_notify_new_camera_event
  AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION notify_new_camera_event();

COMMIT;

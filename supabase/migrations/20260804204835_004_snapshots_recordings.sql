-- Migration 004: Snapshots, recordings, event-triggered pipeline

ALTER TABLE cameras ADD COLUMN IF NOT EXISTS recording_mode VARCHAR(20) NOT NULL DEFAULT 'event';
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS retention_days INTEGER NOT NULL DEFAULT 30;

CREATE TABLE IF NOT EXISTS snapshots (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id         VARCHAR(20) NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  taken_by_user_id  UUID REFERENCES users(id),
  taken_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  storage_url       TEXT NOT NULL,
  trigger           TEXT NOT NULL DEFAULT 'manual',
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
  trigger_reason        TEXT NOT NULL DEFAULT 'event',
  status                TEXT NOT NULL DEFAULT 'recording',
  retention_expires_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_recordings_camera ON recordings(camera_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_recordings_org ON recordings(organization_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_recordings_retention ON recordings(retention_expires_at) WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status) WHERE status = 'recording';

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
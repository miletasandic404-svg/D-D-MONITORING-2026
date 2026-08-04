-- =========================================================
-- Phase 4 migration: real incidents table + activity log
-- =========================================================
-- Scope (per docs/PLATFORM_ROADMAP.md, Faza 4):
--   - incidents: a real table (status, severity, assigned_operator_id)
--     replacing the previous hack of stashing status inside
--     ai_detections.bounding_box->>'incident_status' JSON
--   - incident_activity_log: timeline of who did what to an incident
--   - notification_rules: config storage only in this migration --
--     actual email/SMS delivery integration needs a real provider
--     (SendGrid/Twilio/etc credentials) and is intentionally NOT
--     wired up here; this table just holds the configuration for
--     whenever that's added.
--   - one incident per event (event_id UNIQUE), auto-created via
--     trigger so every new event always has a corresponding incident
--     row without relying on application code to remember to create
--     one.
--
-- Backfills existing events into incidents, pulling any previously
-- set status out of ai_detections' JSON hack so nothing already
-- triaged appears to reset to "New".
--
-- Idempotent (IF NOT EXISTS everywhere; ON CONFLICT DO NOTHING on
-- the backfill; trigger drop+recreate is safe to re-run).

BEGIN;

CREATE TABLE IF NOT EXISTS incidents (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id               UUID NOT NULL REFERENCES sites(id),
  camera_id             VARCHAR(20) NOT NULL REFERENCES cameras(id),
  event_id              INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  severity              VARCHAR(20) NOT NULL DEFAULT 'medium',
  status                VARCHAR(20) NOT NULL DEFAULT 'New', -- New | Acknowledged | In Progress | Resolved | False Alarm
  assigned_operator_id  UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at       TIMESTAMPTZ,
  resolved_at           TIMESTAMPTZ,
  resolution_notes      TEXT
);
CREATE INDEX IF NOT EXISTS idx_incidents_org_status ON incidents(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_incidents_operator ON incidents(assigned_operator_id, status);
CREATE INDEX IF NOT EXISTS idx_incidents_camera ON incidents(camera_id);

CREATE TABLE IF NOT EXISTS incident_activity_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id   UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id),
  action        VARCHAR(50) NOT NULL, -- status_changed | assigned | unassigned | commented
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_incident_activity ON incident_activity_log(incident_id, created_at);

-- Configuration only -- see note above about delivery not being wired up.
CREATE TABLE IF NOT EXISTS notification_rules (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type              VARCHAR(50), -- NULL = applies to all event types
  channel                 VARCHAR(20) NOT NULL, -- email | sms
  recipient               TEXT NOT NULL,
  escalate_after_minutes  INTEGER,
  active                  BOOLEAN NOT NULL DEFAULT true,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notification_rules_org ON notification_rules(organization_id) WHERE active;

-- =========================================================
-- Backfill: one incident per existing event
-- =========================================================
INSERT INTO incidents (organization_id, site_id, camera_id, event_id, severity, status)
SELECT
  e.organization_id,
  c.site_id,
  e.camera_id,
  e.id,
  COALESCE(e.severity, 'medium'),
  COALESCE(
    (SELECT a.bounding_box->>'incident_status' FROM ai_detections a WHERE a.event_id = e.id LIMIT 1),
    'New'
  )
FROM events e
JOIN cameras c ON c.id = e.camera_id
WHERE NOT EXISTS (SELECT 1 FROM incidents i WHERE i.event_id = e.id)
ON CONFLICT (event_id) DO NOTHING;

-- =========================================================
-- Auto-create an incident for every new event
-- =========================================================
CREATE OR REPLACE FUNCTION create_incident_for_event() RETURNS TRIGGER AS $$
DECLARE
  v_site_id UUID;
BEGIN
  SELECT site_id INTO v_site_id FROM cameras WHERE id = NEW.camera_id;
  INSERT INTO incidents (organization_id, site_id, camera_id, event_id, severity, status)
  VALUES (NEW.organization_id, v_site_id, NEW.camera_id, NEW.id, COALESCE(NEW.severity, 'medium'), 'New')
  ON CONFLICT (event_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_create_incident_for_event ON events;
CREATE TRIGGER trg_create_incident_for_event
  AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION create_incident_for_event();

COMMIT;

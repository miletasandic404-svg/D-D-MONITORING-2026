-- Migration 005: Incidents table + activity log

CREATE TABLE IF NOT EXISTS incidents (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id               UUID NOT NULL REFERENCES sites(id),
  camera_id             VARCHAR(20) NOT NULL REFERENCES cameras(id),
  event_id              INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  severity              VARCHAR(20) NOT NULL DEFAULT 'medium',
  status                VARCHAR(20) NOT NULL DEFAULT 'New',
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
  action        VARCHAR(50) NOT NULL,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_incident_activity ON incident_activity_log(incident_id, created_at);

CREATE TABLE IF NOT EXISTS notification_rules (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type              VARCHAR(50),
  channel                 VARCHAR(20) NOT NULL,
  recipient               TEXT NOT NULL,
  escalate_after_minutes  INTEGER,
  active                  BOOLEAN NOT NULL DEFAULT true,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notification_rules_org ON notification_rules(organization_id) WHERE active;

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
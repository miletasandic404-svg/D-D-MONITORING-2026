-- Migration 002: Events organization scoping

ALTER TABLE events ADD COLUMN IF NOT EXISTS organization_id UUID;

UPDATE events e
SET organization_id = c.organization_id
FROM cameras c
WHERE e.camera_id = c.id
  AND e.organization_id IS NULL;

DO $$
DECLARE orphan_count INTEGER;
BEGIN
  SELECT count(*) INTO orphan_count FROM events WHERE organization_id IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'events: % row(s) have no matching camera', orphan_count;
  END IF;
END $$;

ALTER TABLE events ALTER COLUMN organization_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_events_organization') THEN
    ALTER TABLE events ADD CONSTRAINT fk_events_organization
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_events_org ON events(organization_id);
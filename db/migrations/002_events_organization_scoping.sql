-- =========================================================
-- Phase 1 migration: tenant scoping for events
-- =========================================================
-- api/incidents/* joins ai_detections -> events -> cameras. To filter
-- incidents by the authenticated user's organization without a JOIN
-- through cameras on every request, events gets its own
-- organization_id (denormalized, same pattern as cameras in migration
-- 001). Backfilled from the camera each event belongs to.
--
-- Safe to run once. Wrapped in a transaction: fails atomically.
-- Idempotent: re-running is a no-op (checked locally, see commit msg).

BEGIN;

ALTER TABLE events ADD COLUMN IF NOT EXISTS organization_id UUID;

UPDATE events e
SET organization_id = c.organization_id
FROM cameras c
WHERE e.camera_id = c.id
  AND e.organization_id IS NULL;

-- If any event somehow has no matching camera, this will surface as a
-- clear error here instead of silently leaving rows unscoped.
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  SELECT count(*) INTO orphan_count FROM events WHERE organization_id IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'events: % row(s) have no matching camera / organization_id could not be backfilled -- fix orphaned events before re-running this migration', orphan_count;
  END IF;
END $$;

ALTER TABLE events ALTER COLUMN organization_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_events_organization'
  ) THEN
    ALTER TABLE events
      ADD CONSTRAINT fk_events_organization
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_events_org ON events(organization_id);

COMMIT;

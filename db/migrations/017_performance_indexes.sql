-- =========================================================
-- Migration 017: Performance indexes
-- Based on complete audit of existing indexes, row counts, and API query patterns.
--
-- Audit summary:
--   events:            0 rows — adding index for future JOIN/ORDER BY usage
--   ai_detections:     0 rows — adding index for future JOIN usage
--   cameras:           1 row  — adding tenant filter + site JOIN indexes
--   operator_assignments: 0 rows — UNIQUE(user_id, site_id) already covers
--   incidents:         0 rows — 5 indexes already cover well
--   sites:             1 row  — idx_sites_org already added in migration 015
--
-- All CREATE INDEX with IF NOT EXISTS for idempotency.
-- =========================================================

BEGIN;

-- === cameras (1 row, key tenant table) ===
-- Tenant filter: every cameras query filters by organization_id
CREATE INDEX IF NOT EXISTS idx_cameras_org ON cameras(organization_id);
-- JOIN with sites: cameras.site_id → sites.id
CREATE INDEX IF NOT EXISTS idx_cameras_site ON cameras(site_id);

-- === events (0 rows, will grow) ===
-- JOIN with cameras: events.camera_id → cameras.id
CREATE INDEX IF NOT EXISTS idx_events_camera_id ON events(camera_id);
-- Sorted event lists per tenant: dashboard, incident creation
CREATE INDEX IF NOT EXISTS idx_events_org_timestamp ON events(organization_id, timestamp DESC);
-- Partial index: active (non-dismissed) events only — negligible write overhead
CREATE INDEX IF NOT EXISTS idx_events_active ON events(is_dismissed) WHERE NOT is_dismissed;
-- Filter by event type
CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);

-- === ai_detections (0 rows, will grow) ===
-- JOIN with events: ai_detections.event_id → events.id
CREATE INDEX IF NOT EXISTS idx_ai_detections_event_id ON ai_detections(event_id);
-- Filter by detected object type
CREATE INDEX IF NOT EXISTS idx_ai_detections_object_type ON ai_detections(object_type);

COMMIT;

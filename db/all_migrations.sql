-- =========================================================
-- Phase 0 migration: multi-tenant foundation
-- =========================================================
-- Scope (per docs/PLATFORM_ROADMAP.md, Faza 0):
--   - organizations, sites
--   - users, roles, permissions, user_roles
--   - cameras gets organization_id / site_id, backfilled to a
--     default org/site so existing data and the current API/UI
--     keep working unchanged
--
-- Explicitly OUT of scope for this migration (later phases):
--   - operator_assignments, media_nodes, camera_stream_tokens
--   - snapshots, recordings
--   - events/incidents restructuring (existing ai_detections-based
--     "incidents" view is left untouched)
--   - audit_logs / camera_view_logs
--   - RLS policies (enabled once the API sets app.current_org_id
--     per request -- tracked as a separate follow-up, not part of
--     this migration, to avoid breaking the API before it's ready)
--
-- Verified locally against a fresh copy of db/schema.sql plus
-- pre-existing camera rows (see commit message for details).
-- Safe to run once against the existing production schema.
-- Wrapped in a transaction: fails atomically.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

-- =========================================================
-- 1. Organizations & sites
-- =========================================================

CREATE TABLE IF NOT EXISTS organizations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  plan_tier       TEXT NOT NULL DEFAULT 'standard',
  status          TEXT NOT NULL DEFAULT 'active',
  contact_email   TEXT,
  camera_limit    INTEGER NOT NULL DEFAULT 10,
  site_limit      INTEGER NOT NULL DEFAULT 3,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sites (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  address         TEXT,
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sites_org ON sites(organization_id);

-- =========================================================
-- 2. Users / roles / permissions
-- =========================================================
-- NOTE: end-user identity/login lives in Supabase Auth (see
-- frontend/src/services/supabaseClient.js), which is a separate
-- Postgres instance from DATABASE_URL (this database, e.g. Neon).
-- There is no cross-database foreign key possible, so `users.id`
-- here is a local profile record whose id is set to match the
-- Supabase auth user's id (auth.uid()) at sync/first-login time --
-- documented relationship, not an enforced FK.

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY, -- matches Supabase auth.uid(), not a DB-level FK
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE, -- NULL = platform staff
  email           TEXT NOT NULL UNIQUE,
  display_name    TEXT,
  user_type       TEXT NOT NULL DEFAULT 'operator', -- platform_admin | org_admin | operator | customer_viewer
  status          TEXT NOT NULL DEFAULT 'active',
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);

CREATE TABLE IF NOT EXISTS roles (
  id              SERIAL PRIMARY KEY,
  key             TEXT NOT NULL UNIQUE,
  description     TEXT
);

CREATE TABLE IF NOT EXISTS permissions (
  id              SERIAL PRIMARY KEY,
  key             TEXT NOT NULL UNIQUE,
  description     TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id         INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id   INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id         INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- Seed the four baseline roles. Fine-grained permission rows are
-- deliberately NOT seeded here -- that list is defined in Phase 1
-- alongside the RBAC middleware that reads it (see roadmap).
INSERT INTO roles (key, description) VALUES
  ('platform_admin', 'Manages the platform itself, all organizations'),
  ('org_admin',      'Manages one organization''s sites, cameras and users'),
  ('operator',       'Monitors assigned sites/cameras, handles incidents'),
  ('customer_viewer','Read-only view of one organization''s own cameras')
ON CONFLICT (key) DO NOTHING;

-- =========================================================
-- 3. cameras: add organization_id / site_id (nullable first)
-- =========================================================

ALTER TABLE cameras ADD COLUMN IF NOT EXISTS organization_id UUID;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS site_id UUID;

-- =========================================================
-- 4. Backfill: default organization + site for existing cameras
--    (columns now exist, safe to reference them)
-- =========================================================

DO $$
DECLARE
  default_org_id UUID;
  default_site_id UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM cameras WHERE organization_id IS NULL) THEN
    SELECT id INTO default_org_id FROM organizations
      WHERE name = 'Default Organization' ORDER BY created_at ASC LIMIT 1;

    IF default_org_id IS NULL THEN
      INSERT INTO organizations (name, plan_tier, status)
      VALUES ('Default Organization', 'standard', 'active')
      RETURNING id INTO default_org_id;
    END IF;

    SELECT id INTO default_site_id FROM sites
      WHERE organization_id = default_org_id ORDER BY created_at ASC LIMIT 1;

    IF default_site_id IS NULL THEN
      INSERT INTO sites (organization_id, name, timezone, status)
      VALUES (default_org_id, 'Default Site', 'UTC', 'active')
      RETURNING id INTO default_site_id;
    END IF;

    UPDATE cameras
    SET organization_id = default_org_id, site_id = default_site_id
    WHERE organization_id IS NULL;
  END IF;
END $$;

-- =========================================================
-- 5. Tighten constraints now that every row is backfilled
-- =========================================================

ALTER TABLE cameras ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE cameras ALTER COLUMN site_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_cameras_organization'
  ) THEN
    ALTER TABLE cameras
      ADD CONSTRAINT fk_cameras_organization
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_cameras_site'
  ) THEN
    ALTER TABLE cameras
      ADD CONSTRAINT fk_cameras_site
      FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cameras_org ON cameras(organization_id);
CREATE INDEX IF NOT EXISTS idx_cameras_site ON cameras(site_id);

COMMIT;
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
-- =========================================================
-- Phase 2 migration: operator experience
-- =========================================================
-- Scope (per docs/PLATFORM_ROADMAP.md, Faza 2):
--   - operator_assignments: which operator covers which site
--   - camera_view_logs: who viewed which camera, when
--   - camera_stream_tokens: short-lived signed tokens authorizing
--     access to a specific camera's HLS stream
--
-- No backfill needed: these are new, empty tables. Nothing existing
-- depends on them yet, so this migration is low-risk relative to
-- 001/002 (no ALTER on existing tables, no data migration).
--
-- Safe to run once. Idempotent (IF NOT EXISTS everywhere).

BEGIN;

CREATE TABLE IF NOT EXISTS operator_assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id         UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  assigned_by     UUID REFERENCES users(id),
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  active          BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (user_id, site_id)
);
CREATE INDEX IF NOT EXISTS idx_operator_assignments_user ON operator_assignments(user_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_operator_assignments_site ON operator_assignments(site_id) WHERE active;

CREATE TABLE IF NOT EXISTS camera_view_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id       VARCHAR(20) NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ,
  ip_address      INET
);
CREATE INDEX IF NOT EXISTS idx_camera_view_camera ON camera_view_logs(camera_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_camera_view_user ON camera_view_logs(user_id, started_at DESC);
-- Fast lookup of a caller's own currently-open view session (for the
-- "end view" endpoint), avoids a full table scan per request.
CREATE INDEX IF NOT EXISTS idx_camera_view_open ON camera_view_logs(user_id, camera_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS camera_stream_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id       VARCHAR(20) NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id),
  token           TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stream_tokens_lookup ON camera_stream_tokens(token, expires_at);

COMMIT;
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
-- =========================================================
-- Phase 5 migration: media node registry (scalable streaming)
-- =========================================================
-- Scope (per docs/PLATFORM_ROADMAP.md, Faza 5):
--   - media_nodes: registry of MediaMTX (or similar) instances, one
--     row per region/host, so cameras can be spread across multiple
--     streaming servers instead of a single VITE_HLS_BASE_URL for
--     the whole platform.
--   - cameras.media_node_id: which node currently serves this camera.
--
-- media_nodes is platform-level infrastructure, not tenant data -- it
-- has no organization_id. Multiple organizations' cameras can share
-- the same node (that's the whole point of pooling capacity), so only
-- platform_admin manages this table.
--
-- Idempotent (IF NOT EXISTS everywhere).

BEGIN;

CREATE TABLE IF NOT EXISTS media_nodes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region              VARCHAR(50) NOT NULL,
  hostname            TEXT NOT NULL,
  public_hls_url      TEXT NOT NULL, -- e.g. https://stream-eu1.example.com
  capacity            INTEGER NOT NULL DEFAULT 50,
  status              VARCHAR(20) NOT NULL DEFAULT 'online', -- online | degraded | offline (offline is also inferred from stale heartbeat)
  heartbeat_secret    TEXT NOT NULL, -- shared secret the node's heartbeat script authenticates with (not a user JWT)
  last_heartbeat_at   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_nodes_region ON media_nodes(region);

ALTER TABLE cameras ADD COLUMN IF NOT EXISTS media_node_id UUID REFERENCES media_nodes(id);
CREATE INDEX IF NOT EXISTS idx_cameras_media_node ON cameras(media_node_id);

COMMIT;
-- =========================================================
-- Phase 6 migration: audit log + Row Level Security (defense in depth)
-- =========================================================
-- Scope (per docs/PLATFORM_ROADMAP.md, Faza 6):
--   - audit_logs: append-only record of sensitive actions (camera
--     create/delete, media node create, incident changes, snapshot
--     capture) -- who did what, when.
--   - RLS on the core tenant tables that carry organization_id
--     directly: cameras, events, incidents, snapshots, recordings,
--     sites, camera_view_logs, notification_rules, audit_logs.
--
-- This is a SECOND layer on top of the application-level
-- `WHERE organization_id = $1` checks already in every API route
-- (Phases 1-5) -- not a replacement for them. The point of RLS here
-- is that if a future query anywhere forgets that WHERE clause, it
-- returns ZERO rows instead of leaking another tenant's data.
--
-- NOT in scope for this migration (documented, not an oversight):
--   - incident_activity_log, camera_stream_tokens, operator_assignments,
--     user_roles, role_permissions: no organization_id column of their
--     own (would need a subquery-based policy against a parent table,
--     or a denormalized column). Lower blast-radius if a query bug
--     happens (e.g. activity log rows don't expose camera feeds), and
--     already tenant-checked at the application layer via their
--     parent incident/camera. Candidate for a follow-up migration.
--   - media_nodes: intentionally NOT tenant data (shared platform
--     infrastructure across organizations) -- RLS by organization_id
--     doesn't apply here at all.
--
-- CRITICAL DEPLOYMENT NOTE: enabling RLS on a table makes EVERY query
-- against it -- including ones the application code doesn't yet set
-- app.current_org_id for -- return zero rows unless a policy matches.
-- This migration is only safe to run together with (not before) the
-- application code change that makes db/index.js set
-- app.current_org_id per request (see db/index.js's queryAsOrg). If
-- you run this migration against a deployment still using the plain
-- `db.query()` path for these tables, every one of those endpoints
-- will start returning empty results, not an error.
--
-- Idempotent: policies are dropped and recreated; ENABLE ROW LEVEL
-- SECURITY is itself idempotent in Postgres.

BEGIN;

-- =========================================================
-- audit_logs
-- =========================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id),
  action          VARCHAR(100) NOT NULL, -- e.g. camera.create, camera.delete, incident.status_changed, snapshot.captured
  resource_type   VARCHAR(50),
  resource_id     TEXT,
  metadata        JSONB,
  ip_address      INET,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_time ON audit_logs(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id);

-- =========================================================
-- Helper: a single function encapsulating "does this row's
-- organization_id match the caller's session, or is the caller a
-- platform_admin (session flag, bypasses tenant scoping entirely)?"
-- Centralizing this avoids repeating the same OR-condition in every
-- policy and makes future changes (e.g. adding a new bypass role)
-- a one-line change instead of an N-policy edit.
-- =========================================================
CREATE OR REPLACE FUNCTION current_org_matches(row_org_id UUID) RETURNS BOOLEAN AS $$
  SELECT
    current_setting('app.is_platform_admin', true) = 'true'
    OR row_org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- =========================================================
-- Enable RLS + policy per core tenant table
-- =========================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['cameras', 'events', 'incidents', 'snapshots', 'recordings', 'sites', 'camera_view_logs', 'notification_rules', 'audit_logs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t); -- applies even to the table owner role
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_org_matches(organization_id))', t);
  END LOOP;
END $$;

COMMIT;

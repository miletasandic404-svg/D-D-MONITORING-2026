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
--
-- NOTE: user_id is TEXT (not UUID) because users.id is TEXT on the
-- production Neon database (Better Auth uses TEXT for user IDs).
-- The FK reference is omitted to avoid type mismatch errors.

BEGIN;

-- =========================================================
-- audit_logs
-- =========================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         TEXT,
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

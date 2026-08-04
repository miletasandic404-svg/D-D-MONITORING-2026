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

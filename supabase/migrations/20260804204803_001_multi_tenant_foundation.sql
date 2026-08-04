-- Migration 001: Multi-tenant foundation (from db/migrations/001_multi_tenant_foundation.sql)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

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

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  email           TEXT NOT NULL UNIQUE,
  display_name    TEXT,
  user_type       TEXT NOT NULL DEFAULT 'operator',
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

INSERT INTO roles (key, description) VALUES
  ('platform_admin', 'Manages the platform itself, all organizations'),
  ('org_admin',      'Manages one organization''s sites, cameras and users'),
  ('operator',       'Monitors assigned sites/cameras, handles incidents'),
  ('customer_viewer','Read-only view of one organization''s own cameras')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE cameras ADD COLUMN IF NOT EXISTS organization_id UUID;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS site_id UUID;

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

ALTER TABLE cameras ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE cameras ALTER COLUMN site_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_cameras_organization') THEN
    ALTER TABLE cameras ADD CONSTRAINT fk_cameras_organization
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_cameras_site') THEN
    ALTER TABLE cameras ADD CONSTRAINT fk_cameras_site
      FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cameras_org ON cameras(organization_id);
CREATE INDEX IF NOT EXISTS idx_cameras_site ON cameras(site_id);
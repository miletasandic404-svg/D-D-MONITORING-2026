-- =========================================================
-- D&D Monitoring - schema za Supabase Postgres
-- =========================================================
-- Generisano na osnovu STVARNE strukture izvucene iz produkcione
-- Neon baze (information_schema.columns export), NE iz
-- db/migrations/001-008 fajlova, jer je vec dva puta utvrdjeno da
-- se ti fajlovi razlikuju od stvarnog stanja (users, sites).
--
-- Namerno NISU ukljucene tabele "Grupe B" (account, session,
-- verification, alert, asset, invoices, event) - nepovezane sa
-- D&D Monitoring aplikacijom.
--
-- Pokrenuti CEO fajl odjednom u Supabase SQL Editor-u.
-- Idempotentno je (IF NOT EXISTS svuda) - bezbedno za ponovno
-- pokretanje ako nesto stane na pola.
-- =========================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================================================
-- 1. organizations, sites
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

-- NAPOMENA: stvarna 'sites' tabela NEMA 'timezone' ni 'status'
-- kolonu (za razliku od sto migracija 001 iz repo-a pretpostavlja).
CREATE TABLE IF NOT EXISTS sites (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  address         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sites_org ON sites(organization_id);

-- =========================================================
-- 2. users, roles, permissions
-- =========================================================
-- NAPOMENA: 'users' je originalno napravljen od strane Better-Auth
-- biblioteke (otud id TEXT, camelCase emailVerified/createdAt/
-- updatedAt), pa su organization_id/user_type/status/last_login_at
-- naknadno rucno dodati za D&D Monitoring potrebe. Cuvamo TACNO
-- ovaj oblik da ne bi trebalo transformisati podatke pri migraciji.

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  "emailVerified" BOOLEAN NOT NULL DEFAULT false,
  image           TEXT,
  "createdAt"     TIMESTAMP NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMP NOT NULL DEFAULT now(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_type       VARCHAR DEFAULT 'org_admin',
  status          VARCHAR DEFAULT 'active',
  last_login_at   TIMESTAMPTZ
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
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id         INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- NAPOMENA: role/permission redovi se NE seed-uju ovde - dolaze
-- direktno iz Neon migracije (data_migration skripta), da bi se
-- ocuvali tacni ID-jevi na koje se role_permissions/user_roles
-- oslanjaju.

-- =========================================================
-- 3. media_nodes (nema FK zavisnosti unazad)
-- =========================================================

CREATE TABLE IF NOT EXISTS media_nodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  public_hls_url  TEXT,
  region          TEXT,
  status          TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- =========================================================
-- 4. cameras
-- =========================================================

CREATE TABLE IF NOT EXISTS cameras (
  id              VARCHAR PRIMARY KEY,
  name            VARCHAR NOT NULL,
  rtsp_url        VARCHAR,
  location        VARCHAR,
  lat             DOUBLE PRECISION,
  lng             DOUBLE PRECISION,
  enabled         BOOLEAN,
  resolution      VARCHAR,
  fps             INTEGER,
  codec           VARCHAR,
  created_at      TIMESTAMP DEFAULT now(),
  updated_at      TIMESTAMP,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  media_node_id   UUID REFERENCES media_nodes(id) ON DELETE SET NULL,
  site_id         UUID REFERENCES sites(id) ON DELETE CASCADE,
  recording_mode  VARCHAR NOT NULL,
  retention_days  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cameras_org ON cameras(organization_id);
CREATE INDEX IF NOT EXISTS idx_cameras_site ON cameras(site_id);

CREATE TABLE IF NOT EXISTS camera_stream_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id       VARCHAR NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token           TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS camera_view_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id       VARCHAR NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ,
  ip_address      INET
);

-- =========================================================
-- 5. events, ai_detections, object_attributes
-- =========================================================

CREATE TABLE IF NOT EXISTS events (
  id              SERIAL PRIMARY KEY,
  timestamp       TIMESTAMP NOT NULL,
  camera_id       VARCHAR NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  event_type      VARCHAR NOT NULL,
  severity        VARCHAR,
  description     TEXT,
  is_dismissed    BOOLEAN DEFAULT false,
  created_at      TIMESTAMP DEFAULT now(),
  updated_at      TIMESTAMP,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_events_org ON events(organization_id);
CREATE INDEX IF NOT EXISTS idx_events_camera ON events(camera_id);

CREATE TABLE IF NOT EXISTS ai_detections (
  id              SERIAL PRIMARY KEY,
  event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  object_type     VARCHAR NOT NULL,
  confidence      DOUBLE PRECISION NOT NULL,
  bounding_box    JSONB,
  timestamp       TIMESTAMP NOT NULL,
  created_at      TIMESTAMP DEFAULT now(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_attributes_composite ON object_attributes(attribute_type, attribute_value);

CREATE TABLE IF NOT EXISTS object_attributes (
  id              SERIAL PRIMARY KEY,
  detection_id    INTEGER NOT NULL REFERENCES ai_detections(id) ON DELETE CASCADE,
  attribute_type  VARCHAR NOT NULL,
  attribute_value VARCHAR NOT NULL,
  confidence      DOUBLE PRECISION NOT NULL,
  created_at      TIMESTAMP DEFAULT now()
);

-- =========================================================
-- 6. incidents
-- =========================================================

CREATE TABLE IF NOT EXISTS incidents (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  camera_id             VARCHAR REFERENCES cameras(id) ON DELETE SET NULL,
  organization_id       UUID REFERENCES organizations(id) ON DELETE CASCADE,
  status                VARCHAR,
  severity              VARCHAR,
  assigned_operator_id  UUID,
  created_at            TIMESTAMPTZ DEFAULT now(),
  acknowledged_at       TIMESTAMPTZ,
  resolved_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_incidents_org ON incidents(organization_id);

CREATE TABLE IF NOT EXISTS incident_activity_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id     UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  action          VARCHAR NOT NULL,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================================
-- 7. operator_assignments, notification_rules
-- =========================================================

CREATE TABLE IF NOT EXISTS operator_assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id         UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  assigned_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  active          BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS notification_rules (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type              VARCHAR,
  channel                 VARCHAR NOT NULL,
  recipient               TEXT NOT NULL,
  escalate_after_minutes  INTEGER,
  active                  BOOLEAN NOT NULL DEFAULT true,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================================
-- 8. recordings, snapshots
-- =========================================================

CREATE TABLE IF NOT EXISTS recordings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id             VARCHAR NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id              INTEGER REFERENCES events(id) ON DELETE SET NULL,
  start_time            TIMESTAMPTZ NOT NULL,
  end_time              TIMESTAMPTZ,
  storage_url           TEXT,
  duration_seconds      INTEGER,
  size_bytes            BIGINT,
  trigger_reason        TEXT NOT NULL,
  status                TEXT NOT NULL,
  retention_expires_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_recordings_org ON recordings(organization_id);
CREATE INDEX IF NOT EXISTS idx_recordings_camera ON recordings(camera_id);

CREATE TABLE IF NOT EXISTS snapshots (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id         VARCHAR NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  taken_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  taken_at          TIMESTAMPTZ NOT NULL,
  storage_url       TEXT NOT NULL,
  trigger           TEXT NOT NULL,
  file_size_bytes   BIGINT
);
CREATE INDEX IF NOT EXISTS idx_snapshots_org ON snapshots(organization_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_camera ON snapshots(camera_id);

COMMIT;

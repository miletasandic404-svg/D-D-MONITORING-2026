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

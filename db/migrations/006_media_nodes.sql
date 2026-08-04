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

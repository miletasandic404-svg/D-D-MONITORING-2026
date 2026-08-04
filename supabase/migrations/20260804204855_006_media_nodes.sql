-- Migration 006: Media node registry

CREATE TABLE IF NOT EXISTS media_nodes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region              VARCHAR(50) NOT NULL,
  hostname            TEXT NOT NULL,
  public_hls_url      TEXT NOT NULL,
  capacity            INTEGER NOT NULL DEFAULT 50,
  status              VARCHAR(20) NOT NULL DEFAULT 'online',
  heartbeat_secret    TEXT NOT NULL,
  last_heartbeat_at   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_nodes_region ON media_nodes(region);

ALTER TABLE cameras ADD COLUMN IF NOT EXISTS media_node_id UUID REFERENCES media_nodes(id);
CREATE INDEX IF NOT EXISTS idx_cameras_media_node ON cameras(media_node_id);
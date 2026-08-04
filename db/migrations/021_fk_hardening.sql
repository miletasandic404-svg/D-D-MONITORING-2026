-- Migration 021: FK Hardening
--
-- Changes cameras FK delete rules:
--   cameras.site_id → sites(id)    NO ACTION → CASCADE
--     (cameras belong to a site; if site is deleted, cameras should follow)
--   cameras.media_node_id → media_nodes(id)  NO ACTION → SET NULL
--     (if media node is decommissioned, cameras remain but lose the assignment)
--
-- Pre-conditions verified:
--   cameras.media_node_id allows NULL (required for SET NULL) ✅
--   cameras table has data (1 row) — DROP/ADD is safe
--   Constraint names confirmed from pg_indexes: cameras_site_id_fkey, cameras_media_node_id_fkey

BEGIN;

-- cameras.site_id → CASCADE
ALTER TABLE cameras
  DROP CONSTRAINT IF EXISTS cameras_site_id_fkey;

ALTER TABLE cameras
  ADD CONSTRAINT cameras_site_id_fkey
  FOREIGN KEY (site_id)
  REFERENCES sites(id)
  ON DELETE CASCADE;

-- cameras.media_node_id → SET NULL (column is nullable ✅)
ALTER TABLE cameras
  DROP CONSTRAINT IF EXISTS cameras_media_node_id_fkey;

ALTER TABLE cameras
  ADD CONSTRAINT cameras_media_node_id_fkey
  FOREIGN KEY (media_node_id)
  REFERENCES media_nodes(id)
  ON DELETE SET NULL;

COMMIT;

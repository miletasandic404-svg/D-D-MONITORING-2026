-- Migration 020: Cleanup unused object_attributes table
--
-- object_attributes was created outside the migration system
-- and is not used by any API, frontend, or backend code.
-- It has 0 rows and no dependent objects.
-- FK cascade to ai_detections is safe to drop.
--
-- Pre-conditions verified:
--   0 rows
--   0 references in API/lib/ migration code
--   1 FK: detection_id → ai_detections(id) ON DELETE CASCADE
--   No RLS policies
--   No dependent objects

BEGIN;

DROP TABLE IF EXISTS object_attributes;

COMMIT;

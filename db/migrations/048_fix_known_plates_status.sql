-- =========================================================
-- Migration 048: Fix known_plates status constraint
--
-- Problem: Production known_plates has incorrect CHECK constraint:
--   status IN ('active', 'suspicious', 'blocked')
-- Application expects:
--   status IN ('allowed', 'blocked', 'unknown')
--
-- Fix: Normalize existing data and replace constraint.
-- =========================================================

BEGIN;

UPDATE known_plates
SET status = 'allowed'
WHERE status = 'active';

UPDATE known_plates
SET status = 'unknown'
WHERE status = 'suspicious';

ALTER TABLE known_plates
  DROP CONSTRAINT IF EXISTS known_plates_status_check;

ALTER TABLE known_plates
  ADD CHECK (status IN ('allowed', 'blocked', 'unknown'));

COMMIT;

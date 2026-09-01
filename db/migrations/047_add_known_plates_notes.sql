-- =========================================================
-- Migration 047: Add missing notes column to known_plates
--
-- Problem: known_plates table is missing the notes column,
-- causing GET /api/license-plates to fail with:
--   column "notes" does not exist
--
-- Fix: Add the missing column idempotently.
-- =========================================================

BEGIN;

ALTER TABLE known_plates
  ADD COLUMN IF NOT EXISTS notes TEXT;

COMMIT;

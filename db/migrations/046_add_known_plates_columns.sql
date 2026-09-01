-- =========================================================
-- Migration 046: Add missing columns to known_plates
--
-- Problem: known_plates table exists but is missing
-- vehicle_make, vehicle_model, and vehicle_color columns.
-- This causes GET /api/license-plates to fail with:
--   column "vehicle_make" does not exist
--
-- Fix: Add the missing columns idempotently.
-- =========================================================

BEGIN;

ALTER TABLE known_plates
  ADD COLUMN IF NOT EXISTS vehicle_make TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_model TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_color TEXT;

COMMIT;

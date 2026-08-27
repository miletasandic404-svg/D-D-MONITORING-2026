-- =========================================================
-- Migration 044: Known Plates
--
-- Problem: LPR page is a UI wrapper around /ai-detections
-- filter. No known_plates table exists — all plates are
-- "unknown", no allowlist/blocklist management.
--
-- Fix: Create organization-scoped known_plates table for
-- manual plate enrollment without ML matching.
--
-- Idempotent (IF NOT EXISTS everywhere).
-- =========================================================

BEGIN;

CREATE TABLE IF NOT EXISTS known_plates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plate_number    TEXT NOT NULL,
  vehicle_make    TEXT,
  vehicle_model   TEXT,
  vehicle_color   TEXT,
  status          TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('allowed', 'blocked', 'unknown')),
  notes           TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_known_plates_org_plate
  ON known_plates(organization_id, plate_number);

CREATE INDEX IF NOT EXISTS idx_known_plates_org_status
  ON known_plates(organization_id, status);

COMMIT;

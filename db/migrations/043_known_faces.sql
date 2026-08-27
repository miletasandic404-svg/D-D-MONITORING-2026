-- =========================================================
-- Migration 043: Known Faces
--
-- Problem: Face Recognition page is a UI wrapper around
-- /ai-detections filter. No known_faces table exists —
-- all detections are hardcoded as "unknown", no way to
-- enroll/manage known individuals.
--
-- Fix: Create organization-scoped known_faces table for
-- manual face enrollment without ML matching.
--
-- Idempotent (IF NOT EXISTS everywhere).
-- =========================================================

BEGIN;

CREATE TABLE IF NOT EXISTS known_faces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  image_url       TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspicious', 'blocked')),
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_known_faces_org ON known_faces(organization_id);
CREATE INDEX IF NOT EXISTS idx_known_faces_org_status ON known_faces(organization_id, status);

COMMIT;

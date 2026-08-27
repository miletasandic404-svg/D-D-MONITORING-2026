-- =========================================================
-- Migration 041: Emergency Dispatch
--
-- Problem: Emergency Dispatch is a UI placeholder with no
-- backend. Dispatches are simulated via setTimeout() and
-- history is hardcoded.
--
-- Fix: Create emergency_dispatches table to store real
-- dispatch records with org isolation and audit trail.
--
-- Idempotent (IF NOT EXISTS everywhere).
-- =========================================================

BEGIN;

CREATE TABLE IF NOT EXISTS emergency_dispatches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  camera_id       VARCHAR REFERENCES cameras(id) ON DELETE SET NULL,
  incident_type   VARCHAR(50) NOT NULL,
  location        TEXT,
  description     TEXT,
  priority        VARCHAR(20) NOT NULL DEFAULT 'high',
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  dispatched_by   TEXT NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_emergency_dispatches_org ON emergency_dispatches(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_emergency_dispatches_status ON emergency_dispatches(status) WHERE status = 'pending';

COMMIT;

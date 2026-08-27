-- =========================================================
-- Migration 042: Organization Settings
--
-- Problem: Settings page is frontend-only with no persistence.
-- All toggles are local useState, lost on refresh, no RBAC.
--
-- Fix: Create organization_settings table for org-wide
-- persisted settings with audit trail.
--
-- Idempotent (IF NOT EXISTS everywhere).
-- =========================================================

BEGIN;

CREATE TABLE IF NOT EXISTS organization_settings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  email_alerts    BOOLEAN NOT NULL DEFAULT true,
  push_notifications BOOLEAN NOT NULL DEFAULT true,
  auto_reports    BOOLEAN NOT NULL DEFAULT false,
  weekly_summary  BOOLEAN NOT NULL DEFAULT false,
  map_overlays    BOOLEAN NOT NULL DEFAULT true,
  dark_mode       BOOLEAN NOT NULL DEFAULT true,
  updated_at      TIMESTAMPTZ,
  updated_by      TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_organization_settings_org ON organization_settings(organization_id);

COMMIT;

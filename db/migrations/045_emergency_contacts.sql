-- =========================================================
-- Migration 045: Emergency Contacts in Organization Settings
--
-- Problem: Emergency contacts are hardcoded in the frontend
-- (911, 555-1234) and not configurable per organization.
--
-- Fix: Add emergency_contacts JSONB column to
-- organization_settings so each org can configure its own
-- police, fire, ambulance, and security contacts.
--
-- Idempotent (IF NOT EXISTS everywhere).
-- =========================================================

BEGIN;

ALTER TABLE organization_settings
  ADD COLUMN IF NOT EXISTS emergency_contacts JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;

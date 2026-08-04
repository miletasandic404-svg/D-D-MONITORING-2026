-- =========================================================
-- Phase 7 migration: missing performance indexes
-- =========================================================
-- Adds missing indexes identified during security/performance audit
--
-- Safe to run once. Idempotent (IF NOT EXISTS everywhere).

BEGIN;

-- Index on users.email for faster login lookups
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Index on events.is_dismissed for faster incident filtering
CREATE INDEX IF NOT EXISTS idx_events_dismissed ON events(is_dismissed) WHERE is_dismissed = FALSE;

-- Index on incidents.status for faster incident management
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);

COMMIT;

-- Migration 008: Missing performance indexes

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_events_dismissed ON events(is_dismissed) WHERE is_dismissed = FALSE;
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
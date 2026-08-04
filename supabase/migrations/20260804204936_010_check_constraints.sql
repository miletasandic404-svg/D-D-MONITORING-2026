-- Migration 010: CHECK constraints for status fields

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_incidents_status') THEN
    ALTER TABLE incidents ADD CONSTRAINT chk_incidents_status
      CHECK (status IN ('New', 'Acknowledged', 'In Progress', 'Resolved', 'False Alarm'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_user_type') THEN
    ALTER TABLE users ADD CONSTRAINT chk_users_user_type
      CHECK (user_type IN ('platform_admin', 'org_admin', 'operator', 'customer_viewer'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_status') THEN
    ALTER TABLE users ADD CONSTRAINT chk_users_status
      CHECK (status IN ('active', 'invited', 'disabled'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_events_severity') THEN
    ALTER TABLE events ADD CONSTRAINT chk_events_severity
      CHECK (severity IN ('INFO', 'WARNING', 'ALERT'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_recordings_status') THEN
    ALTER TABLE recordings ADD CONSTRAINT chk_recordings_status
      CHECK (status IN ('recording', 'completed', 'failed'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_recordings_trigger_reason') THEN
    ALTER TABLE recordings ADD CONSTRAINT chk_recordings_trigger_reason
      CHECK (trigger_reason IN ('event', 'manual', 'continuous'));
  END IF;
END $$;
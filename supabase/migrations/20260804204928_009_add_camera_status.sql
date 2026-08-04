-- Migration 009: Add camera status column

ALTER TABLE cameras ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'online';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_cameras_status') THEN
    ALTER TABLE cameras ADD CONSTRAINT chk_cameras_status
      CHECK (status IN ('online', 'offline', 'warning'));
  END IF;
END $$;
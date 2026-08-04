-- =========================================================
-- Migration 030: Encrypt camera credentials at rest
--
-- Security fix: Camera usernames/passwords are currently stored in
-- plaintext in camera_setup_tasks (username, password columns) and
-- embedded in cameras.rtsp_url (rtsp://user:pass@ip/path).
--
-- This migration:
--   1. Adds encrypted_credential column to camera_setup_tasks
--      (stores AES-256-GCM encrypted JSON blob with username+password)
--   2. Adds rtsp_username and rtsp_password_encrypted columns to cameras
--      (stores credentials separately from the URL, encrypted)
--   3. Does NOT modify existing columns (no data loss)
--   4. Existing plaintext columns remain but are cleared by the
--      application after task completion
--
-- The application (lib/_crypto.js) handles encryption/decryption using
-- CREDENTIAL_ENCRYPTION_KEY env var (or derived from DATABASE_URL).
--
-- Idempotent: safe to re-run.
-- =========================================================

BEGIN;

-- ── 1. camera_setup_tasks: add encrypted credentials column ───────────────
ALTER TABLE camera_setup_tasks
  ADD COLUMN IF NOT EXISTS encrypted_credentials text;

-- ── 2. cameras: separate credential storage from RTSP URL ────────────────
-- The rtsp_url column will be sanitized to strip embedded credentials.
-- Credentials are stored separately in encrypted form.
ALTER TABLE cameras
  ADD COLUMN IF NOT EXISTS rtsp_username text,
  ADD COLUMN IF NOT EXISTS rtsp_password_encrypted text;

-- ── 3. Index for faster credential lookup by camera ──────────────────────
CREATE INDEX IF NOT EXISTS idx_cameras_rtsp_credentials
  ON cameras (id) WHERE rtsp_password_encrypted IS NOT NULL;

COMMIT;

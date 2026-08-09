-- =========================================================
-- Migration 033: Cloud camera accounts (Tuya/Hikvision/Reolink)
--
-- Lets an organization link a camera-vendor cloud account (Tuya IoT
-- Platform, Hikvision ISC/Ezviz Cloud, Reolink Cloud) so cameras that
-- already push to the vendor's own cloud can be onboarded WITHOUT any
-- local hardware (laptop/media node) on the customer's site -- those
-- vendors already solved the NAT traversal problem for their own
-- devices; we just need to talk to their API.
--
-- Credentials are encrypted at rest using the same AES-256-GCM scheme
-- as camera RTSP credentials (lib/_crypto.js), never stored plaintext.
-- =========================================================

BEGIN;

CREATE TABLE IF NOT EXISTS camera_cloud_accounts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  provider            TEXT NOT NULL CHECK (provider IN ('tuya', 'hikvision', 'reolink')),
  -- Human label so an org can have more than one account per provider
  -- (e.g. two separate Tuya developer projects for two client sites).
  label               TEXT NOT NULL DEFAULT '',

  -- AES-256-GCM encrypted JSON blob. Shape depends on provider:
  --   tuya:      { clientId, clientSecret, region }
  --   hikvision: { accessToken, region }
  --   reolink:   { accessToken }
  encrypted_credentials text NOT NULL,

  -- Result of the most recent connectivity check (see POST ?path=connect),
  -- so the UI can show "connected" / "needs attention" without re-testing
  -- on every page load.
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'error')),
  last_checked_at     timestamptz,
  last_error          text,

  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_camera_cloud_accounts_org
  ON camera_cloud_accounts (organization_id);

ALTER TABLE camera_cloud_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE camera_cloud_accounts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON camera_cloud_accounts;
CREATE POLICY tenant_isolation ON camera_cloud_accounts
  USING (current_org_matches(organization_id));

-- Track which cameras were imported via a cloud account, and from which
-- vendor-side device id, so re-import/refresh can match existing rows
-- instead of creating duplicates.
ALTER TABLE cameras
  ADD COLUMN IF NOT EXISTS cloud_account_id UUID REFERENCES camera_cloud_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cloud_device_id   TEXT;

CREATE INDEX IF NOT EXISTS idx_cameras_cloud_device
  ON cameras (cloud_account_id, cloud_device_id) WHERE cloud_account_id IS NOT NULL;

COMMIT;

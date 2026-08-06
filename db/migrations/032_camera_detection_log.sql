-- =========================================================
-- Migration 032: Camera Models Database + Auto-Detection
--
-- Tabela za čuvanje detektovanih modela kamera
-- i istorije auto-detection procesa
-- =========================================================

BEGIN;

-- 1. Kreiraj tabelu za detektovane kamera modele
CREATE TABLE IF NOT EXISTS camera_detection_log (
  id                BIGSERIAL PRIMARY KEY,
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  camera_id         UUID REFERENCES cameras(id) ON DELETE SET NULL,
  
  -- Detektovani podaci
  ip_address        INET NOT NULL,
  detected_vendor   TEXT,
  detection_method  TEXT CHECK (detection_method IN ('MAC_PREFIX', 'HTTP_HEADERS', 'ONVIF', 'MANUAL')),
  model_guess       TEXT,
  mac_address       MACADDR,
  
  -- RTSP info
  rtsp_url_working  TEXT,
  rtsp_candidates   TEXT,  -- JSON array
  
  -- Kredencijali (encrypted)
  default_username  TEXT,
  default_password_encrypted TEXT,
  
  -- Status
  success           BOOLEAN DEFAULT FALSE,
  error_message     TEXT,
  
  -- Audit
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  detected_by       UUID REFERENCES users(id) ON DELETE SET NULL
);

-- 2. Indexi za brzo pronalaženje
CREATE INDEX IF NOT EXISTS idx_camera_detection_org
  ON camera_detection_log(organization_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_camera_detection_ip
  ON camera_detection_log(ip_address);

CREATE INDEX IF NOT EXISTS idx_camera_detection_success
  ON camera_detection_log(success) WHERE success = true;

-- 3. RLS Policies
ALTER TABLE camera_detection_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY camera_detection_org_isolation
  ON camera_detection_log
  FOR ALL
  USING (
    current_setting('app.current_org_id')::uuid IS NOT NULL
    AND organization_id = current_setting('app.current_org_id')::uuid
  )
  WITH CHECK (
    current_setting('app.current_org_id')::uuid IS NOT NULL
    AND organization_id = current_setting('app.current_org_id')::uuid
  );

-- Workers mogu čitati sve detection logs
CREATE POLICY camera_detection_worker_access
  ON camera_detection_log
  FOR SELECT
  TO media_node_worker
  USING (true);

-- 4. Grant pristupa
GRANT SELECT, INSERT, UPDATE ON camera_detection_log TO media_node_worker;

COMMIT;

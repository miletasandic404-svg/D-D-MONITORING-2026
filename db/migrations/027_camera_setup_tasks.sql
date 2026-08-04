-- Migration 027: Camera Setup Wizard — task queue
--
-- The dashboard wizard cannot reach cameras on the user's LAN (Vercel is in
-- the cloud). LAN work (ONVIF discovery, RTSP probing, MediaMTX path
-- creation) runs on the local media node via workers/camera-setup-agent.js.
-- This table is the message bus between the two:
--
--   dashboard --(API, org-scoped)--> camera_setup_tasks row
--   camera-setup-agent --(owner role, RLS bypass)--> executes task, writes result
--   dashboard --(poll GET /api/camera-setup/:id)--> shows progress / live preview
--
-- Modes:
--   scan   - agent scans its own LAN subnet for ONVIF cameras (result.cameras[])
--   onvif  - agent discovers one camera by IP, finds RTSP URL, tests it,
--            registers the camera (assigned to its own media node) and adds
--            the MediaMTX path (result.camera_id)
--   manual - agent registers the camera from a user-supplied rtsp_url
--
-- Credentials are stored only briefly (task is short-lived; failed/pending
-- tasks are ignored after CAMERA_SETUP_MAX_AGE_MINUTES in the agent) and are
-- never returned by the API.

BEGIN;

CREATE TABLE IF NOT EXISTS camera_setup_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id uuid REFERENCES sites(id) ON DELETE CASCADE,
  created_by text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('scan', 'onvif', 'manual')),
  ip text,
  onvif_port integer NOT NULL DEFAULT 80,
  username text,
  password text,
  rtsp_url text,
  camera_name text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'working', 'done', 'failed')),
  assigned_node_id uuid REFERENCES media_nodes(id) ON DELETE SET NULL,
  camera_id text,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- API polls: org's recent tasks.
CREATE INDEX IF NOT EXISTS idx_camera_setup_org
  ON camera_setup_tasks (organization_id, created_at DESC);

-- Agent claims: oldest pending task (FOR UPDATE SKIP LOCKED).
CREATE INDEX IF NOT EXISTS idx_camera_setup_pending
  ON camera_setup_tasks (status, created_at) WHERE status = 'pending';

COMMIT;

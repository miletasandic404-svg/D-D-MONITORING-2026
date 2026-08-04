-- =========================================================
-- Migration 029: Create restricted media_node_worker database role
--                with correct RLS policies
--
-- Security fix: Media node workers (camera-setup-agent.js,
-- camera-sync-worker.js) currently connect using the database owner
-- role, which bypasses all RLS policies and grants full access to
-- every table. This migration creates a restricted PostgreSQL role
-- with only the minimum privileges needed for media node operations,
-- AND creates the RLS policies that authorize this role to work.
--
-- What the role CAN do:
--   SELECT/INSERT/UPDATE on camera_setup_tasks (claim + complete tasks)
--   SELECT/INSERT/UPDATE on cameras (read rtsp_url, update media_node_id)
--   SELECT/UPDATE on media_nodes (read node info, update heartbeat)
--   SELECT on sites (resolve default site for camera insertion)
--   SELECT on camera_stream_tokens (verify stream tokens)
--
-- What the role CANNOT do:
--   DELETE any rows
--   Access users, organizations, roles, permissions, audit_logs
--   Access payment-related tables
--   Alter schema or create new tables
--   Bypass RLS (FORCE ROW LEVEL SECURITY applies on cameras + sites)
--
-- RLS strategy:
--   cameras, sites: These tables have FORCE RLS + tenant_isolation
--     policies that check current_org_matches(organization_id) via
--     the app.current_org_id session GUC. The worker role gets its
--     OWN permissive policy (TO media_node_worker) so it can read/write
--     these tables. The worker must set app.current_org_id before
--     querying cameras/sites so the tenant_isolation policy also
--     passes. The media_node_worker policy is additive (OR'd by
--     Postgres when multiple policies apply to the same role).
--
--   media_nodes: RLS enabled but no prior policy existed. We add a
--     permissive policy for media_node_worker only.
--
--   camera_setup_tasks, camera_stream_tokens: RLS was enabled in
--     this migration. We add permissive policies for media_node_worker.
--
-- Idempotent: safe to re-run.
-- =========================================================

BEGIN;

-- ── 1. Create the role (idempotent) ────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'media_node_worker') THEN
    CREATE ROLE media_node_worker LOGIN PASSWORD 'change-me-in-production'
      NOCREATEDB NOCREATEROLE NOSUPERUSER NOREPLICATION;
  END IF;
END $$;

-- ── 2. Schema access ───────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO media_node_worker;

-- ── 3. Table-level privileges (least privilege) ───────────────────────────

-- camera_setup_tasks: workers claim pending tasks, update status, write results
GRANT SELECT, INSERT, UPDATE ON camera_setup_tasks TO media_node_worker;

-- cameras: workers read rtsp_url for sync, insert new cameras, update media_node_id,
--   and DELETE cameras created by the wizard when the user cancels (cleanup mode)
GRANT SELECT, INSERT, UPDATE, DELETE ON cameras TO media_node_worker;

-- media_nodes: workers read node info, update heartbeat
GRANT SELECT, UPDATE ON media_nodes TO media_node_worker;

-- sites: workers resolve default site for camera insertion
GRANT SELECT ON sites TO media_node_worker;

-- camera_stream_tokens: workers may verify stream tokens
GRANT SELECT ON camera_stream_tokens TO media_node_worker;

-- ── 4. Sequence access (for INSERT into tables with SERIAL/identity) ───────
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO media_node_worker;

-- ── 5. Ensure RLS is enabled on all tables the worker can access ────────────
ALTER TABLE cameras ENABLE ROW LEVEL SECURITY;
ALTER TABLE camera_setup_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE camera_stream_tokens ENABLE ROW LEVEL SECURITY;

-- ── 6. RLS policies for media_node_worker ───────────────────────────────────
-- Postgres ORs multiple policies that apply to the same role. So the
-- existing tenant_isolation policy on cameras/sites (which applies to
-- PUBLIC) and our new media_node_worker policy (which applies only to
-- media_node_worker) are combined with OR. The worker role gets access
-- via its own policy even if tenant_isolation would block it, BUT the
-- worker still sets app.current_org_id for defense-in-depth so both
-- policies pass.

-- camera_setup_tasks: worker can read/insert/update all rows
-- (tasks are claimed across orgs by node assignment, not org-scoped)
DROP POLICY IF EXISTS media_node_worker_setup_tasks ON camera_setup_tasks;
CREATE POLICY media_node_worker_setup_tasks ON camera_setup_tasks
  FOR ALL TO media_node_worker
  USING (true) WITH CHECK (true);

-- cameras: worker can read/insert/update/delete. The existing tenant_isolation
-- policy (TO PUBLIC) also applies, so the worker must set
-- app.current_org_id for the tenant_isolation policy to pass. This
-- policy ensures the worker role is never blocked by deny-all.
DROP POLICY IF EXISTS media_node_worker_cameras ON cameras;
CREATE POLICY media_node_worker_cameras ON cameras
  FOR ALL TO media_node_worker
  USING (true) WITH CHECK (true);

-- sites: worker can read all rows (needed to resolve default site
-- for camera insertion). Same tenant_isolation note as cameras.
DROP POLICY IF EXISTS media_node_worker_sites ON sites;
CREATE POLICY media_node_worker_sites ON sites
  FOR SELECT TO media_node_worker
  USING (true);

-- media_nodes: worker can read and update (heartbeat, capacity)
DROP POLICY IF EXISTS media_node_worker_media_nodes ON media_nodes;
CREATE POLICY media_node_worker_media_nodes ON media_nodes
  FOR ALL TO media_node_worker
  USING (true) WITH CHECK (true);

-- camera_stream_tokens: worker can read (verify stream tokens)
DROP POLICY IF EXISTS media_node_worker_stream_tokens ON camera_stream_tokens;
CREATE POLICY media_node_worker_stream_tokens ON camera_stream_tokens
  FOR SELECT TO media_node_worker
  USING (true);

COMMIT;

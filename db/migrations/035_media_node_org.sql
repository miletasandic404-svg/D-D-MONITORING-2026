-- =========================================================
-- Migration 035: Bind media nodes to an organization
--
-- Security fix (cross-tenant media node access): media nodes are
-- tenant-owned hardware (laptops on each organization's own LAN --
-- see laptop/README.md). Yet camera_setup_tasks were claimable by
-- ANY online node (workers/camera-setup-agent.js claimNextTask),
-- so org A could create a malicious setup task (ip=169.254.169.254
-- or any host) that a node on org B's network would execute,
-- giving org A network-probe access into org B's LAN.
--
-- This migration adds media_nodes.organization_id so task claiming
-- can be scoped to the node's own organization.
--
-- Backfill: nodes that already have cameras assigned (cameras.
-- media_node_id) inherit the organization of those cameras, but
-- ONLY when that organization is unambiguous (exactly one distinct
-- org across the node's cameras). Nodes with no cameras (or cameras
-- spanning multiple orgs) stay NULL (unassigned) -- they will not
-- claim any tasks until an admin assigns an organization. No
-- mapping is invented.
--
-- Idempotent: safe to re-run.
-- =========================================================

BEGIN;

ALTER TABLE media_nodes
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_media_nodes_org
  ON media_nodes (organization_id);

-- Safe backfill from existing camera assignments (unambiguous only).
UPDATE media_nodes n
SET organization_id = sub.org_id
FROM (
  SELECT c.media_node_id, (array_agg(c.organization_id))[1] AS org_id
  FROM cameras c
  WHERE c.media_node_id IS NOT NULL
  GROUP BY c.media_node_id
  HAVING count(DISTINCT c.organization_id) = 1
) sub
WHERE n.id = sub.media_node_id
  AND n.organization_id IS NULL;

-- Tenant isolation for API access to media_nodes. RLS is already
-- ENABLED (migration 029); FORCE is intentionally NOT used so the
-- owner-role heartbeat (db.query in api/media-nodes.js) and the
-- media_node_worker permissive policy keep working. platform_admin
-- passes via app.is_platform_admin; tenant users see only their own
-- nodes via app.current_org_id.
DROP POLICY IF EXISTS tenant_isolation ON media_nodes;
CREATE POLICY tenant_isolation ON media_nodes
  USING (current_org_matches(organization_id));

COMMIT;

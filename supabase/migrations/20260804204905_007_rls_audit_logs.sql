-- Migration 007: RLS audit logs + Row Level Security

CREATE TABLE IF NOT EXISTS audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         TEXT,
  action          VARCHAR(100) NOT NULL,
  resource_type   VARCHAR(50),
  resource_id     TEXT,
  metadata        JSONB,
  ip_address      INET,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_time ON audit_logs(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id);

CREATE OR REPLACE FUNCTION current_org_matches(row_org_id UUID) RETURNS BOOLEAN AS $$
  SELECT
    current_setting('app.is_platform_admin', true) = 'true'
    OR row_org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['cameras', 'events', 'incidents', 'snapshots', 'recordings', 'sites', 'camera_view_logs', 'notification_rules', 'audit_logs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_org_matches(organization_id))', t);
  END LOOP;
END $$;
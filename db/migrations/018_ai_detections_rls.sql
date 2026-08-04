-- =========================================================
-- Migration 018: ai_detections RLS + hardening
-- 
-- ai_detections was missing:
--   1. RLS tenant isolation (every other tenant table has it since 007)
--   2. FK from organization_id → organizations(id)
--   3. NOT NULL on organization_id
--
-- API code (api/ai-detections.js) already uses queryAsOrg(), so RLS
-- will be transparent — no code changes needed.
-- =========================================================

BEGIN;

-- 1. Add FK: ai_detections.organization_id → organizations(id) ON DELETE CASCADE
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_ai_detections_organization'
      AND conrelid = 'ai_detections'::regclass
  ) THEN
    ALTER TABLE ai_detections
      ADD CONSTRAINT fk_ai_detections_organization
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 2. SET NOT NULL on organization_id
--    Safe: 0 rows currently in ai_detections
ALTER TABLE ai_detections ALTER COLUMN organization_id SET NOT NULL;

-- 3. Enable RLS + add tenant_isolation policy
--    Uses existing current_org_matches() function from migration 007
ALTER TABLE ai_detections ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_detections FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON ai_detections;
CREATE POLICY tenant_isolation ON ai_detections
  USING (current_org_matches(organization_id));

COMMIT;

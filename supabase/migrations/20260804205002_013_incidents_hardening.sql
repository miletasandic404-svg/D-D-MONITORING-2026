-- Migration 013: Incidents table hardening

ALTER TABLE incidents ADD COLUMN IF NOT EXISTS site_id UUID;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS resolution_notes TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_incidents_site') THEN
    ALTER TABLE incidents ADD CONSTRAINT fk_incidents_site
      FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE incidents ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE incidents ALTER COLUMN camera_id SET NOT NULL;
ALTER TABLE incidents ALTER COLUMN status SET NOT NULL;
ALTER TABLE incidents ALTER COLUMN created_at SET NOT NULL;
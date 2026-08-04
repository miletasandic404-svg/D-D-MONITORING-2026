-- Migration 011: Remove duplicate indexes

DROP INDEX IF EXISTS idx_incidents_camera;
DROP INDEX IF EXISTS idx_incidents_organization_id;
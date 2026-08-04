-- =========================================================
-- Migration 019: Cleanup unused RBAC tables
--
-- Audit conclusion:
--   The app uses users.user_type for role-based access control
--   (checked in lib/_auth.js), not the full RBAC join tables.
--   These tables have 0 rows and are never queried by API code.
--
-- Tables to drop (safe — 0 rows, 0 API references):
--   - user_roles        0 rows, FK → roles(id) + users(id)
--   - role_permissions  0 rows, FK → roles(id) + permissions(id)
--   - permissions       0 rows, no rows at all
--
-- Tables to keep:
--   - roles             4 seeded rows (platform_admin, org_admin, operator, customer_viewer)
--                       Keep as reference data mirroring users.user_type CHECK constraint.
--
-- Drop order matters: child tables first (FK chains), then parents.
-- =========================================================

BEGIN;

-- 1. Drop junction tables first (both have FKs to roles)
DROP TABLE IF EXISTS user_roles;
DROP TABLE IF EXISTS role_permissions;

-- 2. Drop permissions (FK from role_permissions already removed above)
DROP TABLE IF EXISTS permissions;

COMMIT;

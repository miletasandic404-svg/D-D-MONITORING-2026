-- =========================================================
-- D&D Monitoring - migracija PODATAKA sa Neon-a na Supabase
-- preko postgres_fdw (Foreign Data Wrapper)
-- =========================================================
-- POKRENUTI TEK POSLE db/supabase_migration_schema.sql
-- (taj fajl kreira prazne tabele; ovaj ih puni podacima).
--
-- Pre pokretanja, popuni <NEON_HOST>, <NEON_PORT>, <NEON_DBNAME>,
-- <NEON_USER>, <NEON_PASSWORD> iz tvog Neon DATABASE_URL-a:
--   postgresql://USER:PASSWORD@HOST:PORT/DBNAME?sslmode=require
--
-- Pokrece se u Supabase SQL Editor-u. Na kraju skripta SAMA cisti
-- za sobom (brise foreign server/user mapping), tako da Neon
-- kredencijali ne ostaju trajno sacuvani u Supabase bazi.
-- =========================================================

-- 1) Omoguci FDW i napravi konekciju ka Neon-u
CREATE EXTENSION IF NOT EXISTS postgres_fdw;

DROP SERVER IF EXISTS neon_source CASCADE;
CREATE SERVER neon_source
  FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (host '<NEON_HOST>', port '<NEON_PORT>', dbname '<NEON_DBNAME>', sslmode 'require');

CREATE USER MAPPING FOR CURRENT_USER
  SERVER neon_source
  OPTIONS (user '<NEON_USER>', password '<NEON_PASSWORD>');

-- 2) Uvezi SAMO Grupu A tabela (bez Better-Auth: account, session,
--    verification, alert, asset, invoices, event)
CREATE SCHEMA IF NOT EXISTS neon_import;

IMPORT FOREIGN SCHEMA public
  LIMIT TO (
    organizations, sites, users, roles, permissions, role_permissions, user_roles,
    media_nodes, cameras, camera_stream_tokens, camera_view_logs,
    events, ai_detections, object_attributes,
    incidents, incident_activity_log,
    operator_assignments, notification_rules,
    recordings, snapshots
  )
  FROM SERVER neon_source INTO neon_import;

-- 3) Kopiranje podataka - redosled postuje foreign key zavisnosti
BEGIN;

INSERT INTO organizations SELECT * FROM neon_import.organizations
  ON CONFLICT (id) DO NOTHING;

INSERT INTO media_nodes SELECT * FROM neon_import.media_nodes
  ON CONFLICT (id) DO NOTHING;

INSERT INTO sites SELECT * FROM neon_import.sites
  ON CONFLICT (id) DO NOTHING;

INSERT INTO users SELECT * FROM neon_import.users
  ON CONFLICT (id) DO NOTHING;

INSERT INTO roles OVERRIDING SYSTEM VALUE SELECT * FROM neon_import.roles
  ON CONFLICT (id) DO NOTHING;

INSERT INTO permissions OVERRIDING SYSTEM VALUE SELECT * FROM neon_import.permissions
  ON CONFLICT (id) DO NOTHING;

INSERT INTO role_permissions SELECT * FROM neon_import.role_permissions
  ON CONFLICT DO NOTHING;

INSERT INTO user_roles SELECT * FROM neon_import.user_roles
  ON CONFLICT DO NOTHING;

INSERT INTO cameras SELECT * FROM neon_import.cameras
  ON CONFLICT (id) DO NOTHING;

INSERT INTO camera_stream_tokens SELECT * FROM neon_import.camera_stream_tokens
  ON CONFLICT (id) DO NOTHING;

INSERT INTO camera_view_logs SELECT * FROM neon_import.camera_view_logs
  ON CONFLICT (id) DO NOTHING;

INSERT INTO events OVERRIDING SYSTEM VALUE SELECT * FROM neon_import.events
  ON CONFLICT (id) DO NOTHING;

INSERT INTO ai_detections OVERRIDING SYSTEM VALUE SELECT * FROM neon_import.ai_detections
  ON CONFLICT (id) DO NOTHING;

INSERT INTO object_attributes OVERRIDING SYSTEM VALUE SELECT * FROM neon_import.object_attributes
  ON CONFLICT (id) DO NOTHING;

INSERT INTO incidents SELECT * FROM neon_import.incidents
  ON CONFLICT (id) DO NOTHING;

INSERT INTO incident_activity_log SELECT * FROM neon_import.incident_activity_log
  ON CONFLICT (id) DO NOTHING;

INSERT INTO operator_assignments SELECT * FROM neon_import.operator_assignments
  ON CONFLICT (id) DO NOTHING;

INSERT INTO notification_rules SELECT * FROM neon_import.notification_rules
  ON CONFLICT (id) DO NOTHING;

INSERT INTO recordings SELECT * FROM neon_import.recordings
  ON CONFLICT (id) DO NOTHING;

INSERT INTO snapshots SELECT * FROM neon_import.snapshots
  ON CONFLICT (id) DO NOTHING;

COMMIT;

-- 4) Uskladi SERIAL sekvence sa najvecim uvezenim ID-jevima
--    (posto smo koristili OVERRIDING SYSTEM VALUE, sledeci INSERT
--    bez eksplicitnog ID-ja bi inace pokusao id=1 i pukao na PK)
SELECT setval(pg_get_serial_sequence('roles','id'),
  COALESCE((SELECT MAX(id) FROM roles), 1));
SELECT setval(pg_get_serial_sequence('permissions','id'),
  COALESCE((SELECT MAX(id) FROM permissions), 1));
SELECT setval(pg_get_serial_sequence('events','id'),
  COALESCE((SELECT MAX(id) FROM events), 1));
SELECT setval(pg_get_serial_sequence('ai_detections','id'),
  COALESCE((SELECT MAX(id) FROM ai_detections), 1));
SELECT setval(pg_get_serial_sequence('object_attributes','id'),
  COALESCE((SELECT MAX(id) FROM object_attributes), 1));

-- 5) Provera brojeva redova (Neon vs Supabase) - moraju se poklapati
SELECT 'organizations' AS tbl, (SELECT COUNT(*) FROM neon_import.organizations) AS neon, (SELECT COUNT(*) FROM organizations) AS supabase
UNION ALL SELECT 'sites', (SELECT COUNT(*) FROM neon_import.sites), (SELECT COUNT(*) FROM sites)
UNION ALL SELECT 'users', (SELECT COUNT(*) FROM neon_import.users), (SELECT COUNT(*) FROM users)
UNION ALL SELECT 'roles', (SELECT COUNT(*) FROM neon_import.roles), (SELECT COUNT(*) FROM roles)
UNION ALL SELECT 'permissions', (SELECT COUNT(*) FROM neon_import.permissions), (SELECT COUNT(*) FROM permissions)
UNION ALL SELECT 'role_permissions', (SELECT COUNT(*) FROM neon_import.role_permissions), (SELECT COUNT(*) FROM role_permissions)
UNION ALL SELECT 'user_roles', (SELECT COUNT(*) FROM neon_import.user_roles), (SELECT COUNT(*) FROM user_roles)
UNION ALL SELECT 'media_nodes', (SELECT COUNT(*) FROM neon_import.media_nodes), (SELECT COUNT(*) FROM media_nodes)
UNION ALL SELECT 'cameras', (SELECT COUNT(*) FROM neon_import.cameras), (SELECT COUNT(*) FROM cameras)
UNION ALL SELECT 'camera_stream_tokens', (SELECT COUNT(*) FROM neon_import.camera_stream_tokens), (SELECT COUNT(*) FROM camera_stream_tokens)
UNION ALL SELECT 'camera_view_logs', (SELECT COUNT(*) FROM neon_import.camera_view_logs), (SELECT COUNT(*) FROM camera_view_logs)
UNION ALL SELECT 'events', (SELECT COUNT(*) FROM neon_import.events), (SELECT COUNT(*) FROM events)
UNION ALL SELECT 'ai_detections', (SELECT COUNT(*) FROM neon_import.ai_detections), (SELECT COUNT(*) FROM ai_detections)
UNION ALL SELECT 'object_attributes', (SELECT COUNT(*) FROM neon_import.object_attributes), (SELECT COUNT(*) FROM object_attributes)
UNION ALL SELECT 'incidents', (SELECT COUNT(*) FROM neon_import.incidents), (SELECT COUNT(*) FROM incidents)
UNION ALL SELECT 'incident_activity_log', (SELECT COUNT(*) FROM neon_import.incident_activity_log), (SELECT COUNT(*) FROM incident_activity_log)
UNION ALL SELECT 'operator_assignments', (SELECT COUNT(*) FROM neon_import.operator_assignments), (SELECT COUNT(*) FROM operator_assignments)
UNION ALL SELECT 'notification_rules', (SELECT COUNT(*) FROM neon_import.notification_rules), (SELECT COUNT(*) FROM notification_rules)
UNION ALL SELECT 'recordings', (SELECT COUNT(*) FROM neon_import.recordings), (SELECT COUNT(*) FROM recordings)
UNION ALL SELECT 'snapshots', (SELECT COUNT(*) FROM neon_import.snapshots), (SELECT COUNT(*) FROM snapshots);

-- =========================================================
-- 6) CISCENJE - obavezno pokrenuti nakon sto se brojevi poklope!
--    Ovo uklanja Neon kredencijale iz Supabase baze.
-- =========================================================
-- DROP SCHEMA neon_import CASCADE;
-- DROP USER MAPPING FOR CURRENT_USER SERVER neon_source;
-- DROP SERVER neon_source CASCADE;
-- DROP EXTENSION IF EXISTS postgres_fdw;

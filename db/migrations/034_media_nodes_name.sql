-- =========================================================
-- Migration 034: Add name column to media_nodes
--
-- GET /api/media-nodes SELECT-uje n.name, ali kolona name
-- nikada nije definisana: migracija 006 kreira tabelu bez nje
-- (ima hostname, ne name), 016 dodaje hostname/capacity/
-- heartbeat_secret/last_heartbeat_at ali ne i name, a kasnije
-- migracije (028, 029, 031, 033) takodje ne. Bez ove kolone
-- endpoint vraca 500 "column n.name does not exist".
--
-- Aditivno i idempotentno: ne menja nijednu postojecu kolonu,
-- ne uklanja hostname, ne dira podatke.
-- =========================================================

BEGIN;

ALTER TABLE media_nodes ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';

COMMIT;

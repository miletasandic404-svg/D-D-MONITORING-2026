-- ============================================================
-- Migration 012: Cleanup unused tables
--
-- Removes 4 tables identified during schema audit as abandoned:
--   - alert:  ORM/PoC artifact, 0 rows, no FK, no API usage
--   - asset:  ORM/PoC artifact, 0 rows, no FK, no API usage
--   - event:  Early prototype table (singular), 0 rows,
--             has FK → organizations(id) — dropped with table
--   - invoices: PayPal billing experiment, 0 rows, no FK
--
-- None of these tables are referenced by any API code, migration,
-- view, trigger, or RLS policy. Safe to drop at any time.
--
-- Idempotent: DROP TABLE IF EXISTS handles re-runs safely.
-- ============================================================

BEGIN;

DROP TABLE IF EXISTS alert;
DROP TABLE IF EXISTS asset;
DROP TABLE IF EXISTS event;
DROP TABLE IF EXISTS invoices;

COMMIT;

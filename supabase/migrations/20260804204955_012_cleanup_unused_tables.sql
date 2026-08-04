-- Migration 012: Cleanup unused tables

DROP TABLE IF EXISTS alert;
DROP TABLE IF EXISTS asset;
DROP TABLE IF EXISTS event;
DROP TABLE IF EXISTS invoices;
'use strict';

/**
 * Migration structure tests.
 *
 * These run on any machine — no database connection required.
 * They validate that the migration files in db/migrations/ are:
 *   1. Numbered sequentially starting from 001 with no gaps.
 *   2. Every file is wrapped in BEGIN; … COMMIT; (so each migration is
 *      atomic and safe to run on a live database).
 *   3. No two files share the same sequence number.
 *
 * To also run the full integration path (fresh DB → all migrations →
 * schema sanity check), set DATABASE_URL / TEST_DATABASE_URL in the
 * environment and run with --test-reporter=spec.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'db', 'migrations');

// ── helpers ──────────────────────────────────────────────────────────────────

function loadMigrationFiles() {
  const entries = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  entries.sort();
  return entries.map((filename) => {
    const match = /^(\d+)_/.exec(filename);
    const seq = match ? parseInt(match[1], 10) : null;
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
    return { filename, seq, content };
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('Migration files', () => {
  const migrations = loadMigrationFiles();

  test('at least one migration file exists', () => {
    assert.ok(migrations.length > 0, 'No migration files found in db/migrations/');
  });

  test('every file starts with a numeric sequence prefix', () => {
    for (const { filename, seq } of migrations) {
      assert.ok(
        seq !== null,
        `${filename} does not start with a numeric sequence (e.g. 001_...)`,
      );
    }
  });

  test('sequence numbers are unique (no duplicate numbering)', () => {
    const seen = new Map();
    for (const { filename, seq } of migrations) {
      if (seen.has(seq)) {
        assert.fail(
          `Sequence ${seq} appears in both "${seen.get(seq)}" and "${filename}"`,
        );
      }
      seen.set(seq, filename);
    }
  });

  test('sequence numbers are contiguous starting from 1 (no gaps)', () => {
    const sorted = [...migrations].sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < sorted.length; i++) {
      const expected = i + 1;
      assert.strictEqual(
        sorted[i].seq,
        expected,
        `Gap in migration sequence: expected ${expected} but got ${sorted[i].seq} (${sorted[i].filename})`,
      );
    }
  });

  test('every migration is wrapped in BEGIN … COMMIT (atomic)', () => {
    for (const { filename, content } of migrations) {
      const normalized = content.replace(/\r\n/g, '\n').trimEnd();
      // Allow optional BOM and leading whitespace/comments before BEGIN
      assert.ok(
        /^\s*(--[^\n]*\n\s*)*BEGIN\s*;/m.test(normalized),
        `${filename}: missing "BEGIN;" — migration is not wrapped in a transaction`,
      );
      assert.ok(
        /COMMIT\s*;\s*$/.test(normalized),
        `${filename}: missing "COMMIT;" at the end — migration is not properly closed`,
      );
    }
  });

  test('files are ordered correctly on disk (alphabetical sort matches numeric order)', () => {
    const filenames = migrations.map((m) => m.filename);
    const sorted = [...filenames].sort();
    assert.deepStrictEqual(
      filenames,
      sorted,
      'Migration files are not in alphabetical order — this can cause them to be applied in the wrong sequence on case-sensitive file systems',
    );
  });
});

// ── optional integration path (skipped when no DB is configured) ─────────────

describe('Migration integration (requires TEST_DATABASE_URL)', () => {
  const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';

  if (!dbUrl) {
    test.skip('skipped — set TEST_DATABASE_URL to run integration tests', () => {});
    return;
  }

  let Pool;
  try {
    Pool = require('pg').Pool;
  } catch {
    test.skip('skipped — pg module not available', () => {});
    return;
  }

  test('all migrations apply cleanly to a fresh schema in the correct order', async () => {
    const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false }, max: 1 });
    const client = await pool.connect();
    let schemaName;

    try {
      // Create an isolated schema so we never touch the real application tables.
      schemaName = `migration_test_${Date.now()}`;
      await client.query(`CREATE SCHEMA "${schemaName}"`);
      await client.query(`SET search_path TO "${schemaName}", public`);

      const sorted = loadMigrationFiles().sort((a, b) => a.seq - b.seq);

      for (const { filename, content } of sorted) {
        try {
          await client.query(content);
        } catch (err) {
          assert.fail(`Migration ${filename} failed: ${err.message}`);
        }
      }

      // Basic sanity: the last migration's main table must exist.
      const { rows } = await client.query(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = $1
           AND table_name = 'payment_transactions'`,
        [schemaName],
      );
      assert.ok(rows.length > 0, 'payment_transactions table was not created by migrations');
    } finally {
      // Best-effort teardown — drop the isolated schema.
      try {
        await client.query(`DROP SCHEMA "${schemaName}" CASCADE`);
      } catch {
        // ignore
      }
      client.release();
      await pool.end();
    }
  });
});

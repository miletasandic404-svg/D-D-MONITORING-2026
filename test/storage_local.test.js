'use strict';

/**
 * Tests for local filesystem storage backend (lib/_storage_local.js).
 *
 * Validates:
 *   - Path traversal protection
 *   - Upload/read/delete operations
 *   - Key extraction from local:// URLs
 *   - Content type detection
 *   - Error handling
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const local = require('../lib/_storage_local');

// ── Test directory setup ──────────────────────────────────────────────

let testDir;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-storage-test-'));
  process.env.STORAGE_LOCAL_PATH = testDir;
});

afterEach(() => {
  delete process.env.STORAGE_LOCAL_PATH;
  // Clean up test directory
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

// ── Tests ─────────────────────────────────────────────────────────────

describe('lib/_storage_local', () => {
  describe('isLocalConfigured', () => {
    test('returns true when STORAGE_LOCAL_PATH is set to valid dir', () => {
      assert.equal(local.isLocalConfigured(), true);
    });

    test('returns false when STORAGE_LOCAL_PATH is not set', () => {
      delete process.env.STORAGE_LOCAL_PATH;
      assert.equal(local.isLocalConfigured(), false);
    });

    test('returns false when STORAGE_LOCAL_PATH does not exist', () => {
      process.env.STORAGE_LOCAL_PATH = '/nonexistent/path/that/does/not/exist';
      assert.equal(local.isLocalConfigured(), false);
    });

    test('returns false when STORAGE_LOCAL_PATH is a file not dir', () => {
      const filePath = path.join(testDir, 'a-file');
      fs.writeFileSync(filePath, 'content');
      process.env.STORAGE_LOCAL_PATH = filePath;
      assert.equal(local.isLocalConfigured(), false);
    });
  });

  describe('getStorageRoot', () => {
    test('returns resolved absolute path', () => {
      process.env.STORAGE_LOCAL_PATH = testDir;
      assert.equal(local.getStorageRoot(), path.resolve(testDir));
    });

    test('returns null when not configured', () => {
      delete process.env.STORAGE_LOCAL_PATH;
      assert.equal(local.getStorageRoot(), null);
    });
  });

  describe('resolveKeyPath', () => {
    test('resolves valid key to absolute path within root', () => {
      const resolved = local.resolveKeyPath('snapshots/org-1/cam-1/test.jpg');
      assert.ok(resolved.startsWith(path.resolve(testDir)));
      assert.ok(resolved.includes('snapshots'));
      assert.ok(resolved.includes('org-1'));
    });

    test('rejects path traversal with ..', () => {
      assert.throws(
        () => local.resolveKeyPath('snapshots/../../etc/passwd'),
        /Path traversal detected/
      );
    });

    test('rejects path traversal in middle of key', () => {
      assert.throws(
        () => local.resolveKeyPath('snapshots/org-1/../../../etc/passwd'),
        /Path traversal detected/
      );
    });

    test('rejects empty key', () => {
      assert.throws(
        () => local.resolveKeyPath(''),
        /Invalid storage key/
      );
    });

    test('rejects null key', () => {
      assert.throws(
        () => local.resolveKeyPath(null),
        /Invalid storage key/
      );
    });

    test('handles Windows-style backslashes', () => {
      const resolved = local.resolveKeyPath('snapshots\\org-1\\cam-1\\test.jpg');
      assert.ok(resolved.includes('snapshots'));
      assert.ok(resolved.includes('org-1'));
    });

    test('strips leading slashes', () => {
      const resolved = local.resolveKeyPath('/snapshots/org-1/test.jpg');
      assert.ok(resolved.startsWith(path.resolve(testDir)));
    });

    test('rejects paths that resolve outside root', () => {
      assert.throws(
        () => local.resolveKeyPath('a/../../../etc/passwd'),
        /Path traversal detected/
      );
    });
  });

  describe('localUploadObject', () => {
    test('writes file to correct path', async () => {
      const key = 'snapshots/org-1/cam-1/test-uuid.jpg';
      const body = Buffer.from('test image content');
      const url = await local.localUploadObject({ key, body, contentType: 'image/jpeg' });

      assert.equal(url, `local://${key}`);
      const filePath = path.resolve(testDir, key);
      assert.ok(fs.existsSync(filePath));
      assert.equal(fs.readFileSync(filePath).toString(), 'test image content');
    });

    test('creates nested directories automatically', async () => {
      const key = 'deep/nested/path/org-1/cam-1/file.jpg';
      const body = Buffer.from('deep content');
      await local.localUploadObject({ key, body, contentType: 'image/jpeg' });

      const filePath = path.resolve(testDir, key);
      assert.ok(fs.existsSync(filePath));
    });

    test('returns local:// URL', async () => {
      const key = 'recordings/org-2/cam-5/rec-100.mp4';
      const body = Buffer.from('video content');
      const url = await local.localUploadObject({ key, body, contentType: 'video/mp4' });

      assert.ok(url.startsWith('local://'));
      assert.ok(url.includes(key));
    });

    test('throws 503 when not configured', async () => {
      delete process.env.STORAGE_LOCAL_PATH;
      await assert.rejects(
        () => local.localUploadObject({ key: 'test', body: Buffer.from('x'), contentType: 'image/jpeg' }),
        /Local storage is not configured/
      );
    });

    test('throws when body is not a Buffer', async () => {
      await assert.rejects(
        () => local.localUploadObject({ key: 'test', body: 'string content', contentType: 'image/jpeg' }),
        /body must be a Buffer/
      );
    });

    test('overwrites existing file', async () => {
      const key = 'snapshots/org-1/cam-1/overwrite.jpg';
      const body1 = Buffer.from('first');
      const body2 = Buffer.from('second');
      await local.localUploadObject({ key, body: body1, contentType: 'image/jpeg' });
      await local.localUploadObject({ key, body: body2, contentType: 'image/jpeg' });

      const filePath = path.resolve(testDir, key);
      assert.equal(fs.readFileSync(filePath).toString(), 'second');
    });
  });

  describe('localReadObject', () => {
    test('reads file content', async () => {
      const key = 'snapshots/org-1/cam-1/read-test.jpg';
      const body = Buffer.from('readable content');
      await local.localUploadObject({ key, body, contentType: 'image/jpeg' });

      const result = local.localReadObject(key);
      assert.equal(result.toString(), 'readable content');
    });

    test('throws when file does not exist', () => {
      assert.throws(
        () => local.localReadObject('snapshots/nonexistent/file.jpg'),
        /ENOENT/
      );
    });

    test('throws when not configured', () => {
      delete process.env.STORAGE_LOCAL_PATH;
      assert.throws(
        () => local.localReadObject('snapshots/test.jpg'),
        /Local storage is not configured/
      );
    });
  });

  describe('localDeleteObject', () => {
    test('deletes existing file', async () => {
      const key = 'snapshots/org-1/cam-1/delete-me.jpg';
      const body = Buffer.from('delete this');
      await local.localUploadObject({ key, body, contentType: 'image/jpeg' });

      const result = local.localDeleteObject(key);
      assert.equal(result, true);
      assert.ok(!fs.existsSync(path.resolve(testDir, key)));
    });

    test('returns false when file does not exist', () => {
      const result = local.localDeleteObject('snapshots/nonexistent/file.jpg');
      assert.equal(result, false);
    });

    test('returns false when not configured', () => {
      delete process.env.STORAGE_LOCAL_PATH;
      const result = local.localDeleteObject('snapshots/test.jpg');
      assert.equal(result, false);
    });

    test('returns false for invalid key', () => {
      const result = local.localDeleteObject('../../etc/passwd');
      assert.equal(result, false);
    });
  });

  describe('localExists', () => {
    test('returns true for existing file', async () => {
      const key = 'snapshots/org-1/cam-1/exists.jpg';
      await local.localUploadObject({ key, body: Buffer.from('x'), contentType: 'image/jpeg' });

      assert.equal(local.localExists(key), true);
    });

    test('returns false for non-existing file', () => {
      assert.equal(local.localExists('snapshots/nonexistent/file.jpg'), false);
    });

    test('returns false when not configured', () => {
      delete process.env.STORAGE_LOCAL_PATH;
      assert.equal(local.localExists('snapshots/test.jpg'), false);
    });
  });

  describe('keyFromLocalUrl', () => {
    test('extracts key from local:// URL', () => {
      assert.equal(
        local.keyFromLocalUrl('local://snapshots/org-1/cam-1/uuid.jpg'),
        'snapshots/org-1/cam-1/uuid.jpg'
      );
    });

    test('returns null for non-local URL', () => {
      assert.equal(local.keyFromLocalUrl('https://cdn.example/snapshots/test.jpg'), null);
    });

    test('returns null for null input', () => {
      assert.equal(local.keyFromLocalUrl(null), null);
    });

    test('returns null for empty string', () => {
      assert.equal(local.keyFromLocalUrl(''), null);
    });
  });

  describe('getContentTypeFromKey', () => {
    test('returns image/jpeg for .jpg', () => {
      assert.equal(local.getContentTypeFromKey('test.jpg'), 'image/jpeg');
    });

    test('returns image/jpeg for .jpeg', () => {
      assert.equal(local.getContentTypeFromKey('test.jpeg'), 'image/jpeg');
    });

    test('returns image/png for .png', () => {
      assert.equal(local.getContentTypeFromKey('test.png'), 'image/png');
    });

    test('returns video/mp4 for .mp4', () => {
      assert.equal(local.getContentTypeFromKey('test.mp4'), 'video/mp4');
    });

    test('returns application/octet-stream for unknown', () => {
      assert.equal(local.getContentTypeFromKey('test.xyz'), 'application/octet-stream');
    });
  });

  describe('tenant isolation', () => {
    test('different orgs get different directories', async () => {
      const key1 = 'snapshots/org-1/cam-1/file.jpg';
      const key2 = 'snapshots/org-2/cam-1/file.jpg';
      await local.localUploadObject({ key: key1, body: Buffer.from('org1'), contentType: 'image/jpeg' });
      await local.localUploadObject({ key: key2, body: Buffer.from('org2'), contentType: 'image/jpeg' });

      const content1 = fs.readFileSync(path.resolve(testDir, key1)).toString();
      const content2 = fs.readFileSync(path.resolve(testDir, key2)).toString();
      assert.equal(content1, 'org1');
      assert.equal(content2, 'org2');
    });

    test('path traversal cannot escape to different org', () => {
      assert.throws(
        () => local.resolveKeyPath('snapshots/org-1/../../snapshots/org-2/secret.jpg'),
        /Path traversal detected/
      );
    });
  });
});

describe('lib/_storage unified interface', () => {
  const storage = require('../lib/_storage');

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-storage-unified-'));
    process.env.STORAGE_LOCAL_PATH = testDir;
    // Clear S3 env vars to ensure local backend is selected
    delete process.env.STORAGE_BUCKET;
    delete process.env.STORAGE_ACCESS_KEY_ID;
    delete process.env.STORAGE_SECRET_ACCESS_KEY;
  });

  afterEach(() => {
    delete process.env.STORAGE_LOCAL_PATH;
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test('getBackend returns local when STORAGE_LOCAL_PATH is set', () => {
    assert.equal(storage.getBackend(), 'local');
  });

  test('isConfigured returns true when local storage is configured', () => {
    assert.equal(storage.isConfigured(), true);
  });

  test('uploadObject returns local:// URL', async () => {
    const url = await storage.uploadObject({
      key: 'snapshots/org-1/cam-1/test.jpg',
      body: Buffer.from('test'),
      contentType: 'image/jpeg',
    });
    assert.ok(url.startsWith('local://'));
  });

  test('keyFromPublicUrl works with local:// URLs', () => {
    const key = storage.keyFromPublicUrl('local://snapshots/org-1/cam-1/test.jpg');
    assert.equal(key, 'snapshots/org-1/cam-1/test.jpg');
  });

  test('readObject reads file', async () => {
    const key = 'snapshots/org-1/cam-1/read.jpg';
    await storage.uploadObject({ key, body: Buffer.from('readable'), contentType: 'image/jpeg' });

    const content = storage.readObject(key);
    assert.equal(content.toString(), 'readable');
  });

  test('deleteObject deletes file', async () => {
    const key = 'snapshots/org-1/cam-1/delete.jpg';
    await storage.uploadObject({ key, body: Buffer.from('delete'), contentType: 'image/jpeg' });

    const result = storage.deleteObject(key);
    assert.equal(result, true);
    assert.equal(storage.exists(key), false);
  });

  test('exists returns correct state', async () => {
    const key = 'snapshots/org-1/cam-1/exists.jpg';
    assert.equal(storage.exists(key), false);

    await storage.uploadObject({ key, body: Buffer.from('x'), contentType: 'image/jpeg' });
    assert.equal(storage.exists(key), true);
  });
});

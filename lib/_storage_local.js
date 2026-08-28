'use strict';

/**
 * Local filesystem storage backend for snapshots and recordings.
 *
 * Writes files to a local directory (e.g., external HDD) instead of S3.
 * Path structure mirrors S3 key pattern for compatibility:
 *   ${STORAGE_LOCAL_PATH}/snapshots/${organizationId}/${cameraId}/${uuid}.jpg
 *   ${STORAGE_LOCAL_PATH}/recordings/${organizationId}/${cameraId}/${recordingId}.mp4
 *
 * Security:
 *   - All paths are resolved and verified to stay within STORAGE_LOCAL_PATH
 *   - Path traversal attempts (../) are rejected
 *   - organization_id is always included in the path for tenant isolation
 *
 * Required env var: STORAGE_LOCAL_PATH
 */

const fs = require('fs');
const path = require('path');

/**
 * Get the configured local storage root path.
 * @returns {string|null} The absolute path or null if not configured.
 */
function getStorageRoot() {
  const raw = process.env.STORAGE_LOCAL_PATH;
  if (!raw) return null;
  return path.resolve(raw);
}

/**
 * Check if local storage backend is configured.
 * @returns {boolean}
 */
function isLocalConfigured() {
  const root = getStorageRoot();
  if (!root) return false;
  try {
    const stat = fs.statSync(root);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve a storage key to an absolute filesystem path.
 * Validates that the resolved path stays within the storage root
 * to prevent path traversal attacks.
 *
 * @param {string} key - Storage key (e.g., "snapshots/org-1/cam-1/uuid.jpg")
 * @returns {string} Absolute filesystem path
 * @throws {Error} If path traversal is detected or root is not configured
 */
function resolveKeyPath(key) {
  const root = getStorageRoot();
  if (!root) {
    throw new Error('Local storage is not configured. Set STORAGE_LOCAL_PATH env var.');
  }

  if (!key || typeof key !== 'string') {
    throw new Error('Invalid storage key: key must be a non-empty string');
  }

  // Reject any path components that could escape the root
  // Check BEFORE normalization to catch traversal attempts
  if (key.includes('..')) {
    throw new Error(`Path traversal detected in storage key: ${key}`);
  }

  // Normalize the path (collapse redundant separators, etc.)
  const normalizedKey = path.normalize(key);
  if (normalizedKey.includes('..')) {
    throw new Error(`Path traversal detected in storage key: ${key}`);
  }

  // Ensure key uses forward slashes (S3-style) and strip leading slash
  const safeKey = normalizedKey.replace(/\\/g, '/').replace(/^\/+/, '');

  if (!safeKey) {
    throw new Error('Invalid storage key: key is empty after normalization');
  }

  const fullPath = path.resolve(root, safeKey);

  // Final safety check: resolved path must start with root
  if (!fullPath.startsWith(root + path.sep) && fullPath !== root) {
    throw new Error(`Path traversal detected: ${key} resolves outside storage root`);
  }

  return fullPath;
}

/**
 * Ensure the directory for a given file path exists.
 * @param {string} filePath - Absolute file path
 */
function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Upload a buffer to local filesystem storage.
 *
 * @param {{ key: string, body: Buffer, contentType: string }} params
 * @returns {string} The file:// URL to store in the DB
 */
async function localUploadObject({ key, body, contentType }) {
  if (!isLocalConfigured()) {
    const err = new Error('Local storage is not configured. Set STORAGE_LOCAL_PATH env var.');
    err.statusCode = 503;
    throw err;
  }

  if (!body || !Buffer.isBuffer(body)) {
    throw new Error('Upload body must be a Buffer');
  }

  const filePath = resolveKeyPath(key);
  ensureDir(filePath);
  fs.writeFileSync(filePath, body);

  return `local://${key}`;
}

/**
 * Read a file from local storage.
 *
 * @param {string} key - Storage key
 * @returns {Buffer} File contents
 */
function localReadObject(key) {
  if (!isLocalConfigured()) {
    throw new Error('Local storage is not configured. Set STORAGE_LOCAL_PATH env var.');
  }

  const filePath = resolveKeyPath(key);
  return fs.readFileSync(filePath);
}

/**
 * Delete a file from local storage.
 *
 * @param {string} key - Storage key
 * @returns {boolean} True if file was deleted, false if it didn't exist
 */
function localDeleteObject(key) {
  if (!isLocalConfigured()) {
    return false;
  }

  let filePath;
  try {
    filePath = resolveKeyPath(key);
  } catch {
    return false;
  }

  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Check if a file exists in local storage.
 *
 * @param {string} key - Storage key
 * @returns {boolean}
 */
function localExists(key) {
  if (!isLocalConfigured()) return false;

  try {
    const filePath = resolveKeyPath(key);
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/**
 * Extract storage key from a local:// URL.
 *
 * @param {string} storageUrl - URL like "local://snapshots/org-1/cam-1/uuid.jpg"
 * @returns {string|null} The storage key or null if not a local URL
 */
function keyFromLocalUrl(storageUrl) {
  if (!storageUrl || !storageUrl.startsWith('local://')) {
    return null;
  }
  return storageUrl.slice('local://'.length);
}

/**
 * Get the content type based on file extension.
 *
 * @param {string} key - Storage key
 * @returns {string} MIME type
 */
function getContentTypeFromKey(key) {
  const ext = path.extname(key).toLowerCase();
  const types = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.json': 'application/json',
    '.txt': 'text/plain',
  };
  return types[ext] || 'application/octet-stream';
}

module.exports = {
  isLocalConfigured,
  getStorageRoot,
  resolveKeyPath,
  localUploadObject,
  localReadObject,
  localDeleteObject,
  localExists,
  keyFromLocalUrl,
  getContentTypeFromKey,
};

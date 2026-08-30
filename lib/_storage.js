const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const local = require('./_storage_local');

/**
 * Unified storage interface for snapshots and recordings.
 *
 * Supports two backends:
 *   - S3-compatible (AWS S3, Cloudflare R2, Backblaze B2, MinIO)
 *   - Local filesystem (external HDD via STORAGE_LOCAL_PATH)
 *
 * Backend selection is automatic:
 *   - If STORAGE_LOCAL_PATH is set and points to a valid directory → local
 *   - Otherwise → S3-compatible (requires STORAGE_BUCKET, etc.)
 *
 * This module preserves the original S3 interface for backward compatibility
 * while adding local storage support transparently.
 */

/**
 * Determine which storage backend is active.
 * @returns {'local' | 's3'}
 */
function getBackend() {
  if (local.isLocalConfigured()) return 'local';
  return 's3';
}

// ── S3 Configuration ──────────────────────────────────────────────

function isS3Configured() {
  return Boolean(
    process.env.STORAGE_BUCKET &&
    process.env.STORAGE_ACCESS_KEY_ID &&
    process.env.STORAGE_SECRET_ACCESS_KEY,
  );
}

function getS3Client() {
  const rawRegion = process.env.STORAGE_REGION;
  const region = rawRegion && rawRegion.trim() ? rawRegion.trim() : 'us-east-1';
  return new S3Client({
    endpoint: process.env.STORAGE_ENDPOINT || undefined,
    region,
    forcePathStyle: Boolean(process.env.STORAGE_ENDPOINT),
    credentials: {
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
    },
  });
}

// ── Unified Interface ─────────────────────────────────────────────

/**
 * Check if any storage backend is configured.
 * @returns {boolean}
 */
function isConfigured() {
  return getBackend() === 'local' ? true : isS3Configured();
}

/**
 * Upload a buffer to storage.
 *
 * @param {{ key: string, body: Buffer, contentType: string }} params
 * @returns {Promise<string>} URL to store in the DB:
 *   - S3: "https://cdn.example/snapshots/org/cam/uuid.jpg"
 *   - Local: "local://snapshots/org/cam/uuid.jpg"
 */
async function uploadObject({ key, body, contentType }) {
  if (getBackend() === 'local') {
    return local.localUploadObject({ key, body, contentType });
  }

  // S3 path
  if (!isS3Configured()) {
    const err = new Error('Object storage is not configured. Set STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY, or STORAGE_LOCAL_PATH.');
    err.statusCode = 503;
    throw err;
  }

  const client = getS3Client();
  try {
    await client.send(new PutObjectCommand({
      Bucket: process.env.STORAGE_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }));
  } catch (err) {
    const enhanced = new Error(`Storage upload failed: ${err.message}`);
    enhanced.code = err.code || err.name;
    enhanced.originalError = err.message;
    throw enhanced;
  }

  const base = process.env.STORAGE_PUBLIC_BASE_URL || `${process.env.STORAGE_ENDPOINT}/${process.env.STORAGE_BUCKET}`;
  return `${base.replace(/\/$/, '')}/${key}`;
}

/**
 * Read a file from storage. Only available for local backend.
 *
 * @param {string} key - Storage key (not URL)
 * @returns {Buffer} File contents
 */
function readObject(key) {
  if (getBackend() === 'local') {
    return local.localReadObject(key);
  }
  throw new Error('readObject is only supported for local storage backend');
}

/**
 * Delete a file from storage.
 *
 * @param {string} key - Storage key (not URL)
 * @returns {boolean} True if deleted
 */
function deleteObject(key) {
  if (getBackend() === 'local') {
    return local.localDeleteObject(key);
  }
  throw new Error('deleteObject requires local storage backend. Use retention-job.js for S3.');
}

/**
 * Check if a file exists in storage.
 *
 * @param {string} key - Storage key
 * @returns {boolean}
 */
function exists(key) {
  if (getBackend() === 'local') {
    return local.localExists(key);
  }
  throw new Error('exists is only supported for local storage backend');
}

/**
 * Extract storage key from a URL previously built by uploadObject().
 * Handles both S3 URLs and local:// URLs.
 *
 * @param {string} storageUrl - URL from DB
 * @returns {string|null} Storage key or null if not recognized
 */
function keyFromPublicUrl(storageUrl) {
  if (!storageUrl) return null;

  // Local storage URL
  if (storageUrl.startsWith('local://')) {
    return local.keyFromLocalUrl(storageUrl);
  }

  // S3 URL
  const base = (process.env.STORAGE_PUBLIC_BASE_URL || `${process.env.STORAGE_ENDPOINT}/${process.env.STORAGE_BUCKET}`).replace(/\/$/, '');
  if (storageUrl.startsWith(base)) {
    return storageUrl.slice(base.length + 1);
  }
  return null;
}

/**
 * Generate a download URL for a storage object.
 *
 * For S3: returns a presigned URL (time-limited).
 * For local: returns a special token-based URL that the local node can serve.
 *
 * @param {string} key - Storage key
 * @param {{ expiresInSeconds?: number }} [opts]
 * @returns {Promise<string>} Download URL
 */
async function getPresignedDownloadUrl(key, { expiresInSeconds = 3600 } = {}) {
  if (getBackend() === 'local') {
    // For local storage, return a local:// URL with encoded key
    // The actual file serving is handled by the local node's HTTP server
    return `local://${key}`;
  }

  if (!isS3Configured()) {
    const err = new Error('Object storage is not configured.');
    err.statusCode = 503;
    throw err;
  }

  const client = getS3Client();
  const command = new GetObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: key });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

/**
 * Get the content type for a storage key based on file extension.
 *
 * @param {string} key - Storage key
 * @returns {string} MIME type
 */
function getContentType(key) {
  return local.getContentTypeFromKey(key);
}

module.exports = {
  isConfigured,
  getBackend,
  uploadObject,
  readObject,
  deleteObject,
  exists,
  keyFromPublicUrl,
  getPresignedDownloadUrl,
  getContentType,
};

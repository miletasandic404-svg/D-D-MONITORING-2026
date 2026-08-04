/**
 * AES-256-GCM encryption for credentials at rest.
 *
 * Requires CREDENTIAL_ENCRYPTION_KEY (32-byte base64-encoded key).
 * If not set, falls back to a key derived from DATABASE_URL and logs
 * a prominent warning. This fallback exists for development only —
 * in production, CREDENTIAL_ENCRYPTION_KEY MUST be set identically
 * on the cloud API and every media node, otherwise credentials
 * encrypted by the cloud cannot be decrypted by the worker (or
 * vice versa).
 */

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function getEncryptionKey() {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (raw) {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 32) return buf;
    console.warn('[crypto] CREDENTIAL_ENCRYPTION_KEY is not 32 bytes after base64 decode — falling back to derived key');
  }
  if (process.env.NODE_ENV === 'production' && !raw) {
    throw new Error('[crypto] CREDENTIAL_ENCRYPTION_KEY is not set and NODE_ENV=production. Refusing to start with insecure fallback key.');
  }
  // Fallback for development only — log a prominent warning
  if (!raw) {
    console.warn('');
    console.warn('============================================================');
    console.warn('[crypto] WARNING: CREDENTIAL_ENCRYPTION_KEY is not set.');
    console.warn('[crypto] Falling back to a key derived from DATABASE_URL.');
    console.warn('[crypto] This is INSECURE for production and will BREAK if');
    console.warn('[crypto] the cloud API and media nodes have different');
    console.warn('[crypto] DATABASE_URL values. Set CREDENTIAL_ENCRYPTION_KEY');
    console.warn('[crypto] to a 32-byte base64-encoded value on ALL services.');
    console.warn('============================================================');
    console.warn('');
  }
  return crypto.createHash('sha256').update(process.env.DATABASE_URL || 'fallback-key-do-not-use-in-prod').digest();
}

let _key = null;
function key() {
  if (!_key) _key = getEncryptionKey();
  return _key;
}

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(blob) {
  if (!blob) return null;
  try {
    const data = Buffer.from(blob, 'base64');
    const iv = data.subarray(0, IV_LEN);
    const tag = data.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const encrypted = data.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    console.error('[crypto] Decryption failed — key mismatch or corrupted data');
    return null;
  }
}

function stripCredentialsFromUrl(url) {
  if (!url || typeof url !== 'string') return url;
  try {
    const m = url.match(/^(rtsps?:\/\/)([^:@/]+)(:[^@/]+)?@(.+)$/i);
    if (m) {
      return `${m[1]}${m[4]}`;
    }
    return url;
  } catch {
    return url;
  }
}

function extractCredentialsFromUrl(url) {
  if (!url || typeof url !== 'string') return { url, username: null, password: null };
  try {
    const m = url.match(/^(rtsps?:\/\/)([^:@/]+)(:[^@/]+)?@(.+)$/i);
    if (m) {
      return {
        url: `${m[1]}${m[4]}`,
        username: decodeURIComponent(m[2]),
        password: m[3] ? decodeURIComponent(m[3].slice(1)) : null,
      };
    }
    return { url, username: null, password: null };
  } catch {
    return { url, username: null, password: null };
  }
}

module.exports = { encrypt, decrypt, stripCredentialsFromUrl, extractCredentialsFromUrl };

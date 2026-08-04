const http = require('http');
const https = require('https');

// =========================================================
// MediaMTX REST API klijent.
//
// MEDIAMTX_API_URL treba da bude INTERNI adresa MediaMTX REST API-ja
// (npr. http://localhost:9997 ako worker/backend deli isti kontejner
// sa MediaMTX-om, ili http://dnd-media-server.internal:9997 preko
// Fly.io 6PN privatne mreze ako su odvojene mašine).
//
// NAMERNO se ne koristi javni HTTPS domen (dnd-media-server.fly.dev)
// za ovo -- REST API ne treba da bude javno izlozen (bezbednost),
// pa ni ovaj klijent ne treba da mu pristupa spolja.
// =========================================================

const API_BASE = (process.env.MEDIAMTX_API_URL || 'http://localhost:9997').replace(/\/$/, '');
const API_USER = process.env.MEDIAMTX_API_USER || '';
const API_PASS = process.env.MEDIAMTX_API_PASS || '';

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const payload = body ? JSON.stringify(body) : null;

    const headers = { 'Content-Type': 'application/json' };
    if (API_USER) {
      headers['Authorization'] = 'Basic ' + Buffer.from(`${API_USER}:${API_PASS}`).toString('base64');
    }
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
        timeout: 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          if (ok) {
            resolve({ status: res.statusCode, body: parsed });
          } else {
            reject(Object.assign(new Error(`MediaMTX API ${method} ${path} -> HTTP ${res.statusCode}`), {
              status: res.statusCode,
              body: parsed,
            }));
          }
        });
      }
    );

    req.on('error', (err) => reject(new Error(`MediaMTX API request failed: ${err.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('MediaMTX API request timed out'));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Dodaje ili azurira MediaMTX path za jednu kameru.
 * Idempotentno: MediaMTX-ov /add endpoint radi upsert (kreira ako ne
 * postoji, azurira ako postoji) -- bezbedno za ponovno pozivanje.
 */
async function addOrUpdateCameraPath(cameraId, rtspUrl) {
  if (!cameraId || !rtspUrl) {
    throw new Error('addOrUpdateCameraPath: cameraId i rtspUrl su obavezni');
  }
  return request('POST', `/v3/config/paths/add/${encodeURIComponent(cameraId)}`, {
    source: rtspUrl,
    sourceOnDemand: true,
  });
}

/**
 * Uklanja MediaMTX path za kameru (npr. kad se kamera obrise).
 * Ne baca gresku ako path vec ne postoji (404 se tretira kao uspeh).
 */
async function deleteCameraPath(cameraId) {
  if (!cameraId) throw new Error('deleteCameraPath: cameraId je obavezan');
  try {
    return await request('DELETE', `/v3/config/paths/delete/${encodeURIComponent(cameraId)}`);
  } catch (err) {
    if (err.status === 404) return { status: 404, body: null };
    throw err;
  }
}

/**
 * Vraca listu svih trenutno konfigurisanih path-ova na MediaMTX-u.
 * Koristi camera-sync-worker za startup/recovery sinhronizaciju.
 */
async function listConfiguredPaths() {
  const res = await request('GET', '/v3/config/paths/list');
  return (res.body && res.body.items) || [];
}

/**
 * Vraca runtime stanje jedne putanje (da li ima aktivan izvor, koliko
 * je citalaca trenutno gleda, poslednja greska). Koristi se za health
 * check per-kamera.
 */
async function getPathStatus(cameraId) {
  try {
    const res = await request('GET', `/v3/paths/get/${encodeURIComponent(cameraId)}`);
    return res.body;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Proverava da li je HLS manifest dostupan za kameru.
 * Vraća objekt sa statusom i HTTP kodom (ako postoji).
 */
async function verifyHlsPlayback(hlsUrl) {
  if (!hlsUrl) return { ok: false, status: null };

  try {
    const response = await fetch(hlsUrl, { method: 'GET', signal: AbortSignal.timeout(8000) });
    return {
      ok: response.ok,
      status: response.status,
    };
  } catch {
    return { ok: false, status: null };
  }
}

module.exports = {
  request,
  addOrUpdateCameraPath,
  deleteCameraPath,
  listConfiguredPaths,
  getPathStatus,
  verifyHlsPlayback,
};

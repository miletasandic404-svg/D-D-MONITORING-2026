// Load .env if one exists, without assuming any fixed install path (e.g.
// C:\dnd-media). Walks up from THIS FILE'S OWN directory rather than
// process.cwd(), so it works regardless of how/where the worker is launched
// from. Silent no-op if dotenv isn't installed or no .env is found -- real
// environment variables (e.g. set directly in start-laptop.bat) still work.
(function loadNearestDotEnv() {
  let dotenv;
  try {
    dotenv = require('dotenv');
  } catch {
    return;
  }
  const fs = require('fs');
  const path = require('path');
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
})();

const { Pool } = require('pg');
const { addOrUpdateCameraPath, deleteCameraPath, listConfiguredPaths } = require('../lib/_mediamtx_client');
const { decrypt, extractCredentialsFromUrl } = require('../lib/_crypto');

// =========================================================
// Camera Sync Worker
//
// Resava tacaka D i E iz plana popravke:
//   D) Restart media servera -> automatski vratiti sve kamere iz baze
//   E) Recovery -- ako MediaMTX padne, posle podizanja ponovo ucitati
//      sve kamere iz baze
//
// Radi na SVAKOM pokretanju (uklj. posle crash-a/redeploy-a): odmah
// izvrsi puni resync (sve kamere iz baze -> MediaMTX paths), a zatim
// ponavlja isti resync na interval, kao bezbednosnu mrezu za slucaj
// da je pojedinacan poziv iz api/cameras.js promasio (npr. MediaMTX
// bio nedostupan u tom trenutku).
//
// Namerno NE koristi LISTEN/NOTIFY -- periodicni pooling potpunog
// stanja je jednostavniji, samoispravljajuci (self-healing) i ne
// zavisi od toga da veza za LISTEN ostane ziva. Cena je do
// SYNC_INTERVAL_SECONDS kasnjenje pre nego sto se nova kamera
// dodata DIREKTNO u bazu (zaobilazeci API) pojavi u MediaMTX-u --
// prihvatljivo za ovaj obim (desetine, ne hiljade kamera).
// =========================================================

const SYNC_INTERVAL_SECONDS = parseInt(process.env.CAMERA_SYNC_INTERVAL_SECONDS || '60', 10);
const MEDIA_NODE_ID = process.env.MEDIA_NODE_ID || null;

const WORKER_DB_URL = process.env.MEDIA_NODE_DATABASE_URL || process.env.DATABASE_URL;

if (!WORKER_DB_URL) {
  console.error('[camera-sync] DATABASE_URL (or MEDIA_NODE_DATABASE_URL) is not set -- worker cannot start');
  process.exit(1);
}

if (!process.env.MEDIA_NODE_DATABASE_URL) {
  console.warn('[camera-sync] WARNING: MEDIA_NODE_DATABASE_URL not set — using owner role (DATABASE_URL). For production, create a restricted media_node_worker role and set MEDIA_NODE_DATABASE_URL.');
}

const pool = new Pool({ connectionString: WORKER_DB_URL, max: 2 });

async function fetchCamerasFromDb() {
  // Ako je MEDIA_NODE_ID podesen, sinhronizuj kamere dodeljene OVOM
  // node-u (multi-node deployment) ILI kamere kojima media_node_id jos
  // nije dodeljen (media_node_id IS NULL) -- ovo pokriva slucaj kad je
  // kamera kreirana pre nego sto je node bio "online" i pickMediaNodeForCamera()
  // nije mogao da dodeli node (vratio null). Bez ovog uslova, takve kamere
  // bi trajno ostale neregistrovane u MediaMTX-u.
  // Ako MEDIA_NODE_ID nije podesen, sinhronizuj sve kamere sa rtsp_url
  // (single-node deployment, V2 pocetno stanje).
  const query = MEDIA_NODE_ID
    ? 'SELECT id, rtsp_url, media_node_id, rtsp_username, rtsp_password_encrypted FROM cameras WHERE (media_node_id = $1 OR media_node_id IS NULL) AND rtsp_url IS NOT NULL AND enabled = true'
    : 'SELECT id, rtsp_url, media_node_id, rtsp_username, rtsp_password_encrypted FROM cameras WHERE rtsp_url IS NOT NULL AND enabled = true';
  const params = MEDIA_NODE_ID ? [MEDIA_NODE_ID] : [];
  const result = await pool.query(query, params);
  return result.rows.map((c) => {
    // Reconstruct full RTSP URL with credentials for MediaMTX (it needs auth to pull from camera)
    let fullUrl = c.rtsp_url;
    if (c.rtsp_username || c.rtsp_password_encrypted) {
      const password = c.rtsp_password_encrypted ? decrypt(c.rtsp_password_encrypted) : '';
      try {
        const u = new URL(fullUrl);
        if (c.rtsp_username) u.username = c.rtsp_username;
        if (password) u.password = password;
        fullUrl = u.toString();
      } catch { /* if URL parse fails, use as-is */ }
    }
    return { ...c, rtsp_url: fullUrl };
  });
}

async function runFullSync() {
  const startedAt = Date.now();
  let cameras;
  try {
    cameras = await fetchCamerasFromDb();
  } catch (err) {
    console.error('[camera-sync] Failed to read cameras from database:', err.message);
    return;
  }

  // Log how many cameras were found and flag any with unassigned media_node_id.
  const unassigned = cameras.filter((c) => c.media_node_id === null);
  console.log(
    `[camera-sync] Found ${cameras.length} camera(s) to sync` +
    (MEDIA_NODE_ID ? ` (node ${MEDIA_NODE_ID}, including ${unassigned.length} with NULL media_node_id)` : ' (all cameras, no MEDIA_NODE_ID filter)')
  );
  if (unassigned.length > 0) {
    console.warn(
      `[camera-sync] Registering ${unassigned.length} camera(s) with NULL media_node_id (will be healed on next API update): ${unassigned.map((c) => c.id).join(', ')}`
    );
  }

  // VAZNO: POST /v3/config/paths/add/{name} radi PUN RELOAD putanje
  // cak i kad se salju identicni podaci -- ovo prekida svaku aktivnu
  // konekciju (poznato, jos nereseno ponasanje MediaMTX-a, vidi
  // https://github.com/bluenviron/mediamtx/issues/5525). Zato PRVO
  // ucitavamo trenutnu MediaMTX konfiguraciju i POREDIMO -- saljemo
  // add/update SAMO za kamere koje su nove ili su im se promenili
  // podaci, ne za svaku kameru na svakom ciklusu.
  //
  // Retry (1 pokusaj) za ovaj poziv: ako GET padne bez retry-ja, worker
  // bi tretirao SVE kamere kao "promenjene" (currentByName prazan) i
  // poslao nepotreban add/reload za svaku -- upravo ono sto gornja
  // diff-logika treba da spreci. Ako i drugi pokusaj padne, preskacemo
  // CEO ciklus (umesto da nastavimo sa praznim currentPaths) -- sledeci
  // ciklus (za CAMERA_SYNC_INTERVAL_SECONDS) ce pokusati ponovo.
  let currentPaths;
  try {
    currentPaths = await listConfiguredPaths();
  } catch (firstErr) {
    console.warn('[camera-sync] listConfiguredPaths failed, retrying once:', firstErr.message);
    try {
      currentPaths = await listConfiguredPaths();
    } catch (secondErr) {
      console.error('[camera-sync] listConfiguredPaths failed twice -- skipping this entire cycle to avoid unnecessary reloads:', secondErr.message);
      return;
    }
  }
  const currentByName = new Map(currentPaths.map((p) => [p.name, p]));

  let added = 0;
  let unchanged = 0;
  let failed = 0;
  for (const cam of cameras) {
    console.log(`[camera-sync] syncing camera ${cam.id}`);
    const existing = currentByName.get(cam.id);
    const alreadyCorrect = existing && existing.source === cam.rtsp_url;
    if (alreadyCorrect) {
      unchanged += 1;
      continue;
    }
    try {
      console.log(`[camera-sync] adding path ${cam.id} -> ${cam.rtsp_url}`);
      const res = await addOrUpdateCameraPath(cam.id, cam.rtsp_url);
      added += 1;
      console.log(`[camera-sync] MediaMTX response for ${cam.id}: HTTP ${res.status} ${JSON.stringify(res.body || {})}`);
    } catch (err) {
      failed += 1;
      console.error(`[camera-sync] Failed to sync path for camera ${cam.id}:`, err.message);
    }
  }

  // Ukloni "osirotele" MediaMTX putanje -- postoje na MediaMTX-u ali
  // vise ne postoje (ili su iskljucene/bez rtsp_url) u bazi.
  let removed = 0;
  try {
    // Ako je prvi listConfiguredPaths() (iznad) pao, currentPaths je []
    // pa ovde radimo KORISTAN retry. Ako je prvi poziv uspeo ali
    // legitimno vratio 0 putanja (prazan sistem), ovo je bezopasan
    // dodatni GET -- orphan-detekcija ispod zavisi iskljucivo od
    // clanstva u dbCameraIds, ne od toga koji tacno snapshot
    // koristimo, pa ovo nikad ne moze pogresno obrisati validnu
    // putanju.
    const configuredPaths = currentPaths.length ? currentPaths : await listConfiguredPaths();
    const dbCameraIds = new Set(cameras.map((c) => c.id));
    for (const p of configuredPaths) {
      const pathName = p && p.name;
      if (pathName && !dbCameraIds.has(pathName)) {
        try {
          await deleteCameraPath(pathName);
          removed += 1;
        } catch (err) {
          console.error(`[camera-sync] Failed to remove orphaned path ${pathName}:`, err.message);
        }
      }
    }
  } catch (err) {
    // MediaMTX API moze biti privremeno nedostupan -- ne fatalno,
    // pokusacemo ponovo na sledecem ciklusu.
    console.error('[camera-sync] Failed to list configured MediaMTX paths (skipping orphan cleanup):', err.message);
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    `[camera-sync] Full sync complete in ${durationMs}ms: ${added} added/updated, ${unchanged} already correct (skipped), ${failed} failed, ${removed} orphaned paths removed (${cameras.length} cameras in DB)`
  );
}

async function main() {
  console.log(`[camera-sync] Starting. Interval: ${SYNC_INTERVAL_SECONDS}s. MEDIA_NODE_ID: ${MEDIA_NODE_ID || '(none -- syncing all cameras)'}`);

  // Puni resync ODMAH pri startu -- ovo je "recovery" korak (D/E).
  await runFullSync();

  // Periodicno ponavljanje kao samoispravljajuca bezbednosna mreza.
  // ZASTITA OD PREKLAPANJA: ako prethodni runFullSync() jos traje kad
  // dodje vreme za sledeci, PRESKACEMO taj ciklus umesto da pokrenemo
  // paralelan. Bez ovoga, na vecem broju kamera (gde jedan ciklus moze
  // trajati duze od SYNC_INTERVAL_SECONDS, jer su MediaMTX pozivi
  // sekvencijalni) dva paralelna ciklusa bi mogla doneti sukobljene
  // odluke o istoj putanji (jedan dodaje/azurira dok drugi istovremeno
  // brise kao "osirotelu"), izazivajuci nepotreban prekid stream-a.
  let syncInProgress = false;
  setInterval(() => {
    if (syncInProgress) {
      console.warn('[camera-sync] Previous sync cycle still running -- skipping this tick. Consider increasing CAMERA_SYNC_INTERVAL_SECONDS if this happens often.');
      return;
    }
    syncInProgress = true;
    runFullSync()
      .catch((err) => console.error('[camera-sync] Unexpected error during sync cycle:', err))
      .finally(() => { syncInProgress = false; });
  }, SYNC_INTERVAL_SECONDS * 1000);
}

main().catch((err) => {
  console.error('[camera-sync] Fatal error, exiting:', err);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  console.log('[camera-sync] SIGTERM received, shutting down');
  await pool.end();
  process.exit(0);
});

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
const { decrypt } = require('../lib/_crypto');
const L = require('../lib/_logger');
const Sentry = require('@sentry/node');
const { initSentry } = require('../lib/_sentry');

const logger = L.makeLogger('camera-sync');

initSentry();

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
  logger.error('worker.database_url_missing');
  process.exit(1);
}

if (!process.env.MEDIA_NODE_DATABASE_URL) {
  logger.warn('worker.owner_role_fallback');
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
  // Security (model B): when a node id is set, restrict the sync to
  // cameras of the node's OWN organization. This prevents a node on
  // org B's LAN from pulling streams of org A's cameras (whose rtsp_url
  // is user-controlled) into its own MediaMTX. If the node has no org
  // assigned yet, only its own assigned cameras are synced -- never a
  // foreign org's unassigned cameras.
  const query = MEDIA_NODE_ID
    ? `SELECT c.id, c.rtsp_url, c.media_node_id, c.rtsp_username, c.rtsp_password_encrypted
       FROM cameras c
       JOIN media_nodes n ON n.id = $1
       WHERE (c.media_node_id = $1 OR c.media_node_id IS NULL)
         AND c.rtsp_url IS NOT NULL
         AND c.enabled = true
         AND (n.organization_id IS NULL
              OR c.organization_id = n.organization_id)`
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
    logger.error('sync.cameras_read_failed', { error: err.message });
    return;
  }

  // Log how many cameras were found and flag any with unassigned media_node_id.
  const unassigned = cameras.filter((c) => c.media_node_id === null);
  logger.info('sync.found_cameras', {
    count: cameras.length,
    node_id: MEDIA_NODE_ID || null,
    unassigned: unassigned.length,
  });
  if (unassigned.length > 0) {
    logger.warn('sync.unassigned_cameras', {
      count: unassigned.length,
      camera_ids: unassigned.map((c) => c.id),
    });
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
    logger.warn('sync.mediamtx_list_retry', { error: firstErr.message });
    try {
      currentPaths = await listConfiguredPaths();
    } catch (secondErr) {
      logger.error('sync.mediamtx_list_failed', { error: secondErr.message });
      return;
    }
  }
  const currentByName = new Map(currentPaths.map((p) => [p.name, p]));

  let added = 0;
  let unchanged = 0;
  let failed = 0;
  for (const cam of cameras) {
    logger.info('sync.syncing_camera', { camera_id: cam.id });
    const existing = currentByName.get(cam.id);
    const alreadyCorrect = existing && existing.source === cam.rtsp_url;
    if (alreadyCorrect) {
      unchanged += 1;
      continue;
    }
    try {
      logger.info('sync.adding_path', { camera_id: cam.id });
      const res = await addOrUpdateCameraPath(cam.id, cam.rtsp_url);
      added += 1;
      logger.info('sync.mediamtx_response', { camera_id: cam.id, http_status: res.status });
    } catch (err) {
      failed += 1;
      logger.error('sync.path_failed', { camera_id: cam.id, error: err.message });
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
          logger.error('sync.orphan_remove_failed', { path: pathName, error: err.message });
        }
      }
    }
  } catch (err) {
    // MediaMTX API moze biti privremeno nedostupan -- ne fatalno,
    // pokusacemo ponovo na sledecem ciklusu.
    logger.error('sync.orphan_cleanup_skipped', { error: err.message });
  }

  const durationMs = Date.now() - startedAt;
  logger.info('sync.complete', {
    duration_ms: durationMs,
    added,
    unchanged,
    failed,
    removed,
    cameras_in_db: cameras.length,
  });
}

async function main() {
  logger.info('worker.start', { interval_seconds: SYNC_INTERVAL_SECONDS, media_node_id: MEDIA_NODE_ID || null });

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
      logger.warn('sync.cycle_skipped');
      return;
    }
    syncInProgress = true;
    runFullSync()
      .catch((err) => {
        logger.error('sync.cycle_unexpected', { error: err.message });
        Sentry.captureException(err);
      })
      .finally(() => { syncInProgress = false; });
  }, SYNC_INTERVAL_SECONDS * 1000);
}

main().catch((err) => {
  logger.error('worker.fatal', { error: err.message });
  Sentry.captureException(err);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  logger.info('worker.sigterm');
  await pool.end();
  process.exit(0);
});

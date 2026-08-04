# Media Server V2 — Deployment

## Arhitektura

```
PostgreSQL (Neon) cameras tabela
        |
        | (1) direktan poziv posle INSERT/UPDATE/DELETE
        v                                    (2) periodicni pun resync (60s)
api/cameras.js  ---HTTP--->  MediaMTX REST API (:9997, interno)
                                    |
                                    v
                          MediaMTX dynamic paths
                                    |
                    +---------------+---------------+
                    v               v               v
                RTSP :8554     HLS :8888      WebRTC :8889
                (publish)      (dashboard              (nekoriscen
                                gleda ovde)              trenutno)
```

Dva nezavisna mehanizma drze bazu i MediaMTX usklađenim:

1. **Real-time (api/cameras.js)** — čim se kamera doda/izmeni/obriše preko aplikacije, `lib/_mediamtx_client.js` odmah pozove MediaMTX REST API. Ako MediaMTX nije dostupan u tom trenutku, poziv se loguje kao neuspešan ali **ne blokira** operaciju nad bazom (baza je izvor istine).
2. **Periodični resync (camera-sync-worker.js)** — svakih 60s (podesivo), i **odmah pri svakom pokretanju** (uključujući posle pada/redeploy-a media servera), worker učita SVE kamere iz baze i uskladi ih sa MediaMTX-om — dodaje nedostajuće, uklanja "osirotele" putanje koje više nisu u bazi. Ovo je *self-healing* sloj koji hvata sve što mehanizam #1 propusti.

## Zašto REST API nije javno izložen

`fly.toml` namerno **nema** `[[services]]` blok za port `9997`. MediaMTX REST API dozvoljava dodavanje proizvoljnog RTSP izvora kao path — ako bi bio javno dostupan bez dodatne zaštite, bilo ko bi mogao da registruje sopstvene stream-ove na tvom serveru. `camera-sync-worker.js` mu pristupa preko `localhost:9997` jer deli isti kontejner sa MediaMTX-om (pokrenuti zajedno preko `start.sh`).

## Poznati rizici (potvrđeno istraživanjem, ne pretpostavka)

- **`POST /v3/config/paths/add/{name}` uvek radi pun reload putanje**,
  čak i kad se šalju identični podaci — ovo prekida aktivnu konekciju
  (otvoren MediaMTX issue, nerešen kroz v1.18.2:
  https://github.com/bluenviron/mediamtx/issues/5525). Zato
  `camera-sync-worker.js` **poredi** trenutnu MediaMTX konfiguraciju
  pre slanja `add` poziva — šalje ga samo ako je kamera nova ili se
  `rtsp_url` promenio, ne na svakom sinhronizacionom ciklusu.
- **Neki korisnici prijavljuju da `DELETE /v3/config/paths/delete/{name}`
  briše SVE dinamički dodate putanje, ne samo navedenu**, u određenim
  konfiguracijama (https://github.com/bluenviron/mediamtx/discussions/5347,
  nerazjašnjeno u diskusiji da li je bug ili pogrešna upotreba).
  **Ovo mora da se testira eksplicitno** pre prelaska u produkciju —
  vidi "Test recovery scenarija" u `MIGRATION_CHECKLIST.md`, korak koji
  briše JEDNU test kameru i proverava da OSTALE ostanu netaknute.



1. **Fly.io app i secrets** (jednom, prvi put):
   ```bash
   fly apps create dnd-media-server
   fly secrets set DATABASE_URL="postgresql://...neon.tech/neondb?sslmode=require" -a dnd-media-server
   fly secrets set MEDIA_NODE_ID="<uuid iz media_nodes tabele>" -a dnd-media-server
   ```
   `MEDIA_NODE_ID` je opciono — ako se izostavi, worker sinhronizuje **sve** kamere sa `rtsp_url`-om, bez obzira na `media_node_id` (dobro za deployment sa jednim media node-om).

2. **Deploy** (iz root-a repozitorijuma, gde je `fly.toml`):
   ```bash
   fly deploy
   ```

3. **Verifikacija posle deploy-a**:
   ```bash
   fly status -a dnd-media-server
   fly logs -a dnd-media-server
   ```
   Traži u logovima: `[start.sh] MediaMTX API je spreman` i `[camera-sync] Full sync complete in ...ms: N synced, 0 failed, M orphaned paths removed`.

4. **Provera da kamera stvarno radi**:
   ```bash
   curl -I https://dnd-media-server.fly.dev/<camera-id>/index.m3u8
   ```
   Očekivano: `200 OK` sa `Content-Type: application/vnd.apple.mpegurl` (ako je auth token ispravan/isključen za taj put) ili `401` (ako je token nevažeći/nedostaje — očekivano ponašanje, ne bug).

## Env varijable koje `camera-sync-worker.js` koristi

| Varijabla | Podrazumevano | Opis |
|---|---|---|
| `DATABASE_URL` | *(obavezno)* | Neon connection string |
| `MEDIA_NODE_ID` | *(nijedan — sinhronizuje sve kamere)* | Ograniči sinhronizaciju na kamere dodeljene ovom media node-u |
| `CAMERA_SYNC_INTERVAL_SECONDS` | `60` | Koliko često se ponavlja puni resync |
| `MEDIAMTX_API_URL` | `http://localhost:9997` | Interna adresa MediaMTX REST API-ja |
| `MEDIAMTX_API_USER` / `MEDIAMTX_API_PASS` | *(prazno)* | Basic auth za REST API, ako je uključen u `mediamtx.yml` |

## Recovery ponašanje (tačke D i E iz plana)

- **D) Restart media servera** — `start.sh` pokreće `camera-sync-worker.js` odmah nakon što MediaMTX API postane spreman; worker odmah radi pun resync, tako da se sve kamere iz baze automatski pojave, bez ručne intervencije.
- **E) MediaMTX padne pa se podigne** — Fly.io detektuje da kontejner nije živ (health check na portu 8888) i restartuje celu mašinu, što ponovo pokreće `start.sh` od početka → isti recovery tok kao D.

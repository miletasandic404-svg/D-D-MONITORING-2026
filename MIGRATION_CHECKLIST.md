# Migration Checklist — Media Server V1 → V2

Ovo je redosled provera pre, tokom i posle prelaska. Svaka stavka ima
tačan komandu za proveru — ne preskačati na osnovu pretpostavke.

## Pre deploy-a

- [ ] Potvrdi da `feat/media-server-v2-real` sadrži sve fajlove:
      `Dockerfile`, `fly.toml`, `start.sh`, `workers/camera-sync-worker.js`,
      `lib/_mediamtx_client.js`, `media-server/mediamtx.yml`,
      `media-server/DEPLOYMENT.md`
      ```bash
      git show --stat feat/media-server-v2-real
      ```
- [ ] Potvrdi da PR **nije** merge-ovan u `master` pre nego što je V2
      testiran (izbegavamo da Vercel deploy-uje frontend/backend izmene
      pre nego što je media server spreman).
- [ ] Proveri da `DATABASE_URL` i (opciono) `MEDIA_NODE_ID` postoje kao
      Fly.io secrets:
      ```bash
      fly secrets list -a dnd-media-server
      ```
- [ ] Proveri stvarnu šemu `cameras` tabele pre nego što worker očekuje
      `rtsp_url`/`enabled`/`media_node_id` kolone:
      ```sql
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'cameras' ORDER BY ordinal_position;
      ```
      Ako neka od `id, rtsp_url, enabled, media_node_id` kolona
      nedostaje, `camera-sync-worker.js` treba prilagoditi PRE deploy-a
      (upit u `fetchCamerasFromDb()`), ne posle.

## Deploy (staging/dry-run preporučeno pre produkcije)

- [ ] `fly deploy` iz root-a repozitorijuma (gde je `fly.toml`)
- [ ] `fly status -a dnd-media-server` — mašina `started`, health check
      `passing`
- [ ] `fly logs -a dnd-media-server` — traži:
      - `[start.sh] MediaMTX API je spreman`
      - `[camera-sync] Full sync complete in ...ms: N synced, 0 failed`
      Ako `failed > 0`, ne nastavljaj dalje — proveri koja kamera i zašto
      pre nego što se oslanjaš na sistem.

## Verifikacija funkcionalnosti

- [ ] Iznutra (SSH), REST API stvarno radi i vidi kamere iz baze:
      ```bash
      fly ssh console -a dnd-media-server
      curl -s http://127.0.0.1:9997/v3/paths/list
      ```
      Broj `itemCount` treba da odgovara broju kamera sa `rtsp_url IS NOT NULL
      AND enabled = true` u bazi.
- [ ] Konkretna kamera ima aktivan izvor:
      ```bash
      curl -s http://127.0.0.1:9997/v3/paths/get/<camera-id>
      ```
- [ ] Sa spoljne mreže, HLS manifest je dostupan (očekuje se 401 bez
      validnog tokena, NE 404):
      ```bash
      curl -I https://dnd-media-server.fly.dev/<camera-id>/index.m3u8
      ```
- [ ] Kroz dashboard (browser), otvori kameru i potvrdi da se video
      stvarno prikazuje (ne samo da HTTP status ispravan).

## Test recovery scenarija (ne preskočiti — ovo je bio glavni V1 nedostatak)

- [ ] Dodaj NOVU test kameru preko UI-ja/API-ja — potvrdi da se pojavi
      na MediaMTX-u u roku od par sekundi (real-time sync):
      ```bash
      curl -s http://127.0.0.1:9997/v3/paths/get/<nova-kamera-id>
      ```
- [ ] Obriši tu test kameru preko UI-ja/API-ja — potvrdi da MediaMTX
      path nestane:
      ```bash
      curl -s http://127.0.0.1:9997/v3/paths/get/<nova-kamera-id>
      # Ocekivano: 404 posle brisanja
      ```
- [ ] **KRITICNO** — pre brisanja test kamere, zabelezi listu SVIH
      trenutno konfigurisanih putanja (`curl .../v3/paths/list`).
      POSLE brisanja test kamere, ponovo proveri listu i potvrdi da
      su SVE OSTALE kamere i dalje tu. Postoji prijavljen (nerazjašnjen)
      MediaMTX bug gde `DELETE` briše sve dinamičke putanje umesto
      samo jedne — vidi `media-server/DEPLOYMENT.md` "Poznati rizici".
      Ako se ovo desi, `camera-sync-worker.js`-ov sledeći periodični
      ciklus će ih vratiti (u roku od `CAMERA_SYNC_INTERVAL_SECONDS`),
      ali privremeni prekid svih stream-ova pri svakom brisanju
      kamere NIJE prihvatljivo ponašanje za produkciju — ako se
      potvrdi, treba prijaviti kao blocker pre merge-a, ne kao
      "poznat, prihvaćen rizik".
- [ ] Restartuj media server ručno i potvrdi da se SVE postojeće
      kamere vrate bez ručne intervencije:
      ```bash
      fly machine restart <machine-id> -a dnd-media-server
      # sacekaj ~30s, zatim:
      fly logs -a dnd-media-server | grep "Full sync complete"
      ```

## Nakon potvrde da sve radi

- [ ] Merge `feat/media-server-v2-real` → `master`
- [ ] Ukloni ili arhiviraj staru `feat/media-server-v2-final` granu
      (potvrđeno beskorisna — vidi git istoriju te grane)
- [ ] Ažuriraj `.env.example` sa novim varijablama
      (`MEDIA_NODE_ID`, `CAMERA_SYNC_INTERVAL_SECONDS`, `MEDIAMTX_API_URL`)
- [ ] Obavesti tim/korisnike da dodavanje kamere kroz UI sada
      automatski pokreće stream — ručna izmena `mediamtx.yml` više
      NIJE potrebna niti podržana (worker briše sve što nije u bazi)

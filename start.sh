#!/bin/bash
# =========================================================
# Pokrece MediaMTX, camera-sync-worker.js i (opciono)
# media-node-heartbeat.js u istom kontejneru.
#
# Ako BILO KOJI od pokrenuth procesa padne, ceo skript se gasi
# sa non-zero statusom -- Fly.io ce automatski restartovati
# masinu, sto opet pokrece ovaj skript, sto opet radi puni
# camera-sync-worker resync odmah pri startu (tacke D i E iz
# plana popravke: restart media servera automatski vraca sve
# kamere iz baze).
#
# Heartbeat worker se pokrece automatski ako su postavljene sve
# tri env varijable: API_BASE_URL, MEDIA_NODE_ID i
# MEDIA_NODE_HEARTBEAT_SECRET. Ako neka nedostaje, heartbeat se
# preskace (single-node setup, development) -- ostala dva procesa
# rade normalno.
# =========================================================
set -euo pipefail

echo "[start.sh] Pokrecem MediaMTX..."
mediamtx /mediamtx.yml &
MEDIAMTX_PID=$!

echo "[start.sh] Cekam da MediaMTX API (port 9997) bude spreman..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:9997/v3/config/global/get" > /dev/null 2>&1; then
    echo "[start.sh] MediaMTX API je spreman (posle ${i}s)."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[start.sh] GRESKA: MediaMTX API nije odgovorio u 30s, prekidam."
    kill "$MEDIAMTX_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

echo "[start.sh] Pokrecem camera-sync-worker..."
node /app/workers/camera-sync-worker.js &
WORKER_PID=$!

echo "[start.sh] Pokrecem xiongmai-stream-worker..."
node /app/workers/xiongmai-stream-worker.js &
XIONGMAI_PID=$!

echo "[start.sh] Pokrecem recording-worker..."
node /app/workers/recording-worker.js &
RECORDING_PID=$!

echo "[start.sh] Pokrecem person-detection-worker..."
node /app/workers/person-detection-worker.js &
PERSON_DETECTION_PID=$!

# Heartbeat worker -- pokrece se samo ako su sve tri neophodne
# env varijable postavljene (konfigurisu se kao Fly.io secrets:
#   fly secrets set API_BASE_URL="https://www.dnd-monitoring.com/api" -a dnd-media-server
#   fly secrets set MEDIA_NODE_ID="<uuid>" -a dnd-media-server
#   fly secrets set MEDIA_NODE_HEARTBEAT_SECRET="<secret>" -a dnd-media-server
# Bez heartbeat-a, media node ostaje "offline" u registru i ne
# prima nove kamere via pickMediaNodeForCamera (multi-node setup).
# Single-node setup koji koristi VITE_HLS_BASE_URL ne zahteva ovo.
HEARTBEAT_PID=""
if [ -n "${API_BASE_URL:-}" ] && [ -n "${MEDIA_NODE_ID:-}" ] && [ -n "${MEDIA_NODE_HEARTBEAT_SECRET:-}" ]; then
  echo "[start.sh] Pokrecem media-node-heartbeat worker..."
  node /app/workers/media-node-heartbeat.js &
  HEARTBEAT_PID=$!
  echo "[start.sh] media-node-heartbeat pokrenut (pid=$HEARTBEAT_PID)."
else
  echo "[start.sh] API_BASE_URL/MEDIA_NODE_ID/MEDIA_NODE_HEARTBEAT_SECRET nisu postavljeni -- heartbeat worker se preskace."
fi

echo "[start.sh] Pokrecem two-way-audio-api..."
node /app/workers/two-way-audio-api.js &
TWA_PID=$!

echo "[start.sh] Pokrecem camera-setup-agent (Fly media node task executor)..."
node /app/workers/camera-setup-agent.js &
AGENT_PID=$!

echo "[start.sh] Procesi pokrenuti (mediamtx=$MEDIAMTX_PID, worker=$WORKER_PID, xiongmai=$XIONGMAI_PID, recording=$RECORDING_PID, person-detection=$PERSON_DETECTION_PID, audio-api=$TWA_PID, agent=$AGENT_PID${HEARTBEAT_PID:+, heartbeat=$HEARTBEAT_PID}). Cekam..."

# Skupi aktivne PID-ove u niz da wait -n i kill budu konzistentni.
PIDS=("$MEDIAMTX_PID" "$WORKER_PID" "$XIONGMAI_PID" "$RECORDING_PID" "$PERSON_DETECTION_PID" "$TWA_PID" "$AGENT_PID")
if [ -n "$HEARTBEAT_PID" ]; then
  PIDS+=("$HEARTBEAT_PID")
fi

# Ako bilo koji od aktivnih procesa zavrsi (crash ili normalan izlaz),
# odmah prekini ceo skript -- Fly.io health check ce primetiti da je
# masina "down" i restartovace je, sto opet pokrece ovaj start.sh od
# pocetka (puni recovery resync).
wait -n "${PIDS[@]}"
EXIT_CODE=$?
echo "[start.sh] Jedan od procesa je zavrsio (exit code $EXIT_CODE). Gasim ostatak i izlazim."
kill "${PIDS[@]}" 2>/dev/null || true
exit "$EXIT_CODE"

# =========================================================
# D&D Monitoring - Media Server V2
# MediaMTX (RTSP/HLS/WebRTC) + camera-sync-worker (Node.js)
# pakovani u jednu Fly.io masinu, pokrenuti zajedno preko start.sh
# =========================================================

FROM node:20-alpine AS worker-deps
WORKDIR /worker
COPY media-server/package.json ./package.json
RUN npm install --production --omit=dev

FROM bluenviron/mediamtx:latest AS mediamtx-src

FROM node:20-alpine
RUN apk add --no-cache bash curl ca-certificates ffmpeg

# --- MediaMTX binarni fajl (TLS root sertifikati dolaze iz Alpine-ovog
#     sopstvenog ca-certificates paketa iznad -- zvanicni
#     bluenviron/mediamtx image je FROM scratch i nikad nije imao
#     /etc/ssl/certs, cak ni u ranijim verzijama) ---
COPY --from=mediamtx-src /mediamtx /usr/local/bin/mediamtx

# --- Node.js zavisnosti za camera-sync-worker (samo 'pg', ne cela app) ---
WORKDIR /app
COPY --from=worker-deps /worker/node_modules ./node_modules
COPY media-server/package.json ./package.json
COPY workers/ ./workers/
COPY lib/ ./lib/

# --- MediaMTX konfiguracija ---
COPY media-server/mediamtx.yml /mediamtx.yml

# --- Start skripta koja pokrece oba procesa ---
COPY start.sh /start.sh
RUN chmod +x /start.sh \
 && test -x /start.sh \
 && head -1 /start.sh | grep -q '^#!/bin/bash$' \
 && echo "start.sh OK: executable, correct shebang"

EXPOSE 8554 8888 8889 8890 9997

# node:20-alpine's base image sets ENTRYPOINT ["docker-entrypoint.sh"].
# Without resetting it here, CMD below is passed to that inherited
# entrypoint as an ARGUMENT instead of being executed directly -- it
# doesn't know what to do with "/start.sh" and exits with code 127
# ("not found"), causing an immediate crash-restart loop in production.
ENTRYPOINT []
# Explicitly invoke bash rather than relying on start.sh's own shebang
# line to be resolved by the container runtime's exec -- more robust
# against any interpreter-resolution quirk (Fly/Firecracker's init vs a
# normal Docker runtime, line-ending corruption, etc.), since this way
# the kernel never has to parse the script's shebang at all.
CMD ["/bin/bash", "/start.sh"]

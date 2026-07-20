# syntax=docker/dockerfile:1

# Stage deps: install production deps terpisah biar layer-nya ke-cache
# selama package*.json gak berubah. better-sqlite3 & @napi-rs/canvas punya
# prebuilt binary buat linux x64/arm64, jadi gak perlu toolchain compile —
# kalau suatu saat prebuilt-nya gak ada, tambahin `apt-get install -y
# python3 make g++` di stage ini.
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Data runtime (usage, history, session SQLite, access log) — mount volume
# ke sini dan set DATA_DIR biar gak hilang tiap redeploy (lihat
# src/utils/dataDir.js).
ENV DATA_DIR=/data
VOLUME /data

EXPOSE 3000

# Liveness check — endpoint /health didaftarkan paling atas di src/app.js,
# tanpa auth dan tanpa kerja berat.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# PENTING: fitur apply/restart di admin panel keluar via process.exit(0) dan
# mengandalkan supervisor buat ngidupin lagi — jalankan container dengan
# `--restart unless-stopped` (atau restart policy setara di compose/orchestrator).
CMD ["node", "server.js"]

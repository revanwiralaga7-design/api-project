import pino from "pino";
import { config } from "../config/index.js";

/**
 * Logger terstruktur (JSON per baris) buat seluruh app — gantiin
 * console.log/console.error yang formatnya bebas-bebas aja.
 *
 * - production: JSON murni ke stdout (di-scrape Railway/Docker logs,
 *   gampang di-filter: `... | jq 'select(.level >= 50)'`).
 * - development: pino-pretty biar kebaca manusia (warna + satu baris).
 * - test: silent — output test bersih, sama seperti perilaku lama
 *   (errorHandler dulu juga skip console di NODE_ENV=test).
 *
 * Catatan: access.log format combined TETAP ditulis morgan (lihat
 * src/app.js) — panel admin (/admin/logs, tailAccessLog) mem-parse file
 * itu. Logger ini buat log aplikasi (error, lifecycle, request console),
 * bukan pengganti access log.
 */
export const logger = pino(
  config.nodeEnv === "test"
    ? { level: "silent" }
    : config.nodeEnv === "development"
      ? {
          level: "debug",
          transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
        }
      : { level: "info" }
);

export default logger;

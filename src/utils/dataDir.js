// dotenv duluan: modul ini bisa ke-import lebih awal dari config/index.js
// (mis. lewat utils/usage.js) — tanpa ini, DATA_DIR dari .env belum kebaca.
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Akar semua file data runtime (usage.json, access.log, history/, sessions/,
 * cache-config.json). Default: ./data di root project — SESUAI perilaku lama.
 *
 * Kenapa perlu env DATA_DIR: filesystem Railway/Render itu EPHEMERAL —
 * tiap redeploy container baru, isi disk balik ke hasil build. Analytics,
 * log, dan session semua orang lenyap. Solusinya pasang volume (Railway:
 * tab Volumes, mount misal ke /data) terus set DATA_DIR=/data — semua
 * file runtime pindah ke situ tanpa ubah kode.
 */
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "..", "data");

export default DATA_DIR;

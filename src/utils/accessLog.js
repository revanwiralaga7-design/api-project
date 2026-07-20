import fs from "fs";
import path from "path";
import { DATA_DIR } from "./dataDir.js";

export const ACCESS_LOG_PATH = path.join(DATA_DIR, "access.log");

// Batas ukuran file log sebelum dirotasi sekali (access.log -> access.log.1,
// yang lama ketimpa). Simpel, cukup buat project single-instance ini.
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Rotasi manual kalau kegedean — dipanggil best-effort dari endpoint
 * /admin/logs (bukan per request API) biar gak ada fs.stat di hot path.
 */
export function rotateIfNeeded() {
  try {
    const stat = fs.statSync(ACCESS_LOG_PATH);
    if (stat.size > MAX_BYTES) {
      fs.renameSync(ACCESS_LOG_PATH, ACCESS_LOG_PATH + ".1");
    }
  } catch {
    // file belum ada — biarin
  }
}

/**
 * Baca N baris terakhir access.log (default 200, max 1000), opsional
 * filter substring (path, status code, IP, dst — plain text match).
 * Baca full file lalu slice dari belakang — file dibatasi 5MB oleh
 * rotasi di atas, jadi aman tanpa reverse-stream yang ribet.
 */
export function tailAccessLog({ lines = 200, filter = "" } = {}) {
  const n = Math.min(Math.max(Number(lines) || 200, 1), 1000);
  let content;
  try {
    content = fs.readFileSync(ACCESS_LOG_PATH, "utf8");
  } catch {
    return { lines: [], totalMatched: 0 };
  }
  let all = content.split("\n").filter(Boolean);
  const f = String(filter || "")
    .trim()
    .toLowerCase();
  if (f) all = all.filter((l) => l.toLowerCase().includes(f));
  return { lines: all.slice(-n), totalMatched: all.length };
}

export default { ACCESS_LOG_PATH, tailAccessLog, rotateIfNeeded };

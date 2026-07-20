import fs from "fs";
import path from "path";
import { DATA_DIR } from "./dataDir.js";

export const AUDIT_LOG_PATH = path.join(DATA_DIR, "audit.log");

// Rotasi sekali kayak accessLog (audit.log -> audit.log.1) — cukup buat
// single-instance; audit bukan compliance-grade, tapi minimal admin bisa
// jawab "siapa ngubah tier si A kemarin".
const MAX_BYTES = 5 * 1024 * 1024;

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(AUDIT_LOG_PATH);
    if (stat.size > MAX_BYTES) fs.renameSync(AUDIT_LOG_PATH, AUDIT_LOG_PATH + ".1");
  } catch {
    // file belum ada — biarin
  }
}

/**
 * Catat satu aksi mutasi admin — append-only JSONL (satu objek per baris,
 * gampang di-parse & di-tail). Best-effort: audit gagal gak boleh
 * gagalin aksi admin-nya sendiri.
 */
export function recordAudit({ actor, action, target, detail, status }) {
  try {
    rotateIfNeeded();
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    const entry = {
      at: new Date().toISOString(),
      actor: actor || "unknown",
      action,
      target: target || null,
      detail: detail || null,
      status: status ?? null,
    };
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    /* best-effort */
  }
}

/**
 * Baca N entry terakhir (default 100, max 500), terbaru duluan.
 * Baris korup di-skip (bisa kejadian kalau proses mati pas nulis).
 */
export function tailAuditLog({ lines = 100 } = {}) {
  const n = Math.min(Math.max(Number(lines) || 100, 1), 500);
  let content;
  try {
    content = fs.readFileSync(AUDIT_LOG_PATH, "utf8");
  } catch {
    return { entries: [] };
  }
  const entries = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* baris korup — skip */
    }
  }
  return { entries: entries.slice(-n).reverse() };
}

export default { AUDIT_LOG_PATH, recordAudit, tailAuditLog };

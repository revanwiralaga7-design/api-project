import fs from "fs";
import path from "path";
import crypto from "crypto";
import { ROOT } from "./scaffold.js";
import { DATA_DIR } from "./dataDir.js";

export const HISTORY_DIR = path.join(DATA_DIR, "history");

// Simpan maksimal N entry riwayat — yang paling lama dibuang otomatis.
const MAX_ENTRIES = 30;

/**
 * Riwayat scaffold: tiap apply (add/delete/edit endpoint) nyimpen SNAPSHOT
 * isi file-file yang disentuh SEBELUM perubahan, ke data/history/<id>.json.
 * Rollback = tulis balik snapshot itu (file yang tadinya belum ada ikut
 * DIHAPUS lagi). Persis mekanisme snapshotFiles/restoreFromSnapshot yang
 * dipakai buat rollback-on-error, cuma ini dipersist ke disk & bisa
 * dipanggil kapan aja dari panel admin.
 *
 * PENTING: rollback entry LAMA sementara ada entry lebih baru yang nyentuh
 * file sama = perubahan yang lebih baru ikut ketimpa. Panel admin nampilin
 * warning-nya (lihat conflictsWith di listHistory).
 */

function historyPath(id) {
  // id selalu dari generateId() internal, tapi tetep divalidasi biar gak
  // bisa path traversal kalau dipanggil dengan id dari request.
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error("ID riwayat tidak valid.");
  return path.join(HISTORY_DIR, `${id}.json`);
}

function generateId(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * Simpan 1 entry riwayat. `snapshot` = { absolutePath: contentOrNull }
 * (null = file belum ada saat itu). `action` bebas ("add"/"delete"/"edit"),
 * `summary` teks pendek buat ditampilkan di daftar.
 */
export function recordHistory({ action, summary, snapshot }) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const id = generateId();
  const entry = {
    id,
    action,
    summary: String(summary || ""),
    createdAt: new Date().toISOString(),
    // Path disimpan RELATIF ke ROOT project biar entry tetap valid walau
    // project dipindah folder.
    files: Object.fromEntries(
      Object.entries(snapshot).map(([abs, content]) => [path.relative(ROOT, abs), content])
    ),
  };
  fs.writeFileSync(historyPath(id), JSON.stringify(entry, null, 2) + "\n", "utf8");
  pruneHistory();
  return { id, createdAt: entry.createdAt };
}

function pruneHistory() {
  const entries = listHistoryRaw();
  const excess = entries.slice(MAX_ENTRIES);
  for (const e of excess) {
    try {
      fs.unlinkSync(historyPath(e.id));
    } catch {
      /* udah kehapus */
    }
  }
}

function listHistoryRaw() {
  let files;
  try {
    files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const entries = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), "utf8"));
      if (parsed && parsed.id) entries.push(parsed);
    } catch {
      // file korup — skip aja
    }
  }
  return entries.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

/**
 * Daftar riwayat buat panel admin (tanpa isi file, cuma metadata).
 * conflictsWith: id entry LEBIH BARU yang nyentuh file yang sama —
 * rollback entry ini bakal nimpa perubahan mereka.
 */
export function listHistory() {
  const entries = listHistoryRaw();
  return entries.map((e, i) => {
    const myFiles = new Set(Object.keys(e.files || {}));
    const conflictsWith = entries
      .slice(0, i) // yang lebih baru ada di depan (sort desc)
      .filter((newer) => Object.keys(newer.files || {}).some((f) => myFiles.has(f)))
      .map((newer) => newer.id);
    return {
      id: e.id,
      action: e.action,
      summary: e.summary,
      createdAt: e.createdAt,
      files: Object.keys(e.files || {}),
      conflictsWith,
    };
  });
}

export function getHistoryEntry(id) {
  try {
    return JSON.parse(fs.readFileSync(historyPath(id), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Rollback: kembalikan semua file di entry ke isi snapshot-nya.
 * File yang snapshot-nya null (belum ada saat itu) DIHAPUS.
 * Return daftar aksi buat ditampilkan di panel.
 */
export function rollbackHistory(id) {
  const entry = getHistoryEntry(id);
  if (!entry) throw new Error(`Entry riwayat "${id}" tidak ditemukan.`);

  const actions = [];
  for (const [rel, content] of Object.entries(entry.files || {})) {
    const abs = path.join(ROOT, rel);
    // Jangan pernah nulis keluar ROOT walau entry-nya diedit manual.
    if (!abs.startsWith(ROOT + path.sep)) throw new Error(`Path di entry riwayat mencurigakan: ${rel}`);
    if (content === null) {
      if (fs.existsSync(abs)) {
        fs.unlinkSync(abs);
        actions.push(`${rel} (dihapus — belum ada saat snapshot)`);
      }
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
      actions.push(`${rel} (dikembalikan)`);
    }
  }
  return { id, summary: entry.summary, actions };
}

export function deleteHistoryEntry(id) {
  const p = historyPath(id);
  if (!fs.existsSync(p)) throw new Error(`Entry riwayat "${id}" tidak ditemukan.`);
  fs.unlinkSync(p);
}

export default {
  recordHistory,
  listHistory,
  getHistoryEntry,
  rollbackHistory,
  deleteHistoryEntry,
  HISTORY_DIR,
};

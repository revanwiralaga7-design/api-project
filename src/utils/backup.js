import fs from "fs";
import path from "path";
import { ROOT, SERVICES_DIR, ROUTES_DIR, snapshotFiles } from "./scaffold.js";
import { CLIENTS_PATH } from "./clients.js";
import { HEALTH_TESTS_PATH } from "./health.js";
import { CACHE_CONFIG_PATH } from "../middleware/responseCache.js";

/**
 * Backup & restore: bundle JSON berisi semua file yang TIDAK bisa
 * direkonstruksi dari git — config runtime (clients.json, cache-config,
 * health-tests) plus kode hasil scaffold (routes/, services/, data.js,
 * routes/index.js). Kepakai banget di Railway: filesystem-nya ephemeral,
 * sekali redeploy tanpa volume semua client key hilang.
 *
 * Format bundle: { version, createdAt, files: { "<path relatif ROOT>": "<isi>" } }.
 */

const BACKUP_VERSION = 1;

// Path SELALU relatif ROOT, dipakai dua arah (backup & restore).
function collectBackupPaths() {
  const paths = new Set();

  const addIfExists = (abs) => {
    if (fs.existsSync(abs)) paths.add(abs);
  };

  addIfExists(CLIENTS_PATH);
  addIfExists(HEALTH_TESTS_PATH);
  addIfExists(CACHE_CONFIG_PATH);
  addIfExists(path.join(ROOT, "public", "data.js"));
  addIfExists(path.join(ROOT, "src", "routes", "index.js"));
  addIfExists(path.join(ROOT, "package.json"));

  for (const dir of [SERVICES_DIR, ROUTES_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".js")) paths.add(path.join(dir, f));
    }
  }
  return [...paths];
}

export function buildBackupBundle() {
  const files = {};
  for (const abs of collectBackupPaths()) {
    files[path.relative(ROOT, abs)] = fs.readFileSync(abs, "utf8");
  }
  return {
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    app: "febry-api",
    files,
  };
}

/**
 * Validasi + tulis bundle backup balik ke disk. Semua path di-resolve dan
 * WAJIB berada di dalam ROOT (tolak path traversal), dan cuma boleh
 * nyentuh area yang memang di-backup (src/routes, src/services,
 * src/config, public/data.js, data/, package.json).
 *
 * Return { written: [...], skipped: [...] } — file di bundle yang path-nya
 * di luar area diizinkan cuma di-skip + dilaporkan, bukan bikin gagal
 * total (biar restore bundle versi lama tetap jalan).
 */
export function restoreBackupBundle(bundle, { snapshot } = {}) {
  if (!bundle || typeof bundle !== "object" || !bundle.files || typeof bundle.files !== "object") {
    throw new Error("Format bundle tidak dikenali (harus ada field files).");
  }
  if (bundle.version !== BACKUP_VERSION) {
    throw new Error(`Versi bundle (${bundle.version}) tidak cocok — backup ini dari versi tool yang beda.`);
  }

  const ALLOWED_PREFIXES = [
    "src/routes" + path.sep,
    "src/services" + path.sep,
    "src/config" + path.sep,
    "data" + path.sep,
    "public" + path.sep + "data.js",
  ].map((p) => p.split("/").join(path.sep));
  const ALLOWED_EXACT = new Set(["package.json", path.join("public", "data.js")]);

  const entries = [];
  const skipped = [];
  for (const [rel, content] of Object.entries(bundle.files)) {
    if (typeof content !== "string") {
      skipped.push(`${rel} (isi bukan string)`);
      continue;
    }
    const normalized = path.normalize(rel);
    const abs = path.resolve(ROOT, normalized);
    if (!abs.startsWith(ROOT + path.sep)) {
      skipped.push(`${rel} (di luar project)`);
      continue;
    }
    const allowed = ALLOWED_EXACT.has(normalized) || ALLOWED_PREFIXES.some((p) => normalized.startsWith(p));
    if (!allowed) {
      skipped.push(`${rel} (area tidak diizinkan)`);
      continue;
    }
    entries.push({ rel: normalized, abs, content });
  }
  if (!entries.length) throw new Error("Tidak ada file valid di bundle ini.");

  // Snapshot kondisi sekarang dulu (buat entry riwayat di pemanggil).
  const preSnapshot = snapshot === false ? null : snapshotFiles(entries.map((e) => e.abs));

  for (const e of entries) {
    fs.mkdirSync(path.dirname(e.abs), { recursive: true });
    fs.writeFileSync(e.abs, e.content, "utf8");
  }

  return { written: entries.map((e) => e.rel), skipped, preSnapshot };
}

export default { buildBackupBundle, restoreBackupBundle };

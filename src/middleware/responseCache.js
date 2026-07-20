import fs from "fs";
import path from "path";
import { DATA_DIR } from "../utils/dataDir.js";

export const CACHE_CONFIG_PATH = path.join(DATA_DIR, "cache-config.json");

// Batas jumlah entry cache in-memory — begitu lewat, entry paling lama
// dibuang (FIFO sederhana). Buat jaga-jaga endpoint dengan kombinasi
// query yang variatif banget gak makan memory tanpa batas.
const MAX_ENTRIES = 500;

const store = new Map(); // cacheKey -> { expiresAt, status, body }

let configCache = null;
let configMtime = 0;

/**
 * Baca data/cache-config.json — { "/api/yt/search": { ttlSeconds: 300 }, ... }.
 * Di-cache pakai mtime file, jadi ubah TTL dari panel admin langsung
 * kepakai tanpa restart, tapi gak fs.stat + parse tiap request penuh.
 */
export function loadCacheConfig() {
  try {
    const stat = fs.statSync(CACHE_CONFIG_PATH);
    if (!configCache || stat.mtimeMs !== configMtime) {
      const parsed = JSON.parse(fs.readFileSync(CACHE_CONFIG_PATH, "utf8"));
      configCache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      configMtime = stat.mtimeMs;
    }
    return configCache;
  } catch {
    configCache = {};
    return configCache;
  }
}

export function saveCacheConfig(config) {
  fs.mkdirSync(path.dirname(CACHE_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CACHE_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  configCache = null; // paksa re-read (mtime bisa sama persis di fs cepat)
}

export function clearResponseCache() {
  const n = store.size;
  store.clear();
  return n;
}

export function cacheStats() {
  const now = Date.now();
  let live = 0;
  for (const entry of store.values()) if (entry.expiresAt > now) live++;
  return { entries: store.size, live };
}

function cacheKeyFor(req, fullPath) {
  // Path + query terurut. TANPA identitas client — cache dibagi bareng
  // semua orang, makanya cuma GET & cuma response sukses yang disimpan.
  const params = new URLSearchParams(req.query);
  // apikey itu identitas client, bukan bagian dari resource: kalau ikut,
  // cache terfragmentasi per user (gak pernah HIT antar user) DAN key
  // orang nyangkut di map in-memory sebagai bagian dari cache key.
  params.delete("apikey");
  return `${fullPath}?${params.toString()}`;
}

/**
 * Cache response in-memory per endpoint (opt-in per path lewat
 * data/cache-config.json, diatur dari panel admin):
 * - Cuma method GET (POST dibiarin lewat — bisa punya efek samping).
 * - Cuma nyimpen response 2xx ber-body JSON.
 * - TTL per path pola prefix TERPANJANG yang cocok: "/api/anime" kena
 *   semua sub-path-nya kecuali ada rule lebih spesifik.
 * - Response dari cache dikasih header X-Cache: HIT + Age.
 *
 * Dipasang di /api/* SETELAH rate limiter (request yang kena cache tetap
 * kehitung kuota — biar konsisten sama janji rate limit per client) dan
 * SEBELUM route handler.
 */
export function responseCache(req, res, next) {
  if (req.method !== "GET") return next();

  // PENTING: middleware ini di-mount di app.use("/api", ...) — req.path
  // di sini RELATIF ke mount point ("/youtube/search"), sedangkan rule
  // di config disimpan sebagai path penuh ("/api/youtube/search").
  // Makanya pakai baseUrl + path.
  const fullPath = (req.baseUrl || "") + req.path;
  if (fullPath.startsWith("/api/admin")) return next();

  const config = loadCacheConfig();
  const paths = Object.keys(config).filter((p) => fullPath === p || fullPath.startsWith(p + "/"));
  if (!paths.length) return next();
  const rulePath = paths.sort((a, b) => b.length - a.length)[0];
  const ttlSeconds = Number(config[rulePath]?.ttlSeconds) || 0;
  if (ttlSeconds <= 0) return next();

  const key = cacheKeyFor(req, fullPath);
  const hit = store.get(key);
  const now = Date.now();

  if (hit && hit.expiresAt > now) {
    res.set("X-Cache", "HIT");
    res.set("Age", String(Math.floor((now - hit.storedAt) / 1000)));
    return res.status(hit.status).type("application/json").send(hit.body);
  }
  if (hit) store.delete(key);

  // Sadap res.json buat nyimpen hasilnya — cuma kalau status 2xx.
  const originalJson = res.json.bind(res);
  res.json = (data) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      if (store.size >= MAX_ENTRIES) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
      store.set(key, {
        storedAt: now,
        expiresAt: now + ttlSeconds * 1000,
        status: res.statusCode,
        body: JSON.stringify(data),
      });
    }
    res.set("X-Cache", "MISS");
    return originalJson(data);
  };

  next();
}

export default responseCache;

import fs from "fs";
import path from "path";
import { DATA_DIR } from "./dataDir.js";

export const USAGE_PATH = path.join(DATA_DIR, "usage.json");

// Simpan ringkasan pemakaian N hari terakhir aja — file-nya JSON polos di
// data/ (di-ignore nodemon, jadi nulis ke sini gak bikin server restart).
const KEEP_DAYS = 30;

// Cache in-memory + flush debounce: dicatat per request tapi ditulis ke
// disk paling cepat tiap 3 detik, biar gak ada fs.writeFileSync per hit.
let cache = null;
let dirty = false;
let flushTimer = null;

function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(USAGE_PATH, "utf8"));
    cache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

function prune(usage) {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const day of Object.keys(usage)) {
    if (day < cutoff) delete usage[day];
  }
}

export function flushUsage() {
  if (!dirty || !cache) return;
  try {
    fs.mkdirSync(path.dirname(USAGE_PATH), { recursive: true });
    fs.writeFileSync(USAGE_PATH, JSON.stringify(cache, null, 2) + "\n", "utf8");
    dirty = false;
  } catch {
    // best-effort — analytics gak boleh bikin request user gagal
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushUsage();
  }, 3000);
  // unref: timer ini gak boleh nahan proses hidup (penting buat test & exit)
  if (flushTimer.unref) flushTimer.unref();
}

/**
 * Catat 1 hit. clientKey = apiKey (kalau dikenal) atau IP (anonim).
 * Dipanggil dari middleware/usageTracker.js pada event 'finish' response.
 */
export function recordHit({ clientKey, tier, path: epPath, status }) {
  if (!clientKey || !epPath) return;
  const usage = load();
  const day = (usage[todayKey()] = usage[todayKey()] || {});
  const entry = (day[clientKey] = day[clientKey] || { tier: tier || "free", total: 0, byPath: {}, statuses: {} });
  entry.tier = tier || entry.tier;
  entry.total += 1;
  entry.byPath[epPath] = (entry.byPath[epPath] || 0) + 1;
  const bucket = `${String(status || 0)[0]}xx`;
  entry.statuses[bucket] = (entry.statuses[bucket] || 0) + 1;
  if (status === 429) entry.limited = (entry.limited || 0) + 1;
  prune(usage);
  dirty = true;
  scheduleFlush();
}

/**
 * Total hit HARI INI untuk 1 client — dipakai middleware dailyQuota
 * (sinkron, dari cache in-memory, jadi murah dipanggil per request).
 */
export function getTodayTotal(clientKey) {
  const usage = load();
  return usage[todayKey()]?.[clientKey]?.total || 0;
}

/**
 * Ringkasan buat panel admin: agregat per client + per endpoint selama
 * `days` hari terakhir (termasuk hari ini).
 */
export function usageSummary(days = 7) {
  const usage = load();
  const cutoff = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const byClient = {};
  const byPath = {};
  for (const [day, clients] of Object.entries(usage)) {
    if (day < cutoff) continue;
    for (const [clientKey, entry] of Object.entries(clients)) {
      const c = (byClient[clientKey] = byClient[clientKey] || { tier: entry.tier, total: 0, limited: 0, today: 0, byPath: {} });
      c.tier = entry.tier;
      c.total += entry.total || 0;
      c.limited += entry.limited || 0;
      if (day === todayKey()) c.today = entry.total || 0;
      for (const [p, n] of Object.entries(entry.byPath || {})) {
        c.byPath[p] = (c.byPath[p] || 0) + n;
        byPath[p] = (byPath[p] || 0) + n;
      }
    }
  }

  const topPaths = Object.entries(byPath)
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => ({ path: p, hits: n }));

  return { days, byClient, topPaths };
}

/**
 * Reset cache in-memory (dipakai test biar tiap test mulai bersih).
 */
export function _resetUsageCache() {
  cache = null;
  dirty = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

export default { recordHit, getTodayTotal, usageSummary, flushUsage, USAGE_PATH };

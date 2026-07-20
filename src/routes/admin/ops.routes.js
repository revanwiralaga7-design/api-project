// Route fitur ops panel admin: riwayat+rollback, usage analytics, cache,
// log viewer, health check, ekspor OpenAPI, backup & restore — dipisah
// dari admin.routes.js monolitik, logikanya tidak berubah.
import { Router } from "express";
import path from "path";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ok, ApiError } from "../../utils/response.js";
import { listClients } from "../../utils/clients.js";
import { ROOT, listAllEndpoints, snapshotFiles } from "../../utils/scaffold.js";
import { recordHistory, listHistory, getHistoryEntry, rollbackHistory, deleteHistoryEntry } from "../../utils/history.js";
import { usageSummary, flushUsage } from "../../utils/usage.js";
import { loadCacheConfig, saveCacheConfig, clearResponseCache, cacheStats } from "../../middleware/responseCache.js";
import { tailAccessLog, rotateIfNeeded } from "../../utils/accessLog.js";
import { loadHealthTests, setHealthTest, deleteHealthTest, healthTestKey, runHealthCheck, buildOpenApiSpec } from "../../utils/health.js";
import { buildBackupBundle, restoreBackupBundle } from "../../utils/backup.js";
import { scheduleRestartAfterResponse } from "./planBuilders.js";

const router = Router();

/* ------------------------------------------------------------------ */
/* Riwayat scaffold + rollback (undo)                                  */
/* ------------------------------------------------------------------ */

router.get(
  "/history",
  asyncHandler(async (req, res) => {
    return ok(res, { history: listHistory() });
  })
);

router.post(
  "/history/rollback",
  asyncHandler(async (req, res) => {
    const { id } = req.body || {};
    if (!id) throw new ApiError("id entry riwayat wajib diisi.", 400);
    const entry = getHistoryEntry(id);
    if (!entry) throw new ApiError(`Entry riwayat "${id}" tidak ditemukan.`, 404);

    let result;
    try {
      result = rollbackHistory(id);
    } catch (e) {
      throw new ApiError(`Rollback gagal: ${e.message}`, 500);
    }

    // Entry-nya sengaja TIDAK dihapus setelah rollback — bisa dipakai
    // buat "redo" manual (isi file sebelum rollback ikut kesimpen di
    // entry riwayat baru di bawah).
    try {
      const snapPaths = Object.keys(entry.files || {}).map((rel) => path.join(ROOT, rel));
      recordHistory({
        action: "rollback",
        summary: `Rollback: ${entry.summary}`,
        snapshot: snapshotFiles(snapPaths)
      });
    } catch { /* best-effort */ }

    scheduleRestartAfterResponse(res);
    return ok(res, {
      message: `Rollback "${entry.summary}" berhasil. Server bakal auto-restart sebentar.`,
      actions: result.actions
    });
  })
);

router.delete(
  "/history/:id",
  asyncHandler(async (req, res) => {
    try {
      deleteHistoryEntry(req.params.id);
    } catch (e) {
      throw new ApiError(e.message, 404);
    }
    return ok(res, { message: "Entry riwayat dihapus." });
  })
);

/* ------------------------------------------------------------------ */
/* Usage analytics                                                     */
/* ------------------------------------------------------------------ */

router.get(
  "/usage",
  asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 30);
    flushUsage(); // pastiin data terbaru kebaca
    const summary = usageSummary(days);

    // Gabungin sama daftar client biar nama & tier-nya kebawa (usage
    // nyimpen per apiKey/IP doang).
    const clients = listClients();
    const byKey = new Map(clients.map((c) => [c.apiKey, c]));
    const rows = Object.entries(summary.byClient)
      .map(([clientKey, u]) => ({
        clientKey,
        name: byKey.get(clientKey)?.name || null, // null = anonim (IP) atau key udah dicabut
        tier: u.tier,
        total: u.total,
        today: u.today,
        limited: u.limited,
        topPaths: Object.entries(u.byPath).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, n]) => ({ path: p, hits: n }))
      }))
      .sort((a, b) => b.total - a.total);

    return ok(res, { days: summary.days, clients: rows, topPaths: summary.topPaths.slice(0, 15) });
  })
);

/* ------------------------------------------------------------------ */
/* Cache per endpoint (TTL)                                            */
/* ------------------------------------------------------------------ */

router.get(
  "/cache",
  asyncHandler(async (req, res) => {
    return ok(res, { config: loadCacheConfig(), stats: cacheStats() });
  })
);

router.post(
  "/cache",
  asyncHandler(async (req, res) => {
    const { path: epPath, ttlSeconds } = req.body || {};
    const clean = String(epPath || "").trim();
    if (!clean.startsWith("/api/")) throw new ApiError("path harus diawali /api/", 400);
    const ttl = Number(ttlSeconds);
    if (!Number.isInteger(ttl) || ttl < 0 || ttl > 86400) {
      throw new ApiError("ttlSeconds harus bilangan bulat 0-86400 (0 = hapus rule).", 400);
    }

    const config = loadCacheConfig();
    if (ttl === 0) delete config[clean];
    else config[clean] = { ttlSeconds: ttl };
    saveCacheConfig(config);
    clearResponseCache(); // rule berubah -> isi lama gak valid lagi

    return ok(res, { message: ttl === 0 ? `Rule cache ${clean} dihapus.` : `Cache ${clean} di-set ${ttl} detik.`, config });
  })
);

router.post(
  "/cache/clear",
  asyncHandler(async (req, res) => {
    const cleared = clearResponseCache();
    return ok(res, { message: `${cleared} entry cache dibersihkan.` });
  })
);

/* ------------------------------------------------------------------ */
/* Log viewer                                                          */
/* ------------------------------------------------------------------ */

router.get(
  "/logs",
  asyncHandler(async (req, res) => {
    rotateIfNeeded();
    const { lines, filter } = req.query || {};
    return ok(res, tailAccessLog({ lines, filter }));
  })
);

/* ------------------------------------------------------------------ */
/* Health check semua endpoint                                         */
/* ------------------------------------------------------------------ */

router.get(
  "/health-tests",
  asyncHandler(async (req, res) => {
    return ok(res, { tests: loadHealthTests() });
  })
);

router.post(
  "/health-tests",
  asyncHandler(async (req, res) => {
    const { path: epPath, method, params, assertFields } = req.body || {};
    if (!epPath) throw new ApiError("path wajib diisi.", 400);
    // Cuma boleh buat endpoint yang beneran terdaftar.
    const known = listAllEndpoints().some((e) => e.path === epPath);
    if (!known) throw new ApiError(`Endpoint "${epPath}" tidak terdaftar.`, 404);
    if (assertFields !== undefined && !Array.isArray(assertFields)) {
      throw new ApiError("assertFields harus array dot-path, mis. [\"result.url\"].", 400);
    }
    setHealthTest({ method, path: epPath, params, assertFields });
    return ok(res, { message: `Test params buat ${epPath} disimpan.` });
  })
);

router.delete(
  "/health-tests",
  asyncHandler(async (req, res) => {
    // path/method lewat query (DELETE body suka di-drop proxy/fetch lama).
    const { path: epPath, method } = req.query || {};
    if (!epPath) throw new ApiError("Query 'path' wajib diisi.", 400);
    const tests = loadHealthTests();
    const key = healthTestKey(method, epPath);
    if (!tests[key]) throw new ApiError(`Belum ada test params tersimpan buat "${epPath}".`, 404);
    deleteHealthTest({ method, path: epPath });
    return ok(res, { message: `Test params buat ${epPath} dihapus.` });
  })
);

router.post(
  "/health/run",
  asyncHandler(async (req, res) => {
    const port = process.env.PORT || 3000;
    const result = await runHealthCheck({ baseUrl: `http://localhost:${port}` });
    return ok(res, result);
  })
);

/* ------------------------------------------------------------------ */
/* Ekspor OpenAPI                                                      */
/* ------------------------------------------------------------------ */

router.get(
  "/openapi.json",
  asyncHandler(async (req, res) => {
    const proto = req.get("x-forwarded-proto") || req.protocol;
    const baseUrl = `${proto}://${req.get("host")}`;
    const spec = buildOpenApiSpec({ baseUrl });
    res.setHeader("Content-Disposition", 'inline; filename="openapi.json"');
    return res.json(spec);
  })
);

/* ------------------------------------------------------------------ */
/* Backup & restore — bundle JSON semua file yang gak bisa direkonstruksi */
/* dari git (clients.json, health-tests, cache-config, kode hasil       */
/* scaffold). Penting di Railway: filesystem ephemeral, sekali redeploy  */
/* tanpa volume semua client key hilang. Lihat src/utils/backup.js.      */
/* ------------------------------------------------------------------ */

router.get(
  "/backup",
  asyncHandler(async (req, res) => {
    const bundle = buildBackupBundle();
    const stamp = bundle.createdAt.slice(0, 19).replace(/[:T]/g, "-");
    res.setHeader("Content-Disposition", `attachment; filename="febry-api-backup-${stamp}.json"`);
    return res.json(bundle);
  })
);

router.post(
  "/backup/restore",
  asyncHandler(async (req, res) => {
    const bundle = req.body;
    let result;
    try {
      result = restoreBackupBundle(bundle);
    } catch (e) {
      throw new ApiError(`Restore gagal: ${e.message}`, 400);
    }

    // Kondisi SEBELUM restore dicatat ke riwayat — restore yang salah
    // bundle bisa di-undo dari panel Ops kayak apply endpoint biasa.
    let historyId = null;
    try {
      historyId = recordHistory({
        action: "restore",
        summary: `Restore backup${bundle.createdAt ? ` (dibuat ${bundle.createdAt})` : ""} — ${result.written.length} file`,
        snapshot: result.preSnapshot || {}
      }).id;
    } catch { /* best-effort */ }

    scheduleRestartAfterResponse(res);
    return ok(res, {
      message: `${result.written.length} file di-restore. Server bakal auto-restart sebentar buat nge-load kode hasil restore — tunggu beberapa detik.`,
      written: result.written,
      skipped: result.skipped,
      historyId
    });
  })
);

export default router;

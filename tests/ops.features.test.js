import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

import { recordHit, getTodayTotal, usageSummary, flushUsage, _resetUsageCache, USAGE_PATH } from "../src/utils/usage.js";
import { isExpired } from "../src/utils/clients.js";
import { recordHistory, listHistory, rollbackHistory, deleteHistoryEntry, HISTORY_DIR } from "../src/utils/history.js";
import { ROOT } from "../src/utils/scaffold.js";
import { buildOpenApiSpec } from "../src/utils/health.js";
import { tailAccessLog, ACCESS_LOG_PATH } from "../src/utils/accessLog.js";

/* ------------------------------------------------------------------ */
/* usage.js                                                            */
/* ------------------------------------------------------------------ */

describe("usage analytics", () => {
  beforeEach(() => {
    _resetUsageCache();
    try { fs.unlinkSync(USAGE_PATH); } catch { /* belum ada */ }
  });
  after(() => {
    _resetUsageCache();
    try { fs.unlinkSync(USAGE_PATH); } catch { /* biarin */ }
  });

  test("recordHit + getTodayTotal", () => {
    recordHit({ clientKey: "key1", tier: "premium", path: "/api/x", status: 200 });
    recordHit({ clientKey: "key1", tier: "premium", path: "/api/x", status: 200 });
    recordHit({ clientKey: "key1", tier: "premium", path: "/api/y", status: 500 });
    assert.equal(getTodayTotal("key1"), 3);
    assert.equal(getTodayTotal("lain"), 0);
  });

  test("429 kecatat sebagai limited", () => {
    recordHit({ clientKey: "k", tier: "free", path: "/api/x", status: 429 });
    const s = usageSummary(1);
    assert.equal(s.byClient["k"].limited, 1);
  });

  test("usageSummary agregat per path", () => {
    recordHit({ clientKey: "a", tier: "free", path: "/api/x", status: 200 });
    recordHit({ clientKey: "b", tier: "free", path: "/api/x", status: 200 });
    const s = usageSummary(7);
    assert.equal(s.topPaths[0].path, "/api/x");
    assert.equal(s.topPaths[0].hits, 2);
  });

  test("flushUsage nulis ke disk & kebaca lagi setelah reset cache", () => {
    recordHit({ clientKey: "k", tier: "free", path: "/api/x", status: 200 });
    flushUsage();
    _resetUsageCache();
    assert.equal(getTodayTotal("k"), 1);
  });
});

/* ------------------------------------------------------------------ */
/* clients.js — expiry                                                 */
/* ------------------------------------------------------------------ */

describe("client expiry", () => {
  test("tanpa expiresAt -> gak pernah expired", () => {
    assert.equal(isExpired({ name: "x", tier: "free" }), false);
  });

  test("expiresAt kemarin -> expired", () => {
    assert.equal(isExpired({ expiresAt: "2000-01-01" }), true);
  });

  test("expiresAt besok -> belum expired", () => {
    const besok = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    assert.equal(isExpired({ expiresAt: besok }), false);
  });

  test("expiresAt HARI INI -> masih berlaku sampai akhir hari (UTC)", () => {
    const hariIni = new Date().toISOString().slice(0, 10);
    assert.equal(isExpired({ expiresAt: hariIni }), false);
  });

  test("format tanggal rusak -> dianggap TIDAK expired (jangan matiin key orang)", () => {
    assert.equal(isExpired({ expiresAt: "bukan-tanggal" }), false);
  });
});

/* ------------------------------------------------------------------ */
/* history.js                                                          */
/* ------------------------------------------------------------------ */

describe("history + rollback", () => {
  const TMP_FILE = path.join(ROOT, "data", "history-test-target.txt");

  function cleanupEntries() {
    for (const h of listHistory()) {
      if (h.summary.startsWith("[test]")) {
        try { deleteHistoryEntry(h.id); } catch { /* biarin */ }
      }
    }
  }
  beforeEach(() => {
    cleanupEntries();
    try { fs.unlinkSync(TMP_FILE); } catch { /* belum ada */ }
  });
  after(() => {
    cleanupEntries();
    try { fs.unlinkSync(TMP_FILE); } catch { /* biarin */ }
  });

  test("record -> list -> rollback isi lama balik", () => {
    fs.mkdirSync(path.dirname(TMP_FILE), { recursive: true });
    fs.writeFileSync(TMP_FILE, "ISI LAMA", "utf8");

    const { id } = recordHistory({
      action: "add",
      summary: "[test] ubah file",
      snapshot: { [TMP_FILE]: "ISI LAMA" }
    });

    fs.writeFileSync(TMP_FILE, "ISI BARU", "utf8");
    const result = rollbackHistory(id);
    assert.equal(fs.readFileSync(TMP_FILE, "utf8"), "ISI LAMA");
    assert.ok(result.actions.length === 1);
  });

  test("snapshot null -> rollback MENGHAPUS file", () => {
    const { id } = recordHistory({
      action: "add",
      summary: "[test] file baru",
      snapshot: { [TMP_FILE]: null }
    });
    fs.mkdirSync(path.dirname(TMP_FILE), { recursive: true });
    fs.writeFileSync(TMP_FILE, "file hasil apply", "utf8");
    rollbackHistory(id);
    assert.equal(fs.existsSync(TMP_FILE), false);
  });

  test("conflictsWith kedeteksi antar entry yang nyentuh file sama", () => {
    recordHistory({ action: "add", summary: "[test] pertama", snapshot: { [TMP_FILE]: "a" } });
    recordHistory({ action: "add", summary: "[test] kedua", snapshot: { [TMP_FILE]: "b" } });
    const list = listHistory().filter((h) => h.summary.startsWith("[test]"));
    // entry paling lama (paling belakang di sort desc) harus punya konflik
    const oldest = list[list.length - 1];
    assert.ok(oldest.conflictsWith.length >= 1);
  });

  test("rollback id tidak dikenal -> throw", () => {
    assert.throws(() => rollbackHistory("gak-ada-000000"), /tidak ditemukan/);
  });
});

/* ------------------------------------------------------------------ */
/* health.js — buildOpenApiSpec                                        */
/* ------------------------------------------------------------------ */

describe("openapi export", () => {
  test("spec valid: ada paths dari data.js, method ALL jadi get+post", () => {
    const spec = buildOpenApiSpec({ baseUrl: "http://localhost:3000" });
    assert.equal(spec.openapi, "3.0.3");
    assert.ok(Object.keys(spec.paths).length >= 1);
    // /api/youtube/search terdaftar method ALL -> harus ada get & post
    const yt = spec.paths["/api/youtube/search"];
    assert.ok(yt, "path /api/youtube/search harus ada di spec");
    assert.ok(yt.get, "harus ada operasi get");
    assert.ok(yt.post, "harus ada operasi post");
    // param query wajib ikut
    const qParam = yt.get.parameters.find((p) => p.name === "query");
    assert.ok(qParam && qParam.required === true);
  });
});

/* ------------------------------------------------------------------ */
/* accessLog.js                                                        */
/* ------------------------------------------------------------------ */

describe("access log tail", () => {
  test("file belum ada -> hasil kosong tanpa error", () => {
    // jangan hapus access.log beneran kalau ada — cukup uji format hasil
    const r = tailAccessLog({ lines: 5, filter: "zzz-gak-bakal-match-zzz" });
    assert.ok(Array.isArray(r.lines));
    assert.equal(r.lines.length, 0);
  });
});

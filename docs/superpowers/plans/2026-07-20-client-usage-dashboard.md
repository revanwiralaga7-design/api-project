# Dashboard Usage Klien + Akses OpenAPI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Klien (akun OAuth) bisa melihat grafik pemakaian harian per API key di halaman docs, dan mengunduh spec OpenAPI dari kartu API key.

**Architecture:** Endpoint baru `GET /auth/usage-series` (guard `requireOAuthUser` yang sudah ada) membaca `data/usage.json` lewat util baru `dailySeriesForKey` di `src/utils/usage.js`. Frontend: panel baru di `public/index.html` + skrip terpisah `public/usage-panel.js` (bukan inline, supaya tercakup `publicSyntax.test.js`), bar chart div murni tanpa library. Tombol "Unduh OpenAPI" hanya link ke `/openapi.json` yang **sudah ada dan publik** di `src/app.js:128-137`.

**Tech Stack:** Express 5 (ESM), `node --test`, vanilla JS di frontend. Tanpa dependency baru.

**Spec deviation (disengaja):** Spec meminta `/openapi.json` di-guard `requireDocsAuth` + 401 JSON untuk non-HTML. Ternyata route itu **sudah ada, publik, dan di-commit dengan alasan eksplisit** ("isinya cuma daftar endpoint yang emang udah tampil di docs, gak ada secret" — `src/app.js:123-127`). Plan ini mempertahankan perilaku publik itu; bagian error-handling docs-auth di spec jadi tidak berlaku. Yang tersisa dari requirement itu: tombol unduh di frontend + regression test.

## Global Constraints

- Node >= 22, ESM (`"type": "module"`), tanpa dependency baru di package.json.
- Test: `node --test --test-concurrency=1` (alias `npm test`); file test SELALU restore `data/usage.json` & `src/config/clients.json` di `after()` (pola `tests/selfService.test.js`).
- Komentar kode dalam bahasa Indonesia santai, meniru gaya file yang disentuh.
- Bentuk response API: sukses `{ status: true, result: ... }`, gagal `{ status: false, error: "..." }`.
- Endpoint yang membawa data per-akun set `Cache-Control: no-store`.
- Sebelum commit terakhir: `npm run lint` dan `npm run format:check` harus lolos.
- Retensi usage 30 hari (`KEEP_DAYS` di `src/utils/usage.js`) — `days` di-clamp 1–30, default 14.

---

### Task 1: Util `dailySeriesForKey` di usage.js

**Files:**

- Modify: `src/utils/usage.js` (tambah fungsi setelah `topPathsForKey`, sekitar baris 176; tambahkan juga ke default export di bawah)
- Test: `tests/usageSeries.test.js` (baru)

**Interfaces:**

- Consumes: `load()`, pola internal `usage[day][clientKey] = { total, limited, byPath }` yang sudah ada.
- Produces: `dailySeriesForKey(clientKey, days = 14)` → `Array<{ day: "YYYY-MM-DD", total: number, limited: number }>` — SEMUA hari di rentang, urut naik, hari kosong 0. Task 2 memanggil ini.

- [ ] **Step 1: Tulis test yang gagal**

Buat `tests/usageSeries.test.js`:

```js
// Test dailySeriesForKey: deret harian SATU key buat grafik usage di docs
// (self-service) — beda dari dailySeries yang agregat semua client.
import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { USAGE_PATH, recordHit, dailySeriesForKey, _resetUsageCache } from "../src/utils/usage.js";

const USAGE_EXISTED = fs.existsSync(USAGE_PATH);
const USAGE_CONTENT = USAGE_EXISTED ? fs.readFileSync(USAGE_PATH, "utf8") : null;

after(() => {
  if (USAGE_EXISTED) fs.writeFileSync(USAGE_PATH, USAGE_CONTENT, "utf8");
  else fs.rmSync(USAGE_PATH, { force: true });
  _resetUsageCache();
});

describe("dailySeriesForKey (deret harian satu key)", () => {
  beforeEach(() => {
    _resetUsageCache();
    fs.rmSync(USAGE_PATH, { force: true });
  });

  test("tanpa data -> SEMUA hari di rentang tetap dibalikin, isi 0", () => {
    const s = dailySeriesForKey("key-a", 7);
    assert.equal(s.length, 7, "7 hari persis, termasuk yang kosong");
    for (const d of s) {
      assert.match(d.day, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(d.total, 0);
      assert.equal(d.limited, 0);
    }
    // urut naik, hari terakhir = hari ini (UTC)
    assert.ok(s[0].day < s[6].day);
    assert.equal(s[6].day, new Date().toISOString().slice(0, 10));
  });

  test("hit hari ini cuma masuk ke key yang benar (filter per key)", () => {
    recordHit({ clientKey: "key-a", tier: "free", path: "/api/yt", status: 200 });
    recordHit({ clientKey: "key-a", tier: "free", path: "/api/yt", status: 429 });
    recordHit({ clientKey: "key-b", tier: "free", path: "/api/yt", status: 200 });

    const a = dailySeriesForKey("key-a", 3);
    assert.equal(a.length, 3);
    assert.equal(a[2].total, 2, "key-a: 2 hit hari ini");
    assert.equal(a[2].limited, 1, "satu di antaranya 429");
    assert.equal(a[0].total + a[1].total, 0, "hari sebelumnya kosong");

    const b = dailySeriesForKey("key-b", 3);
    assert.equal(b[2].total, 1, "key-b gak kecampur hit key-a");
    assert.equal(b[2].limited, 0);
  });

  test("key gak dikenal -> semua 0, gak nge-throw", () => {
    recordHit({ clientKey: "key-a", tier: "free", path: "/api/yt", status: 200 });
    const s = dailySeriesForKey("key-gak-ada", 3);
    assert.equal(s.length, 3);
    for (const d of s) assert.equal(d.total, 0);
  });

  test("clientKey kosong/null -> semua 0, gak nge-throw", () => {
    const s = dailySeriesForKey(null, 2);
    assert.equal(s.length, 2);
    for (const d of s) assert.equal(d.total, 0);
  });

  test("default days = 14", () => {
    assert.equal(dailySeriesForKey("key-a").length, 14);
  });
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test --test-concurrency=1 tests/usageSeries.test.js`
Expected: FAIL — `SyntaxError ... does not provide an export named 'dailySeriesForKey'`.

- [ ] **Step 3: Implementasi minimal**

Di `src/utils/usage.js`, setelah fungsi `topPathsForKey` (sebelum `_resetUsageCache`):

```js
/**
 * Deret harian milik SATU client — buat grafik batang panel usage di docs
 * (self-service). Sama seperti dailySeries: SEMUA hari di rentang dibalikin
 * urut termasuk yang 0 hit, biar sumbu X grafik kontinu.
 */
export function dailySeriesForKey(clientKey, days = 14) {
  const usage = load();
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const entry = clientKey ? usage[day]?.[clientKey] : null;
    out.push({ day, total: entry?.total || 0, limited: entry?.limited || 0 });
  }
  return out;
}
```

Tambahkan `dailySeriesForKey,` ke objek default export di akhir file (blok `export default { ... }` sekitar baris 185-195, sejajar `dailySeries`).

- [ ] **Step 4: Jalankan, pastikan lolos**

Run: `node --test --test-concurrency=1 tests/usageSeries.test.js`
Expected: PASS (5 test).

- [ ] **Step 5: Commit**

```bash
git add src/utils/usage.js tests/usageSeries.test.js
git commit -m "Tambah dailySeriesForKey: deret harian per key buat grafik usage docs"
```

---

### Task 2: Endpoint `GET /auth/usage-series`

**Files:**

- Modify: `src/routes/auth.routes.js` (import baris 15, helper + route baru setelah blok `/keys`, sekitar baris 231)
- Test: `tests/usageSeries.test.js` (tambah describe baru), `tests/auth.routes.test.js` (tambah 1 assertion 401)

**Interfaces:**

- Consumes: `dailySeriesForKey` (Task 1), `listKeysForUser`, `getTodayTotal`, `topPathsForKey`, `TIER_MAX`, guard `requireOAuthUser` — semua sudah diimport/ada di file ini.
- Produces:
  - `buildUsageSeriesPayload(user, query)` (exported, dipakai test) → `{ days: [...], topPaths: [...], quota: { daily, hourly, todayUsed } } | null` (null = key tidak ditemukan / bukan milik user).
  - HTTP `GET /auth/usage-series?key=<apiKey>&days=<1-30>` → `{ status: true, result: <payload> }`, 401 tanpa login, 404 kalau key bukan milik akun. Task 4 (frontend) memanggil ini.

- [ ] **Step 1: Tulis test yang gagal**

Tambahkan di akhir `tests/usageSeries.test.js` (import tambahan di atas: perhatikan file ini akan menarik `auth.routes.js` yang butuh env OAuth kosong — tambahkan `import "./helpers/forceEmptyOauthEnv.js";` sebagai **baris import pertama**, dan fixture clients.json ala `selfService.test.js`):

```js
// --- tambahan import di bagian atas file (forceEmptyOauthEnv PALING atas) ---
import "./helpers/forceEmptyOauthEnv.js";
import { CLIENTS_PATH } from "../src/utils/clients.js";
import { buildUsageSeriesPayload } from "../src/routes/auth.routes.js";
```

```js
// --- fixture clients.json: taruh setelah fixture USAGE yang sudah ada ---
const CLIENTS_EXISTED = fs.existsSync(CLIENTS_PATH);
const CLIENTS_CONTENT = CLIENTS_EXISTED ? fs.readFileSync(CLIENTS_PATH, "utf8") : null;

after(() => {
  if (CLIENTS_EXISTED) fs.writeFileSync(CLIENTS_PATH, CLIENTS_CONTENT, "utf8");
  else fs.rmSync(CLIENTS_PATH, { force: true });
});
```

```js
describe("buildUsageSeriesPayload (logika /auth/usage-series)", () => {
  const USER = { provider: "google", id: "111" };

  beforeEach(() => {
    _resetUsageCache();
    fs.rmSync(USAGE_PATH, { force: true });
    fs.writeFileSync(
      CLIENTS_PATH,
      JSON.stringify(
        {
          "key-primary": {
            name: "Budi",
            tier: "premium",
            provider: "google",
            providerId: "111",
            dailyQuota: 500,
          },
          "key-bot": {
            name: "Budi",
            tier: "premium",
            provider: "google",
            providerId: "111",
            label: "bot-discord",
          },
          "key-orang-lain": { name: "Ani", tier: "free", provider: "github", providerId: "999" },
        },
        null,
        2
      ),
      "utf8"
    );
  });

  test("tanpa ?key -> pakai key primary (yang tanpa label)", () => {
    recordHit({ clientKey: "key-primary", tier: "premium", path: "/api/yt", status: 200 });
    const p = buildUsageSeriesPayload(USER, {});
    assert.ok(p, "payload harus ada");
    assert.equal(p.days.length, 14, "default 14 hari");
    assert.equal(p.days.at(-1).total, 1);
    assert.equal(p.quota.daily, 500);
    assert.equal(p.quota.todayUsed, 1);
    assert.ok(p.quota.hourly > 0, "premium punya limit per jam");
  });

  test("?key milik sendiri (key berlabel) -> dipakai", () => {
    recordHit({ clientKey: "key-bot", tier: "premium", path: "/api/anime", status: 200 });
    const p = buildUsageSeriesPayload(USER, { key: "key-bot" });
    assert.equal(p.days.at(-1).total, 1);
    assert.equal(p.quota.daily, null, "key bot gak punya dailyQuota");
  });

  test("?key milik user LAIN -> null (route bakal 404), bukan data orang", () => {
    assert.equal(buildUsageSeriesPayload(USER, { key: "key-orang-lain" }), null);
  });

  test("?key gak ada di sistem -> null juga (pesan gak bocorin eksistensi)", () => {
    assert.equal(buildUsageSeriesPayload(USER, { key: "key-ngasal" }), null);
  });

  test("user tanpa key sama sekali -> null", () => {
    assert.equal(buildUsageSeriesPayload({ provider: "google", id: "777" }, {}), null);
  });

  test("days di-clamp diam-diam: 999 -> 30, 0 -> 1, 'abc' -> default 14", () => {
    assert.equal(buildUsageSeriesPayload(USER, { days: "999" }).days.length, 30);
    assert.equal(buildUsageSeriesPayload(USER, { days: "0" }).days.length, 1);
    assert.equal(buildUsageSeriesPayload(USER, { days: "abc" }).days.length, 14);
  });

  test("tier admin -> quota.hourly null (unlimited)", () => {
    fs.writeFileSync(
      CLIENTS_PATH,
      JSON.stringify(
        { "key-adm": { name: "Root", tier: "admin", provider: "google", providerId: "111" } },
        null,
        2
      ),
      "utf8"
    );
    assert.equal(buildUsageSeriesPayload(USER, {}).quota.hourly, null);
  });
});
```

CATATAN: `listKeysForUser` membaca `clients.json` fresh tiap panggilan (lihat `loadClients` di `src/utils/clients.js`) — kalau ternyata ada cache dan test gagal karena data basi, panggil helper reset yang tersedia di clients.js (cek `_reset`/`invalidate` di file itu) di `beforeEach`.

Lalu di `tests/auth.routes.test.js`, tambahkan `["GET", "/auth/usage-series"]` ke daftar loop test 401 yang sudah ada (test `"GET/POST /auth/keys & DELETE /auth/keys/:key tanpa login -> 401 semua"`, sekitar baris 160) dan sesuaikan nama test-nya menjadi menyebut usage-series.

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `node --test --test-concurrency=1 tests/usageSeries.test.js`
Expected: FAIL — `does not provide an export named 'buildUsageSeriesPayload'`.

- [ ] **Step 3: Implementasi**

Di `src/routes/auth.routes.js`:

Baris 15, tambah import: `import { getTodayTotal, topPathsForKey, dailySeriesForKey } from "../utils/usage.js";`

Setelah route `DELETE /keys/:apiKey` (baris ~231), sebelum `export default`:

```js
/**
 * Data panel usage di docs: deret harian + top endpoint + kuota untuk SATU
 * key milik akun yang login. Dipisah dari route biar bisa ditest langsung
 * tanpa boot app (pola safeNext di atas).
 *
 * Balikin null kalau key gak ketemu DI DAFTAR KEY USER INI — sengaja gak
 * bedain "key orang lain" vs "key gak ada" biar endpoint ini gak bisa
 * dipakai ngecek eksistensi key orang.
 */
export function buildUsageSeriesPayload(user, query = {}) {
  const keys = listKeysForUser(user?.provider, user?.id);
  if (!keys.length) return null;
  const requested = typeof query.key === "string" && query.key ? query.key : null;
  const owned = requested ? keys.find((k) => k.apiKey === requested) : keys.find((k) => !k.label) || keys[0];
  if (!owned) return null;
  // days di-clamp diam-diam ke 1-30 (retensi usage.json cuma 30 hari),
  // non-angka -> default 14. Bukan error: query nyeleneh gak perlu 400.
  const parsed = Number.parseInt(query.days, 10);
  const days = Number.isFinite(parsed) ? Math.min(30, Math.max(1, parsed)) : 14;
  return {
    days: dailySeriesForKey(owned.apiKey, days),
    topPaths: topPathsForKey(owned.apiKey, days),
    quota: {
      daily: owned.dailyQuota || null,
      hourly: owned.tier === "admin" ? null : (TIER_MAX[owned.tier] ?? TIER_MAX.free),
      todayUsed: getTodayTotal(owned.apiKey),
    },
  };
}

router.get("/usage-series", requireOAuthUser, (req, res) => {
  const payload = buildUsageSeriesPayload(req.user, req.query);
  if (!payload) {
    return res.status(404).json({ status: false, error: "Key tidak ditemukan di akun ini." });
  }
  res.set("Cache-Control", "no-store");
  res.json({ status: true, result: payload });
});
```

PENTING: `requireOAuthUser` dideklarasikan di baris ~193 — route ini harus ditulis SETELAH deklarasi itu (function declaration di-hoist, jadi aman di mana pun setelahnya; taruh setelah blok `/keys` biar rapi).

- [ ] **Step 4: Jalankan, pastikan lolos**

Run: `node --test --test-concurrency=1 tests/usageSeries.test.js tests/auth.routes.test.js`
Expected: PASS semua.

- [ ] **Step 5: Commit**

```bash
git add src/routes/auth.routes.js tests/usageSeries.test.js tests/auth.routes.test.js
git commit -m "Tambah GET /auth/usage-series: data grafik usage per key (self-service)"
```

---

### Task 3: Regression test `/openapi.json` publik

Route sudah ada (`src/app.js:128-137`) tapi belum punya test — kunci perilakunya sebelum frontend bergantung padanya.

**Files:**

- Test: `tests/openapiPublic.test.js` (baru)

**Interfaces:**

- Consumes: app boot pattern dari `tests/auth.routes.test.js` (dynamic import + port acak + SESSION_STORE_PATH tmp).
- Produces: — (test only).

- [ ] **Step 1: Tulis test**

Buat `tests/openapiPublic.test.js`:

```js
// Regression: /openapi.json publik (tanpa login) — dipakai tombol
// "Unduh OpenAPI" di docs + import langsung ke Postman/Insomnia.
// Boot app beneran (pola auth.routes.test.js) karena route-nya nempel
// di src/app.js, bukan di router yang bisa diimport sendirian.
import "./helpers/forceEmptyOauthEnv.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

describe("GET /openapi.json (publik)", () => {
  let server;
  let baseUrl;
  let tmpSessionDir;

  before(async () => {
    tmpSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "febry-api-openapi-test-"));
    process.env.NODE_ENV = "test";
    process.env.SESSION_STORE_PATH = path.join(tmpSessionDir, "sessions.sqlite");
    const { default: app } = await import("../src/app.js");
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (tmpSessionDir) fs.rmSync(tmpSessionDir, { recursive: true, force: true });
  });

  test("tanpa login -> 200, dokumen OpenAPI valid", async () => {
    const res = await fetch(`${baseUrl}/openapi.json`);
    assert.equal(res.status, 200);
    const spec = await res.json();
    assert.match(spec.openapi, /^3\./, "field openapi versi 3.x");
    assert.ok(spec.paths && typeof spec.paths === "object", "punya paths");
    assert.ok(spec.info?.title, "punya info.title");
  });

  test("servers[0].url ngikutin Host request (buat import langsung dari URL)", async () => {
    const res = await fetch(`${baseUrl}/openapi.json`);
    const spec = await res.json();
    assert.ok(
      Array.isArray(spec.servers) && spec.servers[0]?.url?.includes("127.0.0.1"),
      "server url dari req.get('host')"
    );
  });
});
```

- [ ] **Step 2: Jalankan, pastikan lolos**

Run: `node --test --test-concurrency=1 tests/openapiPublic.test.js`
Expected: PASS. (Ini regression test untuk kode yang sudah ada — kalau FAIL, perilaku route berubah dari asumsi; STOP dan periksa `buildOpenApiSpec` di `src/utils/health.js` sebelum lanjut.)

- [ ] **Step 3: Commit**

```bash
git add tests/openapiPublic.test.js
git commit -m "Test regression /openapi.json publik (dipakai tombol unduh di docs)"
```

---

### Task 4: Frontend — panel usage + tombol Unduh OpenAPI

**Files:**

- Create: `public/usage-panel.js`
- Modify: `public/index.html` (markup panel setelah kartu API key ~baris 963; tag script setelah `./app.js` ~baris 986; link OpenAPI di hint kartu ~baris 959-962)
- Test: otomatis tercakup `tests/publicSyntax.test.js` (parse semua `public/*.js`)

**Interfaces:**

- Consumes: `GET /auth/keys` (401 kalau bukan OAuth → panel tetap tersembunyi), `GET /auth/usage-series?key=&days=14` (Task 2).
- Produces: — (UI leaf).

- [ ] **Step 1: Markup panel di index.html**

Setelah `</div>` penutup `apikey-card` (sebelum `<div class="panel-frame">` ~baris 965), sisipkan:

```html
<!-- Panel usage per key: grafik batang 14 hari + kuota + top endpoint.
     Diisi public/usage-panel.js dari /auth/usage-series — cuma tampil
     buat akun OAuth (session admin-key ditolak /auth/keys, panel diem). -->
<div class="apikey-card" id="usagePanel">
  <div class="apikey-head">
    <span class="apikey-label">PEMAKAIAN 14 HARI</span>
    <select
      id="usageKeySelect"
      style="
        font-family: var(--mono);
        font-size: 11px;
        background: var(--bg-2);
        border: 1px solid var(--line);
        border-radius: 4px;
        padding: 3px 6px;
        color: var(--text);
      "
    ></select>
  </div>
  <div
    id="usageChart"
    style="display: flex; align-items: flex-end; gap: 3px; height: 90px; margin-top: 10px"
  ></div>
  <div class="apikey-hint" id="usageQuota" style="display: none"></div>
  <div class="apikey-hint" id="usageTopPaths" style="display: none"></div>
  <div class="apikey-hint" id="usageError" style="display: none; color: var(--amber)"></div>
</div>
```

Panel ikut kelas `apikey-card` yang sudah ada — dia baru terlihat setelah JS menambah kelas `show` (perilaku CSS existing kartu API key), jadi tidak perlu CSS baru dan default-nya tersembunyi.

Di hint terakhir kartu API key (blok "Playground di bawah otomatis pakai key ini…", ~baris 959-962), tambahkan di akhir kalimat (masih di dalam `<div class="apikey-hint">` yang sama):

```html
Spec mesin-terbaca: <a href="/openapi.json" target="_blank" style="color: var(--green)">unduh OpenAPI</a> —
impor ke Postman/Insomnia/Swagger UI.
```

Setelah `<script src="./app.js"></script>` (~baris 986), tambahkan:

```html
<script src="./usage-panel.js"></script>
```

- [ ] **Step 2: Tulis public/usage-panel.js**

```js
// Panel usage di docs (index.html): grafik batang harian per key + kuota +
// top endpoint. Sumber data /auth/usage-series (cuma akun OAuth — kalau
// /auth/keys jawab 401, panel dibiarkan tersembunyi, halaman lain jalan
// normal). Sengaja file terpisah (bukan inline di index.html) biar kena
// guard tests/publicSyntax.test.js.
(function () {
  var panel = document.getElementById("usagePanel");
  var select = document.getElementById("usageKeySelect");
  var chartEl = document.getElementById("usageChart");
  var quotaEl = document.getElementById("usageQuota");
  var topEl = document.getElementById("usageTopPaths");
  var errEl = document.getElementById("usageError");
  if (!panel) return;

  var DAYS = 14;

  function showError(msg) {
    errEl.textContent = msg;
    errEl.style.display = "block";
  }

  function renderChart(days) {
    chartEl.innerHTML = "";
    var max = 1;
    days.forEach(function (d) {
      if (d.total > max) max = d.total;
    });
    days.forEach(function (d) {
      var col = document.createElement("div");
      col.style.flex = "1";
      col.style.display = "flex";
      col.style.flexDirection = "column";
      col.style.justifyContent = "flex-end";
      col.style.height = "100%";
      col.title = d.day + " · " + d.total + " request" + (d.limited ? " (" + d.limited + " kena limit)" : "");

      var ok = d.total - d.limited;
      // Bagian kena 429 di atas (merah), sisanya hijau — bar 0 tetap
      // dikasih alas 2px biar sumbu X-nya kelihatan kontinu.
      if (d.limited > 0) {
        var segLim = document.createElement("div");
        segLim.style.height = Math.max(2, (d.limited / max) * 100) + "%";
        segLim.style.background = "var(--red)";
        segLim.style.borderRadius = "2px 2px 0 0";
        col.appendChild(segLim);
      }
      var segOk = document.createElement("div");
      segOk.style.height = d.total === 0 ? "2px" : Math.max(2, (ok / max) * 100) + "%";
      segOk.style.background = d.total === 0 ? "var(--line)" : "var(--green)";
      segOk.style.borderRadius = d.limited > 0 ? "0" : "2px 2px 0 0";
      col.appendChild(segOk);
      chartEl.appendChild(col);
    });
  }

  function renderMeta(result) {
    var q = result.quota || {};
    var parts = ["hari ini " + (q.todayUsed || 0) + " request"];
    parts.push(q.hourly === null ? "limit: unlimited" : "limit " + q.hourly + "/jam");
    if (q.daily) parts.push("kuota " + (q.todayUsed || 0) + "/" + q.daily + " per hari");
    quotaEl.textContent = parts.join(" · ");
    quotaEl.style.display = "block";

    if (result.topPaths && result.topPaths.length) {
      topEl.textContent =
        "terpopuler: " +
        result.topPaths
          .map(function (t) {
            return t.path + " (" + t.hits + "×)";
          })
          .join(" · ");
      topEl.style.display = "block";
    } else {
      topEl.style.display = "none";
    }
  }

  function loadSeries(apiKey) {
    errEl.style.display = "none";
    fetch("/auth/usage-series?key=" + encodeURIComponent(apiKey) + "&days=" + DAYS)
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (!j.status) {
          showError(j.error || "Gagal memuat data pemakaian.");
          return;
        }
        renderChart(j.result.days);
        renderMeta(j.result);
      })
      .catch(function () {
        showError("Gagal memuat data pemakaian — muat ulang halaman buat coba lagi.");
      });
  }

  // Daftar key dari /auth/keys — juga jadi gerbang: 401/gagal = bukan akun
  // OAuth (mis. session admin-key), panel tetap tersembunyi.
  fetch("/auth/keys")
    .then(function (r) {
      if (!r.ok) throw new Error("bukan akun OAuth");
      return r.json();
    })
    .then(function (j) {
      if (!j.status || !j.result.keys.length) return;
      j.result.keys.forEach(function (k) {
        var opt = document.createElement("option");
        opt.value = k.apiKey;
        // textContent (bukan innerHTML): label key itu input user.
        opt.textContent = (k.label || "key utama") + " · " + k.apiKey.slice(0, 6) + "…";
        select.appendChild(opt);
      });
      select.addEventListener("change", function () {
        loadSeries(select.value);
      });
      panel.classList.add("show");
      loadSeries(select.value);
    })
    .catch(function () {
      /* diem — halaman docs lain tetap jalan */
    });
})();
```

- [ ] **Step 3: Jalankan test syntax + full suite**

Run: `npm test`
Expected: PASS semua (termasuk `publicSyntax.test.js` yang sekarang mem-parse `usage-panel.js`).

- [ ] **Step 4: Cek visual manual**

Run: `npm run dev`, buka `http://localhost:PORT/index.html` (login docs), pastikan: panel muncul untuk akun OAuth, dropdown ganti key memuat ulang grafik, link "unduh OpenAPI" mengunduh JSON. Untuk session admin-key: panel tidak muncul. (Kalau tidak ada browser di environment, minimal `curl -s localhost:PORT/openapi.json | head` dan lanjut — catat di commit bahwa cek visual belum dilakukan.)

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/usage-panel.js
git commit -m "Panel usage per key di docs + link unduh OpenAPI di kartu API key"
```

---

### Task 5: Verifikasi akhir

**Files:** — (verifikasi saja; perbaikan format boleh menyentuh file task sebelumnya)

- [ ] **Step 1: Lint + format**

Run: `npm run lint && npm run format:check`
Expected: keduanya exit 0. Kalau format:check gagal: `npm run format`, review diff, commit `style: format`.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: PASS semua, tidak ada test hang (proses exit sendiri).

- [ ] **Step 3: Commit sisa (kalau ada) — kalau working tree bersih, selesai**

```bash
git status --short
```

---

## Self-Review (sudah dijalankan)

- **Spec coverage:** endpoint usage-series (Task 2) ✓, util deret harian (Task 1) ✓, akses OpenAPI klien (sudah ada; tombol Task 4 + test Task 3, deviasi didokumentasikan di header) ✓, grafik + selector + ringkasan + sembunyikan untuk admin-key (Task 4) ✓, error handling clamp/404/401 (Task 2) & frontend graceful (Task 4) ✓, testing sesuai daftar spec ✓.
- **Placeholder scan:** tidak ada TBD/TODO; semua step berkode lengkap.
- **Type consistency:** `dailySeriesForKey(clientKey, days)` (Task 1) = yang dipanggil Task 2; `buildUsageSeriesPayload(user, query)` (Task 2) = yang ditest; bentuk `{ days, topPaths, quota: { daily, hourly, todayUsed } }` konsisten Task 2 ↔ Task 4.

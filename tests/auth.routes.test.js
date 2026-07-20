// CATATAN: file ini boot beneran src/app.js (bukan cuma import fungsi
// murni), jadi butuh SEMUA dependency ke-install dulu ("npm install")
// sebelum "npm test" — kalau belum, bakal MODULE_NOT_FOUND pas load file
// ini (express, express-session, session-file-store, passport, dst),
// bukan test-nya yang gagal.
//
// Helper ini WAJIB paling atas: import auth.routes.js di bawah narik
// config/index.js (dotenv) — kalau env OAuth belum dikosongin duluan,
// kredensial asli dari .env developer kebawa dan test 503-nya gagal.
import "./helpers/forceEmptyOauthEnv.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { safeNext } from "../src/routes/auth.routes.js";

/* ------------------------------------------------------------------ */
/* 1. safeNext — proteksi open-redirect di param ?next= (dipakai buat  */
/*    dikirim balik lewat `state` OAuth2). Ini fungsi murni, gak butuh */
/*    boot app, jadi ditest langsung.                                  */
/* ------------------------------------------------------------------ */
describe("safeNext (proteksi open-redirect ?next=)", () => {
  test("path internal biasa -> dipakai apa adanya", () => {
    assert.equal(safeNext("/dashboard"), "/dashboard");
  });

  test("path internal dengan query string -> tetap dipakai apa adanya", () => {
    assert.equal(safeNext("/index.html?tab=playground"), "/index.html?tab=playground");
  });

  test("protocol-relative //evil.com -> fallback (INI inti proteksinya)", () => {
    assert.equal(safeNext("//evil.com"), "/index.html");
    assert.equal(safeNext("//evil.com/phish"), "/index.html");
  });

  test("URL absolut ke domain luar -> fallback", () => {
    assert.equal(safeNext("https://evil.com"), "/index.html");
    assert.equal(safeNext("http://evil.com/phish"), "/index.html");
  });

  test("gak diawali '/' sama sekali -> fallback", () => {
    assert.equal(safeNext("evil.com"), "/index.html");
    assert.equal(safeNext("javascript:alert(1)"), "/index.html");
  });

  test("bukan string (array/number/object) -> fallback, gak nge-throw", () => {
    assert.equal(safeNext(["/dashboard"]), "/index.html");
    assert.equal(safeNext(123), "/index.html");
    assert.equal(safeNext({ next: "/x" }), "/index.html");
  });

  test("kosong / undefined -> fallback", () => {
    assert.equal(safeNext(""), "/index.html");
    assert.equal(safeNext(undefined), "/index.html");
  });
});

/* ------------------------------------------------------------------ */
/* 2. Integration test — boot src/app.js beneran di port acak, karena  */
/*    sisa route /auth/* nyangkut ke passport + flag googleEnabled/    */
/*    githubEnabled yang cuma bisa diuji lewat perilaku HTTP asli      */
/*    (redirect, status code), bukan lewat pemanggilan fungsi mentah.  */
/*                                                                     */
/*    Env GOOGLE_* dan GITHUB_* dipaksa string kosong SEBELUM src/app.js*/
/*    di-import (pakai dynamic import di dalam before(), bukan import  */
/*    statement biasa — import biasa di-hoist ke atas file, jadi bakal */
/*    kejalan duluan sebelum process.env sempet di-set, percuma).      */
/*    dotenv (dipanggil dari src/config/index.js) TIDAK menimpa env    */
/*    yang sudah ada duluan di process.env walau isinya "" — jadi ini  */
/*    deterministik, gak kebawa .env asli developer walau di situ      */
/*    Google/GitHub-nya udah diisi kredensial beneran.                 */
/* ------------------------------------------------------------------ */
describe("/auth/* (integration, Google & GitHub sengaja dikosongin)", () => {
  let server;
  let baseUrl;
  let tmpSessionDir;

  before(async () => {
    tmpSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "febry-api-session-test-"));

    process.env.NODE_ENV = "test";
    process.env.GOOGLE_CLIENT_ID = "";
    process.env.GOOGLE_CLIENT_SECRET = "";
    process.env.GITHUB_CLIENT_ID = "";
    process.env.GITHUB_CLIENT_SECRET = "";
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

  test("GET /auth/google -> 503, pesan sebut provider Google belum dikonfigurasi", async () => {
    const res = await fetch(`${baseUrl}/auth/google`);
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.ok(text.includes("Google"), "pesan error harus nyebut providernya");
  });

  test("GET /auth/github -> 503, pesan sebut provider GitHub belum dikonfigurasi", async () => {
    const res = await fetch(`${baseUrl}/auth/github`);
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.ok(text.includes("GitHub"), "pesan error harus nyebut providernya");
  });

  test("GET /auth/google/callback -> redirect ke signin.html?error=google_disabled", async () => {
    const res = await fetch(`${baseUrl}/auth/google/callback`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/signin.html?error=google_disabled");
  });

  test("GET /auth/github/callback -> redirect ke signin.html?error=github_disabled", async () => {
    const res = await fetch(`${baseUrl}/auth/github/callback`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/signin.html?error=github_disabled");
  });

  test("GET /auth/me tanpa login -> user null, apiKey null, clients.json TIDAK ketulis", async () => {
    const clientsExistedBefore = fs.existsSync(new URL("../src/config/clients.json", import.meta.url));
    const res = await fetch(`${baseUrl}/auth/me`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      status: true,
      user: null,
      adminDocs: false,
      apiKey: null,
      apiTier: null,
      usage: null,
    });
    // Guard req.user?.provider harus mencegah provisioning buat anonim —
    // keberadaan file gak boleh berubah gara-gara request ini.
    assert.equal(fs.existsSync(new URL("../src/config/clients.json", import.meta.url)), clientsExistedBefore);
  });

  test("POST /auth/regenerate-key tanpa login -> 401, clients.json TIDAK ketulis", async () => {
    const clientsExistedBefore = fs.existsSync(new URL("../src/config/clients.json", import.meta.url));
    const res = await fetch(`${baseUrl}/auth/regenerate-key`, { method: "POST" });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.status, false);
    assert.ok(body.error, "harus ada pesan error");
    // Guard req.user?.provider harus nolak anonim SEBELUM nyentuh clients —
    // gak boleh ada key siapa pun yang ke-rotate/ketulis gara-gara ini.
    assert.equal(fs.existsSync(new URL("../src/config/clients.json", import.meta.url)), clientsExistedBefore);
  });

  test("GET/POST /auth/keys & DELETE /auth/keys/:key tanpa login -> 401 semua", async () => {
    for (const [method, path] of [
      ["GET", "/auth/keys"],
      ["POST", "/auth/keys"],
      ["DELETE", "/auth/keys/abc123"],
    ]) {
      const res = await fetch(`${baseUrl}${path}`, { method });
      assert.equal(res.status, 401, `${method} ${path} harus 401 buat anonim`);
      const body = await res.json();
      assert.equal(body.status, false);
    }
  });

  test("GET /openapi.json publik -> spec OpenAPI 3 valid tanpa auth", async () => {
    const res = await fetch(`${baseUrl}/openapi.json`);
    assert.equal(res.status, 200);
    const spec = await res.json();
    assert.match(spec.openapi || "", /^3\./, "harus OpenAPI 3.x");
    assert.ok(spec.paths && Object.keys(spec.paths).length > 0, "paths gak boleh kosong");
    assert.ok(spec.info?.title, "harus ada info.title");
  });

  test("GET /auth/logout tanpa sesi aktif -> tetap redirect ke /features.html (gak error)", async () => {
    const res = await fetch(`${baseUrl}/auth/logout`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/features.html");
  });
});

// Test fitur JSON profile card: unit test service (render murni, gak butuh
// server) + integration test route lewat HTTP asli (pola
// requireApiKey.integration.test.js — boot src/app.js di port acak).
import "./helpers/forceEmptyOauthEnv.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { renderJsonCard, MAX_FIELDS, MAX_VALUE_LEN } from "../src/services/jsoncard.service.js";
import { renderWelcomeCard } from "../src/services/welcomecard.service.js";
import { CLIENTS_PATH } from "../src/utils/clients.js";

// 8 byte pertama file PNG selalu persis ini (magic number per spesifikasi).
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.subarray(0, 8).equals(PNG_MAGIC);
}

/* ------------------------------------------------------------------ */
/* 1. Unit: renderJsonCard                                             */
/* ------------------------------------------------------------------ */
describe("renderJsonCard (unit)", () => {
  test("field normal -> buffer PNG valid", async () => {
    const buf = await renderJsonCard({ name: "Kyynzh", title: "Developer" });
    assert.ok(isPng(buf), "harus diawali PNG magic bytes");
    assert.ok(buf.length > 1000, "PNG beneran, bukan file kosong");
  });

  test("makin banyak field -> gambar makin tinggi (tinggi kanvas dinamis)", async () => {
    const kecil = await renderJsonCard({ a: "1" });
    const besar = await renderJsonCard({ a: "1", b: "2", c: "3", d: "4", e: "5" });
    // Tinggi beda -> ukuran file beda; cek kasar tapi cukup tanpa decode PNG.
    assert.notEqual(kecil.length, besar.length);
  });

  test(`lebih dari ${MAX_FIELDS} field -> gak error, kepotong diam-diam`, async () => {
    const banyak = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, `v${i}`]));
    const buf = await renderJsonCard(banyak);
    assert.ok(isPng(buf));
    // Hasilnya harus setinggi kartu MAX_FIELDS field, bukan 20.
    const pasMax = await renderJsonCard(
      Object.fromEntries(Array.from({ length: MAX_FIELDS }, (_, i) => [`k${i}`, `v${i}`]))
    );
    assert.equal(buf.length, pasMax.length);
  });

  test("value dengan kutip/backslash -> gak nge-throw (di-escape)", async () => {
    const buf = await renderJsonCard({ name: 'say "hi" \\ bye' });
    assert.ok(isPng(buf));
  });

  test(`value super panjang -> kepotong ke ${MAX_VALUE_LEN}, tetap render`, async () => {
    const buf = await renderJsonCard({ bio: "x".repeat(500) });
    assert.ok(isPng(buf));
  });
});

/* ------------------------------------------------------------------ */
/* 2. Unit: renderWelcomeCard                                          */
/* ------------------------------------------------------------------ */
describe("renderWelcomeCard (unit)", () => {
  test("nama biasa -> PNG valid", async () => {
    const buf = await renderWelcomeCard("Kyynzh", "Member baru");
    assert.ok(isPng(buf));
  });

  test("deterministik: nama sama -> hasil byte-identik (warna hash konsisten)", async () => {
    const a = await renderWelcomeCard("Kyynzh");
    const b = await renderWelcomeCard("Kyynzh");
    assert.ok(a.equals(b));
  });

  test("nama satu kata / emoji / kosong-ish -> gak nge-throw", async () => {
    for (const name of ["Budi", "🔥🔥", "  x  "]) {
      assert.ok(isPng(await renderWelcomeCard(name)), `gagal buat: ${JSON.stringify(name)}`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. Integration: /api/canvas/jsoncard lewat HTTP asli                */
/* ------------------------------------------------------------------ */
const ORIGINAL_EXISTED = fs.existsSync(CLIENTS_PATH);
const ORIGINAL_CONTENT = ORIGINAL_EXISTED ? fs.readFileSync(CLIENTS_PATH, "utf8") : null;

describe("/api/canvas/jsoncard (integration, HTTP asli)", () => {
  let server;
  let baseUrl;
  let tmpSessionDir;

  before(async () => {
    tmpSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "febry-api-canvas-test-"));
    process.env.SESSION_STORE_PATH = tmpSessionDir;
    fs.writeFileSync(
      CLIENTS_PATH,
      JSON.stringify({ "key-canvas-test": { name: "Canvas Test", tier: "free" } }, null, 2),
      "utf8"
    );

    const { default: app } = await import("../src/app.js");
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (tmpSessionDir) fs.rmSync(tmpSessionDir, { recursive: true, force: true });
    if (ORIGINAL_EXISTED) fs.writeFileSync(CLIENTS_PATH, ORIGINAL_CONTENT, "utf8");
    else fs.rmSync(CLIENTS_PATH, { force: true });
  });

  test("tanpa API key -> 401 (kena gerbang requireApiKey kayak endpoint lain)", async () => {
    const res = await fetch(`${baseUrl}/api/canvas/jsoncard?name=Kyynzh`);
    assert.equal(res.status, 401);
  });

  test("GET dengan key + field -> 200 image/png, body PNG beneran", async () => {
    const res = await fetch(
      `${baseUrl}/api/canvas/jsoncard?name=Kyynzh&title=Dev&apikey=key-canvas-test`
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(isPng(buf));
    assert.equal(Number(res.headers.get("content-length")), buf.length);
  });

  test("GET tanpa field sama sekali -> 400 + contoh pemakaian", async () => {
    const res = await fetch(`${baseUrl}/api/canvas/jsoncard?apikey=key-canvas-test`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.status, false);
    assert.match(body.error, /field/i);
  });

  test("filename & apikey gak ikut jadi field kartu (RESERVED)", async () => {
    // filename doang tanpa field lain = sama kayak kosong -> 400.
    const res = await fetch(
      `${baseUrl}/api/canvas/jsoncard?filename=profile.json&apikey=key-canvas-test`
    );
    assert.equal(res.status, 400);
  });

  test("POST gaya { fields: {...} } -> 200 PNG", async () => {
    const res = await fetch(`${baseUrl}/api/canvas/jsoncard`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "key-canvas-test" },
      body: JSON.stringify({ filename: "me.json", fields: { name: "Kyynzh", role: "Backend" } })
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.ok(isPng(Buffer.from(await res.arrayBuffer())));
  });

  test("POST flat (tanpa wrapper fields) -> tetap jalan", async () => {
    const res = await fetch(`${baseUrl}/api/canvas/jsoncard`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "key-canvas-test" },
      body: JSON.stringify({ name: "Kyynzh" })
    });
    assert.equal(res.status, 200);
  });

  test("query array (?name=a&name=b) -> gak error, ambil nilai pertama", async () => {
    const res = await fetch(
      `${baseUrl}/api/canvas/jsoncard?name=a&name=b&apikey=key-canvas-test`
    );
    assert.equal(res.status, 200);
  });

  test("GET /api/canvas/welcome dengan name -> 200 PNG; tanpa name -> 400", async () => {
    const ok2 = await fetch(`${baseUrl}/api/canvas/welcome?name=Kyynzh&apikey=key-canvas-test`);
    assert.equal(ok2.status, 200);
    assert.equal(ok2.headers.get("content-type"), "image/png");
    assert.ok(isPng(Buffer.from(await ok2.arrayBuffer())));

    const bad = await fetch(`${baseUrl}/api/canvas/welcome?apikey=key-canvas-test`);
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /name/);
  });
});

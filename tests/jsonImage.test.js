// Test ?format=image — render response JSON endpoint apa pun jadi PNG
// ala code editor. Unit service + integration lewat HTTP asli (pola
// jsoncard.test.js / requireApiKey.integration.test.js).
import "./helpers/forceEmptyOauthEnv.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { renderJsonImage, MAX_LINES } from "../src/services/jsonimage.service.js";
import { CLIENTS_PATH } from "../src/utils/clients.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (buf) => Buffer.isBuffer(buf) && buf.subarray(0, 8).equals(PNG_MAGIC);

/* ------------------------------------------------------------------ */
/* 1. Unit: renderJsonImage                                            */
/* ------------------------------------------------------------------ */
describe("renderJsonImage (unit)", () => {
  test("object nested + array (bentuk respons API beneran) -> PNG valid", async () => {
    const buf = await renderJsonImage({
      status: true,
      result: [{ title: "Naruto", views: 123, hd: false, extra: null }]
    });
    assert.ok(isPng(buf));
  });

  test("nilai primitif & aneh-aneh -> gak nge-throw", async () => {
    for (const val of [[], {}, "string doang", 42, true, null]) {
      assert.ok(isPng(await renderJsonImage(val)), `gagal buat: ${JSON.stringify(val)}`);
    }
  });

  test(`respons raksasa -> baris dipotong ke ${MAX_LINES}, gak jadi gambar tak terhingga`, async () => {
    const besar = { result: Array.from({ length: 500 }, (_, i) => ({ i, name: `item-${i}` })) };
    const buf = await renderJsonImage(besar);
    assert.ok(isPng(buf));
    // Tinggi PNG dibaca langsung dari header IHDR (byte 20-23, big-endian) —
    // respons 500 vs 1000 item harus SAMA tingginya (dua-duanya mentok cap;
    // bandingin byte length gak bisa: teks "… N baris lagi"-nya beda angka).
    const heightOf = (b) => b.readUInt32BE(20);
    const lebihBesar = { result: Array.from({ length: 1000 }, (_, i) => ({ i, name: `item-${i}` })) };
    assert.equal(heightOf(buf), heightOf(await renderJsonImage(lebihBesar)));
  });

  test("string ber-kutip/escape di value -> tetap kerender", async () => {
    const buf = await renderJsonImage({ pesan: 'dia bilang "hai" \\ selesai' });
    assert.ok(isPng(buf));
  });
});

/* ------------------------------------------------------------------ */
/* 2. Integration: ?format=image lewat HTTP asli                       */
/* ------------------------------------------------------------------ */
const ORIGINAL_EXISTED = fs.existsSync(CLIENTS_PATH);
const ORIGINAL_CONTENT = ORIGINAL_EXISTED ? fs.readFileSync(CLIENTS_PATH, "utf8") : null;

describe("?format=image (integration, HTTP asli)", () => {
  let server;
  let baseUrl;
  let tmpSessionDir;

  before(async () => {
    tmpSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "febry-api-jsonimage-test-"));
    process.env.SESSION_STORE_PATH = path.join(tmpSessionDir, "sessions.sqlite");
    fs.writeFileSync(
      CLIENTS_PATH,
      JSON.stringify({ "key-img-test": { name: "Img Test", tier: "free" } }, null, 2),
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

  // /api/me dipakai sebagai endpoint sampel: publik (gak nge-scrape situs
  // luar kayak youtube/anime), respons JSON-nya deterministik.
  test("/api/me?format=image -> 200 image/png, body PNG beneran", async () => {
    const res = await fetch(`${baseUrl}/api/me?format=image&apikey=key-img-test`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.ok(isPng(Buffer.from(await res.arrayBuffer())));
  });

  test("tanpa format (atau format=json) -> tetap JSON biasa, gak berubah", async () => {
    const plain = await fetch(`${baseUrl}/api/me?apikey=key-img-test`);
    assert.match(plain.headers.get("content-type"), /application\/json/);
    const eksplisit = await fetch(`${baseUrl}/api/me?format=json&apikey=key-img-test`);
    assert.match(eksplisit.headers.get("content-type"), /application\/json/);
    assert.equal((await eksplisit.json()).status, true);
  });

  test("error SEBELUM route (401 tanpa key) -> tetap JSON walau format=image", async () => {
    const res = await fetch(`${baseUrl}/api/youtube/search?query=naruto&format=image`);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("content-type"), /application\/json/);
  });

  test("endpoint yang emang balikin PNG (canvas) + format=image -> gak dobel-render", async () => {
    const res = await fetch(
      `${baseUrl}/api/canvas/welcome?name=Kyynzh&format=image&apikey=key-img-test`
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.ok(isPng(Buffer.from(await res.arrayBuffer())));
  });
});

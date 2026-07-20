import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { identifyClient, CLIENTS_PATH } from "../src/middleware/identifyClient.js";

/* ------------------------------------------------------------------ */
/* Setup: timpa clients.json sementara dengan data fixture buat test,  */
/* balikin ke kondisi semula setelah semua test selesai (termasuk      */
/* kondisi "belum ada file" — clients.json baru dibuat pas admin       */
/* pertama kali jalanin `npm run create-key`).                          */
/* ------------------------------------------------------------------ */

const ORIGINAL_EXISTED = fs.existsSync(CLIENTS_PATH);
const ORIGINAL_CLIENTS_CONTENT = ORIGINAL_EXISTED ? fs.readFileSync(CLIENTS_PATH, "utf8") : null;

const FIXTURE = {
  "key-free-123": { name: "Klien Free", tier: "free" },
  "key-premium-456": { name: "Klien Premium", tier: "premium" },
  "key-admin-789": { name: "Klien Admin", tier: "admin" },
  "key-invalid-tier": { name: "Rusak", tier: "bukan-tier-valid" },
};

before(() => {
  fs.writeFileSync(CLIENTS_PATH, JSON.stringify(FIXTURE, null, 2), "utf8");
});

after(() => {
  if (ORIGINAL_EXISTED) fs.writeFileSync(CLIENTS_PATH, ORIGINAL_CLIENTS_CONTENT, "utf8");
  else fs.rmSync(CLIENTS_PATH, { force: true });
});

function fakeReq({ apiKey, query } = {}) {
  return {
    ip: "1.2.3.4",
    query: query || {},
    get(header) {
      if (header.toLowerCase() === "x-api-key" && apiKey) return apiKey;
      return undefined;
    },
  };
}

function runMiddleware(req) {
  let called = false;
  identifyClient(req, {}, () => {
    called = true;
  });
  assert.equal(called, true, "next() harus dipanggil");
  return req;
}

describe("identifyClient", () => {
  test("key premium yang valid -> tier premium", () => {
    const req = runMiddleware(fakeReq({ apiKey: "key-premium-456" }));
    assert.equal(req.client.tier, "premium");
    assert.equal(req.client.apiKey, "key-premium-456");
    assert.equal(req.client.id, "Klien Premium");
  });

  test("key admin yang valid -> tier admin", () => {
    const req = runMiddleware(fakeReq({ apiKey: "key-admin-789" }));
    assert.equal(req.client.tier, "admin");
  });

  test("key free yang valid -> tier free, apiKey tetap tercatat", () => {
    const req = runMiddleware(fakeReq({ apiKey: "key-free-123" }));
    assert.equal(req.client.tier, "free");
    assert.equal(req.client.apiKey, "key-free-123");
  });

  test("gak ada header x-api-key -> fallback tier free, apiKey null", () => {
    const req = runMiddleware(fakeReq({}));
    assert.equal(req.client.tier, "free");
    assert.equal(req.client.apiKey, null);
  });

  test("key gak dikenal -> fallback tier free, apiKey null (bukan key aslinya)", () => {
    const req = runMiddleware(fakeReq({ apiKey: "key-ngasal-gak-ada" }));
    assert.equal(req.client.tier, "free");
    assert.equal(req.client.apiKey, null);
  });

  test("tier di clients.json gak valid -> fallback tier free (fail-safe, bukan crash)", () => {
    const req = runMiddleware(fakeReq({ apiKey: "key-invalid-tier" }));
    assert.equal(req.client.tier, "free");
  });

  test("key valid lewat query ?apikey= -> tier sesuai (tanpa header)", () => {
    const req = runMiddleware(fakeReq({ query: { apikey: "key-premium-456" } }));
    assert.equal(req.client.tier, "premium");
    assert.equal(req.client.apiKey, "key-premium-456");
  });

  test("header x-api-key menang atas query ?apikey=", () => {
    const req = runMiddleware(fakeReq({ apiKey: "key-admin-789", query: { apikey: "key-free-123" } }));
    assert.equal(req.client.tier, "admin");
    assert.equal(req.client.apiKey, "key-admin-789");
  });

  test("?apikey=a&apikey=b (array) -> diabaikan, fallback free (bukan crash)", () => {
    const req = runMiddleware(fakeReq({ query: { apikey: ["key-premium-456", "key-free-123"] } }));
    assert.equal(req.client.tier, "free");
    assert.equal(req.client.apiKey, null);
  });
});

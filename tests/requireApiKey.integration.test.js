// Integration test: boot src/app.js beneran (pola auth.routes.test.js)
// buat mastiin gerbang "wajib API key" jalan end-to-end lewat HTTP asli —
// urutan middleware, mount path, query parsing, sampai response cache.
import "./helpers/forceEmptyOauthEnv.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { CLIENTS_PATH } from "../src/utils/clients.js";

const ORIGINAL_EXISTED = fs.existsSync(CLIENTS_PATH);
const ORIGINAL_CONTENT = ORIGINAL_EXISTED ? fs.readFileSync(CLIENTS_PATH, "utf8") : null;

const FIXTURE = {
  "key-e2e-free": { name: "E2E Free", tier: "free" },
  "key-e2e-premium": { name: "E2E Premium", tier: "premium" }
};

describe("wajib API key (integration, HTTP asli)", () => {
  let server;
  let baseUrl;
  let tmpSessionDir;

  before(async () => {
    tmpSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "febry-api-key-test-"));
    process.env.SESSION_STORE_PATH = path.join(tmpSessionDir, "sessions.sqlite");
    fs.writeFileSync(CLIENTS_PATH, JSON.stringify(FIXTURE, null, 2), "utf8");

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

  test("endpoint data tanpa key -> 401 + pesan arahan", async () => {
    const res = await fetch(`${baseUrl}/api/youtube/search?query=naruto`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.status, false);
    assert.match(body.error, /x-api-key/);
  });

  test("path publik tanpa key -> tetap 200: /api, /api/me, /api/endpoints", async () => {
    for (const p of ["/api", "/api/me", "/api/endpoints"]) {
      const res = await fetch(`${baseUrl}${p}`);
      assert.equal(res.status, 200, `${p} harus 200 tanpa key`);
    }
  });

  test("/api/me tanpa key -> identifiedBy anonim; dengan key -> apiKey + tier", async () => {
    const anon = await (await fetch(`${baseUrl}/api/me`)).json();
    assert.equal(anon.result.identifiedBy, "anonim");

    const keyed = await (await fetch(`${baseUrl}/api/me`, { headers: { "x-api-key": "key-e2e-premium" } })).json();
    assert.equal(keyed.result.identifiedBy, "apiKey");
    assert.equal(keyed.result.tier, "premium");
  });

  test("key lewat query ?apikey= -> lolos gerbang (endpoint kebuka, bukan 401)", async () => {
    // Endpoint youtube beneran nge-scrape — yang penting BUKAN 401:
    // gerbang requireApiKey udah lolos, hasil scraping bukan urusan test ini.
    const res = await fetch(`${baseUrl}/api/youtube/search?query=naruto&apikey=key-e2e-free`);
    assert.notEqual(res.status, 401);
  });

  test("key gak dikenal via query -> tetap 401", async () => {
    const res = await fetch(`${baseUrl}/api/youtube/search?query=naruto&apikey=key-ngasal`);
    assert.equal(res.status, 401);
  });

  test("key lewat header di endpoint data -> bukan 401", async () => {
    const res = await fetch(`${baseUrl}/api/anime/search?query=naruto`, {
      headers: { "x-api-key": "key-e2e-free" }
    });
    assert.notEqual(res.status, 401);
  });

  test("/api/admin/* gak diganggu requireApiKey (adminAuth yang jawab: 503/401, bukan pesan apikey)", async () => {
    const res = await fetch(`${baseUrl}/api/admin/endpoints`);
    // Tanpa ADMIN_API_KEY di env test -> adminAuth balas 503 "panel dimatikan";
    // dengan env -> 401 admin key salah. Dua-duanya BUKAN 401 requireApiKey.
    assert.ok([401, 503].includes(res.status));
    const body = await res.json();
    assert.ok(!/x-api-key.*apikey/.test(body.error || ""), "harus pesan adminAuth, bukan requireApiKey");
  });

  test("/auth/me tanpa login -> apiKey null (regresi provisioning anonim)", async () => {
    const body = await (await fetch(`${baseUrl}/auth/me`)).json();
    assert.equal(body.apiKey, null);
  });
});

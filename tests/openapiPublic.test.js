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

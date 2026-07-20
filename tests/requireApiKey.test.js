import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { requireApiKey } from "../src/middleware/requireApiKey.js";

/* ------------------------------------------------------------------ */
/* Unit murni (pola tierRateLimit.test.js): middleware di-mount di     */
/* app.use("/api", ...) jadi req.path di sini RELATIF terhadap /api.   */
/* ------------------------------------------------------------------ */

function run({ path, apiKey } = {}) {
  const req = { path, client: { apiKey: apiKey || null } };
  let nextCalled = false;
  let statusCode = null;
  let jsonBody = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      jsonBody = body;
      return this;
    },
  };
  requireApiKey(req, res, () => {
    nextCalled = true;
  });
  return { nextCalled, statusCode, jsonBody };
}

describe("requireApiKey", () => {
  test("path publik /, /me, /endpoints -> lolos tanpa key", () => {
    for (const p of ["/", "/me", "/endpoints"]) {
      const r = run({ path: p });
      assert.equal(r.nextCalled, true, `${p} harus lolos`);
      assert.equal(r.statusCode, null);
    }
  });

  test("/admin dan /admin/* -> lolos (proteksinya adminAuth sendiri)", () => {
    assert.equal(run({ path: "/admin" }).nextCalled, true);
    assert.equal(run({ path: "/admin/endpoints" }).nextCalled, true);
  });

  test("endpoint data tanpa key -> 401 JSON dengan arahan cara dapat key", () => {
    const r = run({ path: "/youtube/search" });
    assert.equal(r.nextCalled, false);
    assert.equal(r.statusCode, 401);
    assert.equal(r.jsonBody.status, false);
    assert.match(r.jsonBody.error, /x-api-key/);
    assert.match(r.jsonBody.error, /apikey/);
  });

  test("endpoint data dengan key valid (req.client.apiKey terisi) -> next()", () => {
    const r = run({ path: "/youtube/search", apiKey: "key-apapun" });
    assert.equal(r.nextCalled, true);
    assert.equal(r.statusCode, null);
  });

  test("path /me/sub (bukan persis /me) -> tetap wajib key", () => {
    const r = run({ path: "/me/sub" });
    assert.equal(r.statusCode, 401);
  });

  test("req.client belum di-set sama sekali -> 401 (bukan crash)", () => {
    const req = { path: "/anime/search" };
    let status = null;
    const res = {
      status(c) {
        status = c;
        return this;
      },
      json() {
        return this;
      },
    };
    requireApiKey(req, res, () => {});
    assert.equal(status, 401);
  });
});

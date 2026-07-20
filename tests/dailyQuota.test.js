// Test middleware dailyQuota: header X-Daily-Quota-* di semua response
// ber-kuota + Retry-After (detik sampai 00:00 UTC) pas 429.
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { dailyQuota, secondsUntilUtcMidnight } from "../src/middleware/dailyQuota.js";
import { USAGE_PATH, recordHit, _resetUsageCache } from "../src/utils/usage.js";

const USAGE_EXISTED = fs.existsSync(USAGE_PATH);
const USAGE_CONTENT = USAGE_EXISTED ? fs.readFileSync(USAGE_PATH, "utf8") : null;

after(() => {
  if (USAGE_EXISTED) fs.writeFileSync(USAGE_PATH, USAGE_CONTENT, "utf8");
  else fs.rmSync(USAGE_PATH, { force: true });
  _resetUsageCache();
});

/** res palsu minimal: nangkep header, status, dan body json. */
function fakeRes() {
  const headers = {};
  return {
    headers,
    statusCode: 200,
    body: null,
    set(name, value) {
      headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe("secondsUntilUtcMidnight", () => {
  test("jam 23:59:30 UTC -> 30 detik", () => {
    assert.equal(secondsUntilUtcMidnight(new Date("2026-07-20T23:59:30.000Z")), 30);
  });

  test("tepat 00:00 UTC -> 86400 (sampai midnight BERIKUTNYA, bukan 0)", () => {
    assert.equal(secondsUntilUtcMidnight(new Date("2026-07-20T00:00:00.000Z")), 86400);
  });
});

describe("dailyQuota (header X-Daily-Quota-* + Retry-After)", () => {
  beforeEach(() => {
    _resetUsageCache();
    fs.rmSync(USAGE_PATH, { force: true });
  });

  test("client tanpa dailyQuota -> lolos tanpa header kuota", () => {
    const res = fakeRes();
    let called = false;
    dailyQuota({ client: { apiKey: "k-bebas", tier: "free" } }, res, () => {
      called = true;
    });
    assert.ok(called, "next() harus kepanggil");
    assert.equal(res.headers["X-Daily-Quota-Limit"], undefined);
  });

  test("di bawah kuota -> lolos, header Limit & Remaining kekirim", () => {
    recordHit({ clientKey: "k-quota", tier: "free", path: "/api/a", status: 200 });
    recordHit({ clientKey: "k-quota", tier: "free", path: "/api/a", status: 200 });
    const res = fakeRes();
    let called = false;
    dailyQuota({ client: { apiKey: "k-quota", dailyQuota: 10 } }, res, () => {
      called = true;
    });
    assert.ok(called);
    assert.equal(res.headers["X-Daily-Quota-Limit"], "10");
    assert.equal(res.headers["X-Daily-Quota-Remaining"], "8");
    assert.equal(res.headers["Retry-After"], undefined, "belum 429, gak boleh ada Retry-After");
  });

  test("kuota habis -> 429 + Retry-After detik valid (<= 86400)", () => {
    for (let i = 0; i < 3; i++) {
      recordHit({ clientKey: "k-habis", tier: "free", path: "/api/a", status: 200 });
    }
    const res = fakeRes();
    let called = false;
    dailyQuota({ client: { apiKey: "k-habis", dailyQuota: 3 } }, res, () => {
      called = true;
    });
    assert.equal(called, false, "next() gak boleh kepanggil pas kuota habis");
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers["X-Daily-Quota-Remaining"], "0");
    const retry = Number(res.headers["Retry-After"]);
    assert.ok(retry >= 1 && retry <= 86400, `Retry-After ${retry} harus 1..86400`);
    assert.equal(res.body.status, false);
    assert.deepEqual(res.body.quota, { daily: 3, used: 3 });
  });
});

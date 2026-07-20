// CATATAN: file ini import "express-rate-limit" (lewat tierRateLimit.js)
// dan "dotenv" (lewat config/index.js) — jalanin `npm install` dulu baru
// `npm test`, kalau belum ke-install bakal MODULE_NOT_FOUND pas load file
// ini (bukan test-nya yang gagal, dependency-nya yang belum ada).
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { keyForRequest, maxForRequest, shouldSkip, TIER_MAX } from "../src/middleware/tierRateLimit.js";

describe("tierRateLimit", () => {
  test("keyForRequest pakai apiKey kalau ada", () => {
    const req = { client: { apiKey: "abc", tier: "premium" }, ip: "9.9.9.9" };
    assert.equal(keyForRequest(req), "abc");
  });

  test("keyForRequest fallback ke IP kalau apiKey gak ada", () => {
    const req = { client: { apiKey: null, tier: "free" }, ip: "9.9.9.9" };
    assert.equal(keyForRequest(req), "9.9.9.9");
  });

  test("maxForRequest sesuai tier free/premium", () => {
    assert.equal(maxForRequest({ client: { tier: "free" } }), TIER_MAX.free);
    assert.equal(maxForRequest({ client: { tier: "premium" } }), TIER_MAX.premium);
  });

  test("maxForRequest fallback ke free kalau tier gak dikenal/kosong", () => {
    assert.equal(maxForRequest({ client: {} }), TIER_MAX.free);
    assert.equal(maxForRequest({}), TIER_MAX.free);
  });

  test("shouldSkip true hanya buat tier admin (unlimited)", () => {
    assert.equal(shouldSkip({ client: { tier: "admin" } }), true);
    assert.equal(shouldSkip({ client: { tier: "premium" } }), false);
    assert.equal(shouldSkip({ client: { tier: "free" } }), false);
    assert.equal(shouldSkip({}), false);
  });

  test("TIER_MAX.premium lebih gede dari TIER_MAX.free (sanity default)", () => {
    assert.ok(TIER_MAX.premium > TIER_MAX.free);
  });
});

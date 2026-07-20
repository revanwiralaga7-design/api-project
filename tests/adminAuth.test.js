import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { adminAuth, _resetAdminAuthLockout } from "../src/middleware/adminAuth.js";
import { config } from "../src/config/index.js";

/* ------------------------------------------------------------------ */
/* adminAuth — key valid/salah + lockout brute-force per IP            */
/* config.adminApiKeys dimutasi langsung per test (dibalikin di        */
/* beforeEach) — gak nyentuh .env asli.                                */
/* ------------------------------------------------------------------ */

const ORIGINAL_KEYS = config.adminApiKeys;
const TEST_KEY = "kunci-test-lockout";

function fakeReq({ key, ip = "10.0.0.1" } = {}) {
  return {
    ip,
    get(header) {
      if (header.toLowerCase() === "x-admin-key" && key) return key;
      return undefined;
    },
  };
}

function run(req) {
  let error = null;
  adminAuth(req, {}, (e) => {
    error = e || null;
  });
  return error;
}

describe("adminAuth lockout", () => {
  beforeEach(() => {
    config.adminApiKeys = [TEST_KEY];
    _resetAdminAuthLockout();
  });

  test("key benar -> lolos", () => {
    assert.equal(run(fakeReq({ key: TEST_KEY })), null);
  });

  test("key salah -> 401", () => {
    const err = run(fakeReq({ key: "salah" }));
    assert.equal(err.statusCode, 401);
  });

  test("tanpa key sama sekali -> 401", () => {
    const err = run(fakeReq({}));
    assert.equal(err.statusCode, 401);
  });

  test("ADMIN_API_KEY belum di-set -> 503 (panel mati, bukan terbuka)", () => {
    config.adminApiKeys = [];
    const err = run(fakeReq({ key: TEST_KEY }));
    assert.equal(err.statusCode, 503);
  });

  test("5 kegagalan beruntun -> percobaan ke-6 diblokir 429, WALAU key-nya benar", () => {
    for (let i = 0; i < 5; i++) {
      assert.equal(run(fakeReq({ key: "salah" })).statusCode, 401);
    }
    // Udah kekunci — bahkan key benar pun ketolak selama masa blokir
    // (inilah yang bikin brute-force gak bisa "menang" di percobaan pas).
    const err = run(fakeReq({ key: TEST_KEY }));
    assert.equal(err.statusCode, 429);
    assert.match(err.message, /Terlalu banyak percobaan/);
  });

  test("lockout per IP — IP lain gak ikut keblokir", () => {
    for (let i = 0; i < 5; i++) run(fakeReq({ key: "salah", ip: "10.0.0.1" }));
    assert.equal(run(fakeReq({ key: TEST_KEY, ip: "10.0.0.1" })).statusCode, 429);
    assert.equal(run(fakeReq({ key: TEST_KEY, ip: "10.0.0.2" })), null);
  });

  test("login sukses menghapus catatan kegagalan sebelumnya", () => {
    for (let i = 0; i < 4; i++) run(fakeReq({ key: "salah" })); // 4 < ambang 5
    assert.equal(run(fakeReq({ key: TEST_KEY })), null); // sukses -> reset
    // Mulai dari nol lagi: 4 gagal berikutnya belum bikin kekunci
    for (let i = 0; i < 4; i++) run(fakeReq({ key: "salah" }));
    assert.equal(run(fakeReq({ key: TEST_KEY })), null);
  });
});

// Balikin config asli setelah file test ini selesai (node:test jalanin
// file serial, tapi jaga-jaga kalau ada file lain baca config yang sama).
test("cleanup", () => {
  config.adminApiKeys = ORIGINAL_KEYS;
  _resetAdminAuthLockout();
});

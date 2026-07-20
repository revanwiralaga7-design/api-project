// Test fitur self-service & dashboard usage:
// - regenerateClientKey (rotate key sendiri dari docs)
// - dailySeries (deret harian buat grafik batang panel admin)
// - topPathsForKey (endpoint terpopuler milik satu key, buat kartu docs)
// - multi-key per akun OAuth (listKeysForUser/createAdditionalKey/deleteOwnKey)
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  CLIENTS_PATH,
  loadClients,
  regenerateClientKey,
  findClientByProvider,
  listKeysForUser,
  createAdditionalKey,
  deleteOwnKey,
  MAX_KEYS_PER_USER,
} from "../src/utils/clients.js";
import { USAGE_PATH, recordHit, dailySeries, topPathsForKey, _resetUsageCache } from "../src/utils/usage.js";

/* ------------------------------------------------------------------ */
/* Fixture: timpa clients.json & usage.json sementara (pola             */
/* ensureClientForUser.test.js), balikin persis setelah selesai.        */
/* ------------------------------------------------------------------ */

const CLIENTS_EXISTED = fs.existsSync(CLIENTS_PATH);
const CLIENTS_CONTENT = CLIENTS_EXISTED ? fs.readFileSync(CLIENTS_PATH, "utf8") : null;
const USAGE_EXISTED = fs.existsSync(USAGE_PATH);
const USAGE_CONTENT = USAGE_EXISTED ? fs.readFileSync(USAGE_PATH, "utf8") : null;

before(() => {
  fs.writeFileSync(
    CLIENTS_PATH,
    JSON.stringify(
      {
        "key-oauth-lama": {
          name: "Budi",
          tier: "premium",
          provider: "google",
          providerId: "111",
          dailyQuota: 500,
        },
      },
      null,
      2
    ),
    "utf8"
  );
});

after(() => {
  if (CLIENTS_EXISTED) fs.writeFileSync(CLIENTS_PATH, CLIENTS_CONTENT, "utf8");
  else fs.rmSync(CLIENTS_PATH, { force: true });
  if (USAGE_EXISTED) fs.writeFileSync(USAGE_PATH, USAGE_CONTENT, "utf8");
  else fs.rmSync(USAGE_PATH, { force: true });
  _resetUsageCache();
});

describe("regenerateClientKey (self-service rotate key)", () => {
  test("key baru dibuat, entry pindah utuh, key lama mati", () => {
    const rotated = regenerateClientKey("key-oauth-lama");
    assert.ok(rotated.apiKey && rotated.apiKey.length === 48, "key baru 48 hex char");
    assert.notEqual(rotated.apiKey, "key-oauth-lama");
    // entry pindah utuh: nama, tier, provider, kuota ikut semua
    assert.equal(rotated.name, "Budi");
    assert.equal(rotated.tier, "premium");
    assert.equal(rotated.provider, "google");
    assert.equal(rotated.dailyQuota, 500);
    const clients = loadClients();
    assert.equal(clients["key-oauth-lama"], undefined, "key lama harus hilang");
    assert.ok(clients[rotated.apiKey], "key baru harus ada di clients.json");
  });

  test("key yang gak dikenal -> null, clients.json gak berubah", () => {
    const sizeBefore = Object.keys(loadClients()).length;
    assert.equal(regenerateClientKey("key-gak-ada"), null);
    assert.equal(Object.keys(loadClients()).length, sizeBefore);
  });
});

describe("dailySeries (deret harian buat grafik usage)", () => {
  beforeEach(() => {
    _resetUsageCache();
    fs.rmSync(USAGE_PATH, { force: true });
  });

  test("balikin SEMUA hari di rentang urut, hari kosong diisi 0", () => {
    const s = dailySeries(7);
    assert.equal(s.length, 7, "7 hari persis, termasuk yang kosong");
    for (const d of s) {
      assert.match(d.day, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(d.total, 0);
      assert.equal(d.limited, 0);
    }
    // urut naik, hari terakhir = hari ini (UTC)
    assert.ok(s[0].day < s[6].day);
    assert.equal(s[6].day, new Date().toISOString().slice(0, 10));
  });

  test("hit hari ini keakumulasi lintas client di elemen terakhir", () => {
    recordHit({ clientKey: "k1", tier: "free", path: "/api/a", status: 200 });
    recordHit({ clientKey: "k1", tier: "free", path: "/api/a", status: 429 });
    recordHit({ clientKey: "k2", tier: "premium", path: "/api/b", status: 200 });
    const today = dailySeries(7).at(-1);
    assert.equal(today.total, 3);
    assert.equal(today.limited, 1);
  });
});

describe("topPathsForKey (endpoint terpopuler satu key, kartu docs)", () => {
  beforeEach(() => {
    _resetUsageCache();
    fs.rmSync(USAGE_PATH, { force: true });
  });

  test("cuma ngitung path milik key itu, urut hits desc, kena limit", () => {
    recordHit({ clientKey: "k-a", tier: "free", path: "/api/x", status: 200 });
    recordHit({ clientKey: "k-a", tier: "free", path: "/api/x", status: 200 });
    recordHit({ clientKey: "k-a", tier: "free", path: "/api/y", status: 200 });
    recordHit({ clientKey: "k-lain", tier: "free", path: "/api/z", status: 200 });
    const top = topPathsForKey("k-a", 7);
    assert.deepEqual(top, [
      { path: "/api/x", hits: 2 },
      { path: "/api/y", hits: 1 },
    ]);
    // limit kepotong
    assert.equal(topPathsForKey("k-a", 7, 1).length, 1);
  });

  test("key tanpa riwayat / key kosong -> array kosong", () => {
    assert.deepEqual(topPathsForKey("k-gak-ada", 7), []);
    assert.deepEqual(topPathsForKey("", 7), []);
    assert.deepEqual(topPathsForKey(null, 7), []);
  });
});

describe("multi-key per akun OAuth (label per key)", () => {
  const USER = { provider: "google", id: "111" };

  beforeEach(() => {
    // reset clients.json ke kondisi awal: satu key primary punya Budi
    fs.writeFileSync(
      CLIENTS_PATH,
      JSON.stringify(
        {
          "key-oauth-lama": {
            name: "Budi",
            tier: "premium",
            provider: "google",
            providerId: "111",
            dailyQuota: 500,
          },
        },
        null,
        2
      ),
      "utf8"
    );
  });

  test("createAdditionalKey: key baru berlabel, tier & kuota ngikut primary", () => {
    const created = createAdditionalKey(USER, "bot-discord");
    assert.equal(created.apiKey.length, 48);
    assert.equal(created.label, "bot-discord");
    assert.equal(created.tier, "premium");
    assert.equal(created.dailyQuota, 500);
    assert.equal(created.name, "Budi · bot-discord");
    assert.equal(listKeysForUser("google", "111").length, 2);
  });

  test("label dobel / label kosong / akun tanpa key primary -> throw", () => {
    createAdditionalKey(USER, "bot-discord");
    assert.throws(() => createAdditionalKey(USER, "bot-discord"), /sudah dipakai/);
    assert.throws(() => createAdditionalKey(USER, "  "), /wajib diisi/);
    assert.throws(() => createAdditionalKey({ provider: "github", id: "999" }, "x"), /belum punya/);
  });

  test("batas MAX_KEYS_PER_USER ditegakkan", () => {
    for (let i = 1; i < MAX_KEYS_PER_USER; i++) createAdditionalKey(USER, `bot-${i}`);
    assert.throws(() => createAdditionalKey(USER, "kelebihan"), /Maksimal/);
  });

  test("findClientByProvider balikin primary (tanpa label), bukan key tambahan", () => {
    createAdditionalKey(USER, "bot-discord");
    // rotate primary — entry-nya pindah ke akhir objek; primary harus tetap
    // ketemu dari ketiadaan label, bukan dari urutan.
    const rotated = regenerateClientKey(findClientByProvider("google", "111").apiKey);
    const found = findClientByProvider("google", "111");
    assert.equal(found.apiKey, rotated.apiKey);
    assert.equal(found.label, undefined);
  });

  test("deleteOwnKey: hapus key sendiri oke, key orang lain / key terakhir ditolak", () => {
    const created = createAdditionalKey(USER, "bot-discord");
    // orang lain (provider beda) gak bisa hapus walau tahu key-nya
    assert.throws(() => deleteOwnKey({ provider: "github", id: "111" }, created.apiKey), /tidak ditemukan/);
    deleteOwnKey(USER, created.apiKey);
    assert.equal(loadClients()[created.apiKey], undefined);
    // sekarang tinggal 1 key -> gak boleh dihapus
    assert.throws(() => deleteOwnKey(USER, "key-oauth-lama"), /terakhir/);
  });
});

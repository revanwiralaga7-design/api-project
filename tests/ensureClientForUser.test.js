import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { CLIENTS_PATH, loadClients, ensureClientForUser, findClientByProvider, promoteClientToAdmin } from "../src/utils/clients.js";

/* ------------------------------------------------------------------ */
/* Fixture: timpa clients.json sementara (pola identifyClient.test.js), */
/* balikin persis ke kondisi semula setelah selesai.                    */
/* ------------------------------------------------------------------ */

const ORIGINAL_EXISTED = fs.existsSync(CLIENTS_PATH);
const ORIGINAL_CONTENT = ORIGINAL_EXISTED ? fs.readFileSync(CLIENTS_PATH, "utf8") : null;

before(() => {
  fs.writeFileSync(
    CLIENTS_PATH,
    JSON.stringify({ "key-manual-lama": { name: "Manual", tier: "premium" } }, null, 2),
    "utf8"
  );
});

after(() => {
  if (ORIGINAL_EXISTED) fs.writeFileSync(CLIENTS_PATH, ORIGINAL_CONTENT, "utf8");
  else fs.rmSync(CLIENTS_PATH, { force: true });
});

const GOOGLE_USER = { provider: "google", id: "111222333", name: "Budi", email: "budi@gmail.com" };

describe("ensureClientForUser (auto-provision key per akun OAuth)", () => {
  test("login pertama -> key free baru dibuat dengan provider/providerId/email", () => {
    const c = ensureClientForUser(GOOGLE_USER);
    assert.ok(c.apiKey && c.apiKey.length === 48, "key 48 hex char");
    assert.equal(c.tier, "free");
    assert.equal(c.provider, "google");
    assert.equal(c.providerId, "111222333");
    assert.equal(c.email, "budi@gmail.com");
    assert.equal(c.name, "Budi");
  });

  test("idempotent: dipanggil lagi user sama -> key sama, entry gak nambah", () => {
    const before1 = Object.keys(loadClients()).length;
    const c1 = ensureClientForUser(GOOGLE_USER);
    const c2 = ensureClientForUser(GOOGLE_USER);
    assert.equal(c1.apiKey, c2.apiKey);
    assert.equal(Object.keys(loadClients()).length, before1);
  });

  test("providerId number (GitHub) vs string -> tetap dianggap akun sama", () => {
    const asNumber = ensureClientForUser({ provider: "github", id: 999, name: "Sari" });
    const asString = ensureClientForUser({ provider: "github", id: "999", name: "Sari" });
    assert.equal(asNumber.apiKey, asString.apiKey);
  });

  test("provider beda dengan id sama -> key BEDA (bukan tabrakan)", () => {
    const g = ensureClientForUser({ provider: "google", id: "777", name: "A" });
    const h = ensureClientForUser({ provider: "github", id: "777", name: "A" });
    assert.notEqual(g.apiKey, h.apiKey);
  });

  test("user tanpa provider/id -> null, gak nulis apa-apa", () => {
    const count = Object.keys(loadClients()).length;
    assert.equal(ensureClientForUser(null), null);
    assert.equal(ensureClientForUser({}), null);
    assert.equal(ensureClientForUser({ provider: "google" }), null);
    assert.equal(Object.keys(loadClients()).length, count);
  });

  test("user tanpa name -> fallback email lalu provider:id", () => {
    const c = ensureClientForUser({ provider: "google", id: "555", email: "x@y.z" });
    assert.equal(c.name, "x@y.z");
    const c2 = ensureClientForUser({ provider: "github", id: "556" });
    assert.equal(c2.name, "github:556");
  });
});

describe("findClientByProvider", () => {
  test("key manual lama (tanpa provider) gak pernah ke-match", () => {
    assert.equal(findClientByProvider(undefined, undefined), null);
    assert.equal(findClientByProvider(null, "apapun"), null);
  });

  test("nemu entry yang udah di-provision", () => {
    const c = findClientByProvider("google", "111222333");
    assert.ok(c);
    assert.equal(c.email, "budi@gmail.com");
  });
});

describe("promoteClientToAdmin (sinkronin key OAuth dengan session admin)", () => {
  test("key free -> jadi admin, persist di clients.json", () => {
    const c = ensureClientForUser({ provider: "google", id: "promo-1", name: "Admin Ganteng" });
    assert.equal(c.tier, "free");
    const promoted = promoteClientToAdmin(c.apiKey);
    assert.equal(promoted.tier, "admin");
    // Bukan cuma nilai balik — file-nya beneran keupdate.
    assert.equal(loadClients()[c.apiKey].tier, "admin");
  });

  test("idempotent: udah admin -> tetap admin, gak error", () => {
    const c = ensureClientForUser({ provider: "google", id: "promo-1" });
    assert.equal(promoteClientToAdmin(c.apiKey).tier, "admin");
  });

  test("field lain (provider/email/nama) gak keganggu pas promote", () => {
    const c = ensureClientForUser({ provider: "github", id: "promo-2", name: "Sari", email: "s@x.y" });
    promoteClientToAdmin(c.apiKey);
    const after = loadClients()[c.apiKey];
    assert.equal(after.provider, "github");
    assert.equal(after.email, "s@x.y");
    assert.equal(after.name, "Sari");
  });

  test("key gak dikenal -> null, gak nulis apa-apa", () => {
    const count = Object.keys(loadClients()).length;
    assert.equal(promoteClientToAdmin("key-ngasal-gak-ada"), null);
    assert.equal(Object.keys(loadClients()).length, count);
  });
});

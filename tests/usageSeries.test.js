// Test dailySeriesForKey: deret harian SATU key buat grafik usage di docs
// (self-service) — beda dari dailySeries yang agregat semua client.
import "./helpers/forceEmptyOauthEnv.js";
import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { USAGE_PATH, recordHit, dailySeriesForKey, _resetUsageCache } from "../src/utils/usage.js";
import { CLIENTS_PATH } from "../src/utils/clients.js";
import { buildUsageSeriesPayload } from "../src/routes/auth.routes.js";

const USAGE_EXISTED = fs.existsSync(USAGE_PATH);
const USAGE_CONTENT = USAGE_EXISTED ? fs.readFileSync(USAGE_PATH, "utf8") : null;

after(() => {
  if (USAGE_EXISTED) fs.writeFileSync(USAGE_PATH, USAGE_CONTENT, "utf8");
  else fs.rmSync(USAGE_PATH, { force: true });
  _resetUsageCache();
});

const CLIENTS_EXISTED = fs.existsSync(CLIENTS_PATH);
const CLIENTS_CONTENT = CLIENTS_EXISTED ? fs.readFileSync(CLIENTS_PATH, "utf8") : null;

after(() => {
  if (CLIENTS_EXISTED) fs.writeFileSync(CLIENTS_PATH, CLIENTS_CONTENT, "utf8");
  else fs.rmSync(CLIENTS_PATH, { force: true });
});

describe("dailySeriesForKey (deret harian satu key)", () => {
  beforeEach(() => {
    _resetUsageCache();
    fs.rmSync(USAGE_PATH, { force: true });
  });

  test("tanpa data -> SEMUA hari di rentang tetap dibalikin, isi 0", () => {
    const s = dailySeriesForKey("key-a", 7);
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

  test("hit hari ini cuma masuk ke key yang benar (filter per key)", () => {
    recordHit({ clientKey: "key-a", tier: "free", path: "/api/yt", status: 200 });
    recordHit({ clientKey: "key-a", tier: "free", path: "/api/yt", status: 429 });
    recordHit({ clientKey: "key-b", tier: "free", path: "/api/yt", status: 200 });

    const a = dailySeriesForKey("key-a", 3);
    assert.equal(a.length, 3);
    assert.equal(a[2].total, 2, "key-a: 2 hit hari ini");
    assert.equal(a[2].limited, 1, "satu di antaranya 429");
    assert.equal(a[0].total + a[1].total, 0, "hari sebelumnya kosong");

    const b = dailySeriesForKey("key-b", 3);
    assert.equal(b[2].total, 1, "key-b gak kecampur hit key-a");
    assert.equal(b[2].limited, 0);
  });

  test("key gak dikenal -> semua 0, gak nge-throw", () => {
    recordHit({ clientKey: "key-a", tier: "free", path: "/api/yt", status: 200 });
    const s = dailySeriesForKey("key-gak-ada", 3);
    assert.equal(s.length, 3);
    for (const d of s) assert.equal(d.total, 0);
  });

  test("clientKey kosong/null -> semua 0, gak nge-throw", () => {
    const s = dailySeriesForKey(null, 2);
    assert.equal(s.length, 2);
    for (const d of s) assert.equal(d.total, 0);
  });

  test("default days = 14", () => {
    assert.equal(dailySeriesForKey("key-a").length, 14);
  });
});

describe("buildUsageSeriesPayload (logika /auth/usage-series)", () => {
  const USER = { provider: "google", id: "111" };

  beforeEach(() => {
    _resetUsageCache();
    fs.rmSync(USAGE_PATH, { force: true });
    fs.writeFileSync(
      CLIENTS_PATH,
      JSON.stringify(
        {
          "key-primary": {
            name: "Budi",
            tier: "premium",
            provider: "google",
            providerId: "111",
            dailyQuota: 500,
          },
          "key-bot": {
            name: "Budi",
            tier: "premium",
            provider: "google",
            providerId: "111",
            label: "bot-discord",
          },
          "key-orang-lain": { name: "Ani", tier: "free", provider: "github", providerId: "999" },
        },
        null,
        2
      ),
      "utf8"
    );
  });

  test("tanpa ?key -> pakai key primary (yang tanpa label)", () => {
    recordHit({ clientKey: "key-primary", tier: "premium", path: "/api/yt", status: 200 });
    const p = buildUsageSeriesPayload(USER, {});
    assert.ok(p, "payload harus ada");
    assert.equal(p.days.length, 14, "default 14 hari");
    assert.equal(p.days.at(-1).total, 1);
    assert.equal(p.quota.daily, 500);
    assert.equal(p.quota.todayUsed, 1);
    assert.ok(p.quota.hourly > 0, "premium punya limit per jam");
  });

  test("?key milik sendiri (key berlabel) -> dipakai", () => {
    recordHit({ clientKey: "key-bot", tier: "premium", path: "/api/anime", status: 200 });
    const p = buildUsageSeriesPayload(USER, { key: "key-bot" });
    assert.equal(p.days.at(-1).total, 1);
    assert.equal(p.quota.daily, null, "key bot gak punya dailyQuota");
  });

  test("?key milik user LAIN -> null (route bakal 404), bukan data orang", () => {
    assert.equal(buildUsageSeriesPayload(USER, { key: "key-orang-lain" }), null);
  });

  test("?key gak ada di sistem -> null juga (pesan gak bocorin eksistensi)", () => {
    assert.equal(buildUsageSeriesPayload(USER, { key: "key-ngasal" }), null);
  });

  test("user tanpa key sama sekali -> null", () => {
    assert.equal(buildUsageSeriesPayload({ provider: "google", id: "777" }, {}), null);
  });

  test("days di-clamp diam-diam: 999 -> 30, 0 -> 1, 'abc' -> default 14", () => {
    assert.equal(buildUsageSeriesPayload(USER, { days: "999" }).days.length, 30);
    assert.equal(buildUsageSeriesPayload(USER, { days: "0" }).days.length, 1);
    assert.equal(buildUsageSeriesPayload(USER, { days: "abc" }).days.length, 14);
  });

  test("tier admin -> quota.hourly null (unlimited)", () => {
    fs.writeFileSync(
      CLIENTS_PATH,
      JSON.stringify(
        { "key-adm": { name: "Root", tier: "admin", provider: "google", providerId: "111" } },
        null,
        2
      ),
      "utf8"
    );
    assert.equal(buildUsageSeriesPayload(USER, {}).quota.hourly, null);
  });
});

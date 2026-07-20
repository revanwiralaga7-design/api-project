// Test dailySeriesForKey: deret harian SATU key buat grafik usage di docs
// (self-service) — beda dari dailySeries yang agregat semua client.
import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { USAGE_PATH, recordHit, dailySeriesForKey, _resetUsageCache } from "../src/utils/usage.js";

const USAGE_EXISTED = fs.existsSync(USAGE_PATH);
const USAGE_CONTENT = USAGE_EXISTED ? fs.readFileSync(USAGE_PATH, "utf8") : null;

after(() => {
  if (USAGE_EXISTED) fs.writeFileSync(USAGE_PATH, USAGE_CONTENT, "utf8");
  else fs.rmSync(USAGE_PATH, { force: true });
  _resetUsageCache();
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

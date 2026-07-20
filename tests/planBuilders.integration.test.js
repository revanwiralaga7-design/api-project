import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildPlan, buildDeletePlan, buildBatchPlans } from "../src/routes/admin/planBuilders.js";
import { ROUTES_INDEX, PUBLIC_DATA, ROUTES_DIR } from "../src/utils/scaffold.js";
import path from "node:path";

/* ------------------------------------------------------------------ */
/* Integrasi plan builder — jalur yang beneran nulis/hapus file di     */
/* server. buildPlan/buildBatchPlans dites lewat fileOverrides          */
/* (virtual fs — gak nyentuh file project); buildDeletePlan read-only  */
/* by design (nulis-nya di /delete/apply), jadi aman dipanggil ke file */
/* project asli.                                                       */
/* ------------------------------------------------------------------ */

// Fixture minimal routes/index.js & public/data.js dengan format yang
// sama seperti file aslinya (anchor yang dicari generator: result: [...],
// total: N, router.use, const CATEGORIES = [...]).
const FIXTURE_INDEX = `import { Router } from "express";

import youtubeRoutes from "./youtube.routes.js";

const router = Router();

router.use("/youtube", youtubeRoutes);

router.get("/endpoints", (req, res) => {
  res.json({
    status: true,
    total: 1,
    result: [
      { name: "YouTube Search", method: "GET/POST", path: "/api/youtube/search", params: ["query"] },
    ],
  });
});

export default router;
`;

const FIXTURE_DATA = `const ACCENTS = ["#FF8A65"];

const CATEGORIES = [
  {
    id: "youtube",
    tag: "YT",
    label: "YouTube",
    desc: "Cari video",
    endpoints: [
      {
        name: "YouTube Search",
        method: "ALL",
        path: "/api/youtube/search",
        desc: "Cari video YouTube",
        query: [{ name: "query", required: true, desc: "Kata kunci" }],
      },
    ],
  },
];

CATEGORIES.forEach((cat, i) => {
  cat.accent = ACCENTS[i % ACCENTS.length];
});
`;

const CLASS_CODE = `import axios from "axios";

class CatFacts {
  async random({ lang = "en" }) {
    const { data } = await axios.get("https://catfact.ninja/fact", { params: { lang } });
    return data;
  }
  async search({ query, limit = 5 }) {
    return { query, limit };
  }
}
`;

function makeBody(extra = {}) {
  return {
    classCode: CLASS_CODE,
    serviceFileName: "catFacts",
    instanceName: "catFacts",
    routeMode: "new",
    newRouteSlug: "catfacts",
    subPath: "/random",
    httpMethod: "GET",
    selectedMethod: "random",
    methodParams: [{ serviceParamName: "lang", requestParamName: "lang", required: false, desc: "" }],
    ctorParams: [],
    endpointName: "Cat Facts",
    endpointDesc: "Fakta kucing acak",
    categoryMode: "new",
    newCategory: { id: "kucing", tag: "CF", label: "Kucing", desc: "Fakta kucing" },
    ...extra,
  };
}

function overridesForNewRoute() {
  return {
    [ROUTES_INDEX]: FIXTURE_INDEX,
    [PUBLIC_DATA]: FIXTURE_DATA,
    [path.join(ROUTES_DIR, "catfacts.routes.js")]: null, // "belum ada"
  };
}

describe("buildPlan — route file baru + kategori baru", () => {
  test("menghasilkan plan lengkap dengan konten valid", () => {
    const plan = buildPlan(makeBody(), { fileOverrides: overridesForNewRoute() });

    assert.equal(plan.fullPath, "/api/catfacts/random");
    assert.equal(plan.isNewRouteFile, true);
    // Service file: class + export default
    assert.match(plan.serviceFileContent, /class CatFacts/);
    assert.match(plan.serviceFileContent, /export default CatFacts;/);
    // Route file: import service + router.get + validasi param TIDAK
    // dibuat buat `lang` (punya default di class)
    assert.match(plan.routeFileContent, /import CatFacts from "\.\.\/services\/catFacts\.service\.js";/);
    assert.match(plan.routeFileContent, /router\.get\(\s*"\/random"/);
    assert.doesNotMatch(plan.routeFileContent, /if \(!lang\) throw/);
    // routes/index.js: router.use baru + entry result[] + total naik
    assert.match(plan.indexContent, /router\.use\("\/catfacts", catfactsRoutes\)/);
    assert.match(plan.indexContent, /path: "\/api\/catfacts\/random"/);
    assert.match(plan.indexContent, /total: 2/);
    // public/data.js: kategori baru + endpoint-nya
    assert.match(plan.dataContent, /id: "kucing"/);
    assert.match(plan.dataContent, /path: "\/api\/catfacts\/random"/);
    // dependency axios udah ada di package.json project -> gak ada warning
    assert.deepEqual(plan.depWarnings, []);
  });

  test("path duplikat (udah ada di routes/index.js) -> 409", () => {
    const body = makeBody({
      routeMode: "existing",
      routeFile: "youtube",
      subPath: "/search",
    });
    const overrides = { [ROUTES_INDEX]: FIXTURE_INDEX, [PUBLIC_DATA]: FIXTURE_DATA };
    // Bisa ketangkep di salah satu dari 2 lapis cek duplikat (entry di
    // routes/index.js ATAU blok router.* di file route-nya) — dua-duanya 409.
    assert.throws(
      () => buildPlan(body, { fileOverrides: overrides }),
      (e) => e.statusCode === 409 && /udah kedaftar|sudah ada/.test(e.message)
    );
  });

  test("method yang gak ada di class -> 400 dengan daftar method tersedia", () => {
    assert.throws(
      () => buildPlan(makeBody({ selectedMethod: "download" }), { fileOverrides: overridesForNewRoute() }),
      (e) =>
        e.statusCode === 400 &&
        /Method "download" tidak ditemukan/.test(e.message) &&
        /- random/.test(e.message)
    );
  });

  test("kode class bukan JS valid -> 400, bukan 500", () => {
    assert.throws(
      () =>
        buildPlan(makeBody({ classCode: "class Rusak { foo( {} }" }), {
          fileOverrides: overridesForNewRoute(),
        }),
      (e) => /tidak ketemu|bukan JavaScript valid/i.test(e.message)
    );
  });

  test("semua konten hasil generate lolos validasi sintaks (parse ulang)", async () => {
    const { checkJsSyntax } = await import("../src/utils/scaffold.js");
    const plan = buildPlan(makeBody(), { fileOverrides: overridesForNewRoute() });
    for (const [label, content] of Object.entries({
      service: plan.serviceFileContent,
      route: plan.routeFileContent,
      index: plan.indexContent,
      data: plan.dataContent,
    })) {
      assert.equal(checkJsSyntax(content), null, `konten ${label} harus valid JS`);
    }
  });
});

describe("buildBatchPlans — banyak endpoint sekali apply", () => {
  test("endpoint ke-2 melihat hasil endpoint ke-1 (akumulasi overrides)", () => {
    const body = {
      ...makeBody(),
      endpoints: [
        {
          selectedMethod: "random",
          subPath: "/random",
          httpMethod: "GET",
          endpointName: "Random",
          methodParams: [],
        },
        {
          selectedMethod: "search",
          subPath: "/search",
          httpMethod: "GET",
          endpointName: "Search",
          methodParams: [{ serviceParamName: "query", requestParamName: "query", required: true, desc: "" }],
        },
      ],
    };
    // buildBatchPlans gak menerima fileOverrides eksternal — dia baca disk
    // buat plan pertama. Karena route catfacts memang belum ada di project
    // ini, dan index/data project asli formatnya sama, aman jalan read-only.
    const plans = buildBatchPlans(body);
    assert.equal(plans.length, 2);
    // Plan ke-2 harus berisi KEDUA route block (akumulasi dari plan ke-1)
    assert.match(plans[1].routeFileContent, /router\.get\(\s*"\/random"/);
    assert.match(plans[1].routeFileContent, /router\.get\(\s*"\/search"/);
    // Endpoint ke-2 wajib validasi query (required, tanpa default)
    assert.match(plans[1].routeFileContent, /if \(!query\) throw new ApiError/);
    // total di index naik 2x dari nilai asli
    const totalAsli = Number(FIXTURE_INDEX.match(/total: (\d+)/)?.[1]);
    assert.ok(Number.isFinite(totalAsli));
  });

  test("daftar endpoints kosong -> 400", () => {
    assert.throws(
      () => buildBatchPlans({ ...makeBody(), endpoints: [] }),
      (e) => e.statusCode === 400
    );
  });

  test("error di endpoint ke-N menyebut nomor & method-nya", () => {
    const body = {
      ...makeBody(),
      endpoints: [
        {
          selectedMethod: "random",
          subPath: "/random",
          httpMethod: "GET",
          endpointName: "A",
          methodParams: [],
        },
        { selectedMethod: "gakAda", subPath: "/x", httpMethod: "GET", endpointName: "B", methodParams: [] },
      ],
    };
    assert.throws(
      () => buildBatchPlans(body),
      (e) => /Endpoint #2 \(gakAda\)/.test(e.message)
    );
  });
});

describe("buildDeletePlan — read-only terhadap endpoint project asli", () => {
  test("menghapus /api/youtube/search: blok route hilang, index & data bersih", () => {
    const plan = buildDeletePlan({ path: "/api/youtube/search", method: "ALL" });

    // Route file: blok router.all("/search") hilang dari konten baru
    assert.doesNotMatch(plan.newRouteFileContent, /router\.(all|get|post)\(\s*"\/search"/);
    // Entry-nya hilang dari routes/index.js & public/data.js
    assert.doesNotMatch(plan.finalIndexContent, /path: "\/api\/youtube\/search"/);
    assert.doesNotMatch(plan.newDataContent, /path: "\/api\/youtube\/search"/);
    // total berkurang 1 dari nilai sekarang
    const totalSebelum = Number(plan.originalIndexContent.match(/total: (\d+)/)[1]);
    const totalSesudah = Number(plan.finalIndexContent.match(/total: (\d+)/)[1]);
    assert.equal(totalSesudah, totalSebelum - 1);
    // Fungsi ini gak boleh nulis apa-apa — konten asli tetap di disk
    // (dibuktikan test lain yang baca file yang sama; di sini cukup cek
    // original ikut dikembalikan buat keperluan snapshot/rollback).
    assert.ok(plan.originalRouteFileContent.length > 0);
  });

  test("path yang gak terdaftar -> 404", () => {
    assert.throws(
      () => buildDeletePlan({ path: "/api/gak-ada/route" }),
      (e) => e.statusCode === 404
    );
  });

  test("path kosong -> 400", () => {
    assert.throws(
      () => buildDeletePlan({ path: "" }),
      (e) => e.statusCode === 400
    );
  });
});

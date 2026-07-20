import fs from "fs";
import path from "path";
import { PUBLIC_DATA, listAllEndpoints, findEndpointObject } from "./scaffold.js";
import { DATA_DIR } from "./dataDir.js";

export const HEALTH_TESTS_PATH = path.join(DATA_DIR, "health-tests.json");

/**
 * data/health-tests.json — { "<METHOD> <path>": { params: {...}, updatedAt } }.
 * Nyimpen test params per endpoint buat fitur health check: sekali di-set
 * (otomatis pas apply endpoint, atau manual dari panel), /admin/health/run
 * bisa nge-hit semua endpoint pakai params itu kapan aja.
 */
export function loadHealthTests() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HEALTH_TESTS_PATH, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveHealthTests(tests) {
  fs.mkdirSync(path.dirname(HEALTH_TESTS_PATH), { recursive: true });
  fs.writeFileSync(HEALTH_TESTS_PATH, JSON.stringify(tests, null, 2) + "\n", "utf8");
}

export function healthTestKey(method, epPath) {
  return `${String(method || "ALL").toUpperCase()} ${epPath}`;
}

export function setHealthTest({ method, path: epPath, params, assertFields }) {
  const tests = loadHealthTests();
  const entry = {
    params: params && typeof params === "object" ? params : {},
    updatedAt: new Date().toISOString()
  };
  // assertFields: array dot-path yang WAJIB ada (dan non-null) di response
  // sukses, mis. ["result.url", "result.title"]. Nangkep kasus scraper
  // yang balas 200 tapi isinya kosong karena HTML sumbernya berubah.
  const clean = (assertFields || []).map((s) => String(s).trim()).filter(Boolean);
  if (clean.length) entry.assertFields = clean;
  tests[healthTestKey(method, epPath)] = entry;
  saveHealthTests(tests);
}

export function deleteHealthTest({ method, path: epPath }) {
  const tests = loadHealthTests();
  delete tests[healthTestKey(method, epPath)];
  saveHealthTests(tests);
}

/**
 * Ambil nilai dot-path dari object: getByPath({a:{b:1}}, "a.b") -> 1.
 * "arr.0.x" juga jalan (index array). undefined kalau path putus di tengah.
 */
export function getByPath(obj, dotPath) {
  let cur = obj;
  for (const part of String(dotPath).split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Cek assertion fields terhadap body response (udah di-parse JSON).
 * Return array pesan kegagalan (kosong = semua lolos).
 */
export function checkAssertions(body, assertFields) {
  const failures = [];
  for (const f of assertFields || []) {
    const val = getByPath(body, f);
    if (val === undefined || val === null || val === "") {
      failures.push(`field "${f}" kosong / tidak ada di response`);
    }
  }
  return failures;
}

/**
 * Jalankan health check ke SEMUA endpoint terdaftar (dari public/data.js)
 * lewat HTTP ke server sendiri. Endpoint dengan path param (:id) yang
 * belum punya test params tersimpan di-skip (gak bisa dites tanpa nilai).
 *
 * Hasil per endpoint: ok (2xx-4xx yang "wajar") / fail (5xx, timeout,
 * error jaringan) / skipped. 4xx selain 429 dianggap "degraded" — endpoint
 * hidup tapi test params-nya kemungkinan kurang (mis. param wajib kosong).
 */
export async function runHealthCheck({ baseUrl, timeoutMs = 15000 } = {}) {
  const endpoints = listAllEndpoints();
  const tests = loadHealthTests();
  const results = [];

  for (const ep of endpoints) {
    const key = healthTestKey(ep.method, ep.path);
    const test = tests[key];
    const httpMethod = String(ep.method || "GET").toUpperCase() === "POST" ? "POST" : "GET";

    // Path param (:id) wajib punya nilai tersimpan — tanpa itu URL-nya
    // gak bisa dibentuk, jadi skip dengan alasan jelas.
    const pathParams = [...ep.path.matchAll(/:([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
    const params = { ...(test?.params || {}) };
    const missingPathParams = pathParams.filter((p) => !params[p]);
    if (missingPathParams.length) {
      results.push({ ...ep, status: "skipped", reason: `Belum ada nilai test buat path param: ${missingPathParams.join(", ")}` });
      continue;
    }

    let urlPath = ep.path;
    for (const p of pathParams) {
      urlPath = urlPath.replace(`:${p}`, encodeURIComponent(params[p]));
      delete params[p];
    }

    const target = new URL(baseUrl + urlPath);
    const fetchOpts = { method: httpMethod, signal: AbortSignal.timeout(timeoutMs) };
    if (httpMethod === "GET") {
      for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
    } else {
      fetchOpts.headers = { "Content-Type": "application/json" };
      fetchOpts.body = JSON.stringify(params);
    }

    const t0 = Date.now();
    try {
      const resp = await fetch(target.toString(), fetchOpts);
      const ms = Date.now() - t0;
      let status;
      if (resp.status < 400) status = "ok";
      else if (resp.status >= 500) status = "fail";
      else status = "degraded"; // 4xx: endpoint hidup, kemungkinan test params kurang
      let bodyPreview = null;
      let assertFailures = null;
      if (status === "ok" && test?.assertFields?.length) {
        // Nangkep scraper yang balas 200 tapi body-nya kosong (HTML sumber
        // berubah) — field wajib yang di-set di test params dicek satu-satu.
        const text = await resp.text();
        let body;
        try { body = JSON.parse(text); } catch { body = undefined; }
        const failures = body === undefined
          ? ["response bukan JSON valid"]
          : checkAssertions(body, test.assertFields);
        if (failures.length) {
          status = "degraded";
          assertFailures = failures;
          bodyPreview = text.slice(0, 300);
        }
      } else if (status !== "ok") {
        const text = await resp.text();
        bodyPreview = text.slice(0, 300);
      }
      results.push({ ...ep, status, httpStatus: resp.status, ms, hasTestParams: !!test, bodyPreview, assertFailures });
    } catch (err) {
      results.push({
        ...ep,
        status: "fail",
        httpStatus: null,
        ms: Date.now() - t0,
        hasTestParams: !!test,
        error: err.name === "TimeoutError" ? `Timeout > ${timeoutMs}ms` : err.message
      });
    }
  }

  const counts = { ok: 0, degraded: 0, fail: 0, skipped: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  return { checkedAt: new Date().toISOString(), counts, results };
}

/* ------------------------------------------------------------------ */
/* Ekspor OpenAPI 3.0 dari public/data.js                              */
/* ------------------------------------------------------------------ */

/**
 * Generate dokumen OpenAPI 3.0 dari endpoint terdaftar. Sumber datanya
 * public/data.js (nama, desc, params + required) — yang emang jadi
 * sumber kebenaran dokumentasi project ini.
 */
export function buildOpenApiSpec({ baseUrl, title = "Febry API", version = "1.0.0" } = {}) {
  const dataContent = fs.readFileSync(PUBLIC_DATA, "utf8");
  const endpoints = listAllEndpoints();
  const paths = {};

  for (const ep of endpoints) {
    const detail = findEndpointObject(dataContent, { path: ep.path, method: ep.method }) || ep;
    // OpenAPI pakai {id}, Express pakai :id
    const oaPath = ep.path.replace(/:([A-Za-z_$][\w$]*)/g, "{$1}");
    const entry = (paths[oaPath] = paths[oaPath] || {});

    const parameters = [
      ...(detail.pathParams || []).map((p) => ({
        name: p.name, in: "path", required: true,
        description: p.desc || "", schema: { type: "string" }
      })),
      ...(detail.query || [])
        .filter((p) => !p.name.startsWith("..."))
        .map((p) => ({
          name: p.name, in: "query", required: !!p.required,
          description: p.desc || "", schema: { type: "string" }
        }))
    ];

    const bodyProps = {};
    const bodyRequired = [];
    for (const p of detail.query || []) {
      if (p.name.startsWith("...")) continue;
      bodyProps[p.name] = { type: "string", description: p.desc || "" };
      if (p.required) bodyRequired.push(p.name);
    }

    const responses = {
      200: {
        description: "Sukses",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { status: { type: "boolean" }, result: {} }
            }
          }
        }
      },
      400: { description: "Parameter kurang / tidak valid" },
      429: { description: "Rate limit / kuota tercapai" }
    };

    const buckets = String(ep.method || "ALL").toUpperCase();
    const methods = buckets === "ALL" || buckets === "GET/POST" ? ["get", "post"] : [buckets.toLowerCase()];
    for (const m of methods) {
      const op = {
        summary: detail.name || ep.name,
        description: detail.desc || "",
        tags: [detail.categoryLabel || ep.categoryLabel || "API"],
        responses
      };
      if (m === "get") {
        op.parameters = parameters;
      } else {
        op.parameters = parameters.filter((p) => p.in === "path");
        if (Object.keys(bodyProps).length) {
          op.requestBody = {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: bodyProps,
                  ...(bodyRequired.length ? { required: bodyRequired } : {})
                }
              }
            }
          };
        }
      }
      entry[m] = op;
    }
  }

  return {
    openapi: "3.0.3",
    info: {
      title,
      version,
      description: "Digenerate otomatis dari dokumentasi endpoint (public/data.js)."
    },
    servers: baseUrl ? [{ url: baseUrl }] : [],
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" }
      }
    },
    security: [{ ApiKeyAuth: [] }, {}],
    paths
  };
}

export default { loadHealthTests, saveHealthTests, setHealthTest, deleteHealthTest, runHealthCheck, buildOpenApiSpec, HEALTH_TESTS_PATH };

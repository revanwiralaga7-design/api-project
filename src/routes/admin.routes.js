import { Router } from "express";
import fs from "fs";
import path from "path";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ok, ApiError } from "../utils/response.js";
import { listClients, createClient, updateClient, deleteClient } from "../utils/clients.js";
import {
  ROOT,
  SERVICES_DIR,
  ROUTES_DIR,
  ROUTES_INDEX,
  PUBLIC_DATA,
  slugify,
  lowerFirst,
  extractClassInfo,
  checkMissingDeps,
  addDepsToPackageJson,
  extractClassMethods,
  detectInternallyCalledMethods,
  findMethodOrThrow,
  ParserUnsupportedError,
  validateParsedMethodParams,
  buildServiceFileContent,
  buildRouteBlockCode,
  buildNewRouteFileContent,
  appendRouteBlockToExistingFile,
  updateRoutesIndex,
  updatePublicData,
  listExistingCategories,
  listExistingRouteFiles,
  extractPathParams,
  listAllEndpoints,
  splitApiPath,
  findRouteFileForSlug,
  removeRouteBlock,
  countRouteBlocks,
  removeRouteFileRefFromIndex,
  removeEndpointFromRoutesIndex,
  removeEndpointFromPublicData,
  extractServiceImports,
  extractInstanceDecls,
  computeOrphanedServices,
  findDuplicateEndpoint,
  diffLines,
  compactDiff,
  snapshotFiles,
  withRollback,
  escapeRegex,
  findEndpointObject
} from "../utils/scaffold.js";
import { recordHistory, listHistory, getHistoryEntry, rollbackHistory, deleteHistoryEntry } from "../utils/history.js";
import { usageSummary, flushUsage } from "../utils/usage.js";
import { loadCacheConfig, saveCacheConfig, clearResponseCache, cacheStats } from "../middleware/responseCache.js";
import { tailAccessLog, rotateIfNeeded } from "../utils/accessLog.js";
import { loadHealthTests, setHealthTest, deleteHealthTest, healthTestKey, runHealthCheck, buildOpenApiSpec } from "../utils/health.js";
import { buildBackupBundle, restoreBackupBundle } from "../utils/backup.js";

const router = Router();
const PKG_PATH = path.join(ROOT, "package.json");

/**
 * Jadwalin restart proses (biar file baru ke-`import` ulang) TAPI baru
 * SETELAH response request ini beneran selesai dikirim ke client —
 * dengerin event 'finish', bukan restart reaktif dari file-watcher (yang
 * balapan sama response-nya sendiri, lihat catatan di ecosystem.config.cjs).
 * PM2 (autorestart: true, lihat ecosystem.config.cjs) yang nyalain proses
 * baru begitu ini exit — via `npm start` biasa (bukan pm2-runtime), gak
 * ada yang restart otomatis, jadi tetap perlu restart manual seperti biasa.
 */
function scheduleRestartAfterResponse(res) {
  const isPm2 = process.env.pm_id !== undefined;
  if (!isPm2) return; // npm start polos: gak ada supervisor buat nyalain ulang, jangan exit
  res.on("finish", () => {
    setTimeout(() => process.exit(0), 150);
  });
}

/**
 * Wrapper extractClassMethods: kalau parser nemu pola parameter yang
 * belum didukung (nested object, array destructuring, computed
 * property, dst — Parser Upgrade v2 poin 6-8), lempar sebagai ApiError
 * 400 dengan pesan lokasi yang jelas, bukan 500 generik.
 */
function safeExtractClassMethods(classBlock) {
  try {
    return extractClassMethods(classBlock);
  } catch (e) {
    if (e instanceof ParserUnsupportedError) throw new ApiError(e.message, 400);
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* /analyze — parse kode class yang di-paste, balikin daftar method +  */
/* constructor + dependency warning. Dipanggil frontend SEBELUM form   */
/* method/param ditampilkan, biar semuanya auto-detect bukan nebak.    */
/* ------------------------------------------------------------------ */
router.post(
  "/analyze",
  asyncHandler(async (req, res) => {
    const { classCode } = req.body || {};
    if (!classCode || !classCode.trim()) throw new ApiError("Kode class belum di-paste.", 400);

    const { className, classBlock, importLines } = extractClassInfo(classCode);
    const methods = safeExtractClassMethods(classBlock);
    const depWarnings = checkMissingDeps(importLines);
    const ctor = methods.find((m) => m.isConstructor) || null;
    const internallyCalled = detectInternallyCalledMethods(classBlock, methods, className);

    return ok(res, {
      className,
      methods: methods
        .filter((m) => !m.isConstructor)
        .map((m) => ({
          name: m.name,
          paramStyle: m.params.style,
          paramNames: m.params.names,
          // Metadata kaya per parameter (kind: property/alias/rest,
          // required, hasDefault, defaultValue, dst) — Parser Upgrade v2.
          paramsMeta: m.params.params,
          paramsOptional: m.params.optional,
          validation: validateParsedMethodParams(m.params),
          isAsync: m.isAsync,
          isArrowField: m.isArrowField,
          // true kalau method ini dipanggil dari dalam class-nya sendiri
          // (this.xxx() / NamaClass.xxx()) — kemungkinan helper internal,
          // gak wajib dijadikan endpoint sendiri.
          isCalledInternally: internallyCalled.has(m.name)
        })),
      constructor: ctor
        ? {
            paramStyle: ctor.params.style,
            paramNames: ctor.params.names,
            paramsMeta: ctor.params.params,
            paramsOptional: ctor.params.optional,
            validation: validateParsedMethodParams(ctor.params)
          }
        : { paramStyle: "none", paramNames: [], paramsMeta: [], paramsOptional: false, validation: { ok: true, lines: [], summary: "Parser OK" } },
      depWarnings
    });
  })
);

/**
 * Susun semua bahan (nama file, konten yang akan ditulis, dsb) dari
 * payload form. Dipakai bareng oleh /preview dan /apply supaya hasilnya
 * konsisten (preview = simulasi persis apa yang akan ditulis /apply).
 */
function buildPlan(body, opts = {}) {
  const overrides = opts.fileOverrides || {};
  const readVirtual = (p) => (Object.prototype.hasOwnProperty.call(overrides, p) ? overrides[p] : fs.readFileSync(p, "utf8"));
  const existsVirtual = (p) => (Object.prototype.hasOwnProperty.call(overrides, p) ? overrides[p] !== null : fs.existsSync(p));
  const {
    classCode,
    serviceFileName: rawServiceFileName,
    instanceName: rawInstanceName,
    routeMode, // "existing" | "new"
    routeFile, // slug, kalau routeMode = existing
    newRouteSlug, // slug, kalau routeMode = new
    subPath: rawSubPath,
    httpMethod,
    selectedMethod, // nama method yang mau dipanggil, HARUS ada di class
    methodParams, // [{ serviceParamName, requestParamName, required, desc }] urutan sesuai signature
    ctorParams, // [{ serviceParamName, source: "static"|"request", staticValue, requestParamName, required, desc }]
    endpointName,
    endpointDesc,
    categoryMode, // "existing" | "new"
    categoryId,
    newCategory, // { id, tag, label, desc }
    autoInstallDeps
  } = body;

  if (!classCode || !classCode.trim()) throw new ApiError("Kode class belum di-paste.", 400);
  if (!selectedMethod || !selectedMethod.trim()) throw new ApiError("Pilih method yang mau dipanggil dulu (klik 'Analisis Class').", 400);

  const serviceFileName = lowerFirst(slugify(rawServiceFileName));
  if (!serviceFileName) throw new ApiError("Nama service tidak valid (harus huruf/angka, diawali huruf).", 400);

  const { className, classBlock, hasInlineExport, importLines, preludeCode } = extractClassInfo(classCode);
  const depWarnings = checkMissingDeps(importLines);

  // --- Fitur 1: validasi method beneran ada di class ini ---
  const methods = safeExtractClassMethods(classBlock);
  let methodInfo;
  try {
    methodInfo = findMethodOrThrow(methods, selectedMethod);
  } catch (e) {
    throw new ApiError(e.message, 400);
  }
  const ctorInfo = methods.find((m) => m.isConstructor) || null;
  const ctorParamNames = ctorInfo ? ctorInfo.params.names : [];

  // Lookup metadata parser (kind/required/hasDefault/dst) per nama
  // parameter — `names` dan `params` selalu paralel/sejajar urutannya
  // (sama-sama diturunkan dari array yang sama di parseMethodParams),
  // jadi aman di-zip by index. Generator baca dari sini, gak nebak lagi.
  const methodParamsMetaByKey = new Map(methodInfo.params.names.map((n, i) => [n, methodInfo.params.params[i]]));
  const ctorParamsMeta = ctorInfo ? ctorInfo.params.params : [];
  const ctorMetaByKey = new Map(ctorParamNames.map((n, i) => [n, ctorParamsMeta[i]]));

  const routeSlug = slugify(routeMode === "existing" ? routeFile : newRouteSlug).toLowerCase();
  if (!routeSlug) throw new ApiError("Slug route tidak valid.", 400);

  const isNewRouteFile = routeMode !== "existing";
  const routeFilePath = path.join(ROUTES_DIR, `${routeSlug}.routes.js`);

  if (isNewRouteFile && existsVirtual(routeFilePath)) {
    throw new ApiError(`src/routes/${routeSlug}.routes.js sudah ada. Pilih mode "route existing" atau nama slug lain.`, 409);
  }
  if (!isNewRouteFile && !existsVirtual(routeFilePath)) {
    throw new ApiError(`src/routes/${routeSlug}.routes.js tidak ditemukan.`, 404);
  }

  let subPath = String(rawSubPath || "").trim();
  if (!subPath) throw new ApiError("Sub-path endpoint wajib diisi, mis. /download", 400);
  if (!subPath.startsWith("/")) subPath = "/" + subPath;

  const fullPath = `/api/${routeSlug}${subPath}`;
  const method = (httpMethod || "ALL").toUpperCase();

  // --- Fitur 5: duplicate detection (path+method di SELURUH project) ---
  const indexContentPeek = readVirtual(ROUTES_INDEX);
  const dup = findDuplicateEndpoint(indexContentPeek, fullPath, method);
  if (dup) {
    throw new ApiError(`Endpoint "${fullPath}" udah kedaftar sebagai "${dup.name}" (${dup.method}). Ganti path atau method-nya.`, 409);
  }
  if (!isNewRouteFile) {
    const peek = readVirtual(routeFilePath);
    const already = new RegExp(`router\\.(all|get|post)\\(\\s*["']${escapeRegex(subPath)}["']`).test(peek);
    if (already) throw new ApiError(`Sub-path "${subPath}" sudah ada di src/routes/${routeSlug}.routes.js.`, 409);
  }

  const servicePath = path.join(SERVICES_DIR, `${serviceFileName}.service.js`);
  const serviceExists = fs.existsSync(servicePath);
  const instanceName = lowerFirst(slugify(rawInstanceName) || serviceFileName);

  const serviceFileContent = buildServiceFileContent({ importLines, preludeCode, classBlock, className, hasInlineExport });

  // --- Fitur 2 & 4: methodArgs sesuai URUTAN ASLI signature + mapping nama request ---
  // (kind ikut dibawa dari metadata parser: property/alias/rest — dipakai
  // generator buat tau kapan harus render spread (...x) vs key: value biasa)
  const cleanMethodParams = (methodParams || []).filter((p) => p.serviceParamName);
  const methodArgs = methodInfo.params.names.map((n) => {
    const found = cleanMethodParams.find((p) => p.serviceParamName === n);
    const requestParamName = found && found.requestParamName ? (slugify(found.requestParamName) || found.requestParamName) : n;
    const meta = methodParamsMetaByKey.get(n);
    return { serviceParamName: n, requestParamName, kind: meta ? meta.kind : "property" };
  });

  // --- Fitur 3: constructor (singleton kalau kosong, per-request kalau butuh argumen) ---
  let ctor = null;
  if (ctorParamNames.length) {
    const cleanCtorParams = ctorParams || [];
    const args = ctorParamNames.map((n) => {
      const found = cleanCtorParams.find((p) => p.serviceParamName === n);
      if (!found) throw new ApiError(`Constructor class ini butuh parameter "${n}", tapi belum di-set di form.`, 400);
      const meta = ctorMetaByKey.get(n);
      const kind = meta ? meta.kind : "property";
      if (found.source === "static") {
        return { serviceParamName: n, source: "static", staticValue: found.staticValue ?? "", kind };
      }
      const requestParamName = slugify(found.requestParamName) || found.requestParamName;
      return { serviceParamName: n, source: "request", requestParamName, kind };
    });
    ctor = { style: ctorInfo.params.style, args };
  }

  // --- Gabungan semua parameter request (dari method + ctor) buat destructure & validasi ---
  const reqParamMap = new Map();
  for (const a of methodArgs) {
    const meta = methodParamsMetaByKey.get(a.serviceParamName);
    const hasDefault = !!(meta && meta.hasDefault);
    const src = cleanMethodParams.find((p) => p.serviceParamName === a.serviceParamName);
    reqParamMap.set(a.requestParamName, {
      requestParamName: a.requestParamName,
      // Parameter yang di source class-nya udah punya default value (atau
      // rest) TIDAK PERNAH divalidasi "wajib diisi" lagi — class-nya
      // sendiri yang bakal isi default itu. (Parser Upgrade v2, poin 4)
      required: hasDefault || a.kind === "rest" ? false : (src ? !!src.required : true),
      desc: (src && src.desc) || (a.kind === "rest" ? "Properti tambahan lainnya (diteruskan apa adanya)." : ""),
      kind: a.kind
    });
  }
  if (ctor) {
    for (const a of ctor.args) {
      if (a.source !== "request") continue;
      const meta = ctorMetaByKey.get(a.serviceParamName);
      const hasDefault = !!(meta && meta.hasDefault);
      const src = (ctorParams || []).find((p) => p.serviceParamName === a.serviceParamName);
      const existing = reqParamMap.get(a.requestParamName);
      reqParamMap.set(a.requestParamName, {
        requestParamName: a.requestParamName,
        required: hasDefault || a.kind === "rest" ? false : (existing ? existing.required : false) || (src ? !!src.required : true),
        desc: (existing && existing.desc) || (src && src.desc) || "",
        kind: a.kind
      });
    }
  }
  const allRequestParams = [...reqParamMap.values()];

  const { code: routeBlockCodeRaw, usesPerRequestInstance } = buildRouteBlockCode({
    subPath,
    httpMethod,
    className,
    instanceName,
    callMethod: selectedMethod,
    methodParamStyle: methodInfo.params.style,
    methodArgs,
    ctor,
    allRequestParams,
    endpointName,
    endpointDesc
  });
  const routeBlockCode = routeBlockCodeRaw.replace("{ROUTE_PREFIX}", routeSlug);

  let routeFileContent;
  let originalRouteFileContent = null;
  if (isNewRouteFile) {
    routeFileContent = buildNewRouteFileContent({ className, serviceFileName, instanceName, routeBlockCode, usesPerRequestInstance });
  } else {
    originalRouteFileContent = readVirtual(routeFilePath);
    routeFileContent = appendRouteBlockToExistingFile(originalRouteFileContent, {
      className,
      serviceFileName,
      instanceName,
      routeBlockCode,
      usesPerRequestInstance
    });
  }

  const pathParamNames = extractPathParams(subPath);
  const requestOnlyParams = allRequestParams.filter((p) => !pathParamNames.includes(p.requestParamName));

  const originalIndexContent = readVirtual(ROUTES_INDEX);
  const newIndexContent = updateRoutesIndex(originalIndexContent, {
    routeSlug,
    isNewRouteFile,
    endpointEntry: {
      name: endpointName || className,
      method,
      path: fullPath,
      params: [
        ...pathParamNames.map((n) => `${n} (path)`),
        ...requestOnlyParams.map((p) => `${p.kind === "rest" ? "..." + p.requestParamName : p.requestParamName}${p.required ? "" : "?"}`)
      ]
    }
  });

  const originalDataContent = readVirtual(PUBLIC_DATA);
  const endpointObj = {
    name: endpointName || className,
    method,
    path: fullPath,
    desc: endpointDesc || "",
    pathParams: pathParamNames.map((n) => ({ name: n, desc: "" })),
    query: requestOnlyParams.map((p) => ({
      name: p.kind === "rest" ? `...${p.requestParamName}` : p.requestParamName,
      required: !!p.required,
      desc: p.desc || ""
    }))
  };

  let newDataContent;
  if (categoryMode === "existing") {
    if (!categoryId) throw new ApiError("categoryId wajib diisi untuk mode kategori existing.", 400);
    newDataContent = updatePublicData(originalDataContent, { mode: "existing", categoryId, endpointObj });
  } else {
    if (!newCategory || !newCategory.id || !newCategory.label) {
      throw new ApiError("Data kategori baru (id, tag, label) belum lengkap.", 400);
    }
    newDataContent = updatePublicData(originalDataContent, {
      mode: "new",
      newCategory: {
        id: slugify(newCategory.id).toLowerCase(),
        tag: (newCategory.tag || newCategory.id.slice(0, 2)).toUpperCase().slice(0, 3),
        label: newCategory.label,
        desc: newCategory.desc || ""
      },
      endpointObj
    });
  }

  // --- Fitur 7: dependency checker + opsi auto-update package.json ---
  let packageJsonContent = null;
  let depsAdded = [];
  if (autoInstallDeps && depWarnings.length) {
    const pkgRaw = fs.readFileSync(PKG_PATH, "utf8");
    const result = addDepsToPackageJson(pkgRaw, depWarnings);
    packageJsonContent = result.content;
    depsAdded = result.added;
  }

  return {
    depWarnings,
    depsAdded,
    packageJsonContent,
    className,
    serviceFileName,
    serviceExists,
    servicePath,
    serviceFileContent,
    routeSlug,
    isNewRouteFile,
    routeFilePath,
    originalRouteFileContent,
    routeFileContent,
    originalIndexContent,
    indexContent: newIndexContent,
    originalDataContent,
    dataContent: newDataContent,
    fullPath,
    method,
    usesPerRequestInstance
  };
}

/**
 * Susun semua bahan buat hapus 1 endpoint: cari route file yang mount
 * slug-nya, hapus blok router.method(...) di file itu, hapus entry-nya
 * dari routes/index.js (result[] + total) dan public/data.js.
 * Kalau route file jadi kosong (0 endpoint tersisa), file itu ikut
 * dihapus beserta referensi import/router.use-nya di routes/index.js.
 */
function buildDeletePlan(body) {
  const { path: rawPath, method: rawMethod } = body || {};
  const fullPath = String(rawPath || "").trim();
  if (!fullPath) throw new ApiError("Path endpoint wajib diisi.", 400);
  const cleanMethod = rawMethod ? String(rawMethod).toUpperCase() : null;

  const { routeSlug, subPath } = splitApiPath(fullPath);

  const indexContent = fs.readFileSync(ROUTES_INDEX, "utf8");
  const routeFileBase = findRouteFileForSlug(indexContent, routeSlug);
  if (!routeFileBase) {
    throw new ApiError(`Gak ketemu route file yang di-mount di prefix "/${routeSlug}" di routes/index.js.`, 404);
  }

  const routeFilePath = path.join(ROUTES_DIR, `${routeFileBase}.routes.js`);
  if (!fs.existsSync(routeFilePath)) {
    throw new ApiError(`File src/routes/${routeFileBase}.routes.js tidak ditemukan.`, 404);
  }

  const originalRouteFileContent = fs.readFileSync(routeFilePath, "utf8");
  const { content: newRouteFileContent, removed: removedBlock } = removeRouteBlock(originalRouteFileContent, {
    subPath,
    method: cleanMethod
  });
  if (!removedBlock) {
    throw new ApiError(`Gak ketemu blok route untuk "${subPath}" di src/routes/${routeFileBase}.routes.js.`, 404);
  }

  const willDeleteRouteFile = countRouteBlocks(newRouteFileContent) === 0;

  const { cleanedContent: cleanedRouteFileContent, serviceFilesToDelete, orphanNames: orphanCandidateNames } =
    computeOrphanedServices(originalRouteFileContent, newRouteFileContent, { willDeleteRouteFile, routeFileBase });

  let finalIndexContent = indexContent;
  const { content: indexAfterRemoval, removed: removedFromIndex } = removeEndpointFromRoutesIndex(finalIndexContent, {
    path: fullPath,
    method: cleanMethod
  });
  finalIndexContent = indexAfterRemoval;
  if (willDeleteRouteFile) {
    finalIndexContent = removeRouteFileRefFromIndex(finalIndexContent, routeSlug);
  }

  const dataContent = fs.readFileSync(PUBLIC_DATA, "utf8");
  const { content: newDataContent, removed: removedFromData, categoryEmpty } = removeEndpointFromPublicData(dataContent, {
    path: fullPath,
    method: cleanMethod
  });

  const warnings = [];
  if (!removedFromIndex) warnings.push("Entry endpoint tidak ketemu di src/routes/index.js (format beda / sudah kehapus).");
  if (!removedFromData) warnings.push("Entry endpoint tidak ketemu di public/data.js (format beda / sudah kehapus).");
  if (categoryEmpty) warnings.push("Kategori terkait jadi kosong di public/data.js — kategori TIDAK otomatis dihapus, hapus manual kalau perlu.");
  if (willDeleteRouteFile) {
    warnings.push(`src/routes/${routeFileBase}.routes.js jadi kosong (tidak ada endpoint lain) — file ini akan DIHAPUS otomatis beserta referensinya di routes/index.js.`);
  }
  for (const s of serviceFilesToDelete) {
    warnings.push(`src/services/${s.serviceFileName}.service.js tidak dipakai endpoint lain manapun — file ini akan DIHAPUS otomatis.`);
  }
  const keptOrphans = [...new Set(orphanCandidateNames)].filter((n) => !serviceFilesToDelete.some((s) => s.serviceFileName === n));
  for (const n of keptOrphans) {
    warnings.push(`src/services/${n}.service.js masih di-import route file lain, jadi TIDAK dihapus (import/instance yang sudah tidak dipakai di file ini tetap dibersihkan).`);
  }

  return {
    routeFileBase,
    routeFilePath,
    originalRouteFileContent,
    newRouteFileContent: willDeleteRouteFile ? newRouteFileContent : cleanedRouteFileContent,
    willDeleteRouteFile,
    serviceFilesToDelete,
    originalIndexContent: indexContent,
    finalIndexContent,
    originalDataContent: dataContent,
    newDataContent,
    warnings,
    fullPath,
    method: cleanMethod || "ALL"
  };
}

router.get(
  "/endpoints",
  asyncHandler(async (req, res) => {
    return ok(res, { endpoints: listAllEndpoints() });
  })
);

router.get(
  "/whoami",
  asyncHandler(async (req, res) => {
    // Kalau request ini nyampe sini, artinya adminAuth (dipasang di
    // routes/index.js: router.use("/admin", adminAuth, adminRoutes)) udah
    // lolos duluan — key valid. Dipakai login.html buat verifikasi key
    // sebelum disimpen ke sessionStorage, tanpa nyoba akses data apapun.
    return ok(res, { authenticated: true });
  })
);

router.get(
  "/meta",
  asyncHandler(async (req, res) => {
    return ok(res, {
      categories: listExistingCategories(),
      routeFiles: listExistingRouteFiles()
    });
  })
);

/* ------------------------------------------------------------------ */
/* Tambah endpoint: preview (dry-run/diff) + apply (dengan rollback)   */
/* ------------------------------------------------------------------ */

router.post(
  "/preview",
  asyncHandler(async (req, res) => {
    const plan = buildPlan(req.body);

    const warnings = [];
    if (plan.depWarnings.length) {
      warnings.push(`Package belum ke-install: ${plan.depWarnings.join(", ")}. Jalankan "npm install ${plan.depWarnings.join(" ")}", atau centang "auto update package.json".`);
    }
    if (plan.serviceExists) warnings.push(`src/services/${plan.serviceFileName}.service.js sudah ada dan akan DITIMPA.`);
    if (plan.usesPerRequestInstance) warnings.push(`Constructor class ini butuh argumen, jadi instance-nya dibuat ULANG setiap request (bukan sekali di atas file).`);

    const files = [
      {
        path: `src/services/${plan.serviceFileName}.service.js`,
        isNew: !plan.serviceExists,
        content: plan.serviceFileContent,
        diff: plan.serviceExists ? compactDiff(diffLines(fs.readFileSync(plan.servicePath, "utf8"), plan.serviceFileContent)) : null
      },
      {
        path: `src/routes/${plan.routeSlug}.routes.js`,
        isNew: plan.isNewRouteFile,
        content: plan.routeFileContent,
        diff: plan.isNewRouteFile ? null : compactDiff(diffLines(plan.originalRouteFileContent, plan.routeFileContent))
      },
      {
        path: "src/routes/index.js",
        isNew: false,
        diff: compactDiff(diffLines(plan.originalIndexContent, plan.indexContent))
      },
      {
        path: "public/data.js",
        isNew: false,
        diff: compactDiff(diffLines(plan.originalDataContent, plan.dataContent))
      }
    ];
    if (plan.packageJsonContent) {
      files.push({
        path: "package.json",
        isNew: false,
        diff: compactDiff(diffLines(fs.readFileSync(PKG_PATH, "utf8"), plan.packageJsonContent))
      });
      warnings.push(`package.json akan diupdate otomatis: nambahin ${plan.depsAdded.join(", ") || "(tidak ada yang baru)"}.`);
    }

    return ok(res, {
      warnings,
      files,
      summary: { fullPath: plan.fullPath, method: plan.method }
    });
  })
);

router.post(
  "/apply",
  asyncHandler(async (req, res) => {
    const plan = buildPlan(req.body);

    const touchedPaths = [
      plan.servicePath,
      plan.routeFilePath,
      ROUTES_INDEX,
      PUBLIC_DATA,
      ...(plan.packageJsonContent ? [PKG_PATH] : [])
    ];

    // Snapshot buat riwayat (fitur undo) — diambil SEBELUM nulis apa pun.
    const historySnapshot = snapshotFiles(touchedPaths);

    withRollback(touchedPaths, () => {
      fs.writeFileSync(plan.servicePath, plan.serviceFileContent, "utf8");
      fs.writeFileSync(plan.routeFilePath, plan.routeFileContent, "utf8");
      fs.writeFileSync(ROUTES_INDEX, plan.indexContent, "utf8");
      fs.writeFileSync(PUBLIC_DATA, plan.dataContent, "utf8");
      if (plan.packageJsonContent) fs.writeFileSync(PKG_PATH, plan.packageJsonContent, "utf8");
    });

    let historyId = null;
    try {
      historyId = recordHistory({
        action: "add",
        summary: `Tambah endpoint ${plan.method} ${plan.fullPath}`,
        snapshot: historySnapshot
      }).id;
    } catch { /* riwayat best-effort, jangan gagalin apply */ }

    // Simpan test params buat health check (kalau dikirim frontend).
    try {
      if (req.body.testParams && typeof req.body.testParams === "object") {
        setHealthTest({
          method: plan.method,
          path: plan.fullPath,
          params: req.body.testParams,
          assertFields: Array.isArray(req.body.assertFields) ? req.body.assertFields : undefined
        });
      }
    } catch { /* best-effort */ }

    scheduleRestartAfterResponse(res);
    return ok(res, {
      message: "Endpoint baru berhasil dibuat. Server bakal auto-restart sebentar (kalau jalan via PM2/'npm start') atau nodemon (kalau 'npm run dev') buat nge-load file barunya — tunggu beberapa detik sebelum test endpoint-nya.",
      fullPath: plan.fullPath,
      method: plan.method,
      depsAdded: plan.depsAdded,
      historyId,
      filesWritten: [
        `src/services/${plan.serviceFileName}.service.js`,
        `src/routes/${plan.routeSlug}.routes.js`,
        "src/routes/index.js",
        "public/data.js",
        ...(plan.packageJsonContent ? ["package.json"] : [])
      ]
    });
  })
);

/* ------------------------------------------------------------------ */
/* Hapus endpoint: preview (dry-run/diff) + apply (dengan rollback)    */
/* ------------------------------------------------------------------ */

router.post(
  "/delete/preview",
  asyncHandler(async (req, res) => {
    const plan = buildDeletePlan(req.body);
    const files = [
      plan.willDeleteRouteFile
        ? { path: `src/routes/${plan.routeFileBase}.routes.js`, willDelete: true, content: null, diff: null }
        : {
            path: `src/routes/${plan.routeFileBase}.routes.js`,
            willDelete: false,
            diff: compactDiff(diffLines(plan.originalRouteFileContent, plan.newRouteFileContent))
          },
      { path: "src/routes/index.js", diff: compactDiff(diffLines(plan.originalIndexContent, plan.finalIndexContent)) },
      { path: "public/data.js", diff: compactDiff(diffLines(plan.originalDataContent, plan.newDataContent)) },
      ...plan.serviceFilesToDelete.map((s) => ({
        path: `src/services/${s.serviceFileName}.service.js`,
        willDelete: true,
        content: null,
        diff: null
      }))
    ];
    return ok(res, {
      warnings: plan.warnings,
      files,
      summary: { fullPath: plan.fullPath, method: plan.method }
    });
  })
);

router.post(
  "/delete/apply",
  asyncHandler(async (req, res) => {
    const plan = buildDeletePlan(req.body);

    const touchedPaths = [plan.routeFilePath, ROUTES_INDEX, PUBLIC_DATA, ...plan.serviceFilesToDelete.map((s) => s.servicePath)];

    const historySnapshot = snapshotFiles(touchedPaths);

    withRollback(touchedPaths, () => {
      if (plan.willDeleteRouteFile) fs.unlinkSync(plan.routeFilePath);
      else fs.writeFileSync(plan.routeFilePath, plan.newRouteFileContent, "utf8");
      for (const s of plan.serviceFilesToDelete) fs.unlinkSync(s.servicePath);
      fs.writeFileSync(ROUTES_INDEX, plan.finalIndexContent, "utf8");
      fs.writeFileSync(PUBLIC_DATA, plan.newDataContent, "utf8");
    });

    let historyId = null;
    try {
      historyId = recordHistory({
        action: "delete",
        summary: `Hapus endpoint ${plan.method} ${plan.fullPath}`,
        snapshot: historySnapshot
      }).id;
    } catch { /* best-effort */ }

    // Test params health check endpoint ini udah gak relevan.
    try { deleteHealthTest({ method: plan.method, path: plan.fullPath }); } catch { /* best-effort */ }

    scheduleRestartAfterResponse(res);
    return ok(res, {
      message: "Endpoint berhasil dihapus. Server bakal auto-restart sebentar buat nge-drop file lamanya — tunggu beberapa detik sebelum test lagi.",
      fullPath: plan.fullPath,
      method: plan.method,
      historyId,
      filesChanged: [
        plan.willDeleteRouteFile ? `src/routes/${plan.routeFileBase}.routes.js (dihapus)` : `src/routes/${plan.routeFileBase}.routes.js`,
        "src/routes/index.js",
        "public/data.js",
        ...plan.serviceFilesToDelete.map((s) => `src/services/${s.serviceFileName}.service.js (dihapus)`)
      ]
    });
  })
);

/* ------------------------------------------------------------------ */
/* Fitur 10 (best-effort): auto-test endpoint yang baru dibuat, dengan */
/* nge-hit server sendiri lewat HTTP. CATATAN PENTING: kalau server    */
/* jalan via nodemon, proses Node lama akan di-restart setelah file    */
/* ke-apply, jadi endpoint baru baru live SETELAH restart itu selesai. */
/* Makanya endpoint ini dipanggil terpisah (bukan otomatis dalam       */
/* /apply), dan sebaiknya dikasih jeda beberapa detik dulu di sisi     */
/* client sebelum manggil ini.                                         */
/* ------------------------------------------------------------------ */
router.post(
  "/verify",
  asyncHandler(async (req, res) => {
    const { fullPath, method, testParams } = req.body || {};
    if (!fullPath) throw new ApiError("fullPath wajib diisi.", 400);

    const httpMethod = (method || "GET").toUpperCase() === "POST" ? "POST" : "GET";

    // Cuma boleh nge-hit endpoint yang emang beneran terdaftar (hasil apply
    // sebelumnya) — jangan percaya fullPath dari body mentah-mentah buat
    // dijadiin target fetch, walaupun ini localhost-only.
    const known = listAllEndpoints().some(
      (e) => e.path === fullPath && (e.method || "GET").toUpperCase().includes(httpMethod)
    );
    if (!known) {
      throw new ApiError(`Endpoint '${fullPath}' (${httpMethod}) belum terdaftar di routes/index.js.`, 400);
    }

    const port = process.env.PORT || 3000;
    const base = `http://localhost:${port}`;

    let target;
    try {
      target = new URL(base + fullPath);
    } catch {
      throw new ApiError("fullPath tidak valid.", 400);
    }

    const fetchOpts = { method: httpMethod === "POST" ? "POST" : "GET" };
    if (httpMethod === "GET" && testParams) {
      for (const [k, v] of Object.entries(testParams)) target.searchParams.set(k, v);
    } else if (httpMethod === "POST" && testParams) {
      fetchOpts.headers = { "Content-Type": "application/json" };
      fetchOpts.body = JSON.stringify(testParams);
    }

    try {
      const resp = await fetch(target.toString(), fetchOpts);
      const text = await resp.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text.slice(0, 500); }

      if (resp.status >= 500) {
        return ok(res, {
          success: false,
          status: resp.status,
          message: "Endpoint berhasil dibuat, tapi ERROR pas dijalankan.",
          body
        });
      }
      return ok(res, { success: true, status: resp.status, body });
    } catch (err) {
      return ok(res, {
        success: false,
        message: "Belum bisa konek ke server sendiri — biasanya karena masih proses restart (nodemon). Coba lagi beberapa detik lagi.",
        error: err.message
      });
    }
  })
);

/* ------------------------------------------------------------------ */
/* Detail 1 endpoint (buat prefill form "Edit Endpoint" di admin panel) */
/* ------------------------------------------------------------------ */

router.get(
  "/endpoints/detail",
  asyncHandler(async (req, res) => {
    const { path: fullPath, method } = req.query || {};
    if (!fullPath) throw new ApiError("Query 'path' wajib diisi.", 400);

    const dataContent = fs.readFileSync(PUBLIC_DATA, "utf8");
    const detail = findEndpointObject(dataContent, { path: fullPath, method });
    if (!detail) throw new ApiError(`Endpoint "${fullPath}" tidak ketemu di public/data.js.`, 404);

    // Best-effort: tebak nama service file & instance var asli, buat prefill
    // form "Regenerate Penuh" — cuma akurat kalau route file itu isinya 1
    // service doang (kasus paling umum, hasil scaffold "route file baru").
    // Kalau ambigu (>1 service di file yang sama), dibiarin null — user isi
    // manual, gak masalah karena field ini cuma prefill kok.
    let routeFileBase = null;
    let suggestedServiceFileName = null;
    let suggestedInstanceName = null;
    let endpointCountInSameFile = null;
    try {
      const { routeSlug } = splitApiPath(fullPath);
      const indexContent = fs.readFileSync(ROUTES_INDEX, "utf8");
      routeFileBase = findRouteFileForSlug(indexContent, routeSlug) || routeSlug;
      const routeFilePathGuess = path.join(ROUTES_DIR, `${routeFileBase}.routes.js`);
      if (fs.existsSync(routeFilePathGuess)) {
        const routeContent = fs.readFileSync(routeFilePathGuess, "utf8");
        const imports = extractServiceImports(routeContent);
        if (imports.length === 1) {
          suggestedServiceFileName = imports[0].serviceFileName;
          const decls = extractInstanceDecls(routeContent);
          const decl = decls.find((d) => d.className === imports[0].className);
          suggestedInstanceName = decl ? decl.instanceName : null;
        }
      }
      endpointCountInSameFile = listAllEndpoints().filter((e) => splitApiPath(e.path).routeSlug === routeSlug).length;
    } catch {
      // best-effort doang — biarin null semua kalau ada yang gagal di-parse
    }

    return ok(res, {
      endpoint: { ...detail, routeFileBase, suggestedServiceFileName, suggestedInstanceName, endpointCountInSameFile }
    });
  })
);

/* ------------------------------------------------------------------ */
/* Quick edit: ubah nama/deskripsi/kategori/required+desc per param    */
/* SAJA — tidak menyentuh logic/kode service maupun signature param.   */
/* Aman & langsung apply (tanpa preview) karena cuma nyentuh dokumentasi*/
/* (public/data.js) dan entry ringkasan di src/routes/index.js.        */
/* ------------------------------------------------------------------ */

router.post(
  "/endpoints/quick-edit",
  asyncHandler(async (req, res) => {
    const { path: fullPath, method, endpointName, endpointDesc, categoryId, params } = req.body || {};
    if (!fullPath) throw new ApiError("path wajib diisi.", 400);
    if (!categoryId) throw new ApiError("categoryId wajib diisi.", 400);

    const dataContent = fs.readFileSync(PUBLIC_DATA, "utf8");
    const detail = findEndpointObject(dataContent, { path: fullPath, method });
    if (!detail) throw new ApiError(`Endpoint "${fullPath}" tidak ketemu di public/data.js.`, 404);

    const paramOverrides = new Map((params || []).map((p) => [p.name, p]));
    const mergeParam = (p) => {
      const ov = paramOverrides.get(p.name);
      return {
        name: p.name,
        required: ov && typeof ov.required === "boolean" ? ov.required : p.required,
        desc: ov && typeof ov.desc === "string" ? ov.desc : p.desc
      };
    };

    const endpointObj = {
      name: endpointName || detail.name,
      method: detail.method,
      path: detail.path,
      desc: endpointDesc ?? detail.desc,
      pathParams: detail.pathParams,
      query: detail.query.map(mergeParam)
    };

    const { content: dataAfterRemove, categoryEmpty } = removeEndpointFromPublicData(dataContent, {
      path: fullPath,
      method
    });
    const knownCategories = listExistingCategories();
    if (!knownCategories.some((c) => c.id === categoryId)) {
      throw new ApiError(`Kategori "${categoryId}" tidak ketemu.`, 404);
    }
    const newDataContent = updatePublicData(dataAfterRemove, { mode: "existing", categoryId, endpointObj });

    const { routeSlug } = splitApiPath(fullPath);
    const indexContent = fs.readFileSync(ROUTES_INDEX, "utf8");
    const { content: indexAfterRemove } = removeEndpointFromRoutesIndex(indexContent, { path: fullPath, method });
    const idxParams = [
      ...detail.pathParams.map((p) => `${p.name} (path)`),
      ...endpointObj.query.map((p) => `${p.name}${p.required ? "" : "?"}`)
    ];
    const newIndexContent = updateRoutesIndex(indexAfterRemove, {
      routeSlug,
      isNewRouteFile: false,
      endpointEntry: { name: endpointObj.name, method: detail.method, path: fullPath, params: idxParams }
    });

    withRollback([PUBLIC_DATA, ROUTES_INDEX], () => {
      fs.writeFileSync(PUBLIC_DATA, newDataContent, "utf8");
      fs.writeFileSync(ROUTES_INDEX, newIndexContent, "utf8");
    });

    return ok(res, {
      message: "Metadata endpoint berhasil diupdate.",
      warnings: categoryEmpty ? ["Kategori asal jadi kosong sebelum entry baru disisipkan — cek public/data.js kalau perlu."] : []
    });
  })
);

/* ------------------------------------------------------------------ */
/* Full edit: ganti definisi endpoint (bisa ubah method/params/logic)  */
/* — dikerjakan sebagai HAPUS blok lama lalu TULIS blok baru, atomik.  */
/* Payload sama seperti /preview & /apply (tambah endpoint), plus      */
/* originalPath & originalMethod buat nunjuk endpoint mana yang diganti*/
/* ------------------------------------------------------------------ */

router.post(
  "/edit/preview",
  asyncHandler(async (req, res) => {
    const { originalPath, originalMethod, ...addBody } = req.body || {};
    if (!originalPath) throw new ApiError("originalPath (endpoint yang mau diedit) wajib diisi.", 400);

    const deletePlan = buildDeletePlan({ path: originalPath, method: originalMethod });
    const fileOverrides = {
      [ROUTES_INDEX]: deletePlan.finalIndexContent,
      [PUBLIC_DATA]: deletePlan.newDataContent,
      [deletePlan.routeFilePath]: deletePlan.willDeleteRouteFile ? null : deletePlan.newRouteFileContent
    };
    const addPlan = buildPlan(addBody, { fileOverrides });

    const routeFiles = [];
    if (deletePlan.routeFilePath === addPlan.routeFilePath) {
      routeFiles.push({
        path: `src/routes/${addPlan.routeSlug}.routes.js`,
        isNew: deletePlan.willDeleteRouteFile,
        diff: deletePlan.willDeleteRouteFile ? null : compactDiff(diffLines(deletePlan.originalRouteFileContent, addPlan.routeFileContent))
      });
    } else {
      routeFiles.push(
        deletePlan.willDeleteRouteFile
          ? { path: `src/routes/${deletePlan.routeFileBase}.routes.js`, willDelete: true, diff: null }
          : { path: `src/routes/${deletePlan.routeFileBase}.routes.js`, willDelete: false, diff: compactDiff(diffLines(deletePlan.originalRouteFileContent, deletePlan.newRouteFileContent)) },
        {
          path: `src/routes/${addPlan.routeSlug}.routes.js`,
          isNew: addPlan.isNewRouteFile,
          diff: addPlan.isNewRouteFile ? null : compactDiff(diffLines(addPlan.originalRouteFileContent, addPlan.routeFileContent))
        }
      );
    }

    const files = [
      {
        path: `src/services/${addPlan.serviceFileName}.service.js`,
        isNew: !addPlan.serviceExists,
        diff: addPlan.serviceExists ? compactDiff(diffLines(fs.readFileSync(addPlan.servicePath, "utf8"), addPlan.serviceFileContent)) : null
      },
      ...routeFiles,
      { path: "src/routes/index.js", diff: compactDiff(diffLines(deletePlan.originalIndexContent, addPlan.indexContent)) },
      { path: "public/data.js", diff: compactDiff(diffLines(deletePlan.originalDataContent, addPlan.dataContent)) },
      ...deletePlan.serviceFilesToDelete
        .filter((s) => s.serviceFileName !== addPlan.serviceFileName)
        .map((s) => ({ path: `src/services/${s.serviceFileName}.service.js`, willDelete: true, diff: null }))
    ];

    const warnings = [...deletePlan.warnings];
    if (addPlan.depWarnings.length) {
      warnings.push(`Package belum ke-install: ${addPlan.depWarnings.join(", ")}.`);
    }

    return ok(res, {
      warnings,
      files,
      summary: { removedPath: deletePlan.fullPath, removedMethod: deletePlan.method, newPath: addPlan.fullPath, newMethod: addPlan.method }
    });
  })
);

router.post(
  "/edit/apply",
  asyncHandler(async (req, res) => {
    const { originalPath, originalMethod, ...addBody } = req.body || {};
    if (!originalPath) throw new ApiError("originalPath (endpoint yang mau diedit) wajib diisi.", 400);

    const deletePlan = buildDeletePlan({ path: originalPath, method: originalMethod });
    const fileOverrides = {
      [ROUTES_INDEX]: deletePlan.finalIndexContent,
      [PUBLIC_DATA]: deletePlan.newDataContent,
      [deletePlan.routeFilePath]: deletePlan.willDeleteRouteFile ? null : deletePlan.newRouteFileContent
    };
    const addPlan = buildPlan(addBody, { fileOverrides });

    const touchedPaths = [
      ...new Set([
        deletePlan.routeFilePath,
        addPlan.routeFilePath,
        ROUTES_INDEX,
        PUBLIC_DATA,
        addPlan.servicePath,
        ...deletePlan.serviceFilesToDelete.map((s) => s.servicePath),
        ...(addPlan.packageJsonContent ? [PKG_PATH] : [])
      ])
    ];

    const historySnapshot = snapshotFiles(touchedPaths);

    withRollback(touchedPaths, () => {
      const sameRouteFile = deletePlan.routeFilePath === addPlan.routeFilePath;

      if (!sameRouteFile) {
        if (deletePlan.willDeleteRouteFile) {
          if (fs.existsSync(deletePlan.routeFilePath)) fs.unlinkSync(deletePlan.routeFilePath);
        } else {
          fs.writeFileSync(deletePlan.routeFilePath, deletePlan.newRouteFileContent, "utf8");
        }
      }
      // Kalau sameRouteFile: gak perlu tulis apa-apa di sini — konten akhir
      // file itu (blok lama sudah hilang, blok baru sudah nempel) udah ada
      // di addPlan.routeFileContent (dihitung dari fileOverrides di atas),
      // dan bakal ditulis di bawah.

      for (const s of deletePlan.serviceFilesToDelete) {
        if (s.servicePath !== addPlan.servicePath && fs.existsSync(s.servicePath)) fs.unlinkSync(s.servicePath);
      }

      fs.writeFileSync(addPlan.servicePath, addPlan.serviceFileContent, "utf8");
      fs.writeFileSync(addPlan.routeFilePath, addPlan.routeFileContent, "utf8");
      fs.writeFileSync(ROUTES_INDEX, addPlan.indexContent, "utf8");
      fs.writeFileSync(PUBLIC_DATA, addPlan.dataContent, "utf8");
      if (addPlan.packageJsonContent) fs.writeFileSync(PKG_PATH, addPlan.packageJsonContent, "utf8");
    });

    scheduleRestartAfterResponse(res);
    let historyId = null;
    try {
      historyId = recordHistory({
        action: "edit",
        summary: `Edit endpoint ${deletePlan.fullPath} → ${addPlan.method} ${addPlan.fullPath}`,
        snapshot: historySnapshot
      }).id;
    } catch { /* best-effort */ }

    return ok(res, {
      message: "Endpoint berhasil diedit. Server bakal auto-restart sebentar buat nge-load ulang — tunggu beberapa detik sebelum test lagi.",
      removedPath: deletePlan.fullPath,
      newPath: addPlan.fullPath,
      method: addPlan.method,
      historyId
    });
  })
);

/* ------------------------------------------------------------------ */
/* Batch scaffold: banyak method -> banyak endpoint dalam SEKALI apply */
/* Payload: { classCode, serviceFileName, instanceName, routeMode,     */
/*   routeFile/newRouteSlug, categoryMode, categoryId/newCategory,     */
/*   autoInstallDeps, endpoints: [{ selectedMethod, subPath,           */
/*   httpMethod, endpointName, endpointDesc, methodParams, ctorParams  */
/* }] } — field per-endpoint di array, sisanya dibagi bareng.          */
/* Diproses berurutan pakai buildPlan + fileOverrides akumulatif       */
/* (endpoint ke-2 "melihat" hasil endpoint ke-1, dst), jadi validasi   */
/* duplikat & append route block-nya persis sama kayak apply satuan.   */
/* ------------------------------------------------------------------ */

function buildBatchPlans(body) {
  const { endpoints, ...shared } = body || {};
  if (!Array.isArray(endpoints) || !endpoints.length) {
    throw new ApiError("Daftar endpoints kosong — pilih minimal 1 method.", 400);
  }
  if (endpoints.length > 20) throw new ApiError("Maksimal 20 endpoint per batch.", 400);

  const plans = [];
  const fileOverrides = {};
  let routeMode = shared.routeMode;
  let categoryMode = shared.categoryMode;
  let categoryId = shared.categoryId;

  for (const [i, ep] of endpoints.entries()) {
    let plan;
    try {
      plan = buildPlan(
        { ...shared, ...ep, routeMode, categoryMode, categoryId },
        { fileOverrides: { ...fileOverrides } }
      );
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e.message || e);
      throw new ApiError(`Endpoint #${i + 1} (${ep.selectedMethod || "?"}): ${msg}`, e.statusCode || 400);
    }
    plans.push(plan);

    // Akumulasi hasil buat endpoint berikutnya di batch yang sama.
    fileOverrides[plan.servicePath] = plan.serviceFileContent;
    fileOverrides[plan.routeFilePath] = plan.routeFileContent;
    fileOverrides[ROUTES_INDEX] = plan.indexContent;
    fileOverrides[PUBLIC_DATA] = plan.dataContent;

    // Setelah endpoint pertama: route file & kategori barunya udah "ada"
    // (di overrides) — endpoint berikutnya harus pakai mode existing,
    // kalau enggak buildPlan nolak karena "file/kategori sudah ada".
    if (routeMode !== "existing") {
      routeMode = "existing";
      shared.routeFile = plan.routeSlug;
    }
    if (categoryMode !== "existing") {
      categoryMode = "existing";
      categoryId = slugify(shared.newCategory?.id || "").toLowerCase();
    }
  }
  return plans;
}

router.post(
  "/batch/preview",
  asyncHandler(async (req, res) => {
    const plans = buildBatchPlans(req.body);
    const first = plans[0];
    const last = plans[plans.length - 1];

    const warnings = [];
    if (first.depWarnings.length) {
      warnings.push(`Package belum ke-install: ${first.depWarnings.join(", ")}.`);
    }
    if (first.serviceExists) warnings.push(`src/services/${first.serviceFileName}.service.js sudah ada dan akan DITIMPA.`);

    // Diff kumulatif: bandingkan kondisi disk sekarang vs hasil AKHIR batch.
    const files = [
      {
        path: `src/services/${first.serviceFileName}.service.js`,
        isNew: !first.serviceExists,
        content: last.serviceFileContent,
        diff: first.serviceExists ? compactDiff(diffLines(fs.readFileSync(first.servicePath, "utf8"), last.serviceFileContent)) : null
      },
      {
        path: `src/routes/${first.routeSlug}.routes.js`,
        isNew: first.isNewRouteFile,
        content: last.routeFileContent,
        diff: first.isNewRouteFile ? null : compactDiff(diffLines(first.originalRouteFileContent, last.routeFileContent))
      },
      { path: "src/routes/index.js", isNew: false, diff: compactDiff(diffLines(first.originalIndexContent, last.indexContent)) },
      { path: "public/data.js", isNew: false, diff: compactDiff(diffLines(first.originalDataContent, last.dataContent)) }
    ];
    if (last.packageJsonContent) {
      files.push({ path: "package.json", isNew: false, diff: compactDiff(diffLines(fs.readFileSync(PKG_PATH, "utf8"), last.packageJsonContent)) });
    }

    return ok(res, {
      warnings,
      files,
      summary: { endpoints: plans.map((p) => ({ fullPath: p.fullPath, method: p.method })) }
    });
  })
);

router.post(
  "/batch/apply",
  asyncHandler(async (req, res) => {
    const plans = buildBatchPlans(req.body);
    const first = plans[0];
    const last = plans[plans.length - 1];

    const touchedPaths = [
      first.servicePath,
      first.routeFilePath,
      ROUTES_INDEX,
      PUBLIC_DATA,
      ...(last.packageJsonContent ? [PKG_PATH] : [])
    ];

    const historySnapshot = snapshotFiles(touchedPaths);

    withRollback(touchedPaths, () => {
      // Konten akhir tiap file udah kumulatif di plan TERAKHIR.
      fs.writeFileSync(first.servicePath, last.serviceFileContent, "utf8");
      fs.writeFileSync(first.routeFilePath, last.routeFileContent, "utf8");
      fs.writeFileSync(ROUTES_INDEX, last.indexContent, "utf8");
      fs.writeFileSync(PUBLIC_DATA, last.dataContent, "utf8");
      if (last.packageJsonContent) fs.writeFileSync(PKG_PATH, last.packageJsonContent, "utf8");
    });

    let historyId = null;
    try {
      historyId = recordHistory({
        action: "add",
        summary: `Batch tambah ${plans.length} endpoint: ${plans.map((p) => p.fullPath).join(", ")}`,
        snapshot: historySnapshot
      }).id;
    } catch { /* best-effort */ }

    scheduleRestartAfterResponse(res);
    return ok(res, {
      message: `${plans.length} endpoint berhasil dibuat sekaligus. Server bakal auto-restart sebentar — tunggu beberapa detik sebelum test.`,
      endpoints: plans.map((p) => ({ fullPath: p.fullPath, method: p.method })),
      historyId,
      filesWritten: [
        `src/services/${first.serviceFileName}.service.js`,
        `src/routes/${first.routeSlug}.routes.js`,
        "src/routes/index.js",
        "public/data.js",
        ...(last.packageJsonContent ? ["package.json"] : [])
      ]
    });
  })
);

/* ------------------------------------------------------------------ */
/* Riwayat scaffold + rollback (undo)                                  */
/* ------------------------------------------------------------------ */

router.get(
  "/history",
  asyncHandler(async (req, res) => {
    return ok(res, { history: listHistory() });
  })
);

router.post(
  "/history/rollback",
  asyncHandler(async (req, res) => {
    const { id } = req.body || {};
    if (!id) throw new ApiError("id entry riwayat wajib diisi.", 400);
    const entry = getHistoryEntry(id);
    if (!entry) throw new ApiError(`Entry riwayat "${id}" tidak ditemukan.`, 404);

    let result;
    try {
      result = rollbackHistory(id);
    } catch (e) {
      throw new ApiError(`Rollback gagal: ${e.message}`, 500);
    }

    // Entry-nya sengaja TIDAK dihapus setelah rollback — bisa dipakai
    // buat "redo" manual (isi file sebelum rollback ikut kesimpen di
    // entry riwayat baru di bawah).
    try {
      const snapPaths = Object.keys(entry.files || {}).map((rel) => path.join(ROOT, rel));
      recordHistory({
        action: "rollback",
        summary: `Rollback: ${entry.summary}`,
        snapshot: snapshotFiles(snapPaths)
      });
    } catch { /* best-effort */ }

    scheduleRestartAfterResponse(res);
    return ok(res, {
      message: `Rollback "${entry.summary}" berhasil. Server bakal auto-restart sebentar.`,
      actions: result.actions
    });
  })
);

router.delete(
  "/history/:id",
  asyncHandler(async (req, res) => {
    try {
      deleteHistoryEntry(req.params.id);
    } catch (e) {
      throw new ApiError(e.message, 404);
    }
    return ok(res, { message: "Entry riwayat dihapus." });
  })
);

/* ------------------------------------------------------------------ */
/* Usage analytics                                                     */
/* ------------------------------------------------------------------ */

router.get(
  "/usage",
  asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 30);
    flushUsage(); // pastiin data terbaru kebaca
    const summary = usageSummary(days);

    // Gabungin sama daftar client biar nama & tier-nya kebawa (usage
    // nyimpen per apiKey/IP doang).
    const clients = listClients();
    const byKey = new Map(clients.map((c) => [c.apiKey, c]));
    const rows = Object.entries(summary.byClient)
      .map(([clientKey, u]) => ({
        clientKey,
        name: byKey.get(clientKey)?.name || null, // null = anonim (IP) atau key udah dicabut
        tier: u.tier,
        total: u.total,
        today: u.today,
        limited: u.limited,
        topPaths: Object.entries(u.byPath).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, n]) => ({ path: p, hits: n }))
      }))
      .sort((a, b) => b.total - a.total);

    return ok(res, { days: summary.days, clients: rows, topPaths: summary.topPaths.slice(0, 15) });
  })
);

/* ------------------------------------------------------------------ */
/* Cache per endpoint (TTL)                                            */
/* ------------------------------------------------------------------ */

router.get(
  "/cache",
  asyncHandler(async (req, res) => {
    return ok(res, { config: loadCacheConfig(), stats: cacheStats() });
  })
);

router.post(
  "/cache",
  asyncHandler(async (req, res) => {
    const { path: epPath, ttlSeconds } = req.body || {};
    const clean = String(epPath || "").trim();
    if (!clean.startsWith("/api/")) throw new ApiError("path harus diawali /api/", 400);
    const ttl = Number(ttlSeconds);
    if (!Number.isInteger(ttl) || ttl < 0 || ttl > 86400) {
      throw new ApiError("ttlSeconds harus bilangan bulat 0-86400 (0 = hapus rule).", 400);
    }

    const config = loadCacheConfig();
    if (ttl === 0) delete config[clean];
    else config[clean] = { ttlSeconds: ttl };
    saveCacheConfig(config);
    clearResponseCache(); // rule berubah -> isi lama gak valid lagi

    return ok(res, { message: ttl === 0 ? `Rule cache ${clean} dihapus.` : `Cache ${clean} di-set ${ttl} detik.`, config });
  })
);

router.post(
  "/cache/clear",
  asyncHandler(async (req, res) => {
    const cleared = clearResponseCache();
    return ok(res, { message: `${cleared} entry cache dibersihkan.` });
  })
);

/* ------------------------------------------------------------------ */
/* Log viewer                                                          */
/* ------------------------------------------------------------------ */

router.get(
  "/logs",
  asyncHandler(async (req, res) => {
    rotateIfNeeded();
    const { lines, filter } = req.query || {};
    return ok(res, tailAccessLog({ lines, filter }));
  })
);

/* ------------------------------------------------------------------ */
/* Health check semua endpoint                                         */
/* ------------------------------------------------------------------ */

router.get(
  "/health-tests",
  asyncHandler(async (req, res) => {
    return ok(res, { tests: loadHealthTests() });
  })
);

router.post(
  "/health-tests",
  asyncHandler(async (req, res) => {
    const { path: epPath, method, params, assertFields } = req.body || {};
    if (!epPath) throw new ApiError("path wajib diisi.", 400);
    // Cuma boleh buat endpoint yang beneran terdaftar.
    const known = listAllEndpoints().some((e) => e.path === epPath);
    if (!known) throw new ApiError(`Endpoint "${epPath}" tidak terdaftar.`, 404);
    if (assertFields !== undefined && !Array.isArray(assertFields)) {
      throw new ApiError("assertFields harus array dot-path, mis. [\"result.url\"].", 400);
    }
    setHealthTest({ method, path: epPath, params, assertFields });
    return ok(res, { message: `Test params buat ${epPath} disimpan.` });
  })
);

router.delete(
  "/health-tests",
  asyncHandler(async (req, res) => {
    // path/method lewat query (DELETE body suka di-drop proxy/fetch lama).
    const { path: epPath, method } = req.query || {};
    if (!epPath) throw new ApiError("Query 'path' wajib diisi.", 400);
    const tests = loadHealthTests();
    const key = healthTestKey(method, epPath);
    if (!tests[key]) throw new ApiError(`Belum ada test params tersimpan buat "${epPath}".`, 404);
    deleteHealthTest({ method, path: epPath });
    return ok(res, { message: `Test params buat ${epPath} dihapus.` });
  })
);

router.post(
  "/health/run",
  asyncHandler(async (req, res) => {
    const port = process.env.PORT || 3000;
    const result = await runHealthCheck({ baseUrl: `http://localhost:${port}` });
    return ok(res, result);
  })
);

/* ------------------------------------------------------------------ */
/* Ekspor OpenAPI                                                      */
/* ------------------------------------------------------------------ */

router.get(
  "/openapi.json",
  asyncHandler(async (req, res) => {
    const proto = req.get("x-forwarded-proto") || req.protocol;
    const baseUrl = `${proto}://${req.get("host")}`;
    const spec = buildOpenApiSpec({ baseUrl });
    res.setHeader("Content-Disposition", 'inline; filename="openapi.json"');
    return res.json(spec);
  })
);

/* ------------------------------------------------------------------ */
/* Backup & restore — bundle JSON semua file yang gak bisa direkonstruksi */
/* dari git (clients.json, health-tests, cache-config, kode hasil       */
/* scaffold). Penting di Railway: filesystem ephemeral, sekali redeploy  */
/* tanpa volume semua client key hilang. Lihat src/utils/backup.js.      */
/* ------------------------------------------------------------------ */

router.get(
  "/backup",
  asyncHandler(async (req, res) => {
    const bundle = buildBackupBundle();
    const stamp = bundle.createdAt.slice(0, 19).replace(/[:T]/g, "-");
    res.setHeader("Content-Disposition", `attachment; filename="febry-api-backup-${stamp}.json"`);
    return res.json(bundle);
  })
);

router.post(
  "/backup/restore",
  asyncHandler(async (req, res) => {
    const bundle = req.body;
    let result;
    try {
      result = restoreBackupBundle(bundle);
    } catch (e) {
      throw new ApiError(`Restore gagal: ${e.message}`, 400);
    }

    // Kondisi SEBELUM restore dicatat ke riwayat — restore yang salah
    // bundle bisa di-undo dari panel Ops kayak apply endpoint biasa.
    let historyId = null;
    try {
      historyId = recordHistory({
        action: "restore",
        summary: `Restore backup${bundle.createdAt ? ` (dibuat ${bundle.createdAt})` : ""} — ${result.written.length} file`,
        snapshot: result.preSnapshot || {}
      }).id;
    } catch { /* best-effort */ }

    scheduleRestartAfterResponse(res);
    return ok(res, {
      message: `${result.written.length} file di-restore. Server bakal auto-restart sebentar buat nge-load kode hasil restore — tunggu beberapa detik.`,
      written: result.written,
      skipped: result.skipped,
      historyId
    });
  })
);

/* ------------------------------------------------------------------ */
/* Manajemen client / API key & tier (dipakai client-manager.html)     */
/* ------------------------------------------------------------------ */

router.get(
  "/clients",
  asyncHandler(async (req, res) => {
    return ok(res, { clients: listClients() });
  })
);

router.post(
  "/clients",
  asyncHandler(async (req, res) => {
    const { name, tier, expiresAt, dailyQuota } = req.body || {};
    try {
      const client = createClient({ name, tier, expiresAt, dailyQuota });
      return ok(res, { client });
    } catch (err) {
      throw new ApiError(err.message, 400);
    }
  })
);

router.patch(
  "/clients/:apiKey",
  asyncHandler(async (req, res) => {
    const { name, tier, expiresAt, dailyQuota } = req.body || {};
    try {
      const client = updateClient(req.params.apiKey, { name, tier, expiresAt, dailyQuota });
      return ok(res, { client });
    } catch (err) {
      throw new ApiError(err.message, err.message.includes("tidak ditemukan") ? 404 : 400);
    }
  })
);

router.delete(
  "/clients/:apiKey",
  asyncHandler(async (req, res) => {
    try {
      deleteClient(req.params.apiKey);
      return ok(res, { message: "Client key berhasil dicabut." });
    } catch (err) {
      throw new ApiError(err.message, 404);
    }
  })
);

export default router;
export { buildPlan, buildDeletePlan };

// Plan builder buat scaffold endpoint (dipakai bareng preview & apply,
// satuan/batch/edit/delete) + helper restart. Dipisah dari
// admin.routes.js monolitik — logikanya tidak berubah.
import fs from "fs";
import path from "path";
import { ApiError } from "../../utils/response.js";
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
  findMethodOrThrow,
  ParserUnsupportedError,
  buildServiceFileContent,
  buildRouteBlockCode,
  buildNewRouteFileContent,
  appendRouteBlockToExistingFile,
  updateRoutesIndex,
  updatePublicData,
  extractPathParams,
  splitApiPath,
  findRouteFileForSlug,
  removeRouteBlock,
  countRouteBlocks,
  removeRouteFileRefFromIndex,
  removeEndpointFromRoutesIndex,
  removeEndpointFromPublicData,
  computeOrphanedServices,
  findDuplicateEndpoint,
  escapeRegex
} from "../../utils/scaffold.js";

export const PKG_PATH = path.join(ROOT, "package.json");

/**
 * Jadwalin restart proses (biar file baru ke-`import` ulang) TAPI baru
 * SETELAH response request ini beneran selesai dikirim ke client —
 * dengerin event 'finish', bukan restart reaktif dari file-watcher (yang
 * balapan sama response-nya sendiri, lihat catatan di ecosystem.config.cjs).
 * PM2 (autorestart: true, lihat ecosystem.config.cjs) yang nyalain proses
 * baru begitu ini exit — via `npm start` biasa (bukan pm2-runtime), gak
 * ada yang restart otomatis, jadi tetap perlu restart manual seperti biasa.
 */
export function scheduleRestartAfterResponse(res) {
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
export function safeExtractClassMethods(classBlock) {
  try {
    return extractClassMethods(classBlock);
  } catch (e) {
    if (e instanceof ParserUnsupportedError) throw new ApiError(e.message, 400);
    throw e;
  }
}

/**
 * Susun semua bahan (nama file, konten yang akan ditulis, dsb) dari
 * payload form. Dipakai bareng oleh /preview dan /apply supaya hasilnya
 * konsisten (preview = simulasi persis apa yang akan ditulis /apply).
 */
export function buildPlan(body, opts = {}) {
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
export function buildDeletePlan(body) {
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

export function buildBatchPlans(body) {
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

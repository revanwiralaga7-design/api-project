// Route scaffold endpoint (analyze/preview/apply, edit, delete, batch,
// verify, quick-edit) — dipisah dari admin.routes.js monolitik,
// logikanya tidak berubah.
import { Router } from "express";
import fs from "fs";
import path from "path";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ok, ApiError } from "../../utils/response.js";
import {
  ROUTES_DIR,
  ROUTES_INDEX,
  PUBLIC_DATA,
  extractClassInfo,
  checkMissingDeps,
  detectInternallyCalledMethods,
  validateParsedMethodParams,
  updateRoutesIndex,
  updatePublicData,
  listExistingCategories,
  listExistingRouteFiles,
  listAllEndpoints,
  splitApiPath,
  findRouteFileForSlug,
  removeEndpointFromRoutesIndex,
  removeEndpointFromPublicData,
  extractServiceImports,
  extractInstanceDecls,
  diffLines,
  compactDiff,
  snapshotFiles,
  withRollback,
  findEndpointObject,
} from "../../utils/scaffold.js";
import { recordHistory } from "../../utils/history.js";
import { setHealthTest, deleteHealthTest } from "../../utils/health.js";
import {
  PKG_PATH,
  scheduleRestartAfterResponse,
  safeExtractClassMethods,
  buildPlan,
  buildDeletePlan,
  buildBatchPlans,
} from "./planBuilders.js";

const router = Router();

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
          isCalledInternally: internallyCalled.has(m.name),
        })),
      constructor: ctor
        ? {
            paramStyle: ctor.params.style,
            paramNames: ctor.params.names,
            paramsMeta: ctor.params.params,
            paramsOptional: ctor.params.optional,
            validation: validateParsedMethodParams(ctor.params),
          }
        : {
            paramStyle: "none",
            paramNames: [],
            paramsMeta: [],
            paramsOptional: false,
            validation: { ok: true, lines: [], summary: "Parser OK" },
          },
      depWarnings,
    });
  })
);

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
      routeFiles: listExistingRouteFiles(),
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
      warnings.push(
        `Package belum ke-install: ${plan.depWarnings.join(", ")}. Jalankan "npm install ${plan.depWarnings.join(" ")}", atau centang "auto update package.json".`
      );
    }
    if (plan.serviceExists)
      warnings.push(`src/services/${plan.serviceFileName}.service.js sudah ada dan akan DITIMPA.`);
    if (plan.usesPerRequestInstance)
      warnings.push(
        `Constructor class ini butuh argumen, jadi instance-nya dibuat ULANG setiap request (bukan sekali di atas file).`
      );

    const files = [
      {
        path: `src/services/${plan.serviceFileName}.service.js`,
        isNew: !plan.serviceExists,
        content: plan.serviceFileContent,
        diff: plan.serviceExists
          ? compactDiff(diffLines(fs.readFileSync(plan.servicePath, "utf8"), plan.serviceFileContent))
          : null,
      },
      {
        path: `src/routes/${plan.routeSlug}.routes.js`,
        isNew: plan.isNewRouteFile,
        content: plan.routeFileContent,
        diff: plan.isNewRouteFile
          ? null
          : compactDiff(diffLines(plan.originalRouteFileContent, plan.routeFileContent)),
      },
      {
        path: "src/routes/index.js",
        isNew: false,
        diff: compactDiff(diffLines(plan.originalIndexContent, plan.indexContent)),
      },
      {
        path: "public/data.js",
        isNew: false,
        diff: compactDiff(diffLines(plan.originalDataContent, plan.dataContent)),
      },
    ];
    if (plan.packageJsonContent) {
      files.push({
        path: "package.json",
        isNew: false,
        diff: compactDiff(diffLines(fs.readFileSync(PKG_PATH, "utf8"), plan.packageJsonContent)),
      });
      warnings.push(
        `package.json akan diupdate otomatis: nambahin ${plan.depsAdded.join(", ") || "(tidak ada yang baru)"}.`
      );
    }

    return ok(res, {
      warnings,
      files,
      summary: { fullPath: plan.fullPath, method: plan.method },
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
      ...(plan.packageJsonContent ? [PKG_PATH] : []),
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
        snapshot: historySnapshot,
      }).id;
    } catch {
      /* riwayat best-effort, jangan gagalin apply */
    }

    // Simpan test params buat health check (kalau dikirim frontend).
    try {
      if (req.body.testParams && typeof req.body.testParams === "object") {
        setHealthTest({
          method: plan.method,
          path: plan.fullPath,
          params: req.body.testParams,
          assertFields: Array.isArray(req.body.assertFields) ? req.body.assertFields : undefined,
        });
      }
    } catch {
      /* best-effort */
    }

    scheduleRestartAfterResponse(res);
    return ok(res, {
      message:
        "Endpoint baru berhasil dibuat. Server bakal auto-restart sebentar (kalau jalan via PM2/'npm start') atau nodemon (kalau 'npm run dev') buat nge-load file barunya — tunggu beberapa detik sebelum test endpoint-nya.",
      fullPath: plan.fullPath,
      method: plan.method,
      depsAdded: plan.depsAdded,
      historyId,
      filesWritten: [
        `src/services/${plan.serviceFileName}.service.js`,
        `src/routes/${plan.routeSlug}.routes.js`,
        "src/routes/index.js",
        "public/data.js",
        ...(plan.packageJsonContent ? ["package.json"] : []),
      ],
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
            diff: compactDiff(diffLines(plan.originalRouteFileContent, plan.newRouteFileContent)),
          },
      {
        path: "src/routes/index.js",
        diff: compactDiff(diffLines(plan.originalIndexContent, plan.finalIndexContent)),
      },
      { path: "public/data.js", diff: compactDiff(diffLines(plan.originalDataContent, plan.newDataContent)) },
      ...plan.serviceFilesToDelete.map((s) => ({
        path: `src/services/${s.serviceFileName}.service.js`,
        willDelete: true,
        content: null,
        diff: null,
      })),
    ];
    return ok(res, {
      warnings: plan.warnings,
      files,
      summary: { fullPath: plan.fullPath, method: plan.method },
    });
  })
);

router.post(
  "/delete/apply",
  asyncHandler(async (req, res) => {
    const plan = buildDeletePlan(req.body);

    const touchedPaths = [
      plan.routeFilePath,
      ROUTES_INDEX,
      PUBLIC_DATA,
      ...plan.serviceFilesToDelete.map((s) => s.servicePath),
    ];

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
        snapshot: historySnapshot,
      }).id;
    } catch {
      /* best-effort */
    }

    // Test params health check endpoint ini udah gak relevan.
    try {
      deleteHealthTest({ method: plan.method, path: plan.fullPath });
    } catch {
      /* best-effort */
    }

    scheduleRestartAfterResponse(res);
    return ok(res, {
      message:
        "Endpoint berhasil dihapus. Server bakal auto-restart sebentar buat nge-drop file lamanya — tunggu beberapa detik sebelum test lagi.",
      fullPath: plan.fullPath,
      method: plan.method,
      historyId,
      filesChanged: [
        plan.willDeleteRouteFile
          ? `src/routes/${plan.routeFileBase}.routes.js (dihapus)`
          : `src/routes/${plan.routeFileBase}.routes.js`,
        "src/routes/index.js",
        "public/data.js",
        ...plan.serviceFilesToDelete.map((s) => `src/services/${s.serviceFileName}.service.js (dihapus)`),
      ],
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
      try {
        body = JSON.parse(text);
      } catch {
        body = text.slice(0, 500);
      }

      if (resp.status >= 500) {
        return ok(res, {
          success: false,
          status: resp.status,
          message: "Endpoint berhasil dibuat, tapi ERROR pas dijalankan.",
          body,
        });
      }
      return ok(res, { success: true, status: resp.status, body });
    } catch (err) {
      return ok(res, {
        success: false,
        message:
          "Belum bisa konek ke server sendiri — biasanya karena masih proses restart (nodemon). Coba lagi beberapa detik lagi.",
        error: err.message,
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
      endpointCountInSameFile = listAllEndpoints().filter(
        (e) => splitApiPath(e.path).routeSlug === routeSlug
      ).length;
    } catch {
      // best-effort doang — biarin null semua kalau ada yang gagal di-parse
    }

    return ok(res, {
      endpoint: {
        ...detail,
        routeFileBase,
        suggestedServiceFileName,
        suggestedInstanceName,
        endpointCountInSameFile,
      },
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
        desc: ov && typeof ov.desc === "string" ? ov.desc : p.desc,
      };
    };

    const endpointObj = {
      name: endpointName || detail.name,
      method: detail.method,
      path: detail.path,
      desc: endpointDesc ?? detail.desc,
      pathParams: detail.pathParams,
      query: detail.query.map(mergeParam),
    };

    const { content: dataAfterRemove, categoryEmpty } = removeEndpointFromPublicData(dataContent, {
      path: fullPath,
      method,
    });
    const knownCategories = listExistingCategories();
    if (!knownCategories.some((c) => c.id === categoryId)) {
      throw new ApiError(`Kategori "${categoryId}" tidak ketemu.`, 404);
    }
    const newDataContent = updatePublicData(dataAfterRemove, { mode: "existing", categoryId, endpointObj });

    const { routeSlug } = splitApiPath(fullPath);
    const indexContent = fs.readFileSync(ROUTES_INDEX, "utf8");
    const { content: indexAfterRemove } = removeEndpointFromRoutesIndex(indexContent, {
      path: fullPath,
      method,
    });
    const idxParams = [
      ...detail.pathParams.map((p) => `${p.name} (path)`),
      ...endpointObj.query.map((p) => `${p.name}${p.required ? "" : "?"}`),
    ];
    const newIndexContent = updateRoutesIndex(indexAfterRemove, {
      routeSlug,
      isNewRouteFile: false,
      endpointEntry: { name: endpointObj.name, method: detail.method, path: fullPath, params: idxParams },
    });

    withRollback([PUBLIC_DATA, ROUTES_INDEX], () => {
      fs.writeFileSync(PUBLIC_DATA, newDataContent, "utf8");
      fs.writeFileSync(ROUTES_INDEX, newIndexContent, "utf8");
    });

    return ok(res, {
      message: "Metadata endpoint berhasil diupdate.",
      warnings: categoryEmpty
        ? ["Kategori asal jadi kosong sebelum entry baru disisipkan — cek public/data.js kalau perlu."]
        : [],
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
      [deletePlan.routeFilePath]: deletePlan.willDeleteRouteFile ? null : deletePlan.newRouteFileContent,
    };
    const addPlan = buildPlan(addBody, { fileOverrides });

    const routeFiles = [];
    if (deletePlan.routeFilePath === addPlan.routeFilePath) {
      routeFiles.push({
        path: `src/routes/${addPlan.routeSlug}.routes.js`,
        isNew: deletePlan.willDeleteRouteFile,
        diff: deletePlan.willDeleteRouteFile
          ? null
          : compactDiff(diffLines(deletePlan.originalRouteFileContent, addPlan.routeFileContent)),
      });
    } else {
      routeFiles.push(
        deletePlan.willDeleteRouteFile
          ? { path: `src/routes/${deletePlan.routeFileBase}.routes.js`, willDelete: true, diff: null }
          : {
              path: `src/routes/${deletePlan.routeFileBase}.routes.js`,
              willDelete: false,
              diff: compactDiff(
                diffLines(deletePlan.originalRouteFileContent, deletePlan.newRouteFileContent)
              ),
            },
        {
          path: `src/routes/${addPlan.routeSlug}.routes.js`,
          isNew: addPlan.isNewRouteFile,
          diff: addPlan.isNewRouteFile
            ? null
            : compactDiff(diffLines(addPlan.originalRouteFileContent, addPlan.routeFileContent)),
        }
      );
    }

    const files = [
      {
        path: `src/services/${addPlan.serviceFileName}.service.js`,
        isNew: !addPlan.serviceExists,
        diff: addPlan.serviceExists
          ? compactDiff(diffLines(fs.readFileSync(addPlan.servicePath, "utf8"), addPlan.serviceFileContent))
          : null,
      },
      ...routeFiles,
      {
        path: "src/routes/index.js",
        diff: compactDiff(diffLines(deletePlan.originalIndexContent, addPlan.indexContent)),
      },
      {
        path: "public/data.js",
        diff: compactDiff(diffLines(deletePlan.originalDataContent, addPlan.dataContent)),
      },
      ...deletePlan.serviceFilesToDelete
        .filter((s) => s.serviceFileName !== addPlan.serviceFileName)
        .map((s) => ({ path: `src/services/${s.serviceFileName}.service.js`, willDelete: true, diff: null })),
    ];

    const warnings = [...deletePlan.warnings];
    if (addPlan.depWarnings.length) {
      warnings.push(`Package belum ke-install: ${addPlan.depWarnings.join(", ")}.`);
    }

    return ok(res, {
      warnings,
      files,
      summary: {
        removedPath: deletePlan.fullPath,
        removedMethod: deletePlan.method,
        newPath: addPlan.fullPath,
        newMethod: addPlan.method,
      },
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
      [deletePlan.routeFilePath]: deletePlan.willDeleteRouteFile ? null : deletePlan.newRouteFileContent,
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
        ...(addPlan.packageJsonContent ? [PKG_PATH] : []),
      ]),
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
        if (s.servicePath !== addPlan.servicePath && fs.existsSync(s.servicePath))
          fs.unlinkSync(s.servicePath);
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
        snapshot: historySnapshot,
      }).id;
    } catch {
      /* best-effort */
    }

    return ok(res, {
      message:
        "Endpoint berhasil diedit. Server bakal auto-restart sebentar buat nge-load ulang — tunggu beberapa detik sebelum test lagi.",
      removedPath: deletePlan.fullPath,
      newPath: addPlan.fullPath,
      method: addPlan.method,
      historyId,
    });
  })
);

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
    if (first.serviceExists)
      warnings.push(`src/services/${first.serviceFileName}.service.js sudah ada dan akan DITIMPA.`);

    // Diff kumulatif: bandingkan kondisi disk sekarang vs hasil AKHIR batch.
    const files = [
      {
        path: `src/services/${first.serviceFileName}.service.js`,
        isNew: !first.serviceExists,
        content: last.serviceFileContent,
        diff: first.serviceExists
          ? compactDiff(diffLines(fs.readFileSync(first.servicePath, "utf8"), last.serviceFileContent))
          : null,
      },
      {
        path: `src/routes/${first.routeSlug}.routes.js`,
        isNew: first.isNewRouteFile,
        content: last.routeFileContent,
        diff: first.isNewRouteFile
          ? null
          : compactDiff(diffLines(first.originalRouteFileContent, last.routeFileContent)),
      },
      {
        path: "src/routes/index.js",
        isNew: false,
        diff: compactDiff(diffLines(first.originalIndexContent, last.indexContent)),
      },
      {
        path: "public/data.js",
        isNew: false,
        diff: compactDiff(diffLines(first.originalDataContent, last.dataContent)),
      },
    ];
    if (last.packageJsonContent) {
      files.push({
        path: "package.json",
        isNew: false,
        diff: compactDiff(diffLines(fs.readFileSync(PKG_PATH, "utf8"), last.packageJsonContent)),
      });
    }

    return ok(res, {
      warnings,
      files,
      summary: { endpoints: plans.map((p) => ({ fullPath: p.fullPath, method: p.method })) },
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
      ...(last.packageJsonContent ? [PKG_PATH] : []),
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
        snapshot: historySnapshot,
      }).id;
    } catch {
      /* best-effort */
    }

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
        ...(last.packageJsonContent ? ["package.json"] : []),
      ],
    });
  })
);

export default router;

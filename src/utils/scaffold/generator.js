// Generator konten file hasil scaffold: isi service file, blok route,
// update routes/index.js dan public/data.js. Dipisah dari scaffold.js
// monolitik — logikanya tidak berubah.
import { findMatchingClose, escapeRegex, escapeJsString, methodBucket } from "./core.js";

/* ------------------------------------------------------------------ */
/* 2. Generate isi file service                                        */
/* ------------------------------------------------------------------ */

export function buildServiceFileContent({
  importLines,
  preludeCode,
  classBlock,
  className,
  hasInlineExport,
}) {
  const header = `/**\n * Auto-generated lewat halaman /admin.html — silakan dirapikan lagi\n * kalau perlu, ini cuma hasil scaffold dari kode yang di-paste.\n */\n`;
  const imports = importLines.length ? importLines.join("\n") + "\n\n" : "";
  const prelude = preludeCode ? preludeCode + "\n\n" : "";
  const exportLine = hasInlineExport ? "" : `\nexport default ${className};\n`;
  return `${header}${imports}${prelude}${classBlock}\n${exportLine}`;
}

/* ------------------------------------------------------------------ */
/* 3. Generate blok route (router.all/get/post)                        */
/* ------------------------------------------------------------------ */

export function buildParamsList(params) {
  // params: [{name, required, desc}]
  return (params || []).filter((p) => p.name && p.name.trim());
}

export function extractPathParams(subPath) {
  return Array.from(String(subPath).matchAll(/:([A-Za-z_$][\w$]*)/g)).map((m) => m[1]);
}

/**
 * Bangun ekspresi pemanggilan (buat method call ATAU constructor call)
 * dari style ("object"/"positional"/"none") + daftar argumen terurut
 * `{ serviceKey, expr, kind }`. `expr` adalah teks JS mentah yang mau
 * dipakai (nama variabel, atau literal yang sudah di-JSON.stringify).
 *
 * `kind` datang langsung dari metadata parser (Parser Upgrade v2) —
 * generator gak nebak lagi dari nama variabel. `kind: "rest"` di-render
 * sebagai spread (`...expr`), bukan `key: value` biasa. Ini yang
 * memperbaiki bug lama: dulu rest parameter ikut diperlakukan seperti
 * property biasa dan menghasilkan pemanggilan yang salah secara
 * semantik (gak benar-benar nge-spread sisa properti).
 */
function buildCallExpression(style, orderedArgs) {
  if (style === "none" || !orderedArgs.length) return "";
  if (style === "object") {
    const parts = orderedArgs.map((a) => {
      if (a.kind === "rest") return `...${a.expr}`;
      return a.serviceKey === a.expr ? a.serviceKey : `${a.serviceKey}: ${a.expr}`;
    });
    return `{ ${parts.join(", ")} }`;
  }
  return orderedArgs.map((a) => (a.kind === "rest" ? `...${a.expr}` : a.expr)).join(", ");
}

/**
 * Generate 1 blok `router.<method>(...)` lengkap.
 *
 * `methodParamStyle` + `methodArgs` dipakai buat manggil method-nya:
 *   methodArgs: [{ serviceParamName, requestParamName }, ...] (urutan
 *   PERSIS sesuai signature asli method-nya, penting buat style
 *   "positional").
 *
 * `ctor` (opsional) dipakai kalau constructor class butuh argumen:
 *   { style: "object"|"positional", args: [{ serviceParamName, source: "static"|"request", staticValue?, requestParamName? }] }
 *   Kalau `ctor` null/undefined -> instance dibuat SEKALI di atas file
 *   (singleton, seperti sebelumnya). Kalau ada -> instance dibuat ULANG
 *   di dalam setiap request (karena butuh nilai yang cuma ada saat
 *   request masuk, mis. constructor(url)).
 *
 * `allRequestParams`: [{ requestParamName, required, desc }] — dipakai
 * buat bagian destructure + validasi di awal handler (gabungan semua
 * parameter yang dibutuhkan method maupun constructor).
 */
export function buildRouteBlockCode({
  subPath,
  httpMethod,
  className,
  instanceName,
  callMethod,
  methodParamStyle,
  methodArgs,
  ctor,
  allRequestParams,
  endpointName,
  endpointDesc,
}) {
  const method = (httpMethod || "ALL").toLowerCase();
  const pathParams = extractPathParams(subPath);
  const reqParams = (allRequestParams || []).filter((p) => !pathParams.includes(p.requestParamName));

  let paramsLine;
  if (method === "all") {
    paramsLine = `    const params = req.method === "GET" ? req.query : req.body;\n`;
  } else if (method === "get") {
    paramsLine = `    const params = req.query;\n`;
  } else {
    paramsLine = `    const params = req.body;\n`;
  }

  // Rest element (...x) WAJIB jadi yang terakhir dalam destructuring
  // pattern JS (kalau enggak -> SyntaxError). Urutan dari parser
  // seharusnya udah bener (sumbernya emang valid JS), tapi diurutkan
  // ulang di sini sebagai jaring pengaman.
  const orderedReqParams = [...reqParams].sort(
    (a, b) => (a.kind === "rest" ? 1 : 0) - (b.kind === "rest" ? 1 : 0)
  );

  const destructure = orderedReqParams.length
    ? `    const { ${orderedReqParams
        .map((p) => (p.kind === "rest" ? `...${p.requestParamName}` : p.requestParamName))
        .join(", ")} } = params;\n`
    : "";

  // Rest parameter gak pernah divalidasi "wajib" (nangkep sisa properti
  // apa pun, termasuk kosong). Parameter yang di source-nya udah punya
  // default value juga gak lagi divalidasi di sini — biar class-nya
  // sendiri yang isi default itu (lihat Parser Upgrade v2, poin 4).
  const validations = reqParams
    .filter((p) => p.required && p.kind !== "rest")
    .map(
      (p) =>
        `    if (!${p.requestParamName}) throw new ApiError("Parameter '${p.requestParamName}' wajib diisi", 400);\n`
    )
    .join("");

  const methodOrderedArgs = (methodArgs || []).map((a) => ({
    serviceKey: a.serviceParamName,
    kind: a.kind || "property",
    expr: pathParams.includes(a.requestParamName) ? `req.params.${a.requestParamName}` : a.requestParamName,
  }));
  const methodCallArg = buildCallExpression(methodParamStyle || "none", methodOrderedArgs);

  let instanceSetupLine = "";
  let usesPerRequestInstance = false;
  if (ctor && ctor.args && ctor.args.length) {
    usesPerRequestInstance = true;
    const ctorOrderedArgs = ctor.args.map((a) => ({
      serviceKey: a.serviceParamName,
      kind: a.kind || "property",
      expr: a.source === "static" ? JSON.stringify(a.staticValue ?? "") : a.requestParamName,
    }));
    const ctorCallArg = buildCallExpression(ctor.style || "positional", ctorOrderedArgs);
    instanceSetupLine = `    const ${instanceName} = new ${className}(${ctorCallArg});\n`;
  }

  const methodLabel = method === "all" ? "GET/POST" : method.toUpperCase();
  const comment = `/**\n * ${methodLabel} /api/{ROUTE_PREFIX}${subPath}\n * ${endpointName ? endpointName + " — " : ""}${endpointDesc || ""}\n */`;

  const body = `${paramsLine}${destructure}${validations}${instanceSetupLine}    const data = await ${instanceName}.${callMethod}(${methodCallArg});\n    return ok(res, data);\n`;

  return {
    code: `${comment}\nrouter.${method}(\n  "${subPath}",\n  asyncHandler(async (req, res) => {\n${body}  })\n);\n`,
    usesPerRequestInstance,
  };
}

export function buildNewRouteFileContent({
  className,
  serviceFileName,
  instanceName,
  routeBlockCode,
  usesPerRequestInstance,
}) {
  const lines = [
    `import { Router } from "express";`,
    `import ${className} from "../services/${serviceFileName}.service.js";`,
    `import { asyncHandler } from "../utils/asyncHandler.js";`,
    `import { ok, ApiError } from "../utils/response.js";`,
    ``,
    `const router = Router();`,
  ];
  if (!usesPerRequestInstance) lines.push(`const ${instanceName} = new ${className}();`);
  lines.push(``, routeBlockCode, `export default router;`, ``);
  return lines.join("\n");
}

export function appendRouteBlockToExistingFile(
  existingContent,
  { className, serviceFileName, instanceName, routeBlockCode, usesPerRequestInstance }
) {
  let content = existingContent;

  const hasImport = new RegExp(`import\\s+${className}\\s+from`).test(content);
  if (!hasImport) {
    const importAnchor = content.match(/^import\s+\{\s*Router\s*\}\s+from\s+["']express["'];\s*$/m);
    if (importAnchor) {
      const insertAt = importAnchor.index + importAnchor[0].length;
      content =
        content.slice(0, insertAt) +
        `\nimport ${className} from "../services/${serviceFileName}.service.js";` +
        content.slice(insertAt);
    } else {
      content = `import ${className} from "../services/${serviceFileName}.service.js";\n` + content;
    }
  }

  if (!usesPerRequestInstance) {
    const hasInstance = new RegExp(`new\\s+${className}\\s*\\(`).test(content);
    if (!hasInstance) {
      const routerAnchor = content.match(/^const\s+router\s*=\s*Router\(\);\s*$/m);
      if (routerAnchor) {
        const insertAt = routerAnchor.index + routerAnchor[0].length;
        content =
          content.slice(0, insertAt) +
          `\nconst ${instanceName} = new ${className}();` +
          content.slice(insertAt);
      }
    }
  }

  const exportAnchor = content.match(/export default router;\s*$/m);
  if (!exportAnchor)
    throw new Error("File route existing tidak punya 'export default router;' — format tidak dikenali.");
  const insertAt = exportAnchor.index;
  content = content.slice(0, insertAt) + routeBlockCode + "\n" + content.slice(insertAt);

  return content;
}

/**
 * Sisipkan `entryStr` sebagai item baru ke dalam array yang buka di
 * `openIdx` (posisi karakter '[' atau '{') dan tutup di `closeIdx`
 * (posisi karakter ']' atau '}' pasangannya). Whitespace sebelum
 * closeIdx di-trim dulu supaya koma & indentasi hasilnya rapi,
 * tidak peduli berapa banyak whitespace/newline yang sudah ada di sana.
 */
export function insertArrayEntry(source, openIdx, closeIdx, entryStr, closeIndentStr) {
  let i = closeIdx;
  while (i > openIdx + 1 && /\s/.test(source[i - 1])) i--;
  const hasItems = i > openIdx + 1;
  const before = source.slice(0, i);
  const after = source.slice(closeIdx);
  const sep = hasItems ? ",\n" : "\n";
  return `${before}${sep}${entryStr}\n${closeIndentStr}${after}`;
}

/**
 * Cek apakah full path (+ method) yang mau dibuat udah kepake endpoint
 * lain di project ini (baca dari `result: [...]` di routes/index.js,
 * yang jadi sumber kebenaran daftar endpoint terpasang). Dicek di sini
 * — bukan cuma di 1 file route — supaya gak ada 2 endpoint beda file
 * yang kebetulan menuju path yang sama.
 */
export function findDuplicateEndpoint(indexContent, fullPath, method) {
  const resultAnchor = indexContent.match(/result:\s*\[/);
  if (!resultAnchor) return null;
  const openIdx = resultAnchor.index + resultAnchor[0].length - 1;
  const closeIdx = findMatchingClose(indexContent, openIdx, "[", "]");
  const arrInner = indexContent.slice(openIdx + 1, closeIdx);

  const escapedPath = escapeRegex(fullPath);
  const pathRegex = new RegExp(`path:\\s*"${escapedPath}"`);
  const wantBucket = methodBucket(method);

  let depth = 0;
  let start = -1;
  for (let i = 0; i < arrInner.length; i++) {
    if (arrInner[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (arrInner[i] === "}") {
      depth--;
      if (depth === 0) {
        const entry = arrInner.slice(start, i + 1);
        if (pathRegex.test(entry)) {
          const mm = entry.match(/method:\s*"([^"]+)"/);
          const entryMethod = mm ? mm[1] : "ALL";
          if (methodBucket(entryMethod) === wantBucket) {
            const nameMatch = entry.match(/name:\s*"([^"]+)"/);
            return { path: fullPath, method: entryMethod, name: nameMatch ? nameMatch[1] : null };
          }
        }
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 4. Update src/routes/index.js                                       */
/* ------------------------------------------------------------------ */

export function updateRoutesIndex(content, { routeSlug, isNewRouteFile, endpointEntry }) {
  let out = content;

  if (isNewRouteFile) {
    const varName = `${routeSlug}Routes`;
    const importLine = `import ${varName} from "./${routeSlug}.routes.js";`;
    const useLine = `router.use("/${routeSlug}", ${varName});`;

    if (!out.includes(importLine)) {
      const lastImport = [...out.matchAll(/^import .+ from "\.\/.+\.routes\.js";\s*$/gm)].pop();
      if (lastImport) {
        const insertAt = lastImport.index + lastImport[0].length;
        out = out.slice(0, insertAt) + `\n${importLine}` + out.slice(insertAt);
      } else {
        out = `import { Router } from "express";\n${importLine}\n` + out;
      }
    }

    if (!out.includes(useLine)) {
      const lastUse = [...out.matchAll(/^router\.use\("\/.+", .+Routes\);\s*$/gm)].pop();
      if (lastUse) {
        const insertAt = lastUse.index + lastUse[0].length;
        out = out.slice(0, insertAt) + `\n${useLine}` + out.slice(insertAt);
      }
    }
  }

  // --- Sisipkan entry endpoint ke array `result: [ ... ]` ---
  const resultAnchor = out.match(/result:\s*\[/);
  if (!resultAnchor) throw new Error("Tidak ketemu 'result: [' di routes/index.js — format tidak dikenali.");
  const openIdx = resultAnchor.index + resultAnchor[0].length - 1; // posisi '['
  const closeIdx = findMatchingClose(out, openIdx, "[", "]");
  const entryStr = `      { name: "${endpointEntry.name}", method: "${endpointEntry.method}", path: "${endpointEntry.path}", params: [${endpointEntry.params.map((p) => `"${p}"`).join(", ")}] }`;
  out = insertArrayEntry(out, openIdx, closeIdx, entryStr, "    ");

  // --- Update total: N ---
  out = out.replace(/total:\s*(\d+)/, (m, n) => `total: ${Number(n) + 1}`);

  return out;
}

/* ------------------------------------------------------------------ */
/* 5. Update public/data.js                                            */
/* ------------------------------------------------------------------ */

export function updatePublicData(content, { mode, categoryId, newCategory, endpointObj }) {
  let out = content;

  if (mode === "existing") {
    const idAnchor = out.match(new RegExp(`id:\\s*"${categoryId}"`));
    if (!idAnchor) throw new Error(`Kategori id="${categoryId}" tidak ketemu di public/data.js.`);

    // Cari '{' pembuka objek kategori: mundur dari idAnchor ke '{' terdekat.
    const objOpenIdx = out.lastIndexOf("{", idAnchor.index);
    const objCloseIdx = findMatchingClose(out, objOpenIdx, "{", "}");
    const categoryChunk = out.slice(objOpenIdx, objCloseIdx + 1);

    const endpointsAnchor = categoryChunk.match(/endpoints:\s*\[/);
    if (!endpointsAnchor) throw new Error("Kategori tidak punya field 'endpoints: [...]'.");
    const localOpenIdx = endpointsAnchor.index + endpointsAnchor[0].length - 1;
    const localCloseIdx = findMatchingClose(categoryChunk, localOpenIdx, "[", "]");

    const entryStr = endpointObjToJs(endpointObj, 6);
    const newCategoryChunk = insertArrayEntry(categoryChunk, localOpenIdx, localCloseIdx, entryStr, "    ");

    out = out.slice(0, objOpenIdx) + newCategoryChunk + out.slice(objCloseIdx + 1);
    return out;
  }

  // mode === "new": sisip kategori baru sebelum penutup array CATEGORIES
  const catArrayAnchor = out.match(/const\s+CATEGORIES\s*=\s*\[/);
  if (!catArrayAnchor) throw new Error("Tidak ketemu 'const CATEGORIES = [' di public/data.js.");
  const openIdx = catArrayAnchor.index + catArrayAnchor[0].length - 1;
  const closeIdx = findMatchingClose(out, openIdx, "[", "]");

  const categoryStr = [
    `  {`,
    `    id: "${newCategory.id}", tag: "${newCategory.tag}", label: "${newCategory.label}",`,
    `    desc: "${escapeJsString(newCategory.desc)}",`,
    `    endpoints: [`,
    endpointObjToJs(endpointObj, 6),
    `    ]`,
    `  }`,
  ].join("\n");

  out = insertArrayEntry(out, openIdx, closeIdx, categoryStr, "");
  return out;
}

function endpointObjToJs(ep, indent) {
  const pad = " ".repeat(indent);
  const lines = [];
  lines.push(`${pad}{`);
  lines.push(`${pad}  name: "${escapeJsString(ep.name)}", method: "${ep.method}", path: "${ep.path}",`);
  lines.push(`${pad}  desc: "${escapeJsString(ep.desc)}",`);
  if (ep.pathParams && ep.pathParams.length) {
    const pp = ep.pathParams
      .map((p) => `{ name: "${p.name}", required: true, desc: "${escapeJsString(p.desc || "")}" }`)
      .join(", ");
    lines.push(`${pad}  pathParams: [${pp}],`);
  }
  if (ep.query && ep.query.length) {
    const q = ep.query
      .map((p) => `{ name: "${p.name}", required: ${!!p.required}, desc: "${escapeJsString(p.desc || "")}" }`)
      .join(", ");
    lines.push(`${pad}  query: [${q}]`);
  } else {
    // buang trailing koma di baris desc kalau tidak ada query
    lines[lines.length - 1] = lines[lines.length - 1].replace(/,\s*$/, "");
  }
  lines.push(`${pad}}`);
  return lines.join("\n");
}

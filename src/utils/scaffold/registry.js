// "Registry" — baca keadaan project sekarang dari disk: daftar kategori,
// route file, endpoint terpasang, service yang dipakai/yatim, plus operasi
// hapus endpoint dari routes/index.js & public/data.js. Dipisah dari
// scaffold.js monolitik — logikanya tidak berubah.
import fs from "fs";
import path from "path";
import {
  ROUTES_DIR,
  SERVICES_DIR,
  PUBLIC_DATA,
  findMatchingClose,
  escapeRegex,
  unescapeJsString,
  methodBucket,
} from "./core.js";

/* ------------------------------------------------------------------ */
/* 6. Util baca daftar kategori & route file yang ada (buat dropdown)   */
/* ------------------------------------------------------------------ */

export function listExistingCategories() {
  const content = fs.readFileSync(PUBLIC_DATA, "utf8");
  const matches = content.matchAll(/id:\s*"([^"]+)",\s*tag:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g);
  return Array.from(matches).map((m) => ({ id: m[1], tag: m[2], label: m[3] }));
}

export function listExistingRouteFiles() {
  return fs
    .readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith(".routes.js"))
    .map((f) => f.replace(/\.routes\.js$/, ""));
}

/**
 * Baca ulang seluruh endpoint dari public/data.js (dipakai buat dropdown
 * "hapus endpoint" di admin.html) — hasilnya flat list per endpoint,
 * masing-masing dikasih tau categoryId & categoryLabel asalnya.
 */
export function listAllEndpoints() {
  const content = fs.readFileSync(PUBLIC_DATA, "utf8");
  const catArrayAnchor = content.match(/const\s+CATEGORIES\s*=\s*\[/);
  if (!catArrayAnchor) return [];
  const openIdx = catArrayAnchor.index + catArrayAnchor[0].length - 1;
  const closeIdx = findMatchingClose(content, openIdx, "[", "]");
  const catsChunk = content.slice(openIdx + 1, closeIdx);

  const categories = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < catsChunk.length; i++) {
    if (catsChunk[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (catsChunk[i] === "}") {
      depth--;
      if (depth === 0) categories.push(catsChunk.slice(start, i + 1));
    }
  }

  const result = [];
  for (const catChunk of categories) {
    const idM = catChunk.match(/id:\s*"([^"]+)"/);
    const labelM = catChunk.match(/label:\s*"([^"]+)"/);
    const categoryId = idM ? idM[1] : null;
    const categoryLabel = labelM ? labelM[1] : null;

    const epAnchor = catChunk.match(/endpoints:\s*\[/);
    if (!epAnchor) continue;
    const epOpenIdx = epAnchor.index + epAnchor[0].length - 1;
    const epCloseIdx = findMatchingClose(catChunk, epOpenIdx, "[", "]");
    const epChunk = catChunk.slice(epOpenIdx + 1, epCloseIdx);

    let d2 = 0;
    let s2 = -1;
    const epEntries = [];
    for (let i = 0; i < epChunk.length; i++) {
      if (epChunk[i] === "{") {
        if (d2 === 0) s2 = i;
        d2++;
      } else if (epChunk[i] === "}") {
        d2--;
        if (d2 === 0) epEntries.push(epChunk.slice(s2, i + 1));
      }
    }

    for (const epStr of epEntries) {
      const nameM = epStr.match(/name:\s*"((?:[^"\\]|\\.)*)"/);
      const methodM = epStr.match(/method:\s*"([^"]+)"/);
      const pathM = epStr.match(/path:\s*"([^"]+)"/);
      if (!pathM) continue;
      result.push({
        categoryId,
        categoryLabel,
        name: nameM ? nameM[1] : "",
        method: methodM ? methodM[1] : "ALL",
        path: pathM[1],
      });
    }
  }
  return result;
}

/**
 * Ambil semua `import Xxx from "../services/yyy.service.js";` di isi
 * 1 file route. Dipakai buat tahu service apa aja yang dipakai file itu.
 */
export function extractServiceImports(content) {
  const out = [];
  for (const m of content.matchAll(
    /^import\s+(\w+)\s+from\s+["']\.\.\/services\/([\w.-]+)\.service\.js["'];?[ \t]*\n?/gm
  )) {
    out.push({ className: m[1], serviceFileName: m[2], importLine: m[0] });
  }
  return out;
}

/**
 * Ambil semua `const namaVar = new ClassName(...);` di isi 1 file route.
 * Dipakai buat tahu instance mana yang berasal dari class mana.
 */
export function extractInstanceDecls(content) {
  const out = [];
  for (const m of content.matchAll(/^const\s+(\w+)\s*=\s*new\s+(\w+)\([^)]*\);[ \t]*\n?/gm)) {
    out.push({ instanceName: m[1], className: m[2], declLine: m[0] });
  }
  return out;
}

/**
 * Cek apakah `services/{serviceFileName}.service.js` masih di-import di
 * route file LAIN (selain `excludeRouteFileBase` dan selain admin.routes.js).
 * Kalau iya, service itu jangan dihapus — masih dipakai fitur lain.
 */
export function isServiceUsedElsewhere(serviceFileName, excludeRouteFileBase) {
  const files = fs
    .readdirSync(ROUTES_DIR)
    .filter(
      (f) => f.endsWith(".routes.js") && f !== `${excludeRouteFileBase}.routes.js` && f !== "admin.routes.js"
    );
  const needle = `services/${serviceFileName}.service.js`;
  for (const f of files) {
    const c = fs.readFileSync(path.join(ROUTES_DIR, f), "utf8");
    if (c.includes(needle)) return true;
  }
  return false;
}

/**
 * Dipakai oleh alur hapus endpoint: dari isi file route SEBELUM &
 * SESUDAH 1 blok route dihapus, tentukan service mana yang jadi yatim
 * (orphan) dan boleh ikut dihapus dari disk, plus versi file route yang
 * sudah dibersihkan dari import/instance yang sudah tidak dipakai.
 *
 * Catatan penting: saat cek "masih dipakai atau tidak", baris import
 * (`.../xxx.service.js`) dan baris deklarasi instance punya class itu
 * sendiri HARUS disingkirkan dulu dari teks yang dicek — soalnya path
 * import-nya sendiri (mis. "tiktokDownloader.service.js") kebetulan
 * mengandung teks "tiktokDownloader." dan bisa salah kedeteksi sebagai
 * pemakaian padahal itu cuma nama file.
 */
export function computeOrphanedServices(
  originalRouteFileContent,
  newRouteFileContent,
  { willDeleteRouteFile, routeFileBase }
) {
  const serviceImports = extractServiceImports(originalRouteFileContent);
  const instanceDecls = extractInstanceDecls(originalRouteFileContent);

  let cleanedContent = newRouteFileContent;
  const orphanNames = [];

  if (willDeleteRouteFile) {
    orphanNames.push(...serviceImports.map((si) => si.serviceFileName));
  } else {
    // Cek per class yang di-import: apakah class itu MASIH di-instantiate
    // (`new ClassName(`) di mana pun di sisa isi file setelah blok route
    // dihapus? Ini mencakup baik pola singleton (`const x = new Y();` di
    // atas file) MAUPUN pola per-request (`new Y(...)` di dalam handler),
    // karena keduanya sama-sama mengandung teks "new ClassName(".
    for (const si of serviceImports) {
      const stillUsed = new RegExp(`\\bnew\\s+${escapeRegex(si.className)}\\s*\\(`).test(newRouteFileContent);
      if (stillUsed) continue;

      cleanedContent = cleanedContent.replace(si.importLine, "");
      const decl = instanceDecls.find((d) => d.className === si.className);
      if (decl) cleanedContent = cleanedContent.replace(decl.declLine, "");
      orphanNames.push(si.serviceFileName);
    }
  }

  const uniqueOrphans = [...new Set(orphanNames)];
  const serviceFilesToDelete = uniqueOrphans
    .filter((name) => !isServiceUsedElsewhere(name, routeFileBase))
    .map((name) => ({ serviceFileName: name, servicePath: path.join(SERVICES_DIR, `${name}.service.js`) }))
    .filter((s) => fs.existsSync(s.servicePath));

  return { cleanedContent, serviceFilesToDelete, orphanNames: uniqueOrphans };
}

/* ------------------------------------------------------------------ */
/* 7. Hapus endpoint (dipakai oleh /admin/delete)                      */
/* ------------------------------------------------------------------ */
/**
 * Dari isi routes/index.js, cari nama file route (tanpa .routes.js) yang
 * di-mount di prefix tertentu lewat router.use("/prefix", xxxRoutes).
 */
export function findRouteFileForSlug(indexContent, routeSlug) {
  const useMatch = indexContent.match(
    new RegExp(`router\\.use\\(\\s*["']\\/${escapeRegex(routeSlug)}["']\\s*,\\s*(\\w+)\\s*\\)`)
  );
  if (!useMatch) return null;
  const varName = useMatch[1];
  const importMatch = indexContent.match(
    new RegExp(`import\\s+${varName}\\s+from\\s+["']\\.\\/(.+?)\\.routes\\.js["']`)
  );
  if (!importMatch) return null;
  return importMatch[1];
}

/**
 * Cari & hapus satu blok `router.<method>("<subPath>", ...);` dari isi
 * file route (termasuk komentar JSDoc tepat di atasnya kalau ada).
 * Mengembalikan { content, removed }.
 */
export function removeRouteBlock(content, { subPath, method }) {
  const escapedSub = escapeRegex(subPath);
  const callRegex = new RegExp(`router\\.(all|get|post|put|delete|patch)\\(\\s*["']${escapedSub}["']`, "g");
  const matches = [...content.matchAll(callRegex)];
  if (!matches.length) return { content, removed: false };

  // Biasanya cuma ada 1 block per subPath di file ini (pola project ini
  // gabungin GET+POST lewat router.all). Kalau kebetulan ada lebih dari
  // satu (mis. router.get + router.post terpisah di subPath yang sama),
  // baru pakai `method` buat milih yang paling cocok — bukan sebagai
  // filter keras yang bisa bikin false-negative di kasus normal.
  let match = matches[0];
  if (matches.length > 1 && method) {
    const wantBucket = methodBucket(method);
    const exact = matches.find(
      (m) => methodBucket(m[1]) === wantBucket || m[1].toUpperCase() === String(method).toUpperCase()
    );
    if (exact) match = exact;
  }

  // Ikut sertakan komentar JSDoc tepat di atas panggilan ini (kalau ada).
  // Dicari dari BELAKANG (bukan regex lazy dari depan) supaya tidak
  // ketarik ke komentar/blok endpoint lain yang lebih jauh di atasnya.
  let blockStart = match.index;
  const before = content.slice(0, blockStart);
  const closeTailMatch = before.match(/\*\/\s*\n?\s*$/);
  if (closeTailMatch) {
    const closeIdx = closeTailMatch.index; // posisi '*/' relatif ke `before`
    const openIdx = before.lastIndexOf("/**", closeIdx);
    if (openIdx !== -1) blockStart = openIdx;
  }

  const openParenIdx = content.indexOf("(", match.index);
  const closeParenIdx = findMatchingClose(content, openParenIdx, "(", ")");
  let end = closeParenIdx + 1;
  while (content[end] === " " || content[end] === "\t") end++;
  if (content[end] === ";") end++;
  while (content[end] === "\n") end++;

  const newContent = content.slice(0, blockStart) + content.slice(end);
  return { content: newContent, removed: true };
}

/**
 * Hitung berapa banyak panggilan `router.<method>(` yang tersisa di isi
 * file route — dipakai buat cek apakah file jadi kosong setelah endpoint
 * dihapus (kalau 0, file itu kandidat buat dihapus juga).
 */
export function countRouteBlocks(content) {
  const m = content.match(/router\.(all|get|post|put|delete|patch)\(/g);
  return m ? m.length : 0;
}

/**
 * Hapus baris `import ... from "./<slug>.routes.js"` dan
 * `router.use("/<slug>", ...)` dari isi routes/index.js — dipakai kalau
 * file route-nya jadi kosong & ikut dihapus.
 */
export function removeRouteFileRefFromIndex(content, routeSlug) {
  let out = content;
  out = out.replace(
    new RegExp(
      `^import\\s+\\w+\\s+from\\s+["']\\.\\/${escapeRegex(routeSlug)}\\.routes\\.js["'];?\\s*\\n?`,
      "m"
    ),
    ""
  );
  out = out.replace(
    new RegExp(`^router\\.use\\(\\s*["']\\/${escapeRegex(routeSlug)}["']\\s*,\\s*\\w+\\s*\\);?\\s*\\n?`, "m"),
    ""
  );
  return out;
}

/**
 * Hapus 1 entry dari array `result: [...]` di routes/index.js berdasarkan
 * path (dan method kalau dikasih), lalu update `total: N`.
 */
export function removeEndpointFromRoutesIndex(content, { path: targetPath, method }) {
  let out = content;
  const resultAnchor = out.match(/result:\s*\[/);
  if (!resultAnchor) throw new Error("Tidak ketemu 'result: [' di routes/index.js.");
  const openIdx = resultAnchor.index + resultAnchor[0].length - 1;
  const closeIdx = findMatchingClose(out, openIdx, "[", "]");
  const arrInner = out.slice(openIdx + 1, closeIdx);

  const entries = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < arrInner.length; i++) {
    if (arrInner[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (arrInner[i] === "}") {
      depth--;
      if (depth === 0) entries.push(arrInner.slice(start, i + 1));
    }
  }

  const escapedPath = escapeRegex(targetPath);
  const pathRegex = new RegExp(`path:\\s*"${escapedPath}"`);
  const candidates = entries.filter((e) => pathRegex.test(e));
  if (!candidates.length) return { content: out, removed: false };

  let target = candidates[0];
  if (candidates.length > 1 && method) {
    const wantBucket = methodBucket(method);
    const exact = candidates.find((e) => {
      const mm = e.match(/method:\s*"([^"]+)"/);
      return mm && methodBucket(mm[1]) === wantBucket;
    });
    if (exact) target = exact;
  }
  const idx = entries.indexOf(target);

  entries.splice(idx, 1);
  const newArrInner = entries.length ? "\n      " + entries.join(",\n      ") + "\n    " : "";
  out = out.slice(0, openIdx + 1) + newArrInner + out.slice(closeIdx);
  out = out.replace(/total:\s*(\d+)/, (m, n) => `total: ${Math.max(0, Number(n) - 1)}`);
  return { content: out, removed: true };
}

/**
 * Hapus 1 entry endpoint dari public/data.js berdasarkan path (dan
 * method kalau dikasih). Kalau kategori jadi kosong (endpoints: []),
 * kategori TIDAK otomatis dihapus — cuma dikasih tau lewat categoryEmpty.
 */
export function removeEndpointFromPublicData(content, { path: targetPath, method }) {
  let out = content;
  const escapedPath = escapeRegex(targetPath);
  const pathMatches = [...out.matchAll(new RegExp(`path:\\s*"${escapedPath}"`, "g"))];
  if (!pathMatches.length) return { content: out, removed: false, categoryEmpty: false };

  let chosen = pathMatches[0];
  if (method && pathMatches.length > 1) {
    const wantBucket = methodBucket(method);
    for (const m of pathMatches) {
      const objOpen = out.lastIndexOf("{", m.index);
      const objClose = findMatchingClose(out, objOpen, "{", "}");
      const chunk = out.slice(objOpen, objClose + 1);
      const mm = chunk.match(/method:\s*"([^"]+)"/);
      if (mm && methodBucket(mm[1]) === wantBucket) {
        chosen = m;
        break;
      }
    }
  }

  const objOpenIdx = out.lastIndexOf("{", chosen.index);
  const objCloseIdx = findMatchingClose(out, objOpenIdx, "{", "}");

  const beforeObj = out.slice(0, objOpenIdx);
  const endpointsAnchors = [...beforeObj.matchAll(/endpoints:\s*\[/g)];
  const endpointsAnchor = endpointsAnchors[endpointsAnchors.length - 1];
  if (!endpointsAnchor) throw new Error("Tidak ketemu 'endpoints: [' pembungkus entry ini.");
  const arrOpenIdx = endpointsAnchor.index + endpointsAnchor[0].length - 1;
  const arrCloseIdx = findMatchingClose(out, arrOpenIdx, "[", "]");

  let removeStart = objOpenIdx;
  let removeEnd = objCloseIdx + 1;

  const after = out.slice(removeEnd, arrCloseIdx);
  const commaAfterMatch = after.match(/^\s*,/);
  if (commaAfterMatch) {
    removeEnd += commaAfterMatch[0].length;
  } else {
    const beforeItem = out.slice(arrOpenIdx + 1, removeStart);
    const commaBeforeMatch = beforeItem.match(/,\s*$/);
    if (commaBeforeMatch) removeStart -= commaBeforeMatch[0].length;
  }

  out = out.slice(0, removeStart) + out.slice(removeEnd);

  const newArrCloseIdx = findMatchingClose(out, arrOpenIdx, "[", "]");
  const innerNow = out.slice(arrOpenIdx + 1, newArrCloseIdx).trim();
  const categoryEmpty = innerNow.length === 0;

  return { content: out, removed: true, categoryEmpty };
}

/**
 * Baca (TANPA ubah apa-apa) detail lengkap 1 endpoint dari public/data.js
 * berdasarkan path (+ method kalau ada beberapa entry di path yang sama).
 * Dipakai buat prefill form "Edit Endpoint" di admin panel (nama, desc,
 * kategori asal, path params, query params + required/desc-nya).
 */
export function findEndpointObject(content, { path: targetPath, method }) {
  const escapedPath = escapeRegex(targetPath);
  const pathMatches = [...content.matchAll(new RegExp(`path:\\s*"${escapedPath}"`, "g"))];
  if (!pathMatches.length) return null;

  let chosen = pathMatches[0];
  if (method && pathMatches.length > 1) {
    const wantBucket = methodBucket(method);
    for (const m of pathMatches) {
      const objOpen = content.lastIndexOf("{", m.index);
      const objClose = findMatchingClose(content, objOpen, "{", "}");
      const chunk = content.slice(objOpen, objClose + 1);
      const mm = chunk.match(/method:\s*"([^"]+)"/);
      if (mm && methodBucket(mm[1]) === wantBucket) {
        chosen = m;
        break;
      }
    }
  }

  const objOpenIdx = content.lastIndexOf("{", chosen.index);
  const objCloseIdx = findMatchingClose(content, objOpenIdx, "{", "}");
  const chunk = content.slice(objOpenIdx, objCloseIdx + 1);

  const before = content.slice(0, objOpenIdx);
  const catMatches = [...before.matchAll(/id:\s*"([^"]+)",\s*tag:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)];
  const cat = catMatches.length ? catMatches[catMatches.length - 1] : null;

  const nameM = chunk.match(/name:\s*"((?:[^"\\]|\\.)*)"/);
  const methodM = chunk.match(/method:\s*"([^"]+)"/);
  const descM = chunk.match(/desc:\s*"((?:[^"\\]|\\.)*)"/);

  function parseParamArray(fieldName) {
    const anchor = chunk.match(new RegExp(`${fieldName}:\\s*\\[`));
    if (!anchor) return [];
    const openIdx = anchor.index + anchor[0].length - 1;
    const closeIdx = findMatchingClose(chunk, openIdx, "[", "]");
    const inner = chunk.slice(openIdx + 1, closeIdx);
    const entries = [];
    let depth = 0;
    let start = -1;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (inner[i] === "}") {
        depth--;
        if (depth === 0) entries.push(inner.slice(start, i + 1));
      }
    }
    return entries.map((e) => {
      const n = e.match(/name:\s*"((?:[^"\\]|\\.)*)"/);
      const r = e.match(/required:\s*(true|false)/);
      const d = e.match(/desc:\s*"((?:[^"\\]|\\.)*)"/);
      return {
        name: n ? unescapeJsString(n[1]) : "",
        required: r ? r[1] === "true" : false,
        desc: d ? unescapeJsString(d[1]) : "",
      };
    });
  }

  return {
    categoryId: cat ? cat[1] : null,
    categoryLabel: cat ? cat[3] : null,
    name: nameM ? unescapeJsString(nameM[1]) : "",
    method: methodM ? methodM[1] : "ALL",
    path: targetPath,
    desc: descM ? unescapeJsString(descM[1]) : "",
    pathParams: parseParamArray("pathParams"),
    query: parseParamArray("query"),
  };
}

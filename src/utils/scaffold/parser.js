// Parser kode class yang di-paste user (extractClassInfo, extractClassMethods,
// parseMethodParams, dst) + dependency checker. Dipisah dari scaffold.js
// monolitik — logikanya tidak berubah.
import fs from "fs";
import path from "path";
import { ROOT, findMatchingClose, escapeRegex } from "./core.js";

/* ------------------------------------------------------------------ */
/* 1. Parse kode class yang di-paste user                              */
/* ------------------------------------------------------------------ */

/**
 * Ambil hanya blok `class Xxx { ... }` dari kode mentah yang di-paste,
 * plus baris `import ...` di atasnya. Buang sisanya (mis. CLI runner
 * `async function main(){...}` / `main();`).
 */
export function extractClassInfo(rawCode) {
  const code = String(rawCode || "").replace(/\r\n/g, "\n");

  const classMatch = code.match(/(export\s+default\s+)?class\s+([A-Za-z_$][\w$]*)/);
  if (!classMatch) {
    throw new Error("Tidak ketemu deklarasi 'class' di kode yang di-paste.");
  }
  const hasInlineExport = !!classMatch[1];
  const className = classMatch[2];
  const classKeywordIndex = code.indexOf(classMatch[0]);

  const braceOpenIndex = code.indexOf("{", classKeywordIndex);
  if (braceOpenIndex === -1) throw new Error("Class tidak punya body '{ ... }'.");
  const braceCloseIndex = findMatchingClose(code, braceOpenIndex, "{", "}");

  const classBlock = code.slice(classKeywordIndex, braceCloseIndex + 1);

  const beforeClass = code.slice(0, classKeywordIndex);

  const importLines = Array.from(
    beforeClass.matchAll(/^\s*import\s.+;\s*$/gm)
  ).map((m) => m[0].trim());

  // Apapun yang ada SEBELUM class selain baris import (const/let/var,
  // helper function, IIFE decode base64, dsb) jangan dibuang — class
  // body-nya bisa aja bergantung ke situ (mis. setup watermark/konstanta).
  // Cuma buang baris import-nya (udah ditampung terpisah di atas).
  const preludeCode = beforeClass
    .replace(/^\s*import\s.+;\s*$/gm, "")
    .trim();

  return {
    className,
    classBlock,
    hasInlineExport,
    importLines: [...new Set(importLines)],
    preludeCode
  };
}

/**
 * Bandingkan import statements pasted user dengan dependencies di
 * package.json, kasih warning kalau ada package yang belum ke-install.
 */
export function checkMissingDeps(importLines) {
  const pkgPath = path.join(ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const known = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {})
  ]);
  const warnings = [];
  for (const line of importLines) {
    const m = line.match(/from\s+["']([^"']+)["']/);
    if (!m) continue;
    const spec = m[1];
    if (spec.startsWith(".")) continue; // relative import, biarin
    const pkgName = spec.startsWith("@")
      ? spec.split("/").slice(0, 2).join("/")
      : spec.split("/")[0];
    if (!known.has(pkgName)) warnings.push(pkgName);
  }
  return [...new Set(warnings)];
}

/**
 * Tambahin package yang belum ada ke package.json (dependencies),
 * versi dikasih "latest" (valid ditulis di package.json, npm bakal
 * resolve ke versi terbaru pas `npm install` dijalanin). Dipakai kalau
 * user centang opsi "auto update package.json" pas Apply.
 * Return: { content, added: [nama-nama yang beneran ditambahin] }.
 */
export function addDepsToPackageJson(pkgJsonContent, depNames) {
  const pkg = JSON.parse(pkgJsonContent);
  pkg.dependencies = pkg.dependencies || {};
  const added = [];
  for (const name of depNames) {
    if (!pkg.dependencies[name]) {
      pkg.dependencies[name] = "latest";
      added.push(name);
    }
  }
  const sortedDeps = {};
  for (const key of Object.keys(pkg.dependencies).sort()) sortedDeps[key] = pkg.dependencies[key];
  pkg.dependencies = sortedDeps;
  return { content: JSON.stringify(pkg, null, 2) + "\n", added };
}


/* ------------------------------------------------------------------ */
/* 2b. Analisis method & constructor di dalam class (validasi + auto-  */
/*     deteksi parameter, dipakai fitur "Analisis Class" di admin)     */
/* ------------------------------------------------------------------ */

/**
 * Split string di top-level comma aja (gak ke-split kalau lagi di
 * dalam (), [], {}, <> (generic, heuristik), atau di dalam string
 * literal / template literal / comment. Dipakai buat parsing daftar
 * parameter method, mis. `a, b = {x: 1}, ...rest`.
 *
 * Catatan heuristik "<>": "<" cuma dihitung "buka" kalau langsung
 * diikuti huruf besar (pola umum generic, mis. `Array<T>`), supaya
 * operator perbandingan biasa (`a < b`) gak ketutup dianggap depth.
 */
export function splitTopLevelCommas(str) {
  const parts = [];
  let depth = 0;
  let angleDepth = 0;
  let current = "";
  let quote = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const next = str[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === "*" && next === "/") { current += next; i++; inBlockComment = false; }
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === "\\") { current += next; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; current += ch; continue; }
    if (ch === "/" && next === "/") { inLineComment = true; current += ch; continue; }
    if (ch === "/" && next === "*") { inBlockComment = true; current += ch; continue; }

    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "<" && next && /[A-Z]/.test(next)) angleDepth++;
    else if (ch === ">" && angleDepth > 0) angleDepth--;

    if (ch === "," && depth === 0 && angleDepth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * Cari index karakter target (":" atau "=") di TOP-LEVEL segmen aja
 * (di luar (), {}, [], string literal). Dipakai buat misahin
 * "key: value" (alias) atau "name = default" (default value) tanpa
 * ketipu sama karakter yang sama di dalam nested value (mis. ":" di
 * dalam ternary yang jadi default value, atau "=" di dalam "===").
 */
function findTopLevelChar(str, target) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if ("([{".includes(ch)) { depth++; continue; }
    if (")]}".includes(ch)) { depth--; continue; }
    if (depth !== 0) continue;

    if (target === ":" && ch === ":") return i;
    if (target === "=" && ch === "=") {
      const prev = str[i - 1];
      const next = str[i + 1];
      // Skip operator gabungan: "==", "===", "=>", "<=", ">=", "!="
      if (next === "=" || prev === "=" || prev === "<" || prev === ">" || prev === "!") continue;
      return i;
    }
  }
  return -1;
}

/**
 * Misahin "name" dan "= defaultValue" (kalau ada) di top-level.
 */
function splitNameDefault(str) {
  const idx = findTopLevelChar(str, "=");
  if (idx === -1) return { name: str.trim(), defaultValue: null };
  return { name: str.slice(0, idx).trim(), defaultValue: str.slice(idx + 1).trim() };
}

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * Error khusus buat pola parameter yang KETAHUAN tapi belum didukung
 * (nested object, array destructuring, computed property, dst).
 * Lebih baik gagal jelas (dengan lokasi method + parameter) daripada
 * generator menghasilkan JS yang invalid/salah — sesuai prinsip
 * "Parser Upgrade v2".
 */
export class ParserUnsupportedError extends Error {
  constructor(reason, { methodName, paramName } = {}) {
    const lines = [reason, ""];
    if (methodName) lines.push("Lokasi:", `method ${methodName}()`, "");
    if (paramName) lines.push("Parameter:", paramName);
    super(lines.join("\n").replace(/\n+$/, ""));
    this.name = "ParserUnsupportedError";
    this.reason = reason;
    this.methodName = methodName;
    this.paramName = paramName;
  }
}

function assertIdentifier(name, ctx, reason) {
  if (!IDENTIFIER_RE.test(name || "")) {
    throw new ParserUnsupportedError(reason, ctx);
  }
}

/**
 * Parse 1 segmen top-level di dalam object pattern `{ ... }`, balikin
 * metadata kaya (bukan cuma nama doang):
 *   "url"                 -> { kind: "property", name: "url", source: "url", required: true, hasDefault: false }
 *   "limit = 10"          -> { kind: "property", name: "limit", source: "limit", required: false, hasDefault: true, defaultValue: "10" }
 *   "url: videoUrl"       -> { kind: "alias", source: "url", target: "videoUrl", required: true, hasDefault: false }
 *   "url: videoUrl = ''"  -> { kind: "alias", source: "url", target: "videoUrl", required: false, hasDefault: true, defaultValue: "''" }
 *   "...rest"             -> { kind: "rest", name: "rest" }
 * Lempar ParserUnsupportedError kalau ketemu nested object, array
 * destructuring (lewat alias), atau computed property key.
 */
function parseObjectPatternSegment(segment, ctx) {
  const trimmed = segment.trim();

  if (trimmed.startsWith("...")) {
    const name = trimmed.slice(3).trim();
    assertIdentifier(name, { ...ctx, paramName: trimmed }, `Pola rest parameter tidak dikenali: "${trimmed}".`);
    return { kind: "rest", name };
  }

  if (trimmed.startsWith("[")) {
    throw new ParserUnsupportedError("Computed property destructuring belum didukung.", { ...ctx, paramName: trimmed });
  }

  const idxEq = findTopLevelChar(trimmed, "=");
  let idxColon = findTopLevelChar(trimmed, ":");
  // Kalau ":" ketemu SETELAH "=", itu bukan alias separator — itu bagian
  // dari default value (mis. ternary `x = a ? b : c`).
  if (idxColon !== -1 && idxEq !== -1 && idxColon > idxEq) idxColon = -1;

  if (idxColon !== -1) {
    const source = trimmed.slice(0, idxColon).trim();
    const valuePart = trimmed.slice(idxColon + 1).trim();
    assertIdentifier(source, { ...ctx, paramName: source }, `Nama property tidak dikenali: "${source}".`);

    if (valuePart.startsWith("{")) {
      throw new ParserUnsupportedError("Nested object destructuring belum didukung.", { ...ctx, paramName: source });
    }
    if (valuePart.startsWith("[")) {
      throw new ParserUnsupportedError("Array destructuring belum didukung.", { ...ctx, paramName: source });
    }

    const { name: target, defaultValue } = splitNameDefault(valuePart);
    assertIdentifier(target, { ...ctx, paramName: source }, `Nama alias tidak dikenali untuk property "${source}".`);

    return {
      kind: "alias",
      source,
      target,
      required: defaultValue == null,
      hasDefault: defaultValue != null,
      ...(defaultValue != null ? { defaultValue } : {})
    };
  }

  const { name, defaultValue } = splitNameDefault(trimmed);
  assertIdentifier(name, { ...ctx, paramName: trimmed }, `Pola parameter tidak dikenali: "${trimmed}".`);

  return {
    kind: "property",
    name,
    source: name,
    required: defaultValue == null,
    hasDefault: defaultValue != null,
    ...(defaultValue != null ? { defaultValue } : {})
  };
}

/**
 * Parse 1 segmen top-level di daftar parameter positional (bukan
 * destructuring object), mis. `a`, `b = 1`, `...rest`.
 */
function parsePositionalSegment(segment, ctx) {
  const trimmed = segment.trim();

  if (trimmed.startsWith("...")) {
    const name = trimmed.slice(3).trim();
    assertIdentifier(name, { ...ctx, paramName: trimmed }, `Pola rest parameter tidak dikenali: "${trimmed}".`);
    return { kind: "rest", name };
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    throw new ParserUnsupportedError(
      "Parameter destructuring campuran (positional + object/array pattern) belum didukung.",
      { ...ctx, paramName: trimmed }
    );
  }

  const { name, defaultValue } = splitNameDefault(trimmed);
  assertIdentifier(name, { ...ctx, paramName: trimmed }, `Pola parameter tidak dikenali: "${trimmed}".`);

  return {
    kind: "param",
    name,
    required: defaultValue == null,
    hasDefault: defaultValue != null,
    ...(defaultValue != null ? { defaultValue } : {})
  };
}

/**
 * Parse isi tanda kurung parameter 1 method/constructor, mis:
 *   ""                        -> { style: "none", params: [], names: [] }
 *   "url"                     -> { style: "positional", params: [{kind:"param",name:"url",...}], names: ["url"] }
 *   "{ url, format = 'mp3' }" -> { style: "object", params: [...], names: ["url","format"] }
 *
 * `style: "object"` artinya method dipanggil dengan 1 object literal
 * (destructuring), `style: "positional"` artinya parameter dikirim
 * satu-satu jadi argumen langsung.
 *
 * `params` adalah metadata KAYA per parameter (kind: property/alias/
 * rest/param, plus required/hasDefault/defaultValue) — generator HARUS
 * baca dari sini, gak boleh nebak-nebak dari string lagi.
 *
 * `names` tetap disediakan buat backward-compat (konsumen lama yang
 * cuma butuh daftar nama parameter, mis. UI admin yang udah ada).
 *
 * `optional` true kalau seluruh object parameter punya default sendiri,
 * mis. `({ name } = {})` — artinya argumen ini boleh gak dikirim sama
 * sekali dari sisi caller.
 *
 * Lempar ParserUnsupportedError (bukan nebak/silent-fail) buat pola
 * yang belum didukung: nested object, array destructuring, computed
 * property. `ctx` opsional `{ methodName }` dipakai buat lokasi error.
 */
export function parseMethodParams(paramsRaw, ctx = {}) {
  const trimmed = String(paramsRaw || "").trim();
  if (!trimmed) return { style: "none", optional: false, params: [], names: [] };

  if (trimmed.startsWith("{")) {
    const closeIdx = findMatchingClose(trimmed, 0, "{", "}");
    const inner = trimmed.slice(1, closeIdx);
    const remainder = trimmed.slice(closeIdx + 1).trim();

    let optional = false;
    if (remainder) {
      if (!remainder.startsWith("=")) {
        throw new ParserUnsupportedError(`Pola parameter setelah object destructuring tidak dikenali: "${remainder}".`, ctx);
      }
      optional = true;
    }

    const params = splitTopLevelCommas(inner).map((seg) => parseObjectPatternSegment(seg, ctx));
    const names = params.map((p) => (p.kind === "rest" ? p.name : p.source));
    return { style: "object", optional, params, names };
  }

  if (trimmed.startsWith("[")) {
    throw new ParserUnsupportedError("Array destructuring belum didukung.", ctx);
  }

  const params = splitTopLevelCommas(trimmed).map((seg) => parsePositionalSegment(seg, ctx));
  const names = params.map((p) => p.name);
  return { style: "positional", optional: false, params, names };
}

/**
 * "Parser Validation Layer" (#13): rangkum pola apa aja yang berhasil
 * kedetect di satu hasil parseMethodParams, dalam bentuk checklist
 * ✓ siap ditampilkan ke user (mis. panel /admin). Kalau parseMethodParams
 * berhasil balik (gak throw), berarti semua pola di dalamnya udah
 * didukung — fungsi ini cuma buat presentasi, bukan buat re-validasi.
 */
export function validateParsedMethodParams(parsed) {
  const kindsPresent = new Set();
  for (const p of (parsed && parsed.params) || []) {
    kindsPresent.add(p.kind === "param" ? "property" : p.kind);
    if (p.hasDefault) kindsPresent.add("default");
  }
  const order = ["property", "alias", "rest", "default"];
  const lines = order.filter((k) => kindsPresent.has(k)).map((k) => `✓ ${k}`);
  if (!lines.length) lines.push("✓ (tidak ada parameter)");
  return { ok: true, lines, summary: "Parser OK" };
}

/**
 * Scan isi body class (level teratas doang, bukan nested function di
 * dalam method) buat nemuin semua method (termasuk constructor) beserta
 * parameternya. Dipakai buat:
 *  - validasi "method X ada gak di class ini" sebelum generate route
 *  - auto-isi daftar parameter (gak perlu nebak manual)
 *  - deteksi constructor butuh argumen atau enggak
 *
 * Mendukung method biasa (`async foo() {}`, `static foo() {}`,
 * `get/set foo() {}`) maupun class-field arrow function
 * (`foo = async (a, b) => {}`).
 */
export function extractClassMethods(classBlock) {
  const bodyOpen = classBlock.indexOf("{");
  const body = classBlock.slice(bodyOpen + 1, -1); // sampai sebelum '}' penutup class

  const methods = [];
  let depth = 0;
  let i = 0;

  while (i < body.length) {
    const ch = body[i];
    if (ch === "{") { depth++; i++; continue; }
    if (ch === "}") { depth--; i++; continue; }

    if (depth === 0) {
      const rest = body.slice(i);

      // Pola 1: method biasa -> (static)? (async)? (get|set)? name(
      const methodMatch = rest.match(/^(static\s+)?(async\s+)?(\*\s*)?(get\s+|set\s+)?(#?[A-Za-z_$][\w$]*)\s*\(/);
      if (methodMatch) {
        const name = methodMatch[5];
        const parenStart = i + methodMatch[0].length - 1;
        const parenClose = findMatchingClose(body, parenStart, "(", ")");
        let j = parenClose + 1;
        while (/\s/.test(body[j])) j++;
        if (body[j] === "{") {
          const paramsRaw = body.slice(parenStart + 1, parenClose).trim();
          methods.push({
            name,
            isConstructor: name === "constructor",
            isStatic: !!methodMatch[1],
            isAsync: !!methodMatch[2],
            isArrowField: false,
            paramsRaw,
            params: parseMethodParams(paramsRaw, { methodName: name })
          });
          i = j;
          continue;
        }
      }

      // Pola 2: class-field arrow function -> name = (async)? (args) => {
      const arrowMatch = rest.match(/^(#?[A-Za-z_$][\w$]*)\s*=\s*(async\s+)?\(([^)]*)\)\s*=>\s*\{/);
      if (arrowMatch) {
        const name = arrowMatch[1];
        const paramsRaw = arrowMatch[3].trim();
        methods.push({
          name,
          isConstructor: false,
          isStatic: false,
          isAsync: !!arrowMatch[2],
          isArrowField: true,
          paramsRaw,
          params: parseMethodParams(paramsRaw, { methodName: name })
        });
        i += arrowMatch[0].length - 1; // -1 supaya '{' yang barusan match ke-hitung depth di iterasi berikut
        continue;
      }
    }
    i++;
  }

  return methods;
}

/**
 * Deteksi method mana aja yang dipanggil secara INTERNAL dari dalam
 * class itu sendiri (this.namaMethod(...), this.#privat(...), atau
 * NamaClass.staticMethod(...) buat static). Dipakai admin panel buat
 * ngasih badge "dipanggil internal" — penanda bahwa method itu
 * kemungkinan helper dan gak perlu dijadikan endpoint sendiri.
 *
 * Pakai state machine yang sama gayanya dengan findMatchingClose:
 * teks di dalam string literal / template literal / comment diabaikan,
 * biar "this.login(" di dalam string error message gak salah kedetect.
 */
export function detectInternallyCalledMethods(classBlock, methods, className) {
  const methodNames = new Set(methods.filter((m) => !m.isConstructor).map((m) => m.name));
  const called = new Set();
  if (!methodNames.size) return called;

  const src = String(classBlock || "");
  let quote = null;
  let inLineComment = false;
  let inBlockComment = false;
  let cleaned = "";

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];

    if (inLineComment) {
      if (ch === "\n") { inLineComment = false; cleaned += "\n"; }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") { inBlockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; cleaned += " "; continue; }
    if (ch === "/" && next === "/") { inLineComment = true; continue; }
    if (ch === "/" && next === "*") { inBlockComment = true; i++; continue; }
    cleaned += ch;
  }

  for (const m of cleaned.matchAll(/\bthis\s*\.\s*(#?[A-Za-z_$][\w$]*)\s*\(/g)) {
    if (methodNames.has(m[1])) called.add(m[1]);
  }
  if (className) {
    const staticRe = new RegExp(`\\b${escapeRegex(className)}\\s*\\.\\s*(#?[A-Za-z_$][\\w$]*)\\s*\\(`, "g");
    for (const m of cleaned.matchAll(staticRe)) {
      if (methodNames.has(m[1])) called.add(m[1]);
    }
  }
  return called;
}

/**
 * Cari 1 method spesifik (by name) dari hasil extractClassMethods,
 * dan lempar error yang jelas (+ daftar method yang tersedia) kalau
 * gak ketemu. Inilah yang mencegah kasus "download is not a function"
 * — begitu nama method salah ketik, langsung ketauan di preview.
 */
export function findMethodOrThrow(methods, methodName) {
  const found = methods.find((m) => m.name === methodName && !m.isConstructor);
  if (found) return found;
  const available = methods.filter((m) => !m.isConstructor).map((m) => m.name);
  const list = available.length ? available.map((n) => `- ${n}`).join("\n") : "(class ini gak punya method sama sekali)";
  throw new Error(`Method "${methodName}" tidak ditemukan di class ini.\nMethod yang tersedia:\n${list}`);
}

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, "..", "..");
export const SERVICES_DIR = path.join(ROOT, "src", "services");
export const ROUTES_DIR = path.join(ROOT, "src", "routes");
export const ROUTES_INDEX = path.join(ROUTES_DIR, "index.js");
export const PUBLIC_DATA = path.join(ROOT, "public", "data.js");

/* ------------------------------------------------------------------ */
/* Helpers dasar                                                       */
/* ------------------------------------------------------------------ */

export function slugify(str) {
  return String(str || "")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "")
    .replace(/^[0-9]+/, "");
}

export function lowerFirst(str) {
  if (!str) return str;
  return str[0].toLowerCase() + str.slice(1);
}

export function upperFirst(str) {
  if (!str) return str;
  return str[0].toUpperCase() + str.slice(1);
}

/**
 * Cari index penutup bracket yang match, mulai SETELAH openIndex
 * (openIndex = posisi karakter buka, mis. index dari "{" pertama).
 *
 * v2: sadar string ("...", '...', `...`) dan comment (// ..., /* ... *\/)
 * — karakter buka/tutup di dalam situ diabaikan, biar gak salah hitung
 * depth cuma gara-gara ada "{" atau "}" nyasar di dalam string/comment.
 * Tetap bukan full AST parser, jadi nested template literal (backtick
 * di dalam ${...} milik template literal lain) belum didukung.
 */
export function findMatchingClose(source, openIndex, openChar, closeChar) {
  let depth = 1;
  let quote = null; // '"' | "'" | "`" | null
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openIndex + 1; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
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
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "/" && next === "/") { inLineComment = true; i++; continue; }
    if (ch === "/" && next === "*") { inBlockComment = true; i++; continue; }

    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Bracket tidak seimbang, tidak ketemu penutup untuk '${openChar}' di index ${openIndex}`);
}

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


/* ------------------------------------------------------------------ */
/* 2. Generate isi file service                                        */
/* ------------------------------------------------------------------ */

export function buildServiceFileContent({ importLines, preludeCode, classBlock, className, hasInlineExport }) {
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
  endpointDesc
}) {
  const method = (httpMethod || "ALL").toLowerCase();
  const pathParams = extractPathParams(subPath);
  const reqParams = (allRequestParams || []).filter((p) => !pathParams.includes(p.requestParamName));

  let paramsLine = "";
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
  const orderedReqParams = [...reqParams].sort((a, b) => (a.kind === "rest" ? 1 : 0) - (b.kind === "rest" ? 1 : 0));

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
    .map((p) => `    if (!${p.requestParamName}) throw new ApiError("Parameter '${p.requestParamName}' wajib diisi", 400);\n`)
    .join("");

  const methodOrderedArgs = (methodArgs || []).map((a) => ({
    serviceKey: a.serviceParamName,
    kind: a.kind || "property",
    expr: pathParams.includes(a.requestParamName) ? `req.params.${a.requestParamName}` : a.requestParamName
  }));
  const methodCallArg = buildCallExpression(methodParamStyle || "none", methodOrderedArgs);

  let instanceSetupLine = "";
  let usesPerRequestInstance = false;
  if (ctor && ctor.args && ctor.args.length) {
    usesPerRequestInstance = true;
    const ctorOrderedArgs = ctor.args.map((a) => ({
      serviceKey: a.serviceParamName,
      kind: a.kind || "property",
      expr: a.source === "static" ? JSON.stringify(a.staticValue ?? "") : a.requestParamName
    }));
    const ctorCallArg = buildCallExpression(ctor.style || "positional", ctorOrderedArgs);
    instanceSetupLine = `    const ${instanceName} = new ${className}(${ctorCallArg});\n`;
  }

  const methodLabel = method === "all" ? "GET/POST" : method.toUpperCase();
  const comment = `/**\n * ${methodLabel} /api/{ROUTE_PREFIX}${subPath}\n * ${endpointName ? endpointName + " — " : ""}${endpointDesc || ""}\n */`;

  const body = `${paramsLine}${destructure}${validations}${instanceSetupLine}    const data = await ${instanceName}.${callMethod}(${methodCallArg});\n    return ok(res, data);\n`;

  return {
    code: `${comment}\nrouter.${method}(\n  "${subPath}",\n  asyncHandler(async (req, res) => {\n${body}  })\n);\n`,
    usesPerRequestInstance
  };
}

export function buildNewRouteFileContent({ className, serviceFileName, instanceName, routeBlockCode, usesPerRequestInstance }) {
  const lines = [
    `import { Router } from "express";`,
    `import ${className} from "../services/${serviceFileName}.service.js";`,
    `import { asyncHandler } from "../utils/asyncHandler.js";`,
    `import { ok, ApiError } from "../utils/response.js";`,
    ``,
    `const router = Router();`
  ];
  if (!usesPerRequestInstance) lines.push(`const ${instanceName} = new ${className}();`);
  lines.push(``, routeBlockCode, `export default router;`, ``);
  return lines.join("\n");
}

export function appendRouteBlockToExistingFile(existingContent, { className, serviceFileName, instanceName, routeBlockCode, usesPerRequestInstance }) {
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
  if (!exportAnchor) throw new Error("File route existing tidak punya 'export default router;' — format tidak dikenali.");
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
    if (arrInner[i] === "{") { if (depth === 0) start = i; depth++; }
    else if (arrInner[i] === "}") {
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

const ACCENT_TAGS_HINT = "pilih 2 huruf singkatan unik, mis. 'SC' buat Soundcloud";

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
    `  }`
  ].join("\n");

  out = insertArrayEntry(out, openIdx, closeIdx, categoryStr, "");
  return out;
}

function escapeJsString(str) {
  return String(str || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function unescapeJsString(str) {
  return String(str || "").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
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
        path: pathM[1]
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
  for (const m of content.matchAll(/^import\s+(\w+)\s+from\s+["']\.\.\/services\/([\w.-]+)\.service\.js["'];?[ \t]*\n?/gm)) {
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
    .filter((f) => f.endsWith(".routes.js") && f !== `${excludeRouteFileBase}.routes.js` && f !== "admin.routes.js");
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
export function computeOrphanedServices(originalRouteFileContent, newRouteFileContent, { willDeleteRouteFile, routeFileBase }) {
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

export function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Data.js pakai label "ALL" buat endpoint gabungan GET+POST, sedangkan
 * beberapa entry lama di routes/index.js (ditulis manual sebelum ada
 * scaffold tool ini) pakai label "GET/POST" buat endpoint yang PERSIS
 * SAMA. Supaya matching gak gagal gara-gara beda label doang, anggap
 * "ALL" dan "GET/POST" itu satu bucket yang sama.
 */
export function methodBucket(method) {
  const u = String(method || "").toUpperCase();
  return u === "ALL" || u === "GET/POST" ? "COMBINED" : u;
}

/**
 * Pecah full path "/api/<slug>/sisanya" jadi { routeSlug, subPath }.
 */
export function splitApiPath(fullPath) {
  const m = String(fullPath || "").match(/^\/api\/([^/]+)(\/.*)?$/);
  if (!m) throw new Error(`Path "${fullPath}" harus berformat /api/<slug>/...`);
  return { routeSlug: m[1], subPath: m[2] || "/" };
}

/**
 * Dari isi routes/index.js, cari nama file route (tanpa .routes.js) yang
 * di-mount di prefix tertentu lewat router.use("/prefix", xxxRoutes).
 */
export function findRouteFileForSlug(indexContent, routeSlug) {
  const useMatch = indexContent.match(new RegExp(`router\\.use\\(\\s*["']\\/${escapeRegex(routeSlug)}["']\\s*,\\s*(\\w+)\\s*\\)`));
  if (!useMatch) return null;
  const varName = useMatch[1];
  const importMatch = indexContent.match(new RegExp(`import\\s+${varName}\\s+from\\s+["']\\.\\/(.+?)\\.routes\\.js["']`));
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
    const exact = matches.find((m) => methodBucket(m[1]) === wantBucket || m[1].toUpperCase() === String(method).toUpperCase());
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
  out = out.replace(new RegExp(`^import\\s+\\w+\\s+from\\s+["']\\.\\/${escapeRegex(routeSlug)}\\.routes\\.js["'];?\\s*\\n?`, "m"), "");
  out = out.replace(new RegExp(`^router\\.use\\(\\s*["']\\/${escapeRegex(routeSlug)}["']\\s*,\\s*\\w+\\s*\\);?\\s*\\n?`, "m"), "");
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
        desc: d ? unescapeJsString(d[1]) : ""
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
    query: parseParamArray("query")
  };
}

/* ------------------------------------------------------------------ */
/* 9. Diff sederhana (buat preview ala git diff)                       */
/* ------------------------------------------------------------------ */

/**
 * Diff antar baris (LCS klasik). Return array {type: "same"|"add"|"remove", line}.
 * Cukup buat file-file di project ini (ratusan baris), gak perlu
 * library eksternal.
 */
export function diffLines(oldStr, newStr) {
  const a = String(oldStr ?? "").split("\n");
  const b = String(newStr ?? "").split("\n");
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const result = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { result.push({ type: "same", line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { result.push({ type: "remove", line: a[i] }); i++; }
    else { result.push({ type: "add", line: b[j] }); j++; }
  }
  while (i < n) { result.push({ type: "remove", line: a[i] }); i++; }
  while (j < m) { result.push({ type: "add", line: b[j] }); j++; }
  return result;
}

/**
 * Padatin hasil diffLines ala `git diff`: baris "same" yang panjang di
 * tengah-tengah diringkas jadi 1 penanda "N baris tidak berubah",
 * cuma nyisain `context` baris di sekitar tiap perubahan.
 */
export function compactDiff(diffArr, context = 2) {
  const n = diffArr.length;
  const keep = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (diffArr[i].type !== "same") {
      for (let k = Math.max(0, i - context); k <= Math.min(n - 1, i + context); k++) keep[k] = true;
    }
  }
  const out = [];
  let i = 0;
  while (i < n) {
    if (keep[i]) { out.push(diffArr[i]); i++; continue; }
    let j = i;
    while (j < n && !keep[j]) j++;
    out.push({ type: "context", count: j - i });
    i = j;
  }
  return out;
}


/* ------------------------------------------------------------------ */
/* 8. Snapshot & rollback (dipakai /admin/apply biar aman kalau ada    */
/*    1 file gagal ditulis di tengah proses)                           */
/* ------------------------------------------------------------------ */

/**
 * Ambil "potret" isi file-file yang BAKAL disentuh (ditulis/dihapus)
 * SEBELUM proses apply mulai. Untuk file yang belum ada, dicatat
 * sebagai `null` (artinya: kalau di-rollback, file itu harus DIHAPUS
 * lagi, bukan dikembalikan isinya).
 */
export function snapshotFiles(paths) {
  const snapshot = {};
  for (const p of paths) {
    snapshot[p] = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  }
  return snapshot;
}

/**
 * Kembalikan semua file persis seperti isi snapshot-nya. File yang
 * snapshot-nya `null` (belum ada sebelum apply) akan DIHAPUS lagi.
 * Dipanggil kalau ada error di tengah proses tulis-menulis apply,
 * supaya tidak ada perubahan yang "setengah jadi".
 */
export function restoreFromSnapshot(snapshot) {
  for (const [p, original] of Object.entries(snapshot)) {
    if (original === null) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } else {
      fs.writeFileSync(p, original, "utf8");
    }
  }
}

/**
 * Jalanin `fn()` (serangkaian fs.writeFileSync/unlinkSync ke `paths`)
 * dengan snapshot+rollback otomatis: kalau `fn` lempar error, semua
 * file di `paths` dikembalikan seperti semula sebelum error itu
 * dilempar ulang ke pemanggil.
 */
export function withRollback(paths, fn) {
  const snapshot = snapshotFiles(paths);
  try {
    return fn();
  } catch (err) {
    restoreFromSnapshot(snapshot);
    throw err;
  }
}


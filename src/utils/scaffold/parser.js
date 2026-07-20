// Parser kode class yang di-paste user (extractClassInfo, extractClassMethods,
// parseMethodParams, dst) + dependency checker.
//
// Sejak migrasi ke AST (acorn), semua analisis struktur (deteksi class,
// method, parameter, pemanggilan internal) dilakukan lewat parse JS beneran —
// bukan regex + brace matching manual. Ini memperbaiki sekaligus tiga bug
// lama: brace di dalam template literal/komentar yang merusak deteksi
// method, class-field arrow dengan paren bersarang di default value yang
// tidak terdeteksi, dan import multiline yang lolos dari dependency checker.
// API publik dan bentuk hasil (params/names/kind/required/dst) sengaja
// dipertahankan persis — konsumen (planBuilders, routes, UI admin) tidak
// perlu berubah.
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import * as acorn from "acorn";
import { ROOT } from "./core.js";

const ACORN_OPTS = { ecmaVersion: "latest", sourceType: "module" };

/** Traversal AST generik sederhana (cukup buat kebutuhan di file ini). */
function walkAst(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "type") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === "string") walkAst(child, visit);
      }
    } else if (value && typeof value.type === "string") {
      walkAst(value, visit);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 1. Parse kode class yang di-paste user                              */
/* ------------------------------------------------------------------ */

/**
 * Ambil hanya blok `class Xxx { ... }` dari kode mentah yang di-paste,
 * plus statement `import ...` di atasnya (termasuk import MULTILINE,
 * yang dulu lolos dari deteksi karena regex per-baris). Buang sisanya
 * (mis. CLI runner `async function main(){...}` / `main();`).
 */
export function extractClassInfo(rawCode) {
  const code = String(rawCode || "").replace(/\r\n/g, "\n");

  let ast;
  try {
    ast = acorn.parse(code, ACORN_OPTS);
  } catch (e) {
    throw new Error(`Kode yang di-paste bukan JavaScript valid: ${e.message}`, { cause: e });
  }

  // Cari class TOP-LEVEL pertama (deklarasi biasa atau export default).
  let classNode = null;
  let sliceStart = -1; // awal teks classBlock (ikut "export default " kalau ada)
  for (const stmt of ast.body) {
    if (stmt.type === "ClassDeclaration") {
      classNode = stmt;
      sliceStart = stmt.start;
      break;
    }
    if (stmt.type === "ExportDefaultDeclaration" && stmt.declaration.type === "ClassDeclaration") {
      classNode = stmt.declaration;
      sliceStart = stmt.start;
      break;
    }
  }
  if (!classNode) {
    throw new Error("Tidak ketemu deklarasi 'class' di kode yang di-paste.");
  }
  if (!classNode.id) {
    throw new Error("Class-nya harus punya nama (mis. `class TiktokDownloader { ... }`).");
  }

  const hasInlineExport = sliceStart !== classNode.start;
  const className = classNode.id.name;
  const classBlock = code.slice(sliceStart, classNode.end);

  // Import: ambil SEMUA statement import sebelum class (single/multiline
  // sama saja — yang dipotong node AST utuh, bukan per baris).
  const importRanges = [];
  const importLines = [];
  for (const stmt of ast.body) {
    if (stmt.type !== "ImportDeclaration" || stmt.start >= sliceStart) continue;
    importRanges.push([stmt.start, stmt.end]);
    importLines.push(code.slice(stmt.start, stmt.end).trim());
  }

  // Apapun yang ada SEBELUM class selain import (const/let/var, helper
  // function, IIFE decode base64, dsb) jangan dibuang — class body-nya
  // bisa aja bergantung ke situ (mis. setup watermark/konstanta).
  let preludeCode = "";
  let cursor = 0;
  for (const [start, end] of importRanges) {
    preludeCode += code.slice(cursor, start);
    cursor = end;
  }
  preludeCode += code.slice(cursor, sliceStart);
  preludeCode = preludeCode.trim();

  return {
    className,
    classBlock,
    hasInlineExport,
    importLines: [...new Set(importLines)],
    preludeCode,
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
    ...Object.keys(pkg.optionalDependencies || {}),
  ]);
  const warnings = [];
  for (const line of importLines) {
    // `from "pkg"` (import biasa) ATAU `import "pkg"` (side-effect import).
    const m = line.match(/from\s+["']([^"']+)["']/) || line.match(/^import\s+["']([^"']+)["']/);
    if (!m) continue;
    const spec = m[1];
    if (spec.startsWith(".") || spec.startsWith("node:")) continue; // relative / builtin, biarin
    const pkgName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    if (!known.has(pkgName)) warnings.push(pkgName);
  }
  return [...new Set(warnings)];
}

/**
 * Resolve versi terbaru sebuah package lewat `npm view` (di-cache
 * per-proses biar preview + apply gak nge-hit registry dua kali).
 * Balikin null kalau gagal (offline / package gak ada) — caller yang
 * menentukan fallback-nya.
 */
const versionCache = new Map();
export function resolveLatestVersion(pkgName) {
  if (versionCache.has(pkgName)) return versionCache.get(pkgName);
  let version = null;
  try {
    const out = execFileSync("npm", ["view", pkgName, "version"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (/^\d+\.\d+\.\d+/.test(out)) version = out;
  } catch {
    /* offline / package gak ketemu — fallback ke "latest" di caller */
  }
  versionCache.set(pkgName, version);
  return version;
}

/**
 * Tambahin package yang belum ada ke package.json (dependencies).
 * Versinya di-resolve beneran ke `^x.y.z` lewat `npm view` — BUKAN string
 * "latest" seperti dulu, yang nyangkut permanen di package.json dan bikin
 * `npm install` berikutnya diam-diam bisa naik major version. Kalau
 * resolve gagal (offline), baru fallback ke "latest".
 * Return: { content, added: [nama-nama yang beneran ditambahin] }.
 */
export function addDepsToPackageJson(
  pkgJsonContent,
  depNames,
  { resolveVersion = resolveLatestVersion } = {}
) {
  const pkg = JSON.parse(pkgJsonContent);
  pkg.dependencies = pkg.dependencies || {};
  const added = [];
  for (const name of depNames) {
    if (!pkg.dependencies[name]) {
      const version = resolveVersion(name);
      pkg.dependencies[name] = version ? `^${version}` : "latest";
      added.push(name);
    }
  }
  const sortedDeps = {};
  for (const key of Object.keys(pkg.dependencies).sort()) sortedDeps[key] = pkg.dependencies[key];
  pkg.dependencies = sortedDeps;
  return { content: JSON.stringify(pkg, null, 2) + "\n", added };
}

/* ------------------------------------------------------------------ */
/* 2. Validasi sintaks file hasil generate                             */
/* ------------------------------------------------------------------ */

/**
 * Cek satu konten file hasil generate valid secara sintaks JS atau
 * enggak. Balikin null kalau valid, atau pesan error kalau tidak —
 * dipakai plan builder buat menggagalkan preview/apply DI AWAL (error
 * 400 yang jelas) daripada server mati waktu restart nge-import file
 * rusak (rollback-on-error tetap ada, tapi mencegah lebih murah).
 */
export function checkJsSyntax(content) {
  try {
    acorn.parse(content, ACORN_OPTS);
    return null;
  } catch (e) {
    return e.message;
  }
}

/* ------------------------------------------------------------------ */
/* 2b. Analisis method & constructor di dalam class (validasi + auto-  */
/*     deteksi parameter, dipakai fitur "Analisis Class" di admin)     */
/* ------------------------------------------------------------------ */

/**
 * Split string di top-level comma aja (gak ke-split kalau lagi di
 * dalam (), [], {}, string literal, template literal, atau comment).
 * Dulu ini tulang punggung parser parameter; sekarang parameter dibaca
 * dari AST, tapi fungsi ini tetap diekspor buat konsumen lama.
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
      if (ch === "*" && next === "/") {
        current += next;
        i++;
        inBlockComment = false;
      }
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === "\\") {
        current += next;
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      current += ch;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      current += ch;
      continue;
    }

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

/**
 * Terjemahkan 1 node property di dalam ObjectPattern jadi metadata kaya
 * (kind: property/alias/rest + required/hasDefault/defaultValue).
 * `src` = source text tempat node ini di-parse (buat slice defaultValue
 * persis seperti ditulis user).
 */
function analyzeObjectPatternProperty(prop, src, ctx) {
  if (prop.type === "RestElement") {
    if (prop.argument.type !== "Identifier") {
      throw new ParserUnsupportedError(
        `Pola rest parameter tidak dikenali: "${src.slice(prop.start, prop.end)}".`,
        { ...ctx, paramName: src.slice(prop.start, prop.end) }
      );
    }
    return { kind: "rest", name: prop.argument.name };
  }

  if (prop.computed) {
    throw new ParserUnsupportedError("Computed property destructuring belum didukung.", {
      ...ctx,
      paramName: src.slice(prop.start, prop.end),
    });
  }
  if (prop.key.type !== "Identifier") {
    throw new ParserUnsupportedError(
      `Nama property tidak dikenali: "${src.slice(prop.key.start, prop.key.end)}".`,
      {
        ...ctx,
        paramName: src.slice(prop.key.start, prop.key.end),
      }
    );
  }
  const source = prop.key.name;

  // value bisa: Identifier (shorthand/alias), AssignmentPattern (default),
  // ObjectPattern/ArrayPattern (nested — belum didukung).
  let valueNode = prop.value;
  let defaultValue = null;
  if (valueNode.type === "AssignmentPattern") {
    defaultValue = src.slice(valueNode.right.start, valueNode.right.end);
    valueNode = valueNode.left;
  }
  if (valueNode.type === "ObjectPattern") {
    throw new ParserUnsupportedError("Nested object destructuring belum didukung.", {
      ...ctx,
      paramName: source,
    });
  }
  if (valueNode.type === "ArrayPattern") {
    throw new ParserUnsupportedError("Array destructuring belum didukung.", { ...ctx, paramName: source });
  }
  if (valueNode.type !== "Identifier") {
    throw new ParserUnsupportedError(`Pola parameter tidak dikenali: "${src.slice(prop.start, prop.end)}".`, {
      ...ctx,
      paramName: source,
    });
  }

  if (prop.shorthand) {
    return {
      kind: "property",
      name: source,
      source,
      required: defaultValue == null,
      hasDefault: defaultValue != null,
      ...(defaultValue != null ? { defaultValue } : {}),
    };
  }
  return {
    kind: "alias",
    source,
    target: valueNode.name,
    required: defaultValue == null,
    hasDefault: defaultValue != null,
    ...(defaultValue != null ? { defaultValue } : {}),
  };
}

/**
 * Terjemahkan daftar node parameter fungsi (dari AST) jadi bentuk hasil
 * parseMethodParams: { style, optional, params, names }. Dipakai bareng
 * oleh parseMethodParams (input string) dan extractClassMethods (node
 * langsung dari class) supaya SATU jalur kode, gak bisa divergen.
 */
function analyzeParamNodes(paramNodes, src, ctx) {
  if (!paramNodes.length) return { style: "none", optional: false, params: [], names: [] };

  // Style "object": PERSIS satu parameter berupa object destructuring
  // (boleh dibungkus default `= {}` -> optional).
  const single = paramNodes.length === 1 ? paramNodes[0] : null;
  const singleUnwrapped = single && single.type === "AssignmentPattern" ? single.left : single;
  if (singleUnwrapped && singleUnwrapped.type === "ObjectPattern") {
    const optional = single.type === "AssignmentPattern";
    const params = singleUnwrapped.properties.map((p) => analyzeObjectPatternProperty(p, src, ctx));
    const names = params.map((p) => (p.kind === "rest" ? p.name : p.source));
    return { style: "object", optional, params, names };
  }

  // Sisanya harus positional murni: Identifier / default / rest.
  const params = paramNodes.map((node) => {
    if (node.type === "RestElement") {
      if (node.argument.type !== "Identifier") {
        throw new ParserUnsupportedError(
          `Pola rest parameter tidak dikenali: "${src.slice(node.start, node.end)}".`,
          { ...ctx, paramName: src.slice(node.start, node.end) }
        );
      }
      return { kind: "rest", name: node.argument.name };
    }
    let defaultValue = null;
    let target = node;
    if (node.type === "AssignmentPattern") {
      defaultValue = src.slice(node.right.start, node.right.end);
      target = node.left;
    }
    if (target.type === "ObjectPattern") {
      throw new ParserUnsupportedError(
        "Parameter destructuring campuran (positional + object/array pattern) belum didukung.",
        { ...ctx, paramName: src.slice(node.start, node.end) }
      );
    }
    if (target.type === "ArrayPattern") {
      throw new ParserUnsupportedError("Array destructuring belum didukung.", {
        ...ctx,
        paramName: src.slice(node.start, node.end),
      });
    }
    if (target.type !== "Identifier") {
      throw new ParserUnsupportedError(
        `Pola parameter tidak dikenali: "${src.slice(node.start, node.end)}".`,
        {
          ...ctx,
          paramName: src.slice(node.start, node.end),
        }
      );
    }
    return {
      kind: "param",
      name: target.name,
      required: defaultValue == null,
      hasDefault: defaultValue != null,
      ...(defaultValue != null ? { defaultValue } : {}),
    };
  });
  const names = params.map((p) => p.name);
  return { style: "positional", optional: false, params, names };
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
 * property, atau teks yang bukan daftar parameter valid sama sekali.
 * `ctx` opsional `{ methodName }` dipakai buat lokasi error.
 */
export function parseMethodParams(paramsRaw, ctx = {}) {
  const trimmed = String(paramsRaw || "").trim();
  if (!trimmed) return { style: "none", optional: false, params: [], names: [] };

  // Bungkus jadi arrow function biar acorn yang menilai valid/enggaknya —
  // offset node tetap sejajar dengan `src` karena teks aslinya utuh di dalam.
  const src = `(${trimmed}) => {}`;
  let arrowNode;
  try {
    const ast = acorn.parse(src, ACORN_OPTS);
    arrowNode = ast.body[0].expression;
  } catch {
    throw new ParserUnsupportedError(`Pola parameter tidak dikenali: "${trimmed}".`, ctx);
  }
  if (!arrowNode || arrowNode.type !== "ArrowFunctionExpression") {
    throw new ParserUnsupportedError(`Pola parameter tidak dikenali: "${trimmed}".`, ctx);
  }
  return analyzeParamNodes(arrowNode.params, src, ctx);
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

/** Parse classBlock (boleh berawalan "export default ") jadi node class AST. */
function parseClassBlock(classBlock) {
  const src = String(classBlock || "");
  let ast;
  try {
    ast = acorn.parse(src, ACORN_OPTS);
  } catch (e) {
    throw new Error(`Kode class bukan JavaScript valid: ${e.message}`, { cause: e });
  }
  for (const stmt of ast.body) {
    if (stmt.type === "ClassDeclaration") return { classNode: stmt, src };
    if (stmt.type === "ExportDefaultDeclaration" && stmt.declaration.type === "ClassDeclaration") {
      return { classNode: stmt.declaration, src };
    }
  }
  throw new Error("Tidak ketemu deklarasi 'class' di kode yang di-paste.");
}

/** Nama member class dari node key ("#privat" buat PrivateIdentifier). */
function memberName(keyNode) {
  if (keyNode.type === "Identifier") return keyNode.name;
  if (keyNode.type === "PrivateIdentifier") return `#${keyNode.name}`;
  return null; // string literal / computed key — di-skip (gak bisa jadi endpoint)
}

/**
 * Scan body class (level teratas doang, bukan nested function di dalam
 * method) buat nemuin semua method (termasuk constructor) beserta
 * parameternya. Dipakai buat:
 *  - validasi "method X ada gak di class ini" sebelum generate route
 *  - auto-isi daftar parameter (gak perlu nebak manual)
 *  - deteksi constructor butuh argumen atau enggak
 *
 * Mendukung method biasa (`async foo() {}`, `static foo() {}`,
 * `get/set foo() {}`, generator) maupun class-field arrow function
 * (`foo = async (a, b) => {}` — termasuk default value berisi paren
 * bersarang dan arrow tanpa body `{}`, yang dulu gak kedetect).
 */
export function extractClassMethods(classBlock) {
  const { classNode, src } = parseClassBlock(classBlock);

  const methods = [];
  for (const member of classNode.body.body) {
    if (member.type === "MethodDefinition") {
      const name = memberName(member.key);
      if (!name) continue;
      const fn = member.value; // FunctionExpression
      const paramsRaw = fn.params.length
        ? src.slice(fn.params[0].start, fn.params[fn.params.length - 1].end).trim()
        : "";
      methods.push({
        name,
        isConstructor: member.kind === "constructor",
        isStatic: !!member.static,
        isAsync: !!fn.async,
        isArrowField: false,
        paramsRaw,
        params: analyzeParamNodes(fn.params, src, { methodName: name }),
      });
      continue;
    }
    if (
      member.type === "PropertyDefinition" &&
      member.value &&
      member.value.type === "ArrowFunctionExpression"
    ) {
      const name = memberName(member.key);
      if (!name) continue;
      const fn = member.value;
      const paramsRaw = fn.params.length
        ? src.slice(fn.params[0].start, fn.params[fn.params.length - 1].end).trim()
        : "";
      methods.push({
        name,
        isConstructor: false,
        isStatic: !!member.static,
        isAsync: !!fn.async,
        isArrowField: true,
        paramsRaw,
        params: analyzeParamNodes(fn.params, src, { methodName: name }),
      });
    }
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
 * Berbasis AST: teks di dalam string literal / template / comment
 * otomatis bukan CallExpression, jadi gak mungkin salah kedetect.
 */
export function detectInternallyCalledMethods(classBlock, methods, className) {
  const methodNames = new Set(methods.filter((m) => !m.isConstructor).map((m) => m.name));
  const called = new Set();
  if (!methodNames.size) return called;

  let classNode;
  try {
    ({ classNode } = parseClassBlock(classBlock));
  } catch {
    return called; // classBlock gak ke-parse — udah ditangani di tempat lain
  }

  walkAst(classNode, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee;
    if (callee.type !== "MemberExpression" || callee.computed) return;
    const name = memberName(callee.property);
    if (!name || !methodNames.has(name)) return;
    if (callee.object.type === "ThisExpression") called.add(name);
    else if (className && callee.object.type === "Identifier" && callee.object.name === className) {
      called.add(name);
    }
  });
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
  const list = available.length
    ? available.map((n) => `- ${n}`).join("\n")
    : "(class ini gak punya method sama sekali)";
  throw new Error(`Method "${methodName}" tidak ditemukan di class ini.\nMethod yang tersedia:\n${list}`);
}

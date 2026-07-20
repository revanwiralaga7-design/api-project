// Konstanta path project + helper string/bracket dasar yang dipakai
// bareng semua modul scaffold lain (parser, generator, registry).
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, "..", "..", "..");
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
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Bracket tidak seimbang, tidak ketemu penutup untuk '${openChar}' di index ${openIndex}`);
}

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

export function escapeJsString(str) {
  return String(str || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

export function unescapeJsString(str) {
  return String(str || "")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

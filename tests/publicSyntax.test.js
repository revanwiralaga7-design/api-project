import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guard ringan: file frontend (public/*.js) gak pernah ke-import test lain
 * (bukan ESM murni, nempel ke window), tapi syntax error di sana bikin
 * halaman admin/docs mati diam-diam. new Function() = parse-only, gak
 * mengeksekusi (window dkk gak disentuh).
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

test("semua public/*.js bebas syntax error", () => {
  const files = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith(".js"));
  assert.ok(files.length >= 5, "minimal ada beberapa file js di public/");
  for (const f of files) {
    const src = fs.readFileSync(path.join(PUBLIC_DIR, f), "utf8");
    assert.doesNotThrow(() => new Function(src), `syntax error di public/${f}`);
  }
});

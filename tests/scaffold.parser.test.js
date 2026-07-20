import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  splitTopLevelCommas,
  findMatchingClose,
  parseMethodParams,
  validateParsedMethodParams,
  ParserUnsupportedError,
  extractClassInfo,
  extractClassMethods,
  detectInternallyCalledMethods,
  findMethodOrThrow,
  buildRouteBlockCode,
  checkMissingDeps,
  checkJsSyntax,
  addDepsToPackageJson,
} from "../src/utils/scaffold.js";

/* ------------------------------------------------------------------ */
/* splitTopLevelCommas                                                 */
/* ------------------------------------------------------------------ */

describe("splitTopLevelCommas", () => {
  test("simple comma list", () => {
    assert.deepEqual(splitTopLevelCommas("a, b, c"), ["a", "b", "c"]);
  });

  test("ignores commas inside {}", () => {
    assert.deepEqual(splitTopLevelCommas("a, { x: 1, y: 2 }, b"), ["a", "{ x: 1, y: 2 }", "b"]);
  });

  test("ignores commas inside []", () => {
    assert.deepEqual(splitTopLevelCommas("a, [1, 2, 3], b"), ["a", "[1, 2, 3]", "b"]);
  });

  test("ignores commas inside ()", () => {
    assert.deepEqual(splitTopLevelCommas("a, fn(1, 2), b"), ["a", "fn(1, 2)", "b"]);
  });

  test("ignores commas inside single-quoted string", () => {
    assert.deepEqual(splitTopLevelCommas("a, 'x,y', b"), ["a", "'x,y'", "b"]);
  });

  test("ignores commas inside double-quoted string", () => {
    assert.deepEqual(splitTopLevelCommas('a, "x,y", b'), ["a", '"x,y"', "b"]);
  });

  test("ignores commas inside template literal", () => {
    assert.deepEqual(splitTopLevelCommas("a, `x,${b},y`, c"), ["a", "`x,${b},y`", "c"]);
  });

  test("object default with nested commas stays one segment (spec item 11 example)", () => {
    assert.deepEqual(splitTopLevelCommas("data = { a:1, b:2 }"), ["data = { a:1, b:2 }"]);
  });

  test("empty string yields empty array", () => {
    assert.deepEqual(splitTopLevelCommas(""), []);
  });

  test("does not split a plain comparison a < b as generic", () => {
    // "<" cuma di-treat generic kalau diikuti huruf besar; "b" huruf kecil -> gak ke-trigger
    assert.deepEqual(splitTopLevelCommas("a < b, c"), ["a < b", "c"]);
  });
});

/* ------------------------------------------------------------------ */
/* findMatchingClose                                                    */
/* ------------------------------------------------------------------ */

describe("findMatchingClose", () => {
  test("simple matching brace", () => {
    const src = "{ a: 1 }";
    assert.equal(findMatchingClose(src, 0, "{", "}"), src.length - 1);
  });

  test("nested braces", () => {
    const src = "{ a: { b: 1 } }";
    assert.equal(findMatchingClose(src, 0, "{", "}"), src.length - 1);
  });

  test("ignores brace characters inside a string", () => {
    const src = '{ a: "}" }';
    assert.equal(findMatchingClose(src, 0, "{", "}"), src.length - 1);
  });

  test("ignores brace characters inside a line comment", () => {
    const src = "{ a: 1 // } not real\n}";
    assert.equal(findMatchingClose(src, 0, "{", "}"), src.length - 1);
  });

  test("ignores brace characters inside a block comment", () => {
    const src = "{ a: 1 /* } not real */ }";
    assert.equal(findMatchingClose(src, 0, "{", "}"), src.length - 1);
  });

  test("throws on unbalanced input", () => {
    assert.throws(() => findMatchingClose("{ a: 1", 0, "{", "}"));
  });
});

/* ------------------------------------------------------------------ */
/* parseMethodParams — happy paths (regression list, spec item 15)     */
/* ------------------------------------------------------------------ */

describe("parseMethodParams — supported patterns", () => {
  test("no params", () => {
    const r = parseMethodParams("");
    assert.equal(r.style, "none");
    assert.deepEqual(r.params, []);
    assert.deepEqual(r.names, []);
  });

  test("positional: single param", () => {
    const r = parseMethodParams("query");
    assert.equal(r.style, "positional");
    assert.deepEqual(r.names, ["query"]);
    assert.equal(r.params[0].required, true);
    assert.equal(r.params[0].hasDefault, false);
  });

  test("positional: multiple params", () => {
    const r = parseMethodParams("url, format");
    assert.deepEqual(r.names, ["url", "format"]);
  });

  test("positional: with default value", () => {
    const r = parseMethodParams("a, b = 1");
    assert.equal(r.params[1].hasDefault, true);
    assert.equal(r.params[1].required, false);
    assert.equal(r.params[1].defaultValue, "1");
  });

  test("positional: trailing rest", () => {
    const r = parseMethodParams("a, b, ...rest");
    assert.deepEqual(r.names, ["a", "b", "rest"]);
    assert.equal(r.params[2].kind, "rest");
  });

  test("object: single property { url }", () => {
    const r = parseMethodParams("{ url }");
    assert.equal(r.style, "object");
    assert.deepEqual(r.names, ["url"]);
    assert.equal(r.params[0].kind, "property");
    assert.equal(r.params[0].required, true);
    assert.equal(r.params[0].hasDefault, false);
  });

  test("object: multiple properties { url, quality }", () => {
    const r = parseMethodParams("{ url, quality }");
    assert.deepEqual(r.names, ["url", "quality"]);
  });

  test("object: property + rest { url, ...rest }", () => {
    const r = parseMethodParams("{ url, ...rest }");
    assert.deepEqual(r.names, ["url", "rest"]);
    assert.equal(r.params[0].kind, "property");
    assert.equal(r.params[1].kind, "rest");
    assert.equal(r.params[1].name, "rest");
  });

  test("object: alias { url: videoUrl }", () => {
    const r = parseMethodParams("{ url: videoUrl }");
    assert.equal(r.params[0].kind, "alias");
    assert.equal(r.params[0].source, "url");
    assert.equal(r.params[0].target, "videoUrl");
    assert.equal(r.params[0].required, true);
    // names (backward-compat) tetap pakai SOURCE key, sesuai perilaku lama
    assert.deepEqual(r.names, ["url"]);
  });

  test('object: defaults { url = "", quality = 10 }', () => {
    const r = parseMethodParams('{ url = "", quality = 10 }');
    assert.equal(r.params[0].hasDefault, true);
    assert.equal(r.params[0].defaultValue, '""');
    assert.equal(r.params[1].defaultValue, "10");
    assert.equal(r.params[1].required, false);
  });

  test('object: alias + default { url: videoUrl = "" }', () => {
    const r = parseMethodParams('{ url: videoUrl = "" }');
    assert.equal(r.params[0].kind, "alias");
    assert.equal(r.params[0].source, "url");
    assert.equal(r.params[0].target, "videoUrl");
    assert.equal(r.params[0].hasDefault, true);
    assert.equal(r.params[0].defaultValue, '""');
    assert.equal(r.params[0].required, false);
  });

  test("object: only rest { ...rest }", () => {
    const r = parseMethodParams("{ ...rest }");
    assert.deepEqual(r.names, ["rest"]);
    assert.equal(r.params[0].kind, "rest");
  });

  test('object: default + rest { name="anon", ...rest }', () => {
    const r = parseMethodParams('{ name="anon", ...rest }');
    assert.equal(r.params[0].kind, "property");
    assert.equal(r.params[0].hasDefault, true);
    assert.equal(r.params[0].defaultValue, '"anon"');
    assert.equal(r.params[1].kind, "rest");
  });

  test("object: whole-object default { name } = {} marks optional", () => {
    const r = parseMethodParams("{\n  name\n} = {}");
    assert.equal(r.style, "object");
    assert.equal(r.optional, true);
    assert.deepEqual(r.names, ["name"]);
  });

  test("object: mixed required + optional { query, limit = 10 }", () => {
    const r = parseMethodParams("{ query, limit = 10 }");
    assert.equal(r.params[0].required, true);
    assert.equal(r.params[1].required, false);
  });

  test("object: numeric/boolean/template defaults parse without splitting", () => {
    const r = parseMethodParams("{ limit = 10, verbose = false, tag = `v1` }");
    assert.equal(r.params.length, 3);
    assert.equal(r.params[0].defaultValue, "10");
    assert.equal(r.params[1].defaultValue, "false");
    assert.equal(r.params[2].defaultValue, "`v1`");
  });

  test("object: default value containing a comma inside a string stays one param", () => {
    const r = parseMethodParams('{ data = "a,b" }');
    assert.equal(r.params.length, 1);
    assert.equal(r.params[0].defaultValue, '"a,b"');
  });

  test("object: default value is a nested object literal { data = { a:1, b:2 } }", () => {
    const r = parseMethodParams("{ data = { a:1, b:2 } }");
    assert.equal(r.params.length, 1);
    assert.equal(r.params[0].name, "data");
    assert.equal(r.params[0].hasDefault, true);
    assert.equal(r.params[0].defaultValue, "{ a:1, b:2 }");
  });

  test("object: multiline formatting", () => {
    const r = parseMethodParams(`{
      url,
      quality
    }`);
    assert.deepEqual(r.names, ["url", "quality"]);
  });

  test("object: plain property mixed with alias { url: videoUrl, quality }", () => {
    const r = parseMethodParams("{ url: videoUrl, quality }");
    assert.equal(r.params[0].kind, "alias");
    assert.equal(r.params[1].kind, "property");
  });

  test("whitespace-only params behaves like none", () => {
    const r = parseMethodParams("   ");
    assert.equal(r.style, "none");
  });
});

/* ------------------------------------------------------------------ */
/* parseMethodParams — unsupported patterns MUST abort (spec item 6-8) */
/* ------------------------------------------------------------------ */

describe("parseMethodParams — unsupported patterns abort with a clear error", () => {
  test("nested object destructuring { options: { quality } }", () => {
    assert.throws(
      () => parseMethodParams("{ options: { quality } }", { methodName: "create" }),
      (err) => {
        assert.ok(err instanceof ParserUnsupportedError);
        assert.match(err.message, /Nested object destructuring belum didukung/);
        assert.match(err.message, /method create\(\)/);
        assert.match(err.message, /options/);
        return true;
      }
    );
  });

  test("top-level array destructuring [a, b]", () => {
    assert.throws(
      () => parseMethodParams("[a, b]", { methodName: "test" }),
      (err) => {
        assert.ok(err instanceof ParserUnsupportedError);
        assert.match(err.message, /Array destructuring belum didukung/);
        return true;
      }
    );
  });

  test("computed property { [key]: value }", () => {
    assert.throws(
      () => parseMethodParams("{ [key]: value }"),
      (err) => {
        assert.ok(err instanceof ParserUnsupportedError);
        assert.match(err.message, /Computed property destructuring belum didukung/);
        return true;
      }
    );
  });

  test("array destructuring via alias { list: [a, b] }", () => {
    assert.throws(
      () => parseMethodParams("{ list: [a, b] }"),
      (err) => {
        assert.ok(err instanceof ParserUnsupportedError);
        assert.match(err.message, /Array destructuring belum didukung/);
        return true;
      }
    );
  });

  test("mixed positional + object pattern a, { b, c }", () => {
    assert.throws(() => parseMethodParams("a, { b, c }"), ParserUnsupportedError);
  });

  test("non-identifier property key { 'foo-bar': x }", () => {
    assert.throws(() => parseMethodParams("{ 'foo-bar': x }"), ParserUnsupportedError);
  });

  test("garbage after object destructuring { url } extra", () => {
    assert.throws(() => parseMethodParams("{ url } extra"), ParserUnsupportedError);
  });
});

/* ------------------------------------------------------------------ */
/* validateParsedMethodParams — Parser Validation Layer (spec item 13) */
/* ------------------------------------------------------------------ */

describe("validateParsedMethodParams", () => {
  test("reports every kind present", () => {
    const parsed = parseMethodParams("{ url: videoUrl, limit = 10, ...rest }");
    const v = validateParsedMethodParams(parsed);
    assert.equal(v.ok, true);
    assert.equal(v.summary, "Parser OK");
    assert.deepEqual(v.lines, ["✓ property", "✓ alias", "✓ rest", "✓ default"]);
  });

  test("no params still returns an ok checklist", () => {
    const v = validateParsedMethodParams(parseMethodParams(""));
    assert.equal(v.ok, true);
    assert.deepEqual(v.lines, ["✓ (tidak ada parameter)"]);
  });
});

/* ------------------------------------------------------------------ */
/* End-to-end: class parsing + generator output must be valid JS       */
/* ------------------------------------------------------------------ */

describe("extractClassMethods + buildRouteBlockCode — generated code sanity", () => {
  const classCode = `
    class Demo {
      async create({ name, ...rest }) {
        return { name, ...rest };
      }
      async download({ url: videoUrl }) {
        return videoUrl;
      }
      async search({ query, limit = 10 }) {
        return { query, limit };
      }
    }
  `;

  test("class with rest/alias/default methods parses without throwing", () => {
    const { classBlock } = extractClassInfo(classCode);
    const methods = extractClassMethods(classBlock);
    assert.equal(methods.length, 3);
  });

  test("generated route code for a rest parameter is syntactically valid JS and actually spreads", () => {
    const { classBlock } = extractClassInfo(classCode);
    const methods = extractClassMethods(classBlock);
    const methodInfo = findMethodOrThrow(methods, "create");

    const methodArgs = methodInfo.params.names.map((n, i) => ({
      serviceParamName: n,
      requestParamName: n,
      kind: methodInfo.params.params[i].kind,
    }));
    const allRequestParams = methodArgs.map((a) => ({
      requestParamName: a.requestParamName,
      required: a.kind !== "rest",
      desc: "",
      kind: a.kind,
    }));

    const { code } = buildRouteBlockCode({
      subPath: "/create",
      httpMethod: "POST",
      className: "Demo",
      instanceName: "demo",
      callMethod: "create",
      methodParamStyle: methodInfo.params.style,
      methodArgs,
      ctor: null,
      allRequestParams,
      endpointName: "Create",
      endpointDesc: "",
    });

    assert.match(code, /const \{ name, \.\.\.rest \} = params;/);
    assert.match(code, /await demo\.create\(\{ name, \.\.\.rest \}\);/);
    assert.doesNotMatch(code, /\}: rest \}/); // bug lama yang eksplisit dilarang di spec

    // Pastikan hasilnya beneran valid JS (bukan cuma "kelihatan" valid).
    const wrapped = `
      const asyncHandler = (fn) => fn;
      const ok = () => {};
      class ApiError extends Error {}
      const router = { post: () => {} };
      const demo = { create: async () => {} };
      ${code}
    `;
    assert.doesNotThrow(() => new Function(wrapped));
  });

  test("generated route code for an alias parameter maps source:target correctly", () => {
    const { classBlock } = extractClassInfo(classCode);
    const methods = extractClassMethods(classBlock);
    const methodInfo = findMethodOrThrow(methods, "download");

    const methodArgs = methodInfo.params.names.map((n, i) => ({
      serviceParamName: n,
      requestParamName: "videoUrl", // user memetakan field request "videoUrl" -> service key "url"
      kind: methodInfo.params.params[i].kind,
    }));
    const allRequestParams = methodArgs.map((a) => ({
      requestParamName: a.requestParamName,
      required: true,
      desc: "",
      kind: a.kind,
    }));

    const { code } = buildRouteBlockCode({
      subPath: "/download",
      httpMethod: "POST",
      className: "Demo",
      instanceName: "demo",
      callMethod: "download",
      methodParamStyle: methodInfo.params.style,
      methodArgs,
      ctor: null,
      allRequestParams,
      endpointName: "Download",
      endpointDesc: "",
    });

    assert.match(code, /const \{ videoUrl \} = params;/);
    assert.match(code, /await demo\.download\(\{ url: videoUrl \}\);/);

    const wrapped = `
      const asyncHandler = (fn) => fn;
      const ok = () => {};
      class ApiError extends Error {}
      const router = { post: () => {} };
      const demo = { download: async () => {} };
      ${code}
    `;
    assert.doesNotThrow(() => new Function(wrapped));
  });

  test("generated route code never validates a param that has a source-level default", () => {
    const { classBlock } = extractClassInfo(classCode);
    const methods = extractClassMethods(classBlock);
    const methodInfo = findMethodOrThrow(methods, "search");

    const methodArgs = methodInfo.params.names.map((n, i) => ({
      serviceParamName: n,
      requestParamName: n,
      kind: methodInfo.params.params[i].kind,
    }));
    const allRequestParams = methodArgs.map((a, i) => ({
      requestParamName: a.requestParamName,
      required: !methodInfo.params.params[i].hasDefault,
      desc: "",
      kind: a.kind,
    }));

    const { code } = buildRouteBlockCode({
      subPath: "/search",
      httpMethod: "GET",
      className: "Demo",
      instanceName: "demo",
      callMethod: "search",
      methodParamStyle: methodInfo.params.style,
      methodArgs,
      ctor: null,
      allRequestParams,
      endpointName: "Search",
      endpointDesc: "",
    });

    assert.match(code, /if \(!query\) throw new ApiError/);
    assert.doesNotMatch(code, /if \(!limit\) throw new ApiError/);
  });
});

/* ------------------------------------------------------------------ */
/* Regresi migrasi AST: 3 bug parser lama yang dulu silent-fail        */
/* ------------------------------------------------------------------ */

describe("extractClassMethods — regresi parser AST", () => {
  test("brace di dalam template literal tidak menelan method berikutnya (bug #1)", () => {
    const methods = extractClassMethods(
      "class X { foo() { const s = `{ belum tutup`; return s; } bar(x) { return x; } }"
    );
    assert.deepEqual(
      methods.map((m) => m.name),
      ["foo", "bar"]
    );
  });

  test("brace di dalam komentar tidak menelan method berikutnya (bug #1)", () => {
    const methods = extractClassMethods("class X { foo() { /* { */ } bar() {} }");
    assert.deepEqual(
      methods.map((m) => m.name),
      ["foo", "bar"]
    );
  });

  test("brace di dalam ${} template expression tetap aman", () => {
    const methods = extractClassMethods(
      "class X { foo(id) { return `user ${JSON.stringify({ id })}`; } bar() {} }"
    );
    assert.deepEqual(
      methods.map((m) => m.name),
      ["foo", "bar"]
    );
  });

  test("arrow field dengan paren bersarang di default value terdeteksi (bug #2)", () => {
    const methods = extractClassMethods("class X { foo = (a = fn(1), b) => { return a; } }");
    assert.equal(methods.length, 1);
    assert.equal(methods[0].name, "foo");
    assert.equal(methods[0].isArrowField, true);
    assert.deepEqual(methods[0].params.names, ["a", "b"]);
    assert.equal(methods[0].params.params[0].hasDefault, true);
  });

  test("arrow field concise (tanpa body {}) terdeteksi", () => {
    const methods = extractClassMethods("class X { dobel = (a) => a * 2 }");
    assert.deepEqual(
      methods.map((m) => m.name),
      ["dobel"]
    );
  });

  test("class field biasa (bukan arrow) TIDAK dianggap method", () => {
    const methods = extractClassMethods('class X { baseUrl = "https://x"; foo() {} }');
    assert.deepEqual(
      methods.map((m) => m.name),
      ["foo"]
    );
  });
});

describe("extractClassInfo — regresi import multiline (bug #3)", () => {
  test("import multiline masuk importLines dan kedeteksi checkMissingDeps", () => {
    const info = extractClassInfo(
      'import {\n  scrape,\n  parse\n} from "paket-yang-pasti-belum-ada";\nclass X { m() {} }'
    );
    assert.equal(info.importLines.length, 1);
    assert.match(info.importLines[0], /paket-yang-pasti-belum-ada/);
    // Bukan lagi nyangkut di preludeCode seperti sebelum migrasi AST.
    assert.doesNotMatch(info.preludeCode, /paket-yang-pasti-belum-ada/);
    assert.deepEqual(checkMissingDeps(info.importLines), ["paket-yang-pasti-belum-ada"]);
  });

  test("prelude non-import sebelum class tetap dipertahankan", () => {
    const info = extractClassInfo(
      'import a from "x";\nconst WATERMARK = decode("...");\nclass X { m() { return WATERMARK; } }'
    );
    assert.deepEqual(info.importLines, ['import a from "x";']);
    assert.match(info.preludeCode, /WATERMARK/);
    assert.doesNotMatch(info.preludeCode, /^import/m);
  });

  test("kode yang bukan JS valid ditolak dengan pesan jelas", () => {
    assert.throws(() => extractClassInfo("class X { foo( {} }"), /bukan JavaScript valid/);
  });
});

describe("checkJsSyntax", () => {
  test("null untuk JS valid", () => {
    assert.equal(checkJsSyntax('import x from "y";\nexport default 1;'), null);
  });

  test("pesan error untuk JS rusak", () => {
    assert.match(checkJsSyntax("const = 1;"), /./);
  });
});

describe("addDepsToPackageJson — resolve versi", () => {
  const basePkg = JSON.stringify({ name: "t", dependencies: { axios: "^1.0.0" } });

  test("pakai ^versi hasil resolve, bukan 'latest'", () => {
    const { content, added } = addDepsToPackageJson(basePkg, ["cheerio-baru"], {
      resolveVersion: () => "2.3.4",
    });
    const pkg = JSON.parse(content);
    assert.equal(pkg.dependencies["cheerio-baru"], "^2.3.4");
    assert.deepEqual(added, ["cheerio-baru"]);
  });

  test("fallback ke 'latest' kalau resolve gagal (offline)", () => {
    const { content } = addDepsToPackageJson(basePkg, ["paket-x"], { resolveVersion: () => null });
    assert.equal(JSON.parse(content).dependencies["paket-x"], "latest");
  });

  test("package yang sudah ada tidak disentuh dan tidak di-resolve", () => {
    const { content, added } = addDepsToPackageJson(basePkg, ["axios"], {
      resolveVersion: () => {
        throw new Error("gak boleh kepanggil");
      },
    });
    assert.equal(JSON.parse(content).dependencies.axios, "^1.0.0");
    assert.deepEqual(added, []);
  });
});

/* ------------------------------------------------------------------ */
/* detectInternallyCalledMethods                                       */
/* ------------------------------------------------------------------ */

describe("detectInternallyCalledMethods", () => {
  function analyze(raw) {
    const { className, classBlock } = extractClassInfo(raw);
    const methods = extractClassMethods(classBlock);
    return detectInternallyCalledMethods(classBlock, methods, className);
  }

  test("detects this.method() call", () => {
    const called = analyze(`
      class Foo {
        async login() { return { token: "x" }; }
        async getData() { const t = await this.login(); return t; }
      }
    `);
    assert.ok(called.has("login"));
    assert.ok(!called.has("getData"));
  });

  test("detects static call via ClassName.method()", () => {
    const called = analyze(`
      class Foo {
        static helper() { return 1; }
        run() { return Foo.helper(); }
      }
    `);
    assert.ok(called.has("helper"));
  });

  test("detects private #method call", () => {
    const called = analyze(`
      class Foo {
        #sign() { return "sig"; }
        fetchIt() { return this.#sign(); }
      }
    `);
    assert.ok(called.has("#sign"));
  });

  test("ignores this.method( inside string literals and comments", () => {
    const called = analyze(`
      class Foo {
        login() { return 1; }
        run() {
          // this.login() cuma komentar
          const msg = "coba this.login() manual";
          return msg;
        }
      }
    `);
    assert.ok(!called.has("login"));
  });

  test("ignores property access without call parens", () => {
    const called = analyze(`
      class Foo {
        login() { return 1; }
        run() { const fn = this.login; return fn; }
      }
    `);
    assert.ok(!called.has("login"));
  });

  test("empty set for class without methods", () => {
    const called = analyze(`class Foo {}`);
    assert.equal(called.size, 0);
  });
});

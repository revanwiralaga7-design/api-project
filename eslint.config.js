import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default [
  { ignores: ["node_modules/", "data/", "coverage/"] },
  js.configs.recommended,
  prettier,
  {
    files: ["src/**/*.js", "server.js", "scripts/**/*.js", "tests/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // File frontend admin panel: script biasa (bukan module), jalan di browser
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "script",
      // CATEGORIES didefinisikan di data.js, dipakai lintas <script> tag
      globals: { ...globals.browser, CATEGORIES: "readonly" },
    },
    rules: {
      // ignoreRestSiblings: pola destructure-buat-omit ({ a, b, ...rest })
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      // data.js sendiri yang mendeklarasikan CATEGORIES
      "no-redeclare": ["error", { builtinGlobals: false }],
    },
  },
];

// Barrel re-export — scaffold.js dulunya satu file monolitik 1600 baris,
// sekarang dipecah per concern ke scaffold/ (core, parser, generator,
// registry, diff). File ini dipertahankan supaya semua importer lama
// (admin.routes.js, history.js, backup.js, health.js, tests) tetap jalan
// tanpa diubah — import dari "../utils/scaffold.js" seperti biasa.
export * from "./scaffold/core.js";
export * from "./scaffold/parser.js";
export * from "./scaffold/generator.js";
export * from "./scaffold/registry.js";
export * from "./scaffold/diff.js";

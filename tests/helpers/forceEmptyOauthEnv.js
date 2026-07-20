/**
 * WAJIB di-import PALING ATAS di test file yang (langsung atau lewat rantai
 * import) nge-load src/config/index.js — import statement di-hoist &
 * dieksekusi berurutan, jadi file ini sempet ngosongin env OAuth SEBELUM
 * dotenv sempet jalan. dotenv gak nimpa key yang udah ada di process.env
 * (string kosong pun dihitung "ada"), jadi kredensial asli di .env developer
 * gak pernah bocor ke test — tanpa ini, test 503 "provider belum
 * dikonfigurasi" gagal di mesin yang .env-nya keisi Google/GitHub beneran.
 */
process.env.NODE_ENV = "test";
process.env.GOOGLE_CLIENT_ID = "";
process.env.GOOGLE_CLIENT_SECRET = "";
process.env.GITHUB_CLIENT_ID = "";
process.env.GITHUB_CLIENT_SECRET = "";

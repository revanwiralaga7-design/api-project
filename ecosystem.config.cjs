// Dipakai lewat `npm run start:pm2` (pm2-runtime start ecosystem.config.cjs).
// PM2 TIDAK lagi ada di dependencies — install global dulu: `npm i -g pm2`.
// Di Docker/systemd, restart policy container/unit menggantikan peran PM2,
// cukup `npm start` (node server.js).
//
// CATATAN: fitur apply/restart di admin panel keluar via process.exit(0) dan
// MENGANDALKAN supervisor (PM2 / Docker restart policy / systemd) buat
// ngidupin lagi. `npm start` polos tanpa supervisor = proses mati beneran.
//
// PM2 di sini CUMA berperan sebagai process supervisor
// (auto-restart kalau proses exit/crash) — watch filesystem SENGAJA
// dimatikan.
//
// Alasan: restart yang dipicu reaktif dari file-watcher balapan sama
// response HTTP request yang lagi jalan (contoh nyata: /api/admin/apply
// nulis file baru -> watcher langsung restart -> response "apply" itu
// sendiri keputus di tengah jalan / "Failed to fetch" di browser, padahal
// file-nya udah kesimpen). Makanya restart sekarang dipicu MANUAL dari
// kode (lihat src/routes/admin.routes.js: scheduleRestartAfterResponse) —
// dipanggil PERSIS setelah response ke client selesai dikirim, bukan
// ditebak dari event filesystem.
module.exports = {
  apps: [
    {
      name: "febry-api",
      script: "server.js",
      watch: false,
      autorestart: true,
      restart_delay: 300,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};

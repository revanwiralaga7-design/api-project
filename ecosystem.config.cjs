// Dipakai lewat `pm2-runtime start ecosystem.config.cjs` (lihat package.json
// script "start"). PM2 di sini CUMA berperan sebagai process supervisor
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
        NODE_ENV: "production"
      }
    }
  ]
};

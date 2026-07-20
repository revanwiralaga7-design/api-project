import app from "./src/app.js";
import { config } from "./src/config/index.js";
import { flushUsage } from "./src/utils/usage.js";
import { logger } from "./src/utils/logger.js";

const server = app.listen(config.port, () => {
  logger.info(`🚀 Server berjalan di http://localhost:${config.port}`);
  logger.info(`📚 Daftar endpoint: http://localhost:${config.port}/api/endpoints`);
});

// --- Graceful shutdown -------------------------------------------------
// Project ini SERING di-restart by design (fitur Apply exit via
// process.exit(0), PM2/Docker yang nyalain lagi) — tanpa handler ini,
// tiap restart/deploy: koneksi yang lagi jalan keputus mentah dan usage
// analytics yang belum ke-flush (debounce 3 detik di utils/usage.js)
// hilang.
//
// 'exit' handler-nya sinkron (flushUsage juga sinkron), jadi jalur
// process.exit(0) dari scheduleRestartAfterResponse ikut ketutup —
// bukan cuma SIGTERM/SIGINT.
process.on("exit", () => flushUsage());

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return; // sinyal kedua: biarin yang pertama selesai
  shuttingDown = true;
  logger.info(`${signal} diterima — tutup server, tunggu request yang lagi jalan...`);

  // Stop terima koneksi baru; callback jalan setelah koneksi aktif selesai.
  server.close(() => {
    process.exit(0); // flushUsage jalan lewat handler 'exit' di atas
  });

  // Jaring pengaman: koneksi bandel (mis. SSE/download panjang) jangan
  // nahan proses selamanya — paksa keluar setelah 10 detik. unref biar
  // timer ini sendiri gak nahan proses kalau close-nya beres duluan.
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

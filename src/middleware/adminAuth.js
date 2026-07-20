import crypto from "crypto";
import { config } from "../config/index.js";
import { ApiError } from "../utils/response.js";

/**
 * Proteksi seluruh /api/admin/*. Panel ini bisa nulis/hapus file kode
 * di server (lewat /apply, /delete/apply) — TANPA ini, siapapun yang
 * nemu /admin.html bisa nyuntik kode apapun ke server. Wajib aktif
 * sebelum project ini pernah nempel ke internet publik.
 *
 * - ADMIN_API_KEY belum di-set di .env -> panel dimatikan total (503),
 *   bukan default-terbuka. Biar gak ada yang lupa set terus ke-expose.
 * - Key dikirim client lewat header `x-admin-key`.
 * - Perbandingan pakai timingSafeEqual biar gak bocor lewat timing attack.
 * - Lockout per IP: kebanyakan percobaan key SALAH beruntun -> 429 untuk
 *   sementara, biar key gak bisa di-brute-force santai. Rate limit global
 *   admin (config.adminRateLimit) ngebatasin SEMUA request; ini khusus
 *   yang GAGAL auth, jadi jauh lebih ketat tanpa ganggu pemakaian normal.
 */

const MAX_FAILURES = 5; // percobaan salah beruntun sebelum diblokir
const LOCKOUT_MS = 15 * 60 * 1000; // lama blokir
const failures = new Map(); // ip -> { count, lockedUntil }

// Bersihin entry basi tiap 10 menit biar Map gak numpuk IP sekali lewat.
// unref: timer ini gak boleh nahan proses hidup (penting buat test & exit).
const SWEEP_MS = 10 * 60 * 1000;
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of failures) {
    if (entry.lockedUntil && entry.lockedUntil < now) failures.delete(ip);
    else if (!entry.lockedUntil && now - entry.lastFailure > LOCKOUT_MS) failures.delete(ip);
  }
}, SWEEP_MS);
if (sweeper.unref) sweeper.unref();

/** Reset state lockout — dipakai test. */
export function _resetAdminAuthLockout() {
  failures.clear();
}

export function adminAuth(req, res, next) {
  const configuredKeys = config.adminApiKeys;

  if (!configuredKeys.length) {
    return next(
      new ApiError(
        "Admin panel dinonaktifkan: set ADMIN_API_KEY di .env dulu (lihat .env.example), lalu restart server.",
        503
      )
    );
  }

  // req.ip udah IP asli pengunjung berkat app.set("trust proxy", 1).
  const ip = req.ip || "unknown";
  const entry = failures.get(ip);
  if (entry && entry.lockedUntil) {
    if (entry.lockedUntil > Date.now()) {
      const sisaMenit = Math.ceil((entry.lockedUntil - Date.now()) / 60_000);
      return next(
        new ApiError(
          `Terlalu banyak percobaan admin key yang salah. Coba lagi dalam ~${sisaMenit} menit.`,
          429
        )
      );
    }
    failures.delete(ip); // masa blokir habis — mulai bersih lagi
  }

  const providedKey = req.get("x-admin-key") || "";
  const provided = Buffer.from(providedKey);

  const valid = configuredKeys.some((k) => {
    const expected = Buffer.from(k);
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  });

  if (!valid) {
    const current = failures.get(ip) || { count: 0, lockedUntil: 0, lastFailure: 0 };
    current.count += 1;
    current.lastFailure = Date.now();
    if (current.count >= MAX_FAILURES) current.lockedUntil = Date.now() + LOCKOUT_MS;
    failures.set(ip, current);
    return next(new ApiError("Admin key salah atau belum dikirim (header 'x-admin-key').", 401));
  }

  failures.delete(ip); // key benar — hapus catatan kegagalan sebelumnya
  next();
}

export default adminAuth;

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
 */
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

  const providedKey = req.get("x-admin-key") || "";
  const provided = Buffer.from(providedKey);

  const valid = configuredKeys.some((k) => {
    const expected = Buffer.from(k);
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  });

  if (!valid) {
    return next(new ApiError("Admin key salah atau belum dikirim (header 'x-admin-key').", 401));
  }

  next();
}

export default adminAuth;

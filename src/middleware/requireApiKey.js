/**
 * Gerbang "wajib API key" buat endpoint API publik: request yang lolos
 * identifyClient TANPA key valid (req.client.apiKey null) ditolak 401 —
 * gak lagi diperlakukan sebagai free anonim per IP.
 *
 * Dipasang di app.js SETELAH identifyClient dan SEBELUM tierRateLimiter,
 * dengan mount string "/api" (bukan regex) — jadi req.path di sini
 * RELATIF terhadap /api ("/api/youtube/search" -> "/youtube/search").
 *
 * Pengecualian:
 * - Path publik di PUBLIC_PATHS: /api (welcome), /api/me (cek status key
 *   sendiri), /api/endpoints (discovery daftar endpoint) — sengaja tetap
 *   terbuka biar orang bisa lihat ada apa aja & cek key-nya tanpa key.
 * - /api/admin/* — proteksinya adminAuth sendiri (header x-admin-key),
 *   bukan sistem API key konsumen ini.
 *
 * Key bisa dikirim lewat header `x-api-key` ATAU query `?apikey=` (lihat
 * identifyClient.js). Cara dapat key: login Google/GitHub di halaman docs
 * — key tier free dibuat otomatis per akun (utils/clients.js:
 * ensureClientForUser).
 */
const PUBLIC_PATHS = new Set(["/", "/me", "/endpoints"]);

export function requireApiKey(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (req.path === "/admin" || req.path.startsWith("/admin/")) return next();
  if (req.client?.apiKey) return next();

  return res.status(401).json({
    status: false,
    error:
      "API key wajib disertakan: kirim header 'x-api-key: <key>' atau tambahkan '?apikey=<key>' di URL. " +
      "Belum punya? Login Google/GitHub di halaman dokumentasi — API key gratis dibuat otomatis buat akunmu.",
    docs: "/signin.html"
  });
}

export default requireApiKey;

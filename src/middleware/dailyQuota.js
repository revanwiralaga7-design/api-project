import { getTodayTotal } from "../utils/usage.js";

/**
 * Kuota HARIAN per client (fitur pelengkap rate limit per jam):
 * - Cuma berlaku buat client ber-API-key yang punya field dailyQuota > 0
 *   di clients.json (di-set lewat client-manager). Client tanpa
 *   dailyQuota (atau 0/null) = tanpa batas harian.
 * - Anonim (tanpa key) gak kena kuota harian — udah dibatasi rate limit
 *   per jam per IP.
 * - Hitungannya numpang data usage analytics (data/usage.json), jadi
 *   WAJIB dipasang bareng usageTracker. Reset otomatis tiap ganti hari
 *   (kunci hariannya YYYY-MM-DD UTC).
 *
 * Dipasang SETELAH identifyClient (butuh req.client.dailyQuota yang
 * ditempel dari clients.json) dan SEBELUM route handler.
 */
export function dailyQuota(req, res, next) {
  const quota = req.client?.dailyQuota;
  if (!quota || !req.client?.apiKey) return next();

  const used = getTodayTotal(req.client.apiKey);
  if (used >= quota) {
    return res.status(429).json({
      status: false,
      error: `Kuota harian tercapai (${quota} request/hari). Reset otomatis besok (00:00 UTC).`,
      quota: { daily: quota, used },
    });
  }
  next();
}

export default dailyQuota;

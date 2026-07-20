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
 * Header di SEMUA response ber-kuota (pelengkap RateLimit-* per jam yang
 * udah dikirim express-rate-limit): X-Daily-Quota-Limit/-Remaining, biar
 * bot bisa self-throttle tanpa nunggu 429. Pas 429, Retry-After = detik
 * sampai 00:00 UTC (kapan kuotanya reset).
 *
 * Dipasang SETELAH identifyClient (butuh req.client.dailyQuota yang
 * ditempel dari clients.json) dan SEBELUM route handler.
 */

/** Detik dari `now` sampai 00:00 UTC berikutnya (buat Retry-After). */
export function secondsUntilUtcMidnight(now = new Date()) {
  const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(Math.ceil((nextMidnight - now.getTime()) / 1000), 1);
}

export function dailyQuota(req, res, next) {
  const quota = req.client?.dailyQuota;
  if (!quota || !req.client?.apiKey) return next();

  const used = getTodayTotal(req.client.apiKey);
  // Remaining dihitung SEBELUM hit ini kecatat (usageTracker nyatat pas
  // response selesai) — jadi nilai di response N adalah sisa sebelum N.
  res.set("X-Daily-Quota-Limit", String(quota));
  res.set("X-Daily-Quota-Remaining", String(Math.max(quota - used, 0)));
  if (used >= quota) {
    res.set("Retry-After", String(secondsUntilUtcMidnight()));
    return res.status(429).json({
      status: false,
      error: `Kuota harian tercapai (${quota} request/hari). Reset otomatis besok (00:00 UTC).`,
      quota: { daily: quota, used },
    });
  }
  next();
}

export default dailyQuota;

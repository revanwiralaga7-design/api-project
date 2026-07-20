import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { config } from "../config/index.js";

export const TIER_MAX = {
  free: config.tierRateLimit.free,
  premium: config.tierRateLimit.premium,
  // "admin" sengaja gak ada di sini — di-skip total di bawah (unlimited),
  // bukan dikasih angka gede. Biar gak numpuk entry di memory store juga.
};

export function keyForRequest(req) {
  // Semua request yang lolos requireApiKey pasti ber-apiKey — free sekarang
  // di-limit per key (per akun), bukan per IP. Fallback per-IP cuma kepakai
  // di path publik tanpa key (/api/me, /api/endpoints) — pakai helper
  // ipKeyGenerator biar IPv6 di-truncate ke /56 (satu subnet = satu counter,
  // wajib sejak express-rate-limit v8, gak bisa req.ip mentah).
  return req.client?.apiKey || ipKeyGenerator(req.ip);
}

export function maxForRequest(req) {
  return TIER_MAX[req.client?.tier] ?? TIER_MAX.free;
}

export function shouldSkip(req) {
  return req.client?.tier === "admin";
}

export function buildLimitMessage(req) {
  const tier = req.client?.tier || "free";
  const limit = TIER_MAX[tier] ?? TIER_MAX.free;
  return {
    status: false,
    error: `Limit request tier '${tier}' tercapai (${limit}/jam). Coba lagi nanti${
      tier === "free" ? " atau upgrade ke tier premium." : "."
    }`,
    tier,
  };
}

/**
 * Rate limiter PER CLIENT (bukan satu counter global buat semua orang):
 * - key dipisah per API key — termasuk free (key auto-provision per akun
 *   Google/GitHub, lihat utils/clients.js). Per IP tinggal buat path
 *   publik tanpa key (/api/me, /api/endpoints).
 * - batas request beda-beda sesuai tier di req.client (di-set duluan sama
 *   middleware/identifyClient.js, jadi ini WAJIB dipasang setelahnya).
 * - free   : 100/jam (default, bisa diubah RATE_LIMIT_FREE_PER_HOUR)
 * - premium: 1000/jam (RATE_LIMIT_PREMIUM_PER_HOUR)
 * - admin  : unlimited, di-skip dari limiter sepenuhnya
 */
export const tierRateLimiter = rateLimit({
  windowMs: config.tierRateLimit.windowMs,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyForRequest,
  max: maxForRequest,
  skip: shouldSkip,
  handler: (req, res) => {
    res.status(429).json(buildLimitMessage(req));
  },
});

export default tierRateLimiter;

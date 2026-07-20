import { recordHit } from "../utils/usage.js";

/**
 * Catat pemakaian API per client per endpoint (fitur analytics di panel
 * admin). Dipasang di /api/* SETELAH identifyClient (butuh req.client)
 * dan SEBELUM route handler. /api/admin/* sengaja gak dicatat — itu
 * panel internal, bukan pemakaian API publik.
 *
 * Dicatat pas event 'finish' response (bukan pas request masuk) supaya
 * status code akhirnya ikut kecatat (termasuk 429 dari rate limiter).
 */
export function usageTracker(req, res, next) {
  if (req.path.startsWith("/admin")) return next();

  res.on("finish", () => {
    recordHit({
      clientKey: req.client?.apiKey || req.ip,
      tier: req.client?.tier || "free",
      // req.baseUrl + path pola route (tanpa query) — pakai originalUrl
      // yang dipotong query-nya biar path dinamis (/track/:id) tetap
      // kecatat per URL aslinya.
      path: (req.originalUrl || req.url).split("?")[0],
      status: res.statusCode
    });
  });

  next();
}

export default usageTracker;

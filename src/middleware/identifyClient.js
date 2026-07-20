import { loadClients, isExpired, CLIENTS_PATH } from "../utils/clients.js";

const VALID_TIERS = ["free", "premium", "admin"];

export { CLIENTS_PATH };

/**
 * Nempelin req.client = { id, tier, apiKey, dailyQuota, provider }
 * berdasarkan API key dari header `x-api-key` ATAU query `?apikey=`
 * (header menang kalau dua-duanya dikirim).
 * - Key valid & dikenal -> tier sesuai clients.json (+ dailyQuota kalau
 *   di-set — dipakai middleware/dailyQuota.js).
 * - Key gak ada / gak dikenal / tier di file-nya gak valid / key EXPIRED
 *   (field expiresAt kelewat) -> fallback ke tier "free" TANPA apiKey.
 *   Request begini bakal ditolak requireApiKey (kecuali path publik
 *   /api, /api/me, /api/endpoints — di sana di-identifikasi pakai IP).
 *
 * clients.json dibaca ulang tiap request lewat loadClients() (lihat
 * ../utils/clients.js) — file yang sama dipakai juga oleh panel admin
 * (client-manager.html) dan script CLI, jadi nambah/ubah/cabut client
 * langsung aktif tanpa restart server.
 */
export function identifyClient(req, res, next) {
  // Guard typeof: ?apikey=a&apikey=b bikin req.query.apikey jadi ARRAY —
  // jangan sampai kepakai buat lookup (di-stringify jadi "a,b").
  const queryKey = typeof req.query?.apikey === "string" ? req.query.apikey : "";
  const apiKey = req.get("x-api-key") || queryKey;
  const entry = apiKey ? loadClients()[apiKey] : null;

  if (entry && VALID_TIERS.includes(entry.tier) && !isExpired(entry)) {
    req.client = {
      id: entry.name || apiKey.slice(0, 8),
      tier: entry.tier,
      apiKey,
      dailyQuota: Number(entry.dailyQuota) > 0 ? Number(entry.dailyQuota) : null,
      // Asal-usul key hasil auto-provision login docs (google/github),
      // null buat key manual — dibalikin di /api/me.
      provider: entry.provider || null
    };
  } else {
    req.client = { id: null, tier: "free", apiKey: null, dailyQuota: null, provider: null };
    // Kasih tau lewat header kalau key-nya ADA tapi expired — biar client
    // ngerti kenapa tiba-tiba diperlakukan free, tanpa mecahin response body.
    if (entry && isExpired(entry)) res.set("X-Api-Key-Status", "expired");
  }

  next();
}

export default identifyClient;

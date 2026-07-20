import { renderJsonImage } from "../services/jsonimage.service.js";

/**
 * ?format=image di endpoint /api/* mana pun: response JSON-nya di-render
 * jadi gambar PNG ala jendela code editor (syntax highlight + nomor baris)
 * — buat user/bot yang nampilin hasil API langsung ke chat tanpa harus
 * liat JSON mentah berantakan.
 *
 * Cara kerja: nyadap res.json (pola yang sama kayak responseCache.js), jadi
 * SEMUA endpoint sekarang & endpoint scaffold yang dibikin nanti otomatis
 * kebagian — tanpa ubah kode route satu pun.
 *
 * Dipasang di app.js SETELAH responseCache, SEBELUM route handler:
 * - Setelah responseCache: sadapan ini yang paling luar, jadi request
 *   format=image gak pernah nyimpen/ngambil apa-apa dari cache JSON
 *   (cache tetep bersih isi JSON doang).
 * - Error SEBELUM titik mount ini (401 requireApiKey, 429 rate limit)
 *   tetap JSON — yang di-render cuma respons dari route handler-nya.
 *
 * Kalau render-nya sendiri gagal (data gak bisa digambar), fallback kirim
 * JSON biasa — jangan sampai fitur kosmetik matiin endpoint-nya.
 */
export function jsonImage(req, res, next) {
  const format = typeof req.query?.format === "string" ? req.query.format.toLowerCase() : "";
  if (format !== "image") return next();

  const fullPath = (req.baseUrl || "") + req.path;
  if (fullPath.startsWith("/api/admin")) return next(); // panel admin gak butuh

  const originalJson = res.json.bind(res);
  res.json = (data) => {
    // Judul title bar dari path-nya: /api/youtube/search -> youtube-search.json
    const title =
      fullPath
        .replace(/^\/api\/?/, "")
        .replace(/\//g, "-")
        .replace(/[^\w.-]/g, "") + ".json";
    renderJsonImage(data, title || "response.json")
      .then((png) => {
        res.set("Content-Type", "image/png");
        res.set("Content-Length", String(png.length));
        res.send(png);
      })
      .catch(() => originalJson(data));
    return res;
  };

  next();
}

export default jsonImage;

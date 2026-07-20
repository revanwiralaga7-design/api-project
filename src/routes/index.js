import { Router } from "express";

import youtubeRoutes from "./youtube.routes.js";
import adminRoutes from "./admin.routes.js";
import animeRoutes from "./anime.routes.js";
import canvasRoutes from "./canvas.routes.js";
import { adminAuth } from "../middleware/adminAuth.js";

const router = Router();

router.use("/youtube", youtubeRoutes);
router.use("/admin", adminAuth, adminRoutes);

router.use("/anime", animeRoutes);
router.use("/canvas", canvasRoutes);
/**
 * Daftar endpoint yang tersedia — dipakai juga oleh /api dan nanti oleh
 * halaman dokumentasi web.
 */
router.get("/", (req, res) => {
  res.json({
    status: true,
    message: "Selamat datang di Febry API. Lihat daftar endpoint di /api/endpoints",
    endpoints: "/api/endpoints",
  });
});

router.get("/endpoints", (req, res) => {
  res.json({
    status: true,
    total: 4,
    result: [
      { name: "YouTube Search", method: "GET/POST", path: "/api/youtube/search", params: ["query"] },
      { name: "Search ANIME", method: "ALL", path: "/api/anime/search", params: ["query"] },
      {
        name: "JSON Profile Card",
        method: "GET/POST",
        path: "/api/canvas/jsoncard",
        params: ["<field bebas, mis. name, title, email, link>", "filename (opsional)"],
        output: "image/png",
      },
      {
        name: "Welcome Card",
        method: "GET/POST",
        path: "/api/canvas/welcome",
        params: ["name", "subtitle (opsional)"],
        output: "image/png",
      },
    ],
  });
});

/**
 * Cek identitas & tier sendiri — kirim x-api-key (atau ?apikey=) buat
 * lihat tier beneran. Satu-satunya jalur data yang boleh tanpa key
 * (lihat middleware/requireApiKey.js) — tanpa key dijawab sebagai anonim
 * biar orang bisa ngecek "key-ku kebaca gak sih". Sisa kuota ada di
 * header response RateLimit-* / X-RateLimit-* (dari express-rate-limit).
 */
router.get("/me", (req, res) => {
  res.json({
    status: true,
    result: {
      tier: req.client?.tier || "free",
      identifiedBy: req.client?.apiKey ? "apiKey" : "anonim",
      name: req.client?.id || null,
      // Asal key: "google"/"github" (auto-provision dari login docs) atau
      // null (key manual buatan admin / anonim).
      provider: req.client?.provider || null,
    },
  });
});

export default router;

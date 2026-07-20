// Router utama /api/admin — dulunya satu file monolitik 1500+ baris,
// sekarang dipecah per concern ke admin/ (planBuilders, scaffold.routes,
// ops.routes, clients.routes). File ini tinggal gabungin sub-router-nya;
// path & behavior semua endpoint TIDAK berubah (semua route didefinisikan
// relatif ke root /api/admin seperti sebelumnya, bukan di sub-prefix).
import { Router } from "express";
import scaffoldRoutes from "./admin/scaffold.routes.js";
import opsRoutes from "./admin/ops.routes.js";
import clientsRoutes from "./admin/clients.routes.js";
import { recordAudit } from "../utils/auditLog.js";

const router = Router();

// Audit trail SEMUA aksi mutasi admin (POST/PATCH/DELETE) — dipasang di
// router (bukan per route) biar route baru otomatis kecatat, gak bisa
// kelupaan. Dicatat pas response selesai biar status akhirnya ikut.
// Actor = admin key ter-mask (cukup buat bedain multi admin key, tanpa
// nulis key utuh ke file log).
router.use((req, res, next) => {
  if (!["POST", "PATCH", "DELETE", "PUT"].includes(req.method)) return next();
  res.on("finish", () => {
    const key = req.get("x-admin-key") || "";
    recordAudit({
      actor: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : "unknown",
      action: `${req.method} ${req.baseUrl}${req.path}`,
      // Body TIDAK dicatat utuh (bisa berisi kode scaffold gede / key) —
      // cukup field identitas yang umum dipakai buat nelusuri.
      detail:
        req.body && typeof req.body === "object"
          ? Object.fromEntries(
              Object.entries(req.body)
                .filter(([k]) => ["name", "tier", "path", "id", "ttlSeconds", "dailyQuota"].includes(k))
                .map(([k, v]) => [k, String(v).slice(0, 120)])
            )
          : null,
      status: res.statusCode,
    });
  });
  next();
});

router.use(scaffoldRoutes);
router.use(opsRoutes);
router.use(clientsRoutes);

export default router;
// Re-export buat backward-compat (dulu diekspor langsung dari file ini).
export { buildPlan, buildDeletePlan } from "./admin/planBuilders.js";

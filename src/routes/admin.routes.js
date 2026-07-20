// Router utama /api/admin — dulunya satu file monolitik 1500+ baris,
// sekarang dipecah per concern ke admin/ (planBuilders, scaffold.routes,
// ops.routes, clients.routes). File ini tinggal gabungin sub-router-nya;
// path & behavior semua endpoint TIDAK berubah (semua route didefinisikan
// relatif ke root /api/admin seperti sebelumnya, bukan di sub-prefix).
import { Router } from "express";
import scaffoldRoutes from "./admin/scaffold.routes.js";
import opsRoutes from "./admin/ops.routes.js";
import clientsRoutes from "./admin/clients.routes.js";

const router = Router();
router.use(scaffoldRoutes);
router.use(opsRoutes);
router.use(clientsRoutes);

export default router;
// Re-export buat backward-compat (dulu diekspor langsung dari file ini).
export { buildPlan, buildDeletePlan } from "./admin/planBuilders.js";

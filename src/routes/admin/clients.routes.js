// Route manajemen client / API key & tier (dipakai client-manager.html)
// — dipisah dari admin.routes.js monolitik, logikanya tidak berubah.
import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ok, ApiError } from "../../utils/response.js";
import { listClients, createClient, updateClient, deleteClient } from "../../utils/clients.js";

const router = Router();

/* ------------------------------------------------------------------ */
/* Manajemen client / API key & tier (dipakai client-manager.html)     */
/* ------------------------------------------------------------------ */

router.get(
  "/clients",
  asyncHandler(async (req, res) => {
    return ok(res, { clients: listClients() });
  })
);

router.post(
  "/clients",
  asyncHandler(async (req, res) => {
    const { name, tier, expiresAt, dailyQuota } = req.body || {};
    try {
      const client = createClient({ name, tier, expiresAt, dailyQuota });
      return ok(res, { client });
    } catch (err) {
      throw new ApiError(err.message, 400);
    }
  })
);

router.patch(
  "/clients/:apiKey",
  asyncHandler(async (req, res) => {
    const { name, tier, expiresAt, dailyQuota } = req.body || {};
    try {
      const client = updateClient(req.params.apiKey, { name, tier, expiresAt, dailyQuota });
      return ok(res, { client });
    } catch (err) {
      throw new ApiError(err.message, err.message.includes("tidak ditemukan") ? 404 : 400);
    }
  })
);

router.delete(
  "/clients/:apiKey",
  asyncHandler(async (req, res) => {
    try {
      deleteClient(req.params.apiKey);
      return ok(res, { message: "Client key berhasil dicabut." });
    } catch (err) {
      throw new ApiError(err.message, 404);
    }
  })
);

export default router;

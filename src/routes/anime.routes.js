import { Router } from "express";
import Nimegami from "../services/nimegami.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ok, ApiError } from "../utils/response.js";

const router = Router();
const nimegami = new Nimegami();

/**
 * GET/POST /api/anime/search
 * Search ANIME — Ambil link anime
 */
router.all(
  "/search",
  asyncHandler(async (req, res) => {
    const params = req.method === "GET" ? req.query : req.body;
    const { query } = params;
    if (!query) throw new ApiError("Parameter 'query' wajib diisi", 400);
    const data = await nimegami.search(query);
    return ok(res, data);
  })
);

export default router;

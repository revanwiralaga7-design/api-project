import { Router } from "express";
import { ytmp3Search } from "../services/youtube.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ok, ApiError } from "../utils/response.js";

const router = Router();

/**
 * GET/POST /api/youtube/search?query=<kata kunci>
 * Mencari video YouTube berdasarkan kata kunci.
 */
router.all(
  "/search",
  asyncHandler(async (req, res) => {
    const { query } = req.method === "GET" ? req.query : req.body;
    if (!query) throw new ApiError("Parameter 'query' wajib diisi", 400);
    const data = await ytmp3Search(query);
    return ok(res, data);
  })
);

export default router;

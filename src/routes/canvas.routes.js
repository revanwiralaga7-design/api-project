import { Router } from "express";
import { renderJsonCard, MAX_FIELDS } from "../services/jsoncard.service.js";
import { renderWelcomeCard } from "../services/welcomecard.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/response.js";

const router = Router();

/** Kirim buffer PNG dengan header yang bener — dipakai semua endpoint canvas. */
function sendPng(res, png) {
  res.set("Content-Type", "image/png");
  res.set("Content-Length", String(png.length));
  return res.send(png);
}

// Param yang bukan isi kartu: apikey = identitas client (identifyClient
// juga baca dari query), filename = judul di title bar jendela.
const RESERVED = new Set(["apikey", "filename"]);

/**
 * GET/POST /api/canvas/jsoncard
 * Bikin kartu profil bergaya JSON di code editor (PNG) — biar gak perlu
 * kirim JSON mentah berantakan ke user.
 *
 * Semua param bebas jadi field kartu (maks 8), contoh:
 *   GET /api/canvas/jsoncard?name=Kyynzh&title=Developer&email=a@b.c
 *   POST { "filename": "profile.json", "fields": { "name": "Kyynzh" } }
 *
 * `filename` opsional = judul title bar (default "aboutme.json").
 */
router.all(
  "/jsoncard",
  asyncHandler(async (req, res) => {
    const params = req.method === "GET" ? req.query : req.body || {};
    // POST boleh ngirim { fields: {...} } eksplisit, selain gaya flat.
    const source =
      params.fields && typeof params.fields === "object" && !Array.isArray(params.fields)
        ? params.fields
        : params;

    const fields = {};
    for (const [k, v] of Object.entries(source)) {
      if (RESERVED.has(k)) continue;
      // Query array (?name=a&name=b) / objek nested diambil string pertamanya aja.
      const val = Array.isArray(v) ? v[0] : v;
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
        fields[k] = String(val);
      }
    }

    if (!Object.keys(fields).length) {
      throw new ApiError(
        `Minimal satu field wajib diisi (maks ${MAX_FIELDS}). ` +
          "Contoh: /api/canvas/jsoncard?name=Kyynzh&title=Developer&email=kyynzh@gmail.com",
        400
      );
    }

    const png = await renderJsonCard(fields, params.filename || "aboutme.json");
    return sendPng(res, png);
  })
);

/**
 * GET/POST /api/canvas/welcome?name=<nama>&subtitle=<teks kecil>
 * Kartu welcome: avatar lingkaran berinisial + nama + subtitle.
 */
router.all(
  "/welcome",
  asyncHandler(async (req, res) => {
    const params = req.method === "GET" ? req.query : req.body || {};
    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!name) {
      throw new ApiError(
        "Parameter 'name' wajib diisi. Contoh: /api/canvas/welcome?name=Kyynzh&subtitle=Member%20baru",
        400
      );
    }
    const subtitle = typeof params.subtitle === "string" && params.subtitle.trim()
      ? params.subtitle.trim()
      : undefined;
    const png = await renderWelcomeCard(name, subtitle);
    return sendPng(res, png);
  })
);

export default router;

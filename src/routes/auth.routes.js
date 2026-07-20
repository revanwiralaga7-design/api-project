import { Router } from "express";
import crypto from "crypto";
import passport, { googleEnabled, githubEnabled } from "../config/passport.js";
import { config } from "../config/index.js";
import {
  ensureClientForUser,
  promoteClientToAdmin,
  findClientByProvider,
  regenerateClientKey,
  listKeysForUser,
  createAdditionalKey,
  deleteOwnKey,
  MAX_KEYS_PER_USER,
} from "../utils/clients.js";
import { getTodayTotal, topPathsForKey, dailySeriesForKey } from "../utils/usage.js";
import { TIER_MAX } from "../middleware/tierRateLimit.js";

const router = Router();

/**
 * Cuma izinin redirect balik ke PATH internal (diawali "/", bukan "//"),
 * biar gak kebuka jadi open-redirect ke domain luar lewat query ?next=.
 */
export function safeNext(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/index.html";
}

/**
 * "next" (halaman tujuan setelah login) dititipin lewat parameter `state`
 * punya OAuth2 — bukan buat CSRF protection (itu udah dihandle cookie
 * session di app.js), cuma numpang jalan bareng redirect ke provider terus
 * balik lagi ke callback kita apa adanya.
 */
router.get("/google", (req, res, next) => {
  if (!googleEnabled) {
    return res
      .status(503)
      .send(
        "Login Google belum dikonfigurasi di server (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET kosong di .env)."
      );
  }
  passport.authenticate("google", {
    scope: ["profile", "email"],
    state: safeNext(req.query.next),
  })(req, res, next);
});

router.get(
  "/google/callback",
  (req, res, next) => {
    if (!googleEnabled) return res.redirect("/signin.html?error=google_disabled");
    next();
  },
  passport.authenticate("google", { failureRedirect: "/signin.html?error=google_failed" }),
  (req, res) => res.redirect(safeNext(req.query.state))
);

router.get("/github", (req, res, next) => {
  if (!githubEnabled) {
    return res
      .status(503)
      .send(
        "Login GitHub belum dikonfigurasi di server (GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET kosong di .env)."
      );
  }
  passport.authenticate("github", {
    scope: ["user:email"],
    state: safeNext(req.query.next),
  })(req, res, next);
});

router.get(
  "/github/callback",
  (req, res, next) => {
    if (!githubEnabled) return res.redirect("/signin.html?error=github_disabled");
    next();
  },
  passport.authenticate("github", { failureRedirect: "/signin.html?error=github_failed" }),
  (req, res) => res.redirect(safeNext(req.query.state))
);

router.get("/logout", (req, res) => {
  req.logout(() => {
    req.session.destroy(() => res.redirect("/features.html"));
  });
});

/**
 * Tukar admin key (x-admin-key, key yang sama dengan /api/admin/*) jadi
 * session akses Docs/Playground. Dipanggil otomatis oleh login.html &
 * admin-shared.js — jadi orang yang login pakai admin key bisa langsung
 * buka /index.html tanpa harus login Google/GitHub lagi.
 * Validasinya persis adminAuth (timingSafeEqual), cuma hasilnya session
 * flag, bukan akses API admin.
 */
router.post("/admin-session", (req, res) => {
  const configuredKeys = config.adminApiKeys;
  if (!configuredKeys.length) {
    return res.status(503).json({ status: false, error: "ADMIN_API_KEY belum di-set di server." });
  }
  const provided = Buffer.from(req.get("x-admin-key") || "");
  const valid = configuredKeys.some((k) => {
    const expected = Buffer.from(k);
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  });
  if (!valid) {
    return res.status(401).json({ status: false, error: "Admin key salah." });
  }
  req.session.adminDocs = true;
  res.json({ status: true, result: { message: "Akses Docs aktif buat session ini." } });
});

// Dipakai frontend (signin.html, index.html) buat nampilin "login sebagai ..."
// adminDocs ikut dibalikin biar index.html bisa nampilin badge "admin"
// buat yang masuk lewat admin key (bukan Google/GitHub).
// Sekalian AUTO-PROVISION API key tier free per akun OAuth (idempotent,
// lihat utils/clients.js) — ditaruh di sini, bukan di callback OAuth,
// biar session lama dari sebelum fitur ini ada ikut kebagian key pas
// mereka buka docs lagi. apiKey dibalikin ke frontend buat ditampilkan
// + dipakai otomatis sama playground.
router.get("/me", (req, res) => {
  let apiClient = null;
  if (req.user?.provider && req.user?.id) {
    try {
      apiClient = ensureClientForUser(req.user);
      // Session ini udah buktiin pegang ADMIN_API_KEY (lihat /auth/admin-session
      // di atas) — naikin tier key OAuth-nya ke "admin" sekalian, biar tier
      // di kartu API key nyambung sama kenyataan aksesnya (dulu: login admin
      // tapi key-nya tetap "free" — membingungkan). Persist di clients.json,
      // jadi key-nya juga admin dipakai via curl. Idempotent, dan sticky
      // setelah logout (turunin lewat client manager kalau perlu).
      if (apiClient && req.session?.adminDocs && apiClient.tier !== "admin") {
        apiClient = promoteClientToAdmin(apiClient.apiKey) || apiClient;
      }
    } catch {
      /* provisioning best-effort — jangan gagalin /auth/me */
    }
  }
  // Response sekarang bawa secret (API key) — jangan sampai ke-cache di
  // layer mana pun.
  res.set("Cache-Control", "no-store");
  res.json({
    status: true,
    user: req.user || null,
    adminDocs: !!(req.session && req.session.adminDocs),
    apiKey: apiClient ? apiClient.apiKey : null,
    apiTier: apiClient ? apiClient.tier : null,
    // Info pemakaian buat kartu API key di docs (self-service): pemakaian
    // hari ini + limit yang berlaku + endpoint terpopuler 7 hari terakhir.
    // hourlyLimit null = unlimited (admin). expiresAt null = tanpa batas.
    usage: apiClient
      ? {
          today: getTodayTotal(apiClient.apiKey),
          dailyQuota: apiClient.dailyQuota || null,
          hourlyLimit: apiClient.tier === "admin" ? null : (TIER_MAX[apiClient.tier] ?? TIER_MAX.free),
          topPaths: topPathsForKey(apiClient.apiKey, 7),
          expiresAt: apiClient.expiresAt || null,
        }
      : null,
  });
});

/**
 * Self-service rotate API key: user login (OAuth) ganti key-nya sendiri
 * dengan yang baru — key lama langsung mati. Buat kasus "key-ku kesebar
 * di screenshot/log", tanpa harus nunggu admin. Sengaja dibatasi ke akun
 * OAuth yang lagi login (session), bukan sembarang key: kalau nerima key
 * dari body, endpoint ini malah jadi alat mematikan key orang lain.
 */
router.post("/regenerate-key", (req, res) => {
  if (!req.user?.provider || req.user?.id === undefined || req.user?.id === null) {
    return res.status(401).json({ status: false, error: "Harus login Google/GitHub dulu." });
  }
  const existing = findClientByProvider(req.user.provider, req.user.id);
  if (!existing) {
    return res.status(404).json({ status: false, error: "Akun ini belum punya API key." });
  }
  const rotated = regenerateClientKey(existing.apiKey);
  res.set("Cache-Control", "no-store");
  res.json({ status: true, result: { apiKey: rotated.apiKey, tier: rotated.tier } });
});

/* ------------------------------------------------------------------ */
/* Multi-key self-service: akun OAuth bisa pegang beberapa key berlabel */
/* (mis. "bot-discord", "server-prod") — rotate/hapus satu gak matiin   */
/* yang lain. Semua route di bawah pakai guard session yang sama:       */
/* identitas dari session OAuth, BUKAN dari body (biar gak bisa ngatur  */
/* key akun lain). Lihat utils/clients.js buat aturan kepemilikannya.   */
/* ------------------------------------------------------------------ */

function requireOAuthUser(req, res, next) {
  if (!req.user?.provider || req.user?.id === undefined || req.user?.id === null) {
    return res.status(401).json({ status: false, error: "Harus login Google/GitHub dulu." });
  }
  next();
}

router.get("/keys", requireOAuthUser, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    status: true,
    result: {
      keys: listKeysForUser(req.user.provider, req.user.id),
      max: MAX_KEYS_PER_USER,
    },
  });
});

router.post("/keys", requireOAuthUser, (req, res) => {
  try {
    const created = createAdditionalKey(req.user, req.body?.label);
    res.set("Cache-Control", "no-store");
    res.json({
      status: true,
      result: { apiKey: created.apiKey, label: created.label, tier: created.tier },
    });
  } catch (e) {
    res.status(400).json({ status: false, error: e.message });
  }
});

router.delete("/keys/:apiKey", requireOAuthUser, (req, res) => {
  try {
    deleteOwnKey(req.user, req.params.apiKey);
    res.json({ status: true, result: { message: "Key dihapus." } });
  } catch (e) {
    res.status(e.message.includes("tidak ditemukan") ? 404 : 400).json({ status: false, error: e.message });
  }
});

/**
 * Data panel usage di docs: deret harian + top endpoint + kuota untuk SATU
 * key milik akun yang login. Dipisah dari route biar bisa ditest langsung
 * tanpa boot app (pola safeNext di atas).
 *
 * Balikin null kalau key gak ketemu DI DAFTAR KEY USER INI — sengaja gak
 * bedain "key orang lain" vs "key gak ada" biar endpoint ini gak bisa
 * dipakai ngecek eksistensi key orang.
 */
export function buildUsageSeriesPayload(user, query = {}) {
  const keys = listKeysForUser(user?.provider, user?.id);
  if (!keys.length) return null;
  const requested = typeof query.key === "string" && query.key ? query.key : null;
  const owned = requested ? keys.find((k) => k.apiKey === requested) : keys.find((k) => !k.label) || keys[0];
  if (!owned) return null;
  // days di-clamp diam-diam ke 1-30 (retensi usage.json cuma 30 hari),
  // non-angka -> default 14. Bukan error: query nyeleneh gak perlu 400.
  const parsed = Number.parseInt(query.days, 10);
  const days = Number.isFinite(parsed) ? Math.min(30, Math.max(1, parsed)) : 14;
  return {
    days: dailySeriesForKey(owned.apiKey, days),
    topPaths: topPathsForKey(owned.apiKey, days),
    quota: {
      daily: owned.dailyQuota || null,
      hourly: owned.tier === "admin" ? null : (TIER_MAX[owned.tier] ?? TIER_MAX.free),
      todayUsed: getTodayTotal(owned.apiKey),
    },
  };
}

router.get("/usage-series", requireOAuthUser, (req, res) => {
  const payload = buildUsageSeriesPayload(req.user, req.query);
  if (!payload) {
    return res.status(404).json({ status: false, error: "Key tidak ditemukan di akun ini." });
  }
  res.set("Cache-Control", "no-store");
  res.json({ status: true, result: payload });
});

export default router;

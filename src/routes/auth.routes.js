import { Router } from "express";
import crypto from "crypto";
import passport, { googleEnabled, githubEnabled } from "../config/passport.js";
import { config } from "../config/index.js";
import { ensureClientForUser, promoteClientToAdmin } from "../utils/clients.js";

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
  });
});

export default router;

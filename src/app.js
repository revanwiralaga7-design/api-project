import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import session from "express-session";
import sqliteSessionStore from "better-sqlite3-session-store";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

import { config } from "./config/index.js";
import apiRoutes from "./routes/index.js";
import authRoutes from "./routes/auth.routes.js";
import passport from "./config/passport.js";
import { notFound } from "./middleware/notFound.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { identifyClient } from "./middleware/identifyClient.js";
import { requireApiKey } from "./middleware/requireApiKey.js";
import { tierRateLimiter } from "./middleware/tierRateLimit.js";
import { requireDocsAuth } from "./middleware/requireDocsAuth.js";
import { usageTracker } from "./middleware/usageTracker.js";
import { dailyQuota } from "./middleware/dailyQuota.js";
import { responseCache } from "./middleware/responseCache.js";
import { jsonImage } from "./middleware/jsonImage.js";
import { ACCESS_LOG_PATH } from "./utils/accessLog.js";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// WAJIB kalau di-deploy di belakang reverse proxy (Railway, Render, Heroku,
// Vercel, nginx, dst) — tanpa ini, req.ip yang dipakai buat nge-key rate
// limiter (lihat middleware/tierRateLimit.js: keyForRequest) BUKAN IP asli
// pengunjung, dan bisa gak konsisten antar request (kelihatan kayak limit
// "reset" terus padahal cuma dianggap klien baru tiap kali). Angka 1 berarti
// percaya SATU hop proxy paling depan (sesuai arsitektur Railway — kalau
// nanti pindah ke setup dengan proxy berlapis, angka ini perlu disesuaikan).
app.set("trust proxy", 1);

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
// Bundle restore backup isinya SEMUA file hasil scaffold (bisa lewat 2mb
// kalau endpoint-nya udah banyak) — kasih limit lebih longgar khusus path
// ini, SEBELUM parser global di bawah (begitu body udah keparse di sini,
// parser global otomatis skip). Tetap dibatasi 25mb, bukan tanpa batas.
app.use("/api/admin/backup/restore", express.json({ limit: "25mb" }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// Session + passport buat login Google/GitHub (proteksi Docs, /index.html).
// Riwayat store: MemoryStore bawaan (hilang tiap restart + bocor memory) →
// session-file-store (tahan restart, tapi paketnya udah gak di-maintain) →
// sekarang better-sqlite3: satu file .sqlite (SESSION_STORE_PATH, default
// ./data/sessions.sqlite), tahan restart proses selama disk-nya sama (masih
// ilang kalau Railway redeploy ke container baru — filesystem-nya ephemeral
// kecuali dipasangin volume). Ini masih penyimpanan SATU INSTANCE — kalau
// nanti di-scale ke banyak instance sekaligus, ganti ke store yang dibagi
// bareng (mis. connect-redis), file SQLite lokal gak cocok buat itu.
const SqliteStore = sqliteSessionStore(session);
// Reaper bawaan store (dipanggil dari constructor, GAK BISA dimatiin lewat
// opsi — `expired.clear: false` tetap ke-truthy-kan jadi true sama bug
// `(x && x.clear) || true` di paketnya) pakai setInterval tanpa unref, bikin
// proses Node gak bisa exit sendiri — test suite (node --test) yang import
// app.js jadi nge-hang selamanya. Override di prototype: logika reap-nya
// sama persis (delete session kadaluarsa tiap interval), cuma timer-nya
// di-unref biar gak nahan proses hidup.
SqliteStore.prototype.startInterval = function startIntervalUnref() {
  setInterval(this.clearExpiredSessions.bind(this), this.expired.intervalMs).unref();
};
fs.mkdirSync(path.dirname(config.session.storePath), { recursive: true });
const sessionDb = new Database(config.session.storePath);
app.use(
  session({
    store: new SqliteStore({
      client: sessionDb,
      // Reap session kadaluarsa tiap 15 menit (MemoryStore dulu gak pernah
      // reap sama sekali — ini salah satu alasan pindah).
      expired: { clear: true, intervalMs: 15 * 60 * 1000 }
    }),
    secret: config.session.secret || "dev-only-secret-JANGAN-dipakai-produksi-ganti-di-.env",
    resave: false,
    saveUninitialized: false,
    // Perlu ini bareng app.set("trust proxy", 1) di atas biar express-session
    // percaya header X-Forwarded-Proto dari proxy Railway pas nentuin apakah
    // koneksi asli HTTPS (req.secure) — tanpa ini, cookie.secure di bawah
    // gak akan pernah kekirim walau publiknya udah HTTPS.
    proxy: true,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
      httpOnly: true,
      // Cuma dikirim lewat HTTPS pas production — kalau dipaksa true terus
      // waktu dev lokal (http://localhost), cookie gak akan pernah ke-set
      // dan login jadi keliatan gak nyantol padahal cuma soal ini.
      secure: config.nodeEnv === "production"
    }
  })
);
app.use(passport.initialize());
app.use(passport.session());
app.use("/auth", authRoutes);

// Root diarahin ke halaman fitur (marketing/landing), bukan langsung ke
// Docs — Docs (index.html) sekarang butuh login, lihat requireDocsAuth di
// bawah.
app.get("/", (req, res) => res.redirect("/features.html"));

// WAJIB didaftarkan SEBELUM express.static: kalau static duluan, dia bakal
// langsung nyajiin index.html apa adanya tanpa sempet dicek auth-nya dulu.
app.get("/index.html", requireDocsAuth, (req, res, next) => next());

app.use(express.static(path.join(__dirname, "..", "public")));

if (config.nodeEnv !== "test") {
  app.use(morgan(config.nodeEnv === "development" ? "dev" : "combined"));
  // Log viewer admin: selain ke stdout, tulis juga format 'combined' ke
  // data/access.log (append stream, folder data/ di-ignore nodemon jadi
  // gak micu restart). Dibaca via GET /api/admin/logs.
  fs.mkdirSync(path.dirname(ACCESS_LOG_PATH), { recursive: true });
  const accessLogStream = fs.createWriteStream(ACCESS_LOG_PATH, { flags: "a" });
  app.use(morgan("combined", { stream: accessLogStream }));
}

// Limiter khusus /api/admin (fitur scaffold yang bisa nulis kode) — flat,
// gak ikut sistem tier di bawah karena ini soal proteksi panel, bukan
// kuota pemakaian API publik. Dipasang duluan karena path-nya lebih
// spesifik dari /api umum.
const adminLimiter = rateLimit({
  windowMs: config.adminRateLimit.windowMs,
  max: config.adminRateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: false, error: "Terlalu banyak request ke admin panel, coba lagi sebentar lagi." }
});
app.use("/api/admin", adminLimiter);

// Rate limiter PER USER (bukan satu counter global): identifyClient nempelin
// req.client = { tier, apiKey } dari header x-api-key (default tier "free"
// kalau gak ada/gak dikenal, di-key pakai IP). tierRateLimiter baru nentuin
// batas request/jam sesuai tier itu — dipasang di semua /api/* KECUALI
// /api/admin/* (yang udah punya proteksi sendiri di atas).
// WAJIB: /api/* itung request per klien (buat rate limit) dan tier-nya bisa
// beda tiap orang — response-nya TIDAK BOLEH di-cache sama layer mana pun
// (edge Railway, CDN, browser, dst). Tanpa header ini, Express gak ngirim
// Cache-Control sama sekali, jadi tiap layer bebas nentuin sendiri boleh
// nge-reuse response identik atau nggak — ini yang bikin counter kelihatan
// "gak jalan" kalau di-hit pakai URL yang persis sama berkali-kali cepat,
// padahal counter-nya sendiri jalan normal begitu di-cache-bust.
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.use("/api", identifyClient);
// Endpoint API publik WAJIB API key (401 tanpa key) — kecuali /api, /api/me,
// /api/endpoints, dan /api/admin/* (lihat middleware/requireApiKey.js).
// Free gak lagi anonim per IP: key didapat dari login Google/GitHub di docs.
app.use("/api", requireApiKey);
app.use(/^\/api\/(?!admin\/).*/, tierRateLimiter);
// Kuota harian per client (opsional per key, lihat middleware/dailyQuota.js)
// — setelah tierRateLimiter biar 429 per jam tetap yang utama, dan pakai
// data usage yang dicatat usageTracker di bawah.
app.use(/^\/api\/(?!admin\/).*/, dailyQuota);
// Catat pemakaian per client per endpoint (data/usage.json) — dipasang
// setelah limiter supaya hit yang kena 429 juga kecatat statusnya.
app.use("/api", usageTracker);
// Cache response per endpoint (opt-in per path, TTL diatur admin) —
// paling akhir sebelum route handler: request yang kena cache tetap
// kehitung rate limit & analytics di atas.
app.use("/api", responseCache);
// ?format=image: render response JSON jadi gambar PNG ala code editor —
// SETELAH responseCache biar sadapannya paling luar (request gambar gak
// ngisi cache JSON; kunci cache-nya sendiri udah beda karena format=image
// ikut di query). Lihat middleware/jsonImage.js.
app.use("/api", jsonImage);

app.get("/health", (req, res) => {
  res.json({ status: true, uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.use("/api", apiRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;

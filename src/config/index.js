import "dotenv/config";
import path from "path";
import { DATA_DIR } from "../utils/dataDir.js";

export const config = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || "development",
  // Rate limit PER CLIENT (bukan global) berdasarkan tier — lihat
  // middleware/identifyClient.js & middleware/tierRateLimit.js.
  // "admin" sengaja gak punya angka di sini: request tier admin di-skip
  // total dari limiter (unlimited), gak dihitung sama sekali.
  tierRateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 60 * 1000, // 1 jam
    free: Number(process.env.RATE_LIMIT_FREE_PER_HOUR) || 100,
    premium: Number(process.env.RATE_LIMIT_PREMIUM_PER_HOUR) || 1000
  },
  // Kalau kosong, panel admin otomatis dimatikan (lihat middleware/adminAuth.js).
  // Bisa diisi lebih dari satu key, pisah pakai koma:
  //   ADMIN_API_KEY=key-punya-febry,key-punya-orang-lain
  // Tiap key dianggap setara (sama-sama akses penuh ke panel scaffold),
  // gunanya cuma biar tiap orang punya key sendiri (gampang dicabut satu-satu
  // tanpa ganggu yang lain, tinggal hapus dari list terus restart server).
  adminApiKeys: (process.env.ADMIN_API_KEY || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean),
  adminRateLimit: {
    windowMs: Number(process.env.ADMIN_RATE_LIMIT_WINDOW_MS) || 60_000,
    max: Number(process.env.ADMIN_RATE_LIMIT_MAX) || 20
  },
  // Base URL publik project ini — dipakai buat nyusun callback URL OAuth
  // (harus PERSIS sama dengan yang didaftarin di Google Cloud Console /
  // GitHub OAuth App, kalau beda bakal error "redirect_uri_mismatch").
  // Trailing slash dibuang otomatis — kalau kelewat di .env, callback-nya
  // jadi "...app//auth/google/callback" dan mismatch semua.
  appUrl: (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, ""),
  // Login Google/GitHub buat AKSES DOKUMENTASI (/index.html) — beda dari
  // ADMIN_API_KEY di atas (itu buat panel scaffold). Lihat src/config/passport.js.
  session: {
    // Kalau kosong: pakai secret dev yang gak aman, cuma biar server tetap
    // nyala pas lagi coba-coba lokal. WAJIB diisi sebelum online publik.
    secret: process.env.SESSION_SECRET || "",
    // Direktori file session (lihat src/app.js). SESSION_STORE_PATH menang
    // kalau di-set; kalau nggak, ikut DATA_DIR (default ./data/sessions) —
    // biar satu env DATA_DIR aja cukup mindahin SEMUA file runtime ke volume.
    storePath: process.env.SESSION_STORE_PATH || path.join(DATA_DIR, "sessions")
  },
  oauth: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || ""
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID || "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET || ""
    }
  }
};

export default config;

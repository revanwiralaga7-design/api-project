import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as GitHubStrategy } from "passport-github2";
import { config } from "./index.js";

/**
 * Auth buat AKSES DOKUMENTASI (/index.html) — beda total sama adminAuth.js
 * (yang proteksi /admin.html pakai header x-admin-key). Ini pakai session +
 * OAuth Google/GitHub asli, gunanya cuma buat tau "siapa yang lagi liat
 * docs". Ini TIDAK ngubah cara proteksi endpoint /api/* publik — itu tetap
 * lewat x-api-key / identifyClient.js, sama sekali gak disentuh di sini.
 *
 * Gak ada database user di project ini — profil OAuth (id, nama, email,
 * avatar, provider) disimpen APA ADANYA di session lewat serializeUser.
 * Cukup buat MVP satu server. Kalau nanti pindah ke multi-instance /
 * butuh session tahan restart, ganti MemoryStore bawaan express-session
 * dengan store lain (mis. connect-redis) — lihat catatan di app.js.
 */
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

const { google, github } = config.oauth;

export const googleEnabled = Boolean(google.clientId && google.clientSecret);
export const githubEnabled = Boolean(github.clientId && github.clientSecret);

if (googleEnabled) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: google.clientId,
        clientSecret: google.clientSecret,
        callbackURL: `${config.appUrl}/auth/google/callback`
      },
      (accessToken, refreshToken, profile, done) => {
        const user = {
          provider: "google",
          id: profile.id,
          name: profile.displayName || "Google User",
          email: profile.emails?.[0]?.value || null,
          avatar: profile.photos?.[0]?.value || null
        };
        done(null, user);
      }
    )
  );
} else {
  console.warn(
    "⚠️  GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET belum di-set di .env — tombol login Google bakal nampilin error kalau dipencet (lihat .env.example)."
  );
}

if (githubEnabled) {
  passport.use(
    new GitHubStrategy(
      {
        clientID: github.clientId,
        clientSecret: github.clientSecret,
        callbackURL: `${config.appUrl}/auth/github/callback`
      },
      (accessToken, refreshToken, profile, done) => {
        const user = {
          provider: "github",
          id: profile.id,
          name: profile.displayName || profile.username || "GitHub User",
          email: profile.emails?.[0]?.value || null,
          avatar: profile.photos?.[0]?.value || null
        };
        done(null, user);
      }
    )
  );
} else {
  console.warn(
    "⚠️  GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET belum di-set di .env — tombol login GitHub bakal nampilin error kalau dipencet (lihat .env.example)."
  );
}

export default passport;

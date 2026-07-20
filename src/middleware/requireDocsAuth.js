/**
 * Proteksi /index.html (Docs & Playground) — bisa dibuka kalau:
 * 1. Udah login lewat Google atau GitHub (lihat routes/auth.routes.js), ATAU
 * 2. Udah "tukar" admin key jadi session Docs lewat POST /auth/admin-session
 *    (dipanggil otomatis sama login.html & admin-shared.js setelah login
 *    admin) — biar pemegang admin key gak dipaksa login Google/GitHub lagi
 *    cuma buat lihat playground sendiri.
 *
 * Beda dari adminAuth.js (header x-admin-key buat /api/admin/*): ini pakai
 * session cookie, diarahin ke halaman signin.html kalau belum login.
 *
 * Dipasang SEBELUM express.static di app.js — soalnya static middleware
 * bakal langsung nyajiin file index.html apa adanya kalau taruh sebelum ini.
 */
export function requireDocsAuth(req, res, next) {
  if (typeof req.isAuthenticated === "function" && req.isAuthenticated()) {
    return next();
  }
  if (req.session && req.session.adminDocs) {
    return next();
  }
  const nextUrl = encodeURIComponent(req.originalUrl || "/index.html");
  res.redirect(`/signin.html?next=${nextUrl}`);
}

export default requireDocsAuth;

# Desain: Dashboard Usage Klien + Akses OpenAPI Self-Service

Tanggal: 2026-07-20
Status: disetujui (brainstorming selesai, siap masuk perencanaan implementasi)

## Latar Belakang

Docs & playground (`public/index.html`) sudah punya kartu API key dengan ringkasan
pemakaian hari ini, rotate key, dan multi-key berlabel. Generator OpenAPI
(`buildOpenApiSpec` di `src/utils/health.js`) sudah ada tapi hanya bisa diekspor
lewat panel admin (`/api/admin/ops/openapi.json`).

Gap yang ditutup desain ini:

1. Klien belum bisa lihat **tren pemakaian harian per key** (grafik), hanya angka
   hari ini.
2. Klien belum bisa **mengunduh spec OpenAPI** tanpa admin key.

Ini tahap 1 dari roadmap yang disepakati: (1) pengalaman developer/klien →
(2) fitur/endpoint API baru → (3) monetisasi & tier → (4) skalabilitas & ops.
Tahap 2–4 di luar scope dokumen ini.

## Keputusan Pendekatan

**Perluas docs buatan sendiri** — tanpa dependency baru, tanpa Swagger UI/Scalar,
tanpa halaman terpisah. Panel usage baru masuk ke `index.html` mengikuti gaya
visual yang ada; endpoint backend baru reuse util yang sudah ada.

Alternatif yang ditolak:

- **Scalar/Swagger UI di /docs** — dependency baru + dua UI docs paralel.
- **dashboard.html terpisah** — pemisahan rapi tapi kerja lebih banyak; belum
  perlu selama panel muat wajar di index.html.

## Backend

### 1. `GET /auth/usage-series` (di `src/routes/auth.routes.js`)

- Guard: `requireOAuthUser` (sudah ada). Sesi admin-key ditolak sama seperti
  `/auth/keys`.
- Query:
  - `key` — API key yang diminta; **harus milik user login** (validasi via
    `listKeysForUser`). Default: key utama akun.
  - `days` — di-clamp diam-diam ke 1–30 (KEEP_DAYS usage.js = 30); non-angka
    → default 14.
- Response:
  ```json
  {
    "status": true,
    "result": {
      "days": [{ "day": "YYYY-MM-DD", "total": 0, "limited": 0 }],
      "topPaths": [{ "path": "/api/...", "hits": 0 }],
      "quota": { "daily": null, "hourly": 100, "todayUsed": 0 }
    }
  }
  ```
- Util baru `dailySeriesForKey(clientKey, days)` di `src/utils/usage.js` —
  mirip `dailySeries()` tapi difilter satu key; semua hari di rentang
  dikembalikan urut termasuk yang 0 hit (sumbu X kontinu, prinsip yang sudah
  dipakai `dailySeries`).
- `Cache-Control: no-store` (konsisten dengan `/auth/me`).

### 2. `GET /openapi.json` untuk klien

- Guard: `requireDocsAuth` — akses sama dengan index.html (login OAuth ATAU
  sesi admin-docs).
- Reuse `buildOpenApiSpec({ baseUrl })` dari `src/utils/health.js`.
- Endpoint admin lama `/api/admin/ops/openapi.json` **tetap ada** (dipakai
  admin-ops).

## Frontend (`public/index.html` + skrip)

Panel usage baru di antara kartu API key dan playground, gaya visual mengikuti
yang sudah ada (patch-panel/LED):

- **Grafik batang 14 hari** — bar div/SVG tanpa library chart; satu bar per
  hari, hari kosong tetap tampil (bar 0). Tiap bar dibagi dua warna: hit
  normal vs `limited`, supaya klien lihat kapan kena rate limit.
- **Selector key (▾)** — dropdown daftar key milik akun dari `/auth/keys`
  (skrip extraKeys yang ada). Ganti key → fetch ulang
  `/auth/usage-series?key=...`.
- **Ringkasan angka** — pemakaian hari ini vs kuota harian (progress bar),
  limit per jam, top-5 endpoint (dari `topPaths` response yang sama).
- **Tombol "Unduh OpenAPI"** di kartu API key — link `/openapi.json` + tooltip
  "impor ke Postman/Insomnia".
- Sesi admin-key murni (tanpa akun OAuth): panel usage disembunyikan —
  konsisten dengan perilaku extraKeys sekarang.

Logika fetch mengikuti pola yang sudah dipakai (`/auth/me`, `/auth/keys`).
Tidak ada framework baru.

## Error Handling

- `/auth/usage-series`: 401 tanpa login OAuth; 404 kalau `key` bukan milik
  user (pesan tidak membocorkan apakah key itu ada di sistem); `days` invalid
  → clamp diam-diam, bukan error.
- `/openapi.json`: `requireDocsAuth` me-redirect ke signin.html untuk request
  HTML — untuk request non-HTML (`Accept` tanpa `text/html`) balas **401
  JSON** supaya `curl`/Postman dapat error jelas, bukan halaman signin.
- Frontend: fetch gagal → panel menampilkan pesan ringkas tanpa mengganggu
  bagian docs lain (pola kartu extraKeys).

## Testing (`node --test`, pola tests/ yang ada)

- `tests/usageSeries.test.js` — unit `dailySeriesForKey`: hari kosong = 0,
  filter per key benar, clamp days, key tak dikenal → semua 0.
- Integrasi route: `/auth/usage-series` tolak tanpa session, tolak key milik
  user lain, sukses untuk key sendiri; `/openapi.json` butuh docs auth dan
  hasilnya dokumen OpenAPI valid (punya `openapi`, `paths`).
- `publicSyntax.test.js` otomatis memvalidasi sintaks JS baru di `public/`.

## Batasan Scope

Murni aditif: tidak menyentuh sistem tier, admin panel, skema penyimpanan,
atau dependency. Data usage tetap `data/usage.json` dengan retensi 30 hari —
grafik maksimal menampilkan rentang itu.

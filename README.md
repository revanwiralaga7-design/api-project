# Febry API — Backend

Backend REST API (YouTube Search, Anime Search) plus panel admin untuk
menambah/mengedit/menghapus endpoint secara dinamis, dibangun dengan Node.js +
Express.

## Instalasi

```bash
npm install
cp .env.example .env
npm run dev     # mode development (auto-restart)
# atau
npm start       # mode production
```

Server berjalan di `http://localhost:3000` secara default (ubah lewat `.env`).

## Cek endpoint

- `GET /health` — cek server hidup
- `GET /api` — pesan selamat datang
- `GET /api/endpoints` — daftar semua endpoint yang tersedia (nama, method, path, parameter)

## `?format=image` — respons JSON jadi gambar

Semua endpoint data `/api/*` bisa dikasih `?format=image`: respons JSON-nya
di-render jadi **gambar PNG ala jendela code editor** (syntax highlight +
nomor baris) — buat bot WhatsApp/Discord yang mau nampilin hasil API
langsung ke chat tanpa nyuruh orang baca JSON mentah.

```bash
# JSON biasa
curl "https://host/api/youtube/search?query=naruto&apikey=<key>"
# hasil yang sama, tapi sebagai gambar PNG
curl "https://host/api/youtube/search?query=naruto&format=image&apikey=<key>" -o hasil.png
```

Otomatis berlaku juga buat endpoint scaffold yang dibikin belakangan (di-
implement sebagai middleware yang nyadap `res.json`, bukan per route —
lihat `src/middleware/jsonImage.js`). Respons panjang dipotong ke 80 baris
dengan penanda `… N baris lagi`. Error sebelum route (401 tanpa key, 429
rate limit) tetap JSON.

## API key wajib + rate limiter per user (bukan global)

Semua `/api/*` (kecuali `/api`, `/api/me`, `/api/endpoints`, dan `/api/admin/*`
yang punya proteksi sendiri) **wajib menyertakan API key** — tanpa key
request ditolak 401. Key bisa dikirim dua cara:

```bash
# lewat header (disarankan)
curl -H "x-api-key: <key>" https://host/api/youtube/search?query=naruto
# atau lewat query param di URL
curl "https://host/api/youtube/search?query=naruto&apikey=<key>"
```

> ⚠️ `?apikey=` di URL kepraktisannya dibayar risiko: URL tercatat di access
> log server, history browser, dan bisa kebawa header Referer — buat
> integrasi serius pakai header `x-api-key`.

Limit dihitung **per API key** (per akun), bukan per IP dan bukan satu
counter global:

| Tier | Limit | Cara dapet |
|---|---|---|
| Free | 100 request/jam | **login Google/GitHub di halaman docs** — API key dibuat otomatis buat akunmu (sekali, permanen) dan tampil di kartu "API KEY KAMU" di docs |
| Premium | 1000 request/jam | minta admin upgrade key kamu (atau dibuatkan key premium manual) |
| Admin | unlimited | key yang tier-nya `admin` di clients.json — **otomatis** buat akun Google/GitHub yang login docs sambil pegang session admin (lihat catatan di bawah), atau di-set manual lewat client manager |

> **Login admin + login Google/GitHub = key kamu naik ke admin.** Kalau kamu
> masuk docs lewat admin key (`/auth/admin-session`, dipanggil otomatis dari
> login.html) DAN juga login Google/GitHub, key OAuth kamu otomatis
> dinaikkan ke tier `admin` (persist di `clients.json`, berlaku juga via
> curl/Postman). Sticky: sekali naik gak turun sendiri pas logout —
> turunkan manual lewat `/client-manager.html` kalau perlu. Tanpa mekanisme
> ini dua sistem itu jalan sendiri-sendiri: login admin tapi kartu API key
> nulis "free" — membingungkan.

**Bikin API key client secara manual (selain jalur login docs):**
```bash
npm run create-key -- "nama-client" premium
# atau: free / admin
```
Key baru langsung aktif (tersimpan di `src/config/clients.json` — file ini
di-gitignore karena isinya API key asli, jangan di-commit; lihat
`clients.example.json` buat formatnya. Dibaca ulang tiap request, jadi gak
perlu restart server). Kasih tau client-nya buat kirim `x-api-key: <key>`
di header tiap request.

Cek tier & identitas sendiri: `GET /api/me` (kirim `x-api-key` / `?apikey=`
kalau punya — endpoint ini satu-satunya yang boleh diakses tanpa key, biar
gampang ngecek "key-ku kebaca gak"). Sisa kuota ada di header response
`RateLimit-*`.

Angka default (100/1000 per jam) bisa diubah lewat `RATE_LIMIT_FREE_PER_HOUR`
/ `RATE_LIMIT_PREMIUM_PER_HOUR` / `RATE_LIMIT_WINDOW_MS` di `.env`.

> **Deploy di belakang proxy (Railway/Render/Heroku/dst)?** `app.set("trust
> proxy", 1)` di `src/app.js` WAJIB ada (udah ada di project ini) — tanpa
> ini, request tanpa `x-api-key` (diidentifikasi lewat IP) bisa kelihatan
> "reset" terus limitnya, soalnya Express baca IP proxy internal, bukan IP
> pengunjung asli.

> Catatan: tier "admin" di `clients.json` ini beda dari `ADMIN_API_KEY` di
> bawah — yang ini kuota pemakaian API buat konsumen, yang itu kunci ke
> fitur scaffold (bikin/hapus endpoint dengan nulis kode).

## Login Google/GitHub buat akses Docs

Sejak sekarang, `/index.html` (dokumentasi & playground) **gak lagi publik** —
harus login dulu pakai akun Google atau GitHub. Ini sistem auth yang
**terpisah total** dari `ADMIN_API_KEY` di bawah (yang itu buat panel
scaffold, bukan buat baca-baca docs).

Alurnya: buka `/` → landing `/features.html` (publik, jelasin fitur) → klik
"Lihat Dokumentasi" → kalau belum login, dilempar ke `/signin.html` → pilih
Google atau GitHub → balik lagi ke `/index.html` udah dalam keadaan login.

### Setup Google OAuth

1. Buka [Google Cloud Console](https://console.cloud.google.com/) → buat
   project (atau pakai yang udah ada) → **APIs & Services > Credentials**.
2. **Create Credentials > OAuth client ID**, tipe **Web application**.
3. Di **Authorized redirect URIs**, isi persis: `{APP_URL}/auth/google/callback`
   (mis. `http://localhost:3000/auth/google/callback` waktu development).
4. Copy **Client ID** & **Client Secret** yang muncul ke `.env`:
   `GOOGLE_CLIENT_ID=...` dan `GOOGLE_CLIENT_SECRET=...`.
5. Kalau project Google-nya masih "Testing" (belum publish/verifikasi), cuma
   email yang kamu daftarin sebagai **Test user** di OAuth consent screen
   yang bisa login — ini normal buat tahap development.

### Setup GitHub OAuth

1. Buka **GitHub > Settings > Developer settings > OAuth Apps > New OAuth App**.
2. **Homepage URL**: isi `{APP_URL}` (mis. `http://localhost:3000`).
3. **Authorization callback URL**: isi persis `{APP_URL}/auth/github/callback`.
4. Setelah dibuat, generate **Client Secret**, lalu copy **Client ID** &
   **Client Secret** ke `.env`: `GITHUB_CLIENT_ID=...` dan
   `GITHUB_CLIENT_SECRET=...`.

### Isi juga

- `APP_URL` — base URL server ini (harus PERSIS sama dengan yang dipasang di
  langkah di atas; ganti ke domain asli waktu deploy).
- `SESSION_SECRET` — string random panjang buat nandatangani session cookie
  login (WAJIB diisi sebelum online publik, jangan dikosongin).

Kalau `GOOGLE_CLIENT_ID`/`SECRET` atau `GITHUB_CLIENT_ID`/`SECRET` kosong,
tombol login provider itu di `/signin.html` bakal nampilin pesan error kalau
dipencet (bukan bikin seluruh proteksi Docs mati) — isi salah satu provider
aja juga udah cukup buat bikin Docs bisa diakses.

Session login disimpen di cookie (default 7 hari). Server pakai penyimpanan
`session-file-store` — sesi ditulis ke disk (default `./data/sessions`, bisa
diganti lewat `SESSION_STORE_PATH`), jadi tahan restart proses, beda dari
MemoryStore bawaan express-session yang hilang tiap restart. Ini masih
penyimpanan **satu instance**: kalau nanti di-scale jadi banyak instance
sekaligus, ganti ke store yang dibagi bareng (mis. `connect-redis`) — file
store gak cocok buat itu karena tiap instance punya disk sendiri-sendiri.
Cookie session juga cuma dikirim lewat HTTPS (`secure: true`) pas
`NODE_ENV=production`; di dev/test tetap jalan di `http://localhost`.

## Panel admin butuh API key

Panel admin (`/admin.html` dan halaman-halaman lain di bawahnya) dan semua
`/api/admin/*` bisa nulis/hapus file kode di server serta membuat/mencabut API
key client, jadi **wajib** diproteksi sebelum project ini pernah nempel ke
internet publik.

1. Isi `ADMIN_API_KEY` di `.env` dengan string random yang panjang (lihat
   `.env.example`). Kalau kosong, panel otomatis dimatikan (503) — bukan
   default kebuka.
2. Restart server.
3. Buka halaman admin manapun — kalau belum login, otomatis dilempar ke
   `/login.html` buat masukin key itu. Key yang valid disimpen di
   `sessionStorage` tab itu dan otomatis dipakai buat request selanjutnya
   (header `x-admin-key`) di SEMUA halaman admin (nav bar-nya sama). Kalau
   salah/expired, dilempar balik ke halaman login. Tombol "ganti key" ada di
   nav bar kalau perlu ganti/logout.
4. Admin punya rate limit sendiri yang lebih ketat (`ADMIN_RATE_LIMIT_MAX`,
   default 20/menit) di luar limiter umum `/api/*`.

**Jangan deploy publik tanpa langkah di atas.**

## Halaman admin

Panel admin kepisah jadi beberapa halaman, saling terhubung lewat nav bar
di atas tiap halaman:

| Halaman | Fungsi |
|---|---|
| `/features.html` | Landing page publik — jelasin fitur Justice API, gak butuh login |
| `/signin.html` | Login Google/GitHub, buat buka `/index.html` |
| `/index.html` | Dokumentasi & playground API — **butuh login Google/GitHub** (lihat bagian di atas), beda dari admin key |
| `/login.html` | Login admin — masukin `ADMIN_API_KEY`, semua halaman admin di bawah lempar ke sini kalau belum login |
| `/admin.html` | **Dashboard** — ringkasan jumlah endpoint/kategori/client, status server, dan tabel semua endpoint (bisa cari, edit, hapus langsung) |
| `/endpoint-add.html` | **Tambah Endpoint** — paste class code → analisis → pilih method & parameter → preview diff → apply |
| `/endpoint-edit.html` | **Edit Endpoint** — dibuka dari tombol "Edit" di dashboard. Ada 2 mode: **Edit Cepat** (ganti nama/deskripsi/kategori/wajib-opsional param, gak nyentuh kode) dan **Regenerate Penuh** (ganti method/parameter/logic — kerjanya hapus definisi lama + tulis definisi baru secara atomik, rollback otomatis kalau gagal) |
| `/client-manager.html` | **Client & API Key** — buat/lihat/edit tier/cabut API key client (beda dari `ADMIN_API_KEY` di atas — ini kuota pemakaian API buat konsumen) |
| `/admin-ops.html` | **Ops** — health check, riwayat scaffold (undo), usage analytics, cache per endpoint, log viewer, ekspor OpenAPI, backup & restore |

### Tambah endpoint baru

Buka `/endpoint-add.html` (link "+ Endpoint" di nav bar semua halaman admin, atau tombol di dashboard).

Alurnya:
1. Tempel kode class API baru (mis. `class SpotifyDL { ... }`) di kotak kode, klik **Analisis Class**.
2. Pilih method yang mau dipanggil dari daftar yang kedetect otomatis (bukan ngetik manual — jadi gak mungkin salah nama method). Parameternya juga otomatis ke-isi sesuai signature asli, tinggal atur nama field request-nya kalau mau beda (mis. service pakai `url` tapi kamu mau expose sebagai `urltiktok`).
3. Kalau constructor class-nya butuh argumen, ada bagian khusus buat nentuin argumen itu diambil dari request atau nilai tetap (mis. API key) — instance-nya otomatis dibuat ulang per-request kalau perlu.
4. Isi nama file service, slug route (baru atau nambah ke route existing), sub-path, method HTTP, kategori dokumentasi.
5. Klik **Preview** — nampilin diff ala `git diff` (baris hijau = ditambah) buat tiap file yang bakal berubah, plus warning kalau ada dependency yang belum ke-install (bisa dicentang buat auto-update `package.json`).
6. Klik **Apply** — otomatis bikin/update semua file terkait. Kalau ada file yang gagal ditulis di tengah proses, SEMUA perubahan di-rollback otomatis (gak ada yang "setengah jadi").
7. Setelah Apply, ada tombol **Test Endpoint Sekarang** yang nge-hit endpoint barunya lewat HTTP buat mastiin gak error 500 — ini butuh nodemon selesai restart dulu (biasanya beberapa detik), jadi kalau gagal pertama kali tinggal klik "Test Lagi".

Endpoint juga otomatis dicek biar gak dobel-daftar (path + method yang sama, atau import service yang sama ditambahin berkali-kali di file yang sama).

Kalau server jalan via `npm run dev` (nodemon), server auto-restart setelah Apply. Kalau via `npm start`, restart manual (`Ctrl+C` lalu `npm start` lagi).

> Catatan: generator ini pakai pencocokan bracket sederhana buat nyisipin ke `routes/index.js` dan `public/data.js`, jadi hindari karakter `{ } [ ]` literal di kolom deskripsi/nama endpoint.

### Edit endpoint

Klik **Edit** di baris endpoint manapun di dashboard (`/admin.html`), atau buka langsung `/endpoint-edit.html?path=/api/xxx/yyy&method=GET`.

- **Edit Cepat**: ubah nama tampilan, deskripsi, kategori dokumentasi, atau toggle wajib/opsional & deskripsi tiap query parameter — langsung apply, gak ada preview karena cuma nyentuh dokumentasi (`public/data.js` & ringkasan di `routes/index.js`), bukan kode.
- **Regenerate Penuh**: buat ganti method HTTP, nama/jumlah parameter, atau logic service-nya. Form-nya identik dengan halaman Tambah Endpoint (beberapa field diprefill otomatis dari endpoint yang ada), tapi kerjanya beda: HAPUS definisi lama lalu TULIS definisi baru dalam satu operasi atomik (preview dulu, lalu apply). Kalau ada error di tengah proses, semua perubahan — termasuk penghapusan yang lama — di-rollback, project balik ke kondisi semula.

### Hapus endpoint

Dari dashboard (`/admin.html`), klik **Hapus** di baris endpoint yang mau dibuang — muncul modal preview dulu (nunjukin file apa aja yang bakal berubah/dihapus) sebelum konfirmasi. Otomatis buang blok route-nya, entry-nya di `routes/index.js` & `public/data.js`, DAN service file-nya juga — tapi HANYA kalau service itu udah gak dipakai endpoint lain manapun (dicek dulu sebelum dihapus). Rollback otomatis kalau ada yang gagal di tengah jalan.

### Kelola client & API key

Buka `/client-manager.html`. Bikin client baru (nama + tier free/premium/admin) → API key digenerate otomatis, ditampilkan sekali di kotak hijau (tapi tetap bisa dilihat lagi kapan aja lewat tombol "lihat" di tabel — bukan cuma sekali seperti password). Bisa ganti nama/tier atau cabut key kapan aja; perubahan langsung aktif tanpa perlu restart server (`clients.json` dibaca ulang tiap request). Ini juga bisa dikerjakan lewat CLI: `npm run create-key -- "nama" premium`.

## Struktur folder

```
server.js                  # entry point
src/
  app.js                   # setup express, middleware, session/passport, error handler
  config/                  # konfigurasi env, clients.json (API key & tier), passport.js (strategi OAuth)
  middleware/               # error handler, 404 handler, adminAuth, identifyClient, tierRateLimit, requireDocsAuth
  utils/                    # helper response, asyncHandler, scaffold (parser+generator), clients (CRUD API key)
  services/                 # logic scraping/API tiap platform (1 file = 1 sumber)
  routes/                   # route express (admin.routes.js — scaffold dll, auth.routes.js — login Google/GitHub)
public/
  features.html             # landing page publik — jelasin fitur
  signin.html                # login Google/GitHub (buka Docs)
  index.html                # dokumentasi & playground API (butuh login)
  login.html                 # login admin (masukin ADMIN_API_KEY)
  admin.html                # dashboard admin (ringkasan + tabel endpoint)
  endpoint-add.html          # tambah/generate endpoint
  endpoint-edit.html         # edit endpoint (cepat / regenerate penuh)
  client-manager.html        # manage API key & tier
  admin-ops.html             # ops: health check, riwayat/undo, usage, cache, log, backup
  shared.css                 # design tokens & komponen bersama halaman admin
  admin-shared.js            # auth key, fetch wrapper, nav bar, diff-viewer bersama
  endpoint-form.js           # logic form definisi endpoint (dipakai add & edit)
```

## Endpoint admin (`/api/admin/*`, butuh header `x-admin-key`)

| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/admin/whoami` | cek admin key valid (dipakai `/login.html`) |
| GET | `/api/admin/meta` | daftar kategori & route file (buat dropdown) |
| GET | `/api/admin/endpoints` | daftar semua endpoint (buat dashboard) |
| GET | `/api/admin/endpoints/detail?path=&method=` | detail 1 endpoint (buat prefill form edit) |
| POST | `/api/admin/analyze` | parse class code → daftar method & parameter |
| POST | `/api/admin/preview` / `/apply` | preview & tulis endpoint baru |
| POST | `/api/admin/edit/preview` / `/edit/apply` | ganti endpoint (hapus lama + tulis baru, atomik) |
| POST | `/api/admin/endpoints/quick-edit` | ubah nama/deskripsi/kategori/wajib-opsional param (gak nyentuh kode) |
| POST | `/api/admin/delete/preview` / `/delete/apply` | preview & hapus endpoint |
| POST | `/api/admin/verify` | test endpoint yang baru dibuat lewat HTTP |
| POST | `/api/admin/batch/preview` / `/batch/apply` | buat BANYAK endpoint sekaligus (1 per method) dari 1 class |
| GET/POST/DELETE | `/api/admin/history` (+`/rollback`, `/:id`) | riwayat scaffold + undo (rollback ke snapshot sebelum apply) |
| GET | `/api/admin/usage?days=` | analytics pemakaian per client & per endpoint |
| GET/POST | `/api/admin/cache` (+`/clear`) | kelola rule cache per endpoint (TTL detik) |
| GET | `/api/admin/logs?lines=&filter=` | tail access log (data/access.log) |
| GET/POST/DELETE | `/api/admin/health-tests` | simpan/hapus test params (+ `assertFields`) per endpoint buat health check |
| POST | `/api/admin/health/run` | hit semua endpoint terdaftar, laporan ok/degraded/fail |
| GET | `/api/admin/openapi.json` | ekspor OpenAPI 3.0 (import ke Postman/Swagger UI) |
| GET | `/api/admin/backup` | download bundle backup (clients, config runtime, kode hasil scaffold) |
| POST | `/api/admin/backup/restore` | restore bundle backup (kondisi sebelum restore masuk riwayat/undo) |
| GET/POST/PATCH/DELETE | `/api/admin/clients` (+`/:apiKey`) | CRUD client & API key (+ `expiresAt`, `dailyQuota`) |

Halaman **Ops** (`/admin-ops.html`) ngebungkus semuanya: health check,
riwayat+undo, usage analytics, cache, log viewer, ekspor OpenAPI, backup &
restore.

### Health check dengan assertion field

Selain status HTTP, health check bisa mastiin field tertentu beneran ada
(dan non-null) di response sukses — nangkep scraper yang balas 200 tapi
body-nya kosong karena HTML sumbernya berubah. Set lewat tombol **set
params** di tabel health check (halaman Ops): isi kolom "field wajib" pakai
dot-path yang dipisah koma, mis. `result.url, result.title`. Endpoint yang
lolos HTTP tapi gagal assertion ditandai **degraded** beserta daftar field
yang kosong.

### Backup & restore

Config runtime (API key client, rule cache, test params health check) dan
kode endpoint hasil scaffold **tidak** ada di git. Di hosting dengan
filesystem ephemeral (mis. Railway tanpa volume), semua itu hilang tiap
redeploy. Tombol **Download Backup** di halaman Ops ngebungkus semuanya jadi
1 file JSON; setelah redeploy tinggal **Restore dari File** — kondisi
sebelum restore ikut kecatat di riwayat, jadi bisa di-undo kalau salah
bundle.

### Persistensi permanen: pasang volume (recommended buat production)

Backup manual di atas itu jaring pengaman — solusi bener-nya **volume**,
biar gak ada yang hilang sama sekali tiap redeploy:

1. **Railway**: buka service → tab **Volumes** → Add Volume, mount path
   misal `/data`. (Render: **Disks**; VPS: folder mana pun di luar folder
   deploy.)
2. Set 2 env var:
   ```bash
   DATA_DIR=/data              # semua file runtime: usage.json, access.log,
                               # history/, sessions/, cache-config.json, ...
   CLIENTS_PATH=/data/clients.json  # SEMUA API key konsumen — paling penting:
                               # tanpa ini, tiap redeploy semua key user
                               # hangus & mereka dapet key baru
   ```
3. Redeploy. Migrasi awal: download backup dari halaman Ops sebelum ganti
   env, restore setelahnya (atau salin manual `data/` + `clients.json` lama
   ke volume).

`SESSION_STORE_PATH` juga otomatis ikut `DATA_DIR` (`/data/sessions`) kalau
gak di-set eksplisit — login orang gak ke-logout tiap deploy lagi.

## Endpoint auth (`/auth/*`, login Docs)

| Method | Path | Fungsi |
|---|---|---|
| GET | `/auth/google` | mulai login Google (redirect ke consent screen Google) |
| GET | `/auth/google/callback` | callback Google, bikin session lalu redirect ke Docs |
| GET | `/auth/github` | mulai login GitHub |
| GET | `/auth/github/callback` | callback GitHub, bikin session lalu redirect ke Docs |
| GET | `/auth/logout` | hapus session, redirect ke `/features.html` |
| GET | `/auth/me` | JSON `{ user }` — profil yang lagi login, atau `null` |

## Daftar endpoint (ringkas)

| Kategori | Path | Keterangan |
|---|---|---|
| YouTube | `/api/youtube/search` | Cari video YouTube berdasarkan kata kunci |
| Anime | `/api/anime/search` | Cari anime (scrape Nimegami) berdasarkan kata kunci |

Daftar di atas bisa berubah kapan saja karena endpoint ditambah/dihapus lewat
panel admin (yang otomatis meng-update `routes/index.js` + `public/data.js`,
bukan README ini) — sumber kebenaran terbarunya response `GET /api/endpoints`.
Detail parameter lengkap juga ada di sana.

## Catatan penting

- Endpoint scraper (YouTube Search, Anime Search) mengambil data dari halaman
  yang **tidak resmi/tidak didokumentasikan**. Artinya sewaktu-waktu bisa
  berhenti berfungsi kalau situsnya berubah struktur atau memblokir — ini
  wajar untuk jenis endpoint seperti ini, bukan bug di kode. Pakai health
  check + assertion field di halaman Ops buat ketahuan lebih cepat.
- Ada rate limiter bawaan (default 60 request/menit per IP), bisa diatur lewat
  `.env` (`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`).

// Data endpoint diambil langsung dari source code backend (src/routes/*.js)
// accent = warna LED/aksen kategori di patch panel & sidebar

const ACCENTS = ["#FF8A65","#C08CFF","#4FD1E0","#6FE0A6","#FFD166","#FF7AA8","#7FB8FF","#F2A65A","#88E0D0","#E08AFF","#9CE07A","#FFB454","#7AA8FF","#FF9E7A","#5FE0C0"];

const CATEGORIES = [
  {
    id: "akun", tag: "ME", label: "Akun & Limit",
    desc: "Cek tier & sisa kuota API key kamu sendiri — gak perlu ngetik header manual lewat curl/Postman, tinggal isi field di bawah terus klik Kirim.",
    endpoints: [
      {
        name: "Cek Limit / Tier Saya", method: "GET", path: "/api/me",
        desc: "Lihat tier API key kamu (free/premium/admin) dan sisa kuota per jam (dari header response RateLimit-*). Endpoint ini satu-satunya yang boleh diakses tanpa key — key-nya sendiri otomatis kepasang dari akun login kamu, atau isi manual di field bawah.",
        headers: [
          { name: "x-api-key", required: false, desc: "API key kamu. Kosongin = otomatis pakai key akun login (lihat kartu API KEY KAMU di atas), atau tanpa key sama sekali buat lihat perlakuan anonim." }
        ]
      }
    ]
  },
  {
    id: "youtube", tag: "YT", label: "YouTube",
    desc: "Cari video YouTube berdasarkan kata kunci.",
    endpoints: [
      {
        name: "YouTube Search", method: "ALL", path: "/api/youtube/search",
        desc: "Cari video YouTube berdasarkan kata kunci, tanpa proses convert. Wajib API key (header x-api-key atau ?apikey= di URL) — di playground ini otomatis kepasang dari akun login kamu.",
        query: [
          { name: "query", required: true, desc: "Kata kunci pencarian" },
          { name: "format", required: false, desc: "Isi 'image' buat dapet hasilnya sebagai gambar PNG ala code editor (biar gak liat JSON mentah)" }
        ]
      }
    ]
  },
  {
    id: "animeapi", tag: "ANI", label: "Anime",
    desc: "ANIMEAPI🗿",
    endpoints: [
      {
        name: "Search ANIME", method: "ALL", path: "/api/anime/search",
        desc: "Ambil link anime. Wajib API key (header x-api-key atau ?apikey= di URL) — di playground ini otomatis kepasang dari akun login kamu.",
        query: [
          { name: "query", required: true, desc: "" },
          { name: "format", required: false, desc: "Isi 'image' buat dapet hasilnya sebagai gambar PNG ala code editor" }
        ]
      }
    ]
  },
  {
    id: "canvas", tag: "CVS", label: "Canvas",
    desc: "Generator gambar — respons berupa PNG, bukan JSON.",
    endpoints: [
      {
        name: "JSON Profile Card", method: "ALL", path: "/api/canvas/jsoncard",
        desc: "Bikin kartu profil bergaya JSON di code editor (PNG). Semua query param bebas jadi field kartu (maks 8). Wajib API key — di playground ini otomatis kepasang dari akun login kamu.",
        note: "Response-nya gambar PNG — buka URL-nya langsung di tab browser buat lihat hasilnya.",
        query: [
          { name: "name", required: false, desc: "Contoh field — ganti/tambah bebas (title, email, link, dst.)" },
          { name: "title", required: false, desc: "Contoh field lain" },
          { name: "email", required: false, desc: "Contoh field lain" },
          { name: "link", required: false, desc: "Contoh field lain" },
          { name: "filename", required: false, desc: "Judul di title bar jendela (default: aboutme.json)" }
        ]
      },
      {
        name: "Welcome Card", method: "ALL", path: "/api/canvas/welcome",
        desc: "Kartu welcome: avatar lingkaran berinisial + nama + subtitle. Cocok buat bot Discord/WhatsApp nyambut member baru. Wajib API key — di playground ini otomatis kepasang dari akun login kamu.",
        note: "Response-nya gambar PNG — buka URL-nya langsung di tab browser buat lihat hasilnya.",
        query: [
          { name: "name", required: true, desc: "Nama yang disambut (juga nentuin warna avatar & inisial)" },
          { name: "subtitle", required: false, desc: "Teks kecil di bawah nama (default: Selamat datang!)" }
        ]
      }
    ]
  }
];

CATEGORIES.forEach((cat, i) => { cat.accent = ACCENTS[i % ACCENTS.length]; });

import "dotenv/config"; // wajib sebelum baca process.env.CLIENTS_PATH di bawah
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { writeFileAtomic } from "./atomicWrite.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// File paling berharga di project ini: SEMUA API key konsumen (termasuk
// hasil auto-provision login Google/GitHub). Default: src/config/clients.json
// (perilaku lama). Di hosting ber-filesystem ephemeral (Railway/Render),
// set CLIENTS_PATH ke file di volume (mis. /data/clients.json) — kalau
// nggak, tiap redeploy SEMUA key user hangus dan mereka dapet key baru
// (yang lama 401 semua).
export const CLIENTS_PATH = process.env.CLIENTS_PATH
  ? path.resolve(process.env.CLIENTS_PATH)
  : path.join(__dirname, "..", "config", "clients.json");

export const VALID_TIERS = ["free", "premium", "admin"];

/**
 * Baca clients.json — { "<apiKey>": { name, tier, createdAt? } }.
 * Dibaca ulang tiap kali dipanggil (bukan di-cache), biar nambah/ubah/
 * cabut client via panel admin ATAU lewat CLI script langsung kepakai
 * tanpa restart server.
 */
export function loadClients() {
  try {
    const raw = fs.readFileSync(CLIENTS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveClients(clients) {
  // Atomic (tmp + rename): kalau proses mati di tengah nulis, file lama
  // tetap utuh — clients.json gak boleh korup, isinya gak bisa direkonstruksi.
  writeFileAtomic(CLIENTS_PATH, JSON.stringify(clients, null, 2) + "\n");
}

/**
 * Daftar client dalam bentuk array (buat ditampilkan di client-manager.html).
 * apiKey ikut dibalikin utuh (bukan masked) karena endpoint ini sendiri
 * sudah di belakang adminAuth — admin memang butuh key-nya buat dikasih
 * ke client.
 */
export function listClients() {
  const clients = loadClients();
  return Object.entries(clients)
    .map(([apiKey, entry]) => ({
      apiKey,
      name: entry?.name || "(tanpa nama)",
      tier: VALID_TIERS.includes(entry?.tier) ? entry.tier : "free",
      createdAt: entry?.createdAt || null,
      // Opsional: batas masa berlaku key (ISO date) & kuota harian.
      // null/undefined = tanpa batas (perilaku lama, backward-compat).
      expiresAt: entry?.expiresAt || null,
      dailyQuota: Number(entry?.dailyQuota) > 0 ? Number(entry.dailyQuota) : null,
      // Key hasil auto-provision login docs (Google/GitHub) bawa asal-usulnya
      // — null = key manual buatan admin (perilaku lama).
      provider: entry?.provider || null,
      email: entry?.email || null,
      expired: isExpired(entry),
    }))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

/**
 * Key dianggap expired kalau entry punya expiresAt dan waktunya sudah
 * lewat. expiresAt boleh "YYYY-MM-DD" (dianggap habis di AKHIR hari itu
 * UTC) atau ISO datetime penuh.
 */
export function isExpired(entry, now = new Date()) {
  if (!entry?.expiresAt) return false;
  const raw = String(entry.expiresAt);
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59.999Z` : raw;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false; // format aneh -> jangan matiin key orang
  return now.getTime() > t;
}

/**
 * Normalisasi & validasi field opsional expiresAt / dailyQuota dari
 * form admin. String kosong = hapus batasnya (null).
 */
function cleanLimitFields({ expiresAt, dailyQuota }, target) {
  if (expiresAt !== undefined) {
    const raw = String(expiresAt || "").trim();
    if (!raw) {
      target.expiresAt = null;
    } else {
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59.999Z` : raw;
      if (Number.isNaN(Date.parse(iso)))
        throw new Error(`Format expiresAt tidak valid: '${raw}'. Pakai YYYY-MM-DD.`);
      target.expiresAt = raw;
    }
  }
  if (dailyQuota !== undefined) {
    const raw = String(dailyQuota ?? "").trim();
    if (!raw) {
      target.dailyQuota = null;
    } else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0)
        throw new Error(`dailyQuota harus bilangan bulat > 0 (atau kosong buat tanpa batas).`);
      target.dailyQuota = n;
    }
  }
}

export function createClient({ name, tier, expiresAt, dailyQuota }) {
  const cleanName = String(name || "").trim();
  if (!cleanName) throw new Error("Nama client wajib diisi.");
  const cleanTier = String(tier || "free").toLowerCase();
  if (!VALID_TIERS.includes(cleanTier))
    throw new Error(`Tier tidak valid: '${cleanTier}'. Pilihan: ${VALID_TIERS.join(", ")}.`);

  const clients = loadClients();
  const apiKey = crypto.randomBytes(24).toString("hex");
  const entry = { name: cleanName, tier: cleanTier, createdAt: new Date().toISOString() };
  cleanLimitFields({ expiresAt, dailyQuota }, entry);
  clients[apiKey] = entry;
  saveClients(clients);
  return { apiKey, ...entry };
}

export function updateClient(apiKey, { name, tier, expiresAt, dailyQuota }) {
  const clients = loadClients();
  const existing = clients[apiKey];
  if (!existing) throw new Error(`Client dengan key tersebut tidak ditemukan.`);

  if (name !== undefined) {
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("Nama client tidak boleh kosong.");
    existing.name = cleanName;
  }
  if (tier !== undefined) {
    const cleanTier = String(tier || "").toLowerCase();
    if (!VALID_TIERS.includes(cleanTier))
      throw new Error(`Tier tidak valid: '${cleanTier}'. Pilihan: ${VALID_TIERS.join(", ")}.`);
    existing.tier = cleanTier;
  }
  cleanLimitFields({ expiresAt, dailyQuota }, existing);
  clients[apiKey] = existing;
  saveClients(clients);
  return { apiKey, ...existing };
}

export function deleteClient(apiKey) {
  const clients = loadClients();
  if (!clients[apiKey]) throw new Error(`Client dengan key tersebut tidak ditemukan.`);
  delete clients[apiKey];
  saveClients(clients);
}

/**
 * Cari key PRIMARY milik akun OAuth tertentu. providerId dibandingkan
 * sebagai string (profile.id Google itu string angka panjang, GitHub
 * number — jangan sampai beda tipe bikin akun yang sama dianggap belum
 * punya key). Sejak ada multi-key: key TANPA label = primary (key
 * tambahan selalu berlabel, lihat createAdditionalKey) — jangan andalkan
 * urutan objek, rotate key mindahin entry ke akhir.
 */
export function findClientByProvider(provider, providerId) {
  if (!provider || providerId === undefined || providerId === null) return null;
  const mine = Object.entries(loadClients()).filter(
    ([, e]) => e?.provider === provider && String(e?.providerId) === String(providerId)
  );
  if (!mine.length) return null;
  const hit = mine.find(([, e]) => !e.label) || mine[0];
  return { apiKey: hit[0], ...hit[1] };
}

/**
 * Auto-provision API key tier "free" buat akun OAuth (Google/GitHub) yang
 * login ke Docs — SEKALI per akun, idempotent: panggilan berikutnya balikin
 * key yang sama. Dipanggil dari GET /auth/me (bukan callback OAuth) biar
 * session lama yang masih hidup dari sebelum fitur ini ada ikut kebagian.
 *
 * Aman tanpa lock: loadClients() dibaca ulang tepat sebelum write dan
 * seluruh read-check-write sinkron dalam satu event-loop tick (gak ada
 * await di tengah), jadi dua request paralel gak bisa interleave.
 */
export function ensureClientForUser(user) {
  if (!user?.provider || user.id === undefined || user.id === null) return null;
  const existing = findClientByProvider(user.provider, user.id);
  if (existing) {
    // Backfill email buat entry lama (dari sebelum field email disimpan):
    // sekali isi pas login berikutnya, biar admin bisa hubungi pemilik key.
    if (!existing.email && user.email) {
      const clients = loadClients();
      if (clients[existing.apiKey]) {
        clients[existing.apiKey].email = user.email;
        saveClients(clients);
        existing.email = user.email;
      }
    }
    return existing;
  }

  const clients = loadClients();
  const apiKey = crypto.randomBytes(24).toString("hex");
  const entry = {
    name: user.name || user.email || `${user.provider}:${user.id}`,
    tier: "free",
    provider: user.provider,
    providerId: String(user.id),
    email: user.email || null,
    createdAt: new Date().toISOString(),
  };
  clients[apiKey] = entry;
  saveClients(clients);
  return { apiKey, ...entry };
}

/**
 * Naikin tier sebuah key ke "admin" — persist di clients.json, jadi berlaku
 * juga di luar docs (curl/Postman), bukan cuma buat session itu.
 *
 * Dipanggil dari GET /auth/me pas session-nya JUGA punya akses admin
 * (req.session.adminDocs, hasil tukar ADMIN_API_KEY di /auth/admin-session):
 * tanpa ini, dua sistem itu gak nyambung — orang login admin tapi key akun
 * OAuth-nya tetap "free" (kejadian nyata yang bikin bingung). Sticky: sekali
 * naik, gak turun sendiri pas logout — turunin manual lewat client manager.
 */
export function promoteClientToAdmin(apiKey) {
  const clients = loadClients();
  const entry = clients[apiKey];
  if (!entry) return null;
  if (entry.tier === "admin") return { apiKey, ...entry };
  entry.tier = "admin";
  clients[apiKey] = entry;
  saveClients(clients);
  return { apiKey, ...entry };
}

/**
 * Ganti API key sebuah client dengan key acak baru — entry (nama, tier,
 * provider, kuota) pindah utuh, key lama langsung mati. Buat self-service
 * di docs: user yang key-nya bocor bisa rotate sendiri tanpa nunggu admin.
 * Riwayat usage key lama sengaja gak dimigrasi (tercatat per key).
 */
export function regenerateClientKey(apiKey) {
  const clients = loadClients();
  const entry = clients[apiKey];
  if (!entry) return null;
  const newKey = crypto.randomBytes(24).toString("hex");
  delete clients[apiKey];
  clients[newKey] = entry;
  saveClients(clients);
  return { apiKey: newKey, ...entry };
}

/* ------------------------------------------------------------------ */
/* Multiple keys per akun OAuth (self-service, label per key)           */
/* ------------------------------------------------------------------ */

// Batas key per akun — cukup buat "bot-discord, server-prod, dev-laptop"
// tanpa jadi jalur nyepam entry di clients.json.
export const MAX_KEYS_PER_USER = 5;

/**
 * Semua key milik satu akun OAuth, urut pembuatan (key pertama = primary,
 * itu yang dibalikin findClientByProvider & dipakai playground docs).
 */
export function listKeysForUser(provider, providerId) {
  if (!provider || providerId === undefined || providerId === null) return [];
  return Object.entries(loadClients())
    .filter(([, e]) => e?.provider === provider && String(e?.providerId) === String(providerId))
    .map(([apiKey, e]) => ({
      apiKey,
      label: e.label || null,
      tier: e.tier,
      createdAt: e.createdAt || null,
      dailyQuota: Number(e?.dailyQuota) > 0 ? Number(e.dailyQuota) : null,
      expiresAt: e.expiresAt || null,
    }));
}

/**
 * Bikin key TAMBAHAN berlabel buat akun OAuth (mis. "bot-discord",
 * "server-prod") — biar rotate/hapus satu key gak mematikan semua bot.
 * Tier & kuota ngikut key primary (kebijakan per akun, bukan per key).
 * Wajib udah punya key primary (dari ensureClientForUser pas login).
 */
export function createAdditionalKey(user, label) {
  const cleanLabel = String(label || "").trim();
  if (!cleanLabel) throw new Error("Label key wajib diisi (mis. 'bot-discord').");
  if (cleanLabel.length > 40) throw new Error("Label maksimal 40 karakter.");

  const primary = findClientByProvider(user?.provider, user?.id);
  if (!primary) throw new Error("Akun ini belum punya API key.");

  const existing = listKeysForUser(user.provider, user.id);
  if (existing.length >= MAX_KEYS_PER_USER)
    throw new Error(`Maksimal ${MAX_KEYS_PER_USER} key per akun. Hapus salah satu dulu.`);
  if (existing.some((k) => (k.label || "") === cleanLabel))
    throw new Error(`Label '${cleanLabel}' sudah dipakai key lain.`);

  const clients = loadClients();
  const apiKey = crypto.randomBytes(24).toString("hex");
  const entry = {
    name: `${primary.name} · ${cleanLabel}`,
    label: cleanLabel,
    tier: primary.tier,
    provider: primary.provider,
    providerId: String(primary.providerId),
    email: primary.email || null,
    dailyQuota: primary.dailyQuota || null,
    createdAt: new Date().toISOString(),
  };
  clients[apiKey] = entry;
  saveClients(clients);
  return { apiKey, ...entry };
}

/**
 * Hapus salah satu key MILIK SENDIRI. Kepemilikan dicek dari provider +
 * providerId (bukan cuma "key-nya ada") — user gak bisa hapus key orang
 * lain walau tahu key-nya. Key terakhir gak boleh dihapus (playground &
 * kartu API key butuh minimal satu; pakai "ganti key" buat rotate).
 */
export function deleteOwnKey(user, apiKey) {
  const clients = loadClients();
  const entry = clients[apiKey];
  if (!entry || entry.provider !== user?.provider || String(entry.providerId) !== String(user?.id)) {
    throw new Error("Key tidak ditemukan di akun ini.");
  }
  if (listKeysForUser(user.provider, user.id).length <= 1) {
    throw new Error("Key terakhir tidak bisa dihapus — pakai 'ganti key' buat rotate.");
  }
  delete clients[apiKey];
  saveClients(clients);
}

export default {
  loadClients,
  saveClients,
  listClients,
  createClient,
  updateClient,
  deleteClient,
  findClientByProvider,
  ensureClientForUser,
  promoteClientToAdmin,
  regenerateClientKey,
  listKeysForUser,
  createAdditionalKey,
  deleteOwnKey,
  isExpired,
  VALID_TIERS,
  MAX_KEYS_PER_USER,
};

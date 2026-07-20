import { createCanvas } from "@napi-rs/canvas";
import "./jsoncard.service.js"; // register font JetBrains (module side-effect, sekali per proses)

// Palet gelap senada jsoncard biar satu keluarga visual.
const THEME = {
  bgTop: "#1a1f2e",
  bgBottom: "#0f1420",
  accent: "#98C379",
  text: "#FFFFFF",
  muted: "#8b98b8"
};

// Warna avatar dipilih dari hash nama — konsisten: nama sama warna sama.
// Sengaja TANPA #98C379 (warna aksen ring): kalau ikut, nama yang kebetulan
// kena warna itu bikin ring-nya ketelan (avatar & ring jadi satu blob).
const AVATAR_COLORS = ["#E06C75", "#61AFEF", "#C678DD", "#E5C07B", "#56B6C2"];

export const MAX_NAME_LEN = 25;
export const MAX_SUBTITLE_LEN = 50;

function pickColor(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** Inisial buat avatar: maksimal 2 huruf dari kata pertama & terakhir. */
function initials(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = [...words[0]][0];
  const last = words.length > 1 ? [...words[words.length - 1]][0] : "";
  return (first + last).toUpperCase();
}

/**
 * Render kartu welcome: avatar lingkaran berinisial + nama + subtitle.
 * Cocok buat bot Discord/WhatsApp nyambut member baru.
 *
 * @param {string} name — nama yang disambut
 * @param {string} [subtitle="Selamat datang!"] — teks kecil di bawah nama
 * @returns {Promise<Buffer>} PNG buffer
 */
export async function renderWelcomeCard(name, subtitle = "Selamat datang!") {
  const cleanName = String(name).slice(0, MAX_NAME_LEN);
  const cleanSub = String(subtitle).slice(0, MAX_SUBTITLE_LEN);

  const width = 1000;
  const height = 400;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Latar gradasi + garis aksen tipis di tepi bawah
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, THEME.bgTop);
  grad.addColorStop(1, THEME.bgBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = THEME.accent;
  ctx.fillRect(0, height - 6, width, 6);

  // Avatar lingkaran: ring aksen + isi warna hash + inisial
  const cx = width / 2;
  const avatarY = 140;
  const r = 75;
  ctx.beginPath();
  ctx.arc(cx, avatarY, r + 6, 0, Math.PI * 2);
  ctx.fillStyle = THEME.accent;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, avatarY, r, 0, Math.PI * 2);
  ctx.fillStyle = pickColor(cleanName);
  ctx.fill();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = THEME.text;
  ctx.font = 'bold 64px "JetBrains"';
  ctx.fillText(initials(cleanName), cx, avatarY + 4);

  // Nama + subtitle
  ctx.font = 'bold 44px "JetBrains"';
  ctx.fillText(cleanName, cx, 275);
  ctx.font = '24px "JetBrains"';
  ctx.fillStyle = THEME.muted;
  ctx.fillText(cleanSub, cx, 330);

  return canvas.encode("png");
}

export default renderWelcomeCard;

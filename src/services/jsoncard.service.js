import path from "path";
import { fileURLToPath } from "url";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(__dirname, "..", "assets", "fonts");

// Daftarkan sekali di module load — GlobalFonts itu global process-wide,
// registrasi ulang tiap request cuma buang waktu.
GlobalFonts.registerFromPath(path.join(FONT_DIR, "JetBrainsMono-Regular.ttf"), "JetBrains");
GlobalFonts.registerFromPath(path.join(FONT_DIR, "JetBrainsMono-Bold.ttf"), "JetBrains");

// Palet ala editor kode (One Dark-ish) — key merah, value hijau, simbol putih.
const THEME = {
  pageBg: "#f5f2ea",
  cardBg: "#202433",
  titleText: "#cfcfcf",
  key: "#E06C75",
  value: "#98C379",
  symbol: "#FFFFFF",
  trafficLights: ["#ff5f57", "#febc2e", "#28c840"]
};

const WIDTH = 1200;
const CARD_X = 120;
const CARD_W = WIDTH - CARD_X * 2;
const RADIUS = 35;
const ROW_HEIGHT = 60;
const FONT_ROW = 'bold 40px "JetBrains"';
const FONT_TITLE = '34px "JetBrains"';

// Batas biar kanvas gak meledak dimensinya / teks keluar kartu.
export const MAX_FIELDS = 8;
export const MAX_KEY_LEN = 20;
export const MAX_VALUE_LEN = 40;

/** Escape karakter yang bikin string JSON di gambar jadi bohong (kutip & backslash). */
function esc(str) {
  return String(str).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Satu baris `"key": "value",` — posisi titik dua & value dihitung dari
 * lebar teks asli (measureText), bukan koordinat hardcode, jadi rapi
 * berapapun panjang key-nya. `colonX` disamakan antar baris (dihitung dari
 * key terpanjang) biar kolomnya sejajar kayak di code editor beneran.
 */
function drawRow(ctx, key, value, y, colonX, last) {
  const keyX = CARD_X + 90;
  ctx.fillStyle = THEME.key;
  ctx.fillText(`"${key}"`, keyX, y);
  ctx.fillStyle = THEME.symbol;
  ctx.fillText(":", colonX, y);
  const valueX = colonX + ctx.measureText(": ").width;
  ctx.fillStyle = THEME.value;
  const text = `"${value}"`;
  ctx.fillText(text, valueX, y);
  if (!last) {
    ctx.fillStyle = THEME.symbol;
    ctx.fillText(",", valueX + ctx.measureText(text).width + 5, y);
  }
}

/**
 * Render kartu "aboutme.json": objek key-value digambar sebagai JSON
 * berwarna di dalam jendela editor. Tinggi kanvas ngikutin jumlah field.
 *
 * @param {Record<string, string>} fields — pasangan key-value yang mau ditampilkan
 * @param {string} [title="aboutme.json"] — judul di title bar jendela
 * @returns {Promise<Buffer>} PNG buffer
 */
export async function renderJsonCard(fields, title = "aboutme.json") {
  const entries = Object.entries(fields)
    .slice(0, MAX_FIELDS)
    .map(([k, v]) => [esc(String(k).slice(0, MAX_KEY_LEN)), esc(String(v).slice(0, MAX_VALUE_LEN))]);

  const cardH = 230 + entries.length * ROW_HEIGHT;
  const height = cardH + 240;
  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = THEME.pageBg;
  ctx.fillRect(0, 0, WIDTH, height);

  // Kartu dengan drop shadow
  const cardY = 120;
  ctx.shadowColor = "rgba(0,0,0,.25)";
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 10;
  roundedRect(ctx, CARD_X, cardY, CARD_W, cardH, RADIUS);
  ctx.fillStyle = THEME.cardBg;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Traffic light macOS + judul file di title bar
  THEME.trafficLights.forEach((c, i) => {
    ctx.beginPath();
    ctx.arc(CARD_X + 80 + i * 45, cardY + 50, 14, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
  });
  ctx.font = FONT_TITLE;
  ctx.fillStyle = THEME.titleText;
  ctx.textAlign = "center";
  ctx.fillText(String(title).slice(0, 30), WIDTH / 2, cardY + 60);
  ctx.textAlign = "left";

  // Isi JSON — kolom ":" disejajarkan ke key terpanjang
  ctx.font = FONT_ROW;
  const keyX = CARD_X + 90;
  const colonX =
    keyX + Math.max(...entries.map(([k]) => ctx.measureText(`"${k}"`).width)) + 15;

  ctx.fillStyle = THEME.symbol;
  ctx.fillText("{", CARD_X + 40, cardY + 125);
  entries.forEach(([k, v], i) => {
    drawRow(ctx, k, v, cardY + 165 + i * ROW_HEIGHT, colonX, i === entries.length - 1);
  });
  ctx.fillStyle = THEME.symbol;
  ctx.fillText("}", CARD_X + 45, cardY + 165 + entries.length * ROW_HEIGHT);

  return canvas.encode("png");
}

export default renderJsonCard;

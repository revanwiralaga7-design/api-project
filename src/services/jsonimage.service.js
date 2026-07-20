import { createCanvas } from "@napi-rs/canvas";
import "./jsoncard.service.js"; // register font JetBrains (module side-effect, sekali per proses)

// Palet One Dark-ish, senada jsoncard.service.js.
const THEME = {
  pageBg: "#f5f2ea",
  cardBg: "#202433",
  gutterText: "#5b6378",
  titleText: "#cfcfcf",
  key: "#E06C75",
  string: "#98C379",
  number: "#D19A66",
  bool: "#C678DD",
  nullish: "#7f8ca3",
  symbol: "#ABB2BF",
  trafficLights: ["#ff5f57", "#febc2e", "#28c840"],
};

const FONT_SIZE = 26;
const LINE_HEIGHT = 38;
const FONT_CODE = `${FONT_SIZE}px "JetBrains"`;
const FONT_TITLE = '26px "JetBrains"';

// Pembatas biar respons gede (search 50 hasil) gak jadi gambar raksasa:
// baris dipotong + dikasih penanda "… N baris lagi".
export const MAX_LINES = 80;
export const MAX_LINE_CHARS = 100;

/**
 * Pecah satu baris pretty-printed JSON jadi token berwarna.
 * Regex-nya per baris (bukan parser beneran) — cukup karena input SELALU
 * hasil JSON.stringify(data, null, 2), bukan JSON tulisan tangan.
 */
function tokenizeLine(line) {
  const tokens = [];
  const re =
    /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\bnull\b|([{}[\],:])/g;
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    if (m.index > last) tokens.push({ text: line.slice(last, m.index), color: THEME.symbol });
    if (m[1] !== undefined) {
      // String — kalau diikuti ":" berarti key.
      if (m[2] !== undefined) {
        tokens.push({ text: m[1], color: THEME.key });
        tokens.push({ text: m[2], color: THEME.symbol });
      } else {
        tokens.push({ text: m[1], color: THEME.string });
      }
    } else if (m[3] !== undefined) {
      tokens.push({ text: m[3], color: THEME.number });
    } else if (m[4] !== undefined) {
      tokens.push({ text: m[4], color: THEME.bool });
    } else if (m[5] !== undefined) {
      tokens.push({ text: m[5], color: THEME.symbol });
    } else {
      tokens.push({ text: m[0], color: THEME.nullish }); // null
    }
    last = re.lastIndex;
  }
  if (last < line.length) tokens.push({ text: line.slice(last), color: THEME.symbol });
  return tokens;
}

/**
 * Render nilai JSON APA PUN (object/array/nested — respons endpoint beneran)
 * jadi gambar jendela code editor: syntax highlight + nomor baris.
 * Ini beda dari renderJsonCard (kartu profil flat key-value 8 baris) —
 * yang ini buat ?format=image di endpoint data, ukuran ngikutin isi.
 *
 * @param {*} data — nilai apa pun yang bisa di-JSON.stringify
 * @param {string} [title="response.json"] — judul title bar
 * @returns {Promise<Buffer>} PNG buffer
 */
export async function renderJsonImage(data, title = "response.json") {
  let allLines = JSON.stringify(data, null, 2).split("\n");
  const dropped = Math.max(0, allLines.length - MAX_LINES);
  if (dropped) allLines = allLines.slice(0, MAX_LINES);
  const lines = allLines.map((l) => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS - 1) + "…" : l));
  if (dropped) lines.push(`… ${dropped} baris lagi (kepotong)`);

  // Ukur dulu pakai kanvas kecil biar lebar kartu pas sama baris terpanjang.
  const measurer = createCanvas(1, 1).getContext("2d");
  measurer.font = FONT_CODE;
  const maxLineW = Math.max(...lines.map((l) => measurer.measureText(l).width));

  const gutterW = 34 + measurer.measureText(String(lines.length)).width;
  const pad = 28;
  const cardW = Math.max(560, Math.ceil(gutterW + pad + maxLineW + pad));
  const headH = 78;
  const cardH = headH + lines.length * LINE_HEIGHT + pad;
  const margin = 48;
  const width = cardW + margin * 2;
  const height = cardH + margin * 2;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = THEME.pageBg;
  ctx.fillRect(0, 0, width, height);

  // Kartu + shadow
  ctx.shadowColor = "rgba(0,0,0,.25)";
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 8;
  ctx.beginPath();
  ctx.roundRect(margin, margin, cardW, cardH, 22);
  ctx.fillStyle = THEME.cardBg;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Traffic light + judul
  THEME.trafficLights.forEach((c, i) => {
    ctx.beginPath();
    ctx.arc(margin + 42 + i * 34, margin + 40, 10, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
  });
  ctx.font = FONT_TITLE;
  ctx.fillStyle = THEME.titleText;
  ctx.textAlign = "center";
  ctx.fillText(String(title).slice(0, 40), margin + cardW / 2, margin + 48);
  ctx.textAlign = "left";

  // Baris kode + nomor baris
  ctx.font = FONT_CODE;
  lines.forEach((line, i) => {
    const y = margin + headH + i * LINE_HEIGHT + FONT_SIZE;
    ctx.fillStyle = THEME.gutterText;
    ctx.textAlign = "right";
    ctx.fillText(String(i + 1), margin + gutterW - 14, y);
    ctx.textAlign = "left";
    let x = margin + gutterW + 8;
    for (const tok of tokenizeLine(line)) {
      ctx.fillStyle = tok.color;
      ctx.fillText(tok.text, x, y);
      x += ctx.measureText(tok.text).width;
    }
  });

  return canvas.encode("png");
}

export default renderJsonImage;

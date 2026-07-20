import fs from "fs";
import path from "path";

/**
 * Tulis file secara ATOMIC: isi ditulis ke file sementara di folder yang
 * sama, lalu di-rename ke path tujuan. rename() di filesystem yang sama
 * itu atomic — pembaca cuma bisa lihat isi lama utuh atau isi baru utuh,
 * gak pernah setengah jadi.
 *
 * Kenapa perlu: project ini SERING restart by design (fitur Apply exit via
 * process.exit(0)). Kalau proses mati persis di tengah fs.writeFileSync
 * biasa, file-nya korup — fatal buat clients.json (semua API key konsumen)
 * yang gak bisa direkonstruksi dari mana-mana.
 *
 * File tmp dikasih pid + counter biar dua proses/panggilan beruntun gak
 * saling timpa tmp-nya. Kalau rename gagal, tmp-nya dibersihin lagi.
 */
let seq = 0;

export function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${seq++}.tmp`;
  fs.writeFileSync(tmpPath, content, "utf8");
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* tmp udah gak ada — biarin */
    }
    throw err;
  }
}

export default writeFileAtomic;

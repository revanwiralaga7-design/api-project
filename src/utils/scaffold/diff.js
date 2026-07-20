// Diff sederhana (preview ala git diff) + snapshot/rollback file.
// Dipisah dari scaffold.js monolitik — logikanya tidak berubah.
import fs from "fs";

/* ------------------------------------------------------------------ */
/* 9. Diff sederhana (buat preview ala git diff)                       */
/* ------------------------------------------------------------------ */

/**
 * Diff antar baris (LCS klasik). Return array {type: "same"|"add"|"remove", line}.
 * Cukup buat file-file di project ini (ratusan baris), gak perlu
 * library eksternal.
 */
export function diffLines(oldStr, newStr) {
  const a = String(oldStr ?? "").split("\n");
  const b = String(newStr ?? "").split("\n");
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const result = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: "same", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: "remove", line: a[i] });
      i++;
    } else {
      result.push({ type: "add", line: b[j] });
      j++;
    }
  }
  while (i < n) {
    result.push({ type: "remove", line: a[i] });
    i++;
  }
  while (j < m) {
    result.push({ type: "add", line: b[j] });
    j++;
  }
  return result;
}

/**
 * Padatin hasil diffLines ala `git diff`: baris "same" yang panjang di
 * tengah-tengah diringkas jadi 1 penanda "N baris tidak berubah",
 * cuma nyisain `context` baris di sekitar tiap perubahan.
 */
export function compactDiff(diffArr, context = 2) {
  const n = diffArr.length;
  const keep = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (diffArr[i].type !== "same") {
      for (let k = Math.max(0, i - context); k <= Math.min(n - 1, i + context); k++) keep[k] = true;
    }
  }
  const out = [];
  let i = 0;
  while (i < n) {
    if (keep[i]) {
      out.push(diffArr[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < n && !keep[j]) j++;
    out.push({ type: "context", count: j - i });
    i = j;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 8. Snapshot & rollback (dipakai /admin/apply biar aman kalau ada    */
/*    1 file gagal ditulis di tengah proses)                           */
/* ------------------------------------------------------------------ */

/**
 * Ambil "potret" isi file-file yang BAKAL disentuh (ditulis/dihapus)
 * SEBELUM proses apply mulai. Untuk file yang belum ada, dicatat
 * sebagai `null` (artinya: kalau di-rollback, file itu harus DIHAPUS
 * lagi, bukan dikembalikan isinya).
 */
export function snapshotFiles(paths) {
  const snapshot = {};
  for (const p of paths) {
    snapshot[p] = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  }
  return snapshot;
}

/**
 * Kembalikan semua file persis seperti isi snapshot-nya. File yang
 * snapshot-nya `null` (belum ada sebelum apply) akan DIHAPUS lagi.
 * Dipanggil kalau ada error di tengah proses tulis-menulis apply,
 * supaya tidak ada perubahan yang "setengah jadi".
 */
export function restoreFromSnapshot(snapshot) {
  for (const [p, original] of Object.entries(snapshot)) {
    if (original === null) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } else {
      fs.writeFileSync(p, original, "utf8");
    }
  }
}

/**
 * Jalanin `fn()` (serangkaian fs.writeFileSync/unlinkSync ke `paths`)
 * dengan snapshot+rollback otomatis: kalau `fn` lempar error, semua
 * file di `paths` dikembalikan seperti semula sebelum error itu
 * dilempar ulang ke pemanggil.
 */
export function withRollback(paths, fn) {
  const snapshot = snapshotFiles(paths);
  try {
    return fn();
  } catch (err) {
    restoreFromSnapshot(snapshot);
    throw err;
  }
}

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { snapshotFiles, restoreFromSnapshot, withRollback } from "../src/utils/scaffold.js";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "febry-rollback-test-"));
}

describe("snapshotFiles + restoreFromSnapshot", () => {
  test("captures existing file content", () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "a.txt");
    fs.writeFileSync(filePath, "isi awal");

    const snap = snapshotFiles([filePath]);
    assert.equal(snap[filePath], "isi awal");
  });

  test("captures null for a file that doesn't exist yet", () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "belum-ada.txt");

    const snap = snapshotFiles([filePath]);
    assert.equal(snap[filePath], null);
  });

  test("restores modified file back to its original content", () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "a.txt");
    fs.writeFileSync(filePath, "isi awal");

    const snap = snapshotFiles([filePath]);
    fs.writeFileSync(filePath, "isi rusak");
    restoreFromSnapshot(snap);

    assert.equal(fs.readFileSync(filePath, "utf8"), "isi awal");
  });

  test("restore deletes a file that didn't exist before the snapshot", () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "baru.txt");

    const snap = snapshotFiles([filePath]);
    fs.writeFileSync(filePath, "file baru yang harusnya dihapus lagi");
    restoreFromSnapshot(snap);

    assert.equal(fs.existsSync(filePath), false);
  });
});

describe("withRollback", () => {
  test("keeps all writes when fn() succeeds", () => {
    const dir = makeTmpDir();
    const fileA = path.join(dir, "a.txt");
    const fileB = path.join(dir, "b.txt");
    fs.writeFileSync(fileA, "a lama");

    withRollback([fileA, fileB], () => {
      fs.writeFileSync(fileA, "a baru");
      fs.writeFileSync(fileB, "b baru");
    });

    assert.equal(fs.readFileSync(fileA, "utf8"), "a baru");
    assert.equal(fs.readFileSync(fileB, "utf8"), "b baru");
  });

  test("rolls back ALL touched files when fn() throws partway through", () => {
    const dir = makeTmpDir();
    const fileA = path.join(dir, "a.txt");
    const fileB = path.join(dir, "b.txt");
    fs.writeFileSync(fileA, "a lama");
    fs.writeFileSync(fileB, "b lama");

    assert.throws(() => {
      withRollback([fileA, fileB], () => {
        fs.writeFileSync(fileA, "a baru"); // ini berhasil ditulis...
        throw new Error("simulasi gagal di tengah proses apply");
        // eslint-disable-next-line no-unreachable
        fs.writeFileSync(fileB, "b baru"); // ...ini gak pernah kejalan
      });
    }, /simulasi gagal/);

    // fileA yang sempat ke-tulis harus balik ke isi lama, bukan "setengah jadi"
    assert.equal(fs.readFileSync(fileA, "utf8"), "a lama");
    assert.equal(fs.readFileSync(fileB, "utf8"), "b lama");
  });

  test("rolls back and removes a file that was newly created before the error", () => {
    const dir = makeTmpDir();
    const existing = path.join(dir, "existing.txt");
    const newFile = path.join(dir, "new.txt");
    fs.writeFileSync(existing, "isi lama");

    assert.throws(() => {
      withRollback([existing, newFile], () => {
        fs.writeFileSync(existing, "isi baru");
        fs.writeFileSync(newFile, "file service baru");
        throw new Error("gagal nulis file berikutnya");
      });
    }, /gagal nulis/);

    assert.equal(fs.readFileSync(existing, "utf8"), "isi lama");
    assert.equal(fs.existsSync(newFile), false);
  });

  test("re-throws the original error after rollback so caller still sees it", () => {
    const dir = makeTmpDir();
    const fileA = path.join(dir, "a.txt");
    fs.writeFileSync(fileA, "lama");

    assert.throws(
      () =>
        withRollback([fileA], () => {
          throw new Error("pesan error asli");
        }),
      /pesan error asli/
    );
  });
});

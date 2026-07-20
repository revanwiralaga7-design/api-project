(function () {
  "use strict";
  const { $, getStoredAdminKey, setStoredAdminKey } = window.AdminShared;

  function getNextUrl() {
    const params = new URLSearchParams(location.search);
    const next = params.get("next");
    // Cuma terima path relatif punya sendiri, jangan sampe kepake buat
    // open-redirect ke domain lain.
    if (next && next.startsWith("/") && !next.startsWith("//")) return next;
    return "/admin.html";
  }

  function verifyKey(key) {
    return fetch("/api/admin/whoami", { headers: { "x-admin-key": key } });
  }

  function showMsg(text, type) {
    $("loginMsg").innerHTML = text ? `<div class="msg ${type}">${text}</div>` : "";
  }

  // Kalau udah ada key tersimpan (misal sesi lama) dan masih valid,
  // langsung lempar ke halaman tujuan tanpa nyuruh login ulang.
  (async function tryAutoRedirect() {
    const existing = getStoredAdminKey();
    if (!existing) return;
    try {
      const res = await verifyKey(existing);
      if (res.ok) location.href = getNextUrl();
    } catch {
      /* biarin, user login manual di bawah */
    }
  })();

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = $("adminKeyInput").value.trim();
    const btn = $("loginBtn");
    showMsg("", "");

    if (!key) {
      showMsg("Admin key gak boleh kosong.", "err");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Memeriksa...";

    try {
      const res = await verifyKey(key);
      if (res.status === 503) {
        const json = await res.json().catch(() => ({}));
        showMsg(json.error || "Admin panel belum diaktifkan di server (ADMIN_API_KEY belum di-set).", "warn");
      } else if (res.status === 401) {
        showMsg("Admin key salah.", "err");
      } else if (!res.ok) {
        showMsg(`Gagal verifikasi (status ${res.status}).`, "err");
      } else {
        setStoredAdminKey(key);
        // Tukar admin key jadi session Docs juga (best-effort) — biar
        // tombol "Dokumentasi" / playground langsung bisa dibuka tanpa
        // disuruh login Google/GitHub lagi.
        try {
          await fetch("/auth/admin-session", { method: "POST", headers: { "x-admin-key": key } });
        } catch {
          /* gak fatal — docs tinggal minta login provider */
        }
        location.href = getNextUrl();
        return;
      }
    } catch (err) {
      showMsg("Request gagal: " + err.message, "err");
    }

    btn.disabled = false;
    btn.textContent = "Masuk";
  });
})();

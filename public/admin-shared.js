/**
 * admin-shared.js — dipakai bareng oleh admin.html, endpoint-add.html,
 * endpoint-edit.html, client-manager.html. Isinya: auth (x-admin-key),
 * fetch wrapper, render nav bar, dan helper render pesan/diff yang
 * formatnya sama di semua halaman (dipakai admin.routes.js: preview/apply
 * & edit/preview & edit/apply semua balikin bentuk files[]/warnings[] yang
 * sama).
 *
 * Load file ini PALING ATAS di tiap halaman admin, sebelum script
 * per-halaman lainnya. Semua fungsi ditempel ke window.AdminShared.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  /* ---------------- Admin key (auth) ---------------- */
  const ADMIN_KEY_STORAGE = "febry_admin_key";

  function getStoredAdminKey() {
    return sessionStorage.getItem(ADMIN_KEY_STORAGE) || "";
  }
  function setStoredAdminKey(key) {
    sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
  }
  function clearStoredAdminKey() {
    sessionStorage.removeItem(ADMIN_KEY_STORAGE);
  }

  function redirectToLogin() {
    const next = location.pathname + location.search;
    location.href = "/login.html?next=" + encodeURIComponent(next);
  }

  /**
   * WAJIB dipanggil (di-await) di baris PALING ATAS tiap halaman admin,
   * sebelum renderNav() atau apapun lain. Beda dari sekadar ngecek "ada
   * key tersimpan di sessionStorage", ini verifikasi ASLI ke server
   * (/api/admin/whoami) tiap kali halaman dibuka — jadi kalau
   * ADMIN_API_KEY diganti di .env / server di-restart / key lama udah
   * gak valid, langsung dipaksa login ulang. Gak asal percaya sisa
   * sessionStorage dari sesi sebelumnya.
   */
  async function guardAdminAccess() {
    const key = getStoredAdminKey();
    if (!key) {
      redirectToLogin();
      return false;
    }
    try {
      const res = await fetch("/api/admin/whoami", { headers: { "x-admin-key": key } });
      if (res.ok) {
        ensureDocsSession(key);
        return true;
      }
      clearStoredAdminKey();
      redirectToLogin();
      return false;
    } catch {
      // Server/network gak kejangkau — jangan paksa logout gara-gara
      // ini, biar adminFetch yang nanganin pas beneran manggil API data.
      return true;
    }
  }

  /**
   * Best-effort, sekali per tab session: tukar admin key jadi session
   * Docs (POST /auth/admin-session) biar link "Dokumentasi" di nav bisa
   * langsung dibuka tanpa login Google/GitHub. Penting buat orang yang
   * udah keburu login admin SEBELUM fitur ini ada (login.js baru
   * ngelakuin ini pas login berikutnya).
   */
  function ensureDocsSession(key) {
    if (sessionStorage.getItem("febry_docs_session_ok")) return;
    fetch("/auth/admin-session", { method: "POST", headers: { "x-admin-key": key } })
      .then((r) => { if (r.ok) sessionStorage.setItem("febry_docs_session_ok", "1"); })
      .catch(() => {});
  }

  /**
   * Wrapper fetch buat semua panggilan ke /api/admin/* — otomatis nempelin
   * header x-admin-key. Kalau belum ada key tersimpan (belum login) atau
   * server balikin 401 (key salah/expired), langsung tendang ke
   * /login.html — bukan window.prompt() lagi.
   */
  async function adminFetch(url, options = {}) {
    const key = getStoredAdminKey();
    if (!key) {
      redirectToLogin();
      throw new Error("Belum login.");
    }

    const res = await fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), "x-admin-key": key }
    });

    if (res.status === 401) {
      clearStoredAdminKey();
      redirectToLogin();
      throw new Error("Sesi admin berakhir, silakan login lagi.");
    }

    updateKeyStatus();
    return res;
  }

  function updateKeyStatus() {
    const dot = $("navKeyDot");
    const label = $("navKeyLabel");
    if (!dot || !label) return;
    const key = getStoredAdminKey();
    if (key) {
      dot.classList.add("ok");
      label.textContent = "key tersimpan (" + key.slice(0, 4) + "…)";
    } else {
      dot.classList.remove("ok");
      label.textContent = "belum login";
    }
  }

  /* ---------------- Helpers umum ---------------- */
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function renderMessages(list, type) {
    return (list || []).map((m) => `<div class="msg ${type}">${escapeHtml(m)}</div>`).join("");
  }

  function methodBadgeClass(method) {
    const u = String(method || "").toUpperCase();
    if (u === "GET") return "badge-get";
    if (u === "POST") return "badge-post";
    return "badge-all";
  }

  function tierBadgeClass(tier) {
    return `badge-tier-${String(tier || "free").toLowerCase()}`;
  }

  function renderDiff(diffArr) {
    if (!diffArr) return "";
    return diffArr.map((d) => {
      if (d.type === "context") return `<span class="l ctx">⋯ ${d.count} baris tidak berubah ⋯</span>`;
      const prefix = d.type === "add" ? "+ " : d.type === "remove" ? "- " : "  ";
      const cls = d.type === "add" ? "add" : d.type === "remove" ? "remove" : "";
      return `<span class="l ${cls}">${escapeHtml(prefix + d.line)}</span>`;
    }).join("");
  }

  /**
   * Render daftar file dari response preview (/preview, /delete/preview,
   * /edit/preview semua balikin bentuk yang kompatibel). Field opsional
   * `willDelete` dipakai buat kasih tag "AKAN DIHAPUS" tanpa body.
   */
  function renderFiles(files) {
    return (files || []).map((f) => {
      let tag = "";
      if (f.willDelete) tag = '<span class="del">akan DIHAPUS</span>';
      else if (f.isNew) tag = '<span class="new">file baru</span>';
      else tag = '<span class="ow">akan diubah</span>';

      let body;
      if (f.willDelete) {
        body = `<pre><span class="l remove">(file ini akan dihapus)</span></pre>`;
      } else if (f.isNew && f.content) {
        body = `<pre>${f.content.split("\n").map((l) => `<span class="l add">${escapeHtml(l)}</span>`).join("")}</pre>`;
      } else if (f.isNew && !f.diff) {
        body = `<pre><span class="l add">(file baru — isi lihat setelah apply)</span></pre>`;
      } else {
        body = `<pre>${renderDiff(f.diff)}</pre>`;
      }
      return `<div class="file-block"><div class="fname"><span>${escapeHtml(f.path)}</span>${tag}</div>${body}</div>`;
    }).join("");
  }

  /* ---------------- Nav bar ---------------- */
  const NAV_ITEMS = [
    { key: "docs", href: "/index.html", label: "Dokumentasi" },
    { key: "dashboard", href: "/admin.html", label: "Dashboard" },
    { key: "add", href: "/endpoint-add.html", label: "+ Endpoint" },
    { key: "clients", href: "/client-manager.html", label: "Clients" },
    { key: "ops", href: "/admin-ops.html", label: "Ops" }
  ];

  function renderNav(activeKey) {
    if (!getStoredAdminKey()) {
      redirectToLogin();
      return;
    }
    const mount = $("adminnav");
    if (!mount) return;
    mount.innerHTML = `
      <div class="brand"><span class="dot"></span>JUSTICE_API // ADMIN</div>
      <div class="navlinks">
        ${NAV_ITEMS.map((n) => `<a href="${n.href}" class="${n.key === activeKey ? "active" : ""}">${n.label}</a>`).join("")}
      </div>
      <div class="spacer"></div>
      <div class="keystat">
        <span class="kdot" id="navKeyDot"></span>
        <span id="navKeyLabel">belum login</span>
        <button id="navKeyBtn" type="button">keluar</button>
      </div>
    `;
    $("navKeyBtn").addEventListener("click", () => {
      clearStoredAdminKey();
      location.href = "/login.html";
    });
    updateKeyStatus();
  }

  window.AdminShared = {
    $,
    adminFetch,
    guardAdminAccess,
    getStoredAdminKey,
    setStoredAdminKey,
    clearStoredAdminKey,
    escapeHtml,
    renderMessages,
    renderDiff,
    renderFiles,
    renderNav,
    methodBadgeClass,
    tierBadgeClass
  };
})();

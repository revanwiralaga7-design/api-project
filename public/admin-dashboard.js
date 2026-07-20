(async function () {
  "use strict";
  const {
    $,
    adminFetch,
    escapeHtml,
    renderMessages,
    renderFiles,
    renderNav,
    guardAdminAccess,
    methodBadgeClass,
  } = window.AdminShared;
  if (!(await guardAdminAccess())) return;
  renderNav("dashboard");

  let allEndpoints = [];

  /* ---------------- Status server (publik, gak butuh admin key) ---------------- */
  (async function checkServer() {
    try {
      const res = await fetch("/api/");
      const ok = res.ok;
      $("statServer").textContent = ok ? "ONLINE" : `ERROR ${res.status}`;
      $("statServer").style.color = ok ? "var(--green)" : "var(--red)";
      $("statServerSub").textContent = ok ? "merespons normal" : "cek log server";
    } catch {
      $("statServer").textContent = "OFFLINE";
      $("statServer").style.color = "var(--red)";
      $("statServerSub").textContent = "gak bisa dihubungi";
    }
  })();

  /* ---------------- Stats + endpoint list ---------------- */
  async function loadEndpoints() {
    try {
      const res = await adminFetch("/api/admin/endpoints");
      const json = await res.json();
      if (!json.status) {
        $("epTableWrap").innerHTML = renderMessages([json.error || "Gagal memuat daftar endpoint"], "err");
        return;
      }
      allEndpoints = json.result.endpoints || [];
      $("statEndpoints").textContent = allEndpoints.length;
      const catCount = new Set(allEndpoints.map((e) => e.categoryId)).size;
      $("statEndpointsSub").textContent = `di ${catCount} kategori`;
      $("statCategories").textContent = catCount;
      renderTable(allEndpoints);
    } catch (e) {
      $("epTableWrap").innerHTML = renderMessages(["Request gagal: " + e.message], "err");
    }
  }

  async function loadClientStats() {
    try {
      const res = await adminFetch("/api/admin/clients");
      const json = await res.json();
      if (!json.status) {
        $("statClientsSub").textContent = "gagal memuat";
        return;
      }
      const clients = json.result.clients || [];
      $("statClients").textContent = clients.length;
      const byTier = {};
      clients.forEach((c) => {
        byTier[c.tier] = (byTier[c.tier] || 0) + 1;
      });
      $("statClientsSub").textContent =
        Object.entries(byTier)
          .map(([t, n]) => `${n} ${t}`)
          .join(" · ") || "belum ada client";
    } catch {
      $("statClientsSub").textContent = "gagal memuat";
    }
  }

  function renderTable(endpoints) {
    const wrap = $("epTableWrap");
    $("epCount").textContent = `${endpoints.length} endpoint`;
    if (!endpoints.length) {
      wrap.innerHTML = `<div class="empty-hint">Belum ada endpoint. <a href="/endpoint-add.html">Tambah yang pertama →</a></div>`;
      return;
    }
    const byCategory = {};
    endpoints.forEach((ep) => {
      const key = ep.categoryLabel || ep.categoryId || "Lainnya";
      (byCategory[key] = byCategory[key] || []).push(ep);
    });

    const rows = Object.entries(byCategory)
      .map(
        ([label, eps]) => `
      <tr><td colspan="4" class="cat-group-label">${escapeHtml(label)} <span style="color:var(--muted-2);">(${eps.length})</span></td></tr>
      ${eps
        .map(
          (ep) => `
        <tr>
          <td><span class="badge ${methodBadgeClass(ep.method)}">${escapeHtml(ep.method)}</span></td>
          <td><code>${escapeHtml(ep.path)}</code><div class="hint" style="margin:2px 0 0;">${escapeHtml(ep.name)}</div></td>
          <td>${escapeHtml(ep.categoryLabel || ep.categoryId || "")}</td>
          <td style="white-space:nowrap;">
            <a class="icon-btn" href="/endpoint-edit.html?path=${encodeURIComponent(ep.path)}&method=${encodeURIComponent(ep.method)}">Edit</a>
            <button type="button" class="icon-btn danger" data-path="${escapeHtml(ep.path)}" data-method="${escapeHtml(ep.method)}" data-name="${escapeHtml(ep.name)}">Hapus</button>
          </td>
        </tr>
      `
        )
        .join("")}
    `
      )
      .join("");

    wrap.innerHTML = `<div class="table-scroll"><table class="dtable"><thead><tr><th>Method</th><th>Path</th><th>Kategori</th><th>Aksi</th></tr></thead><tbody>${rows}</tbody></table></div>`;

    wrap.querySelectorAll("button.icon-btn.danger").forEach((btn) => {
      btn.addEventListener("click", () =>
        openDeleteModal(btn.dataset.path, btn.dataset.method, btn.dataset.name)
      );
    });
  }

  $("epFilter").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) {
      renderTable(allEndpoints);
      return;
    }
    renderTable(
      allEndpoints.filter(
        (ep) =>
          ep.name.toLowerCase().includes(q) ||
          ep.path.toLowerCase().includes(q) ||
          (ep.categoryLabel || "").toLowerCase().includes(q)
      )
    );
  });

  /* ---------------- Modal hapus endpoint ---------------- */
  function closeModal() {
    $("deleteModalMount").innerHTML = "";
  }

  function openDeleteModal(path, method, name) {
    $("deleteModalMount").innerHTML = `
      <div class="modal-backdrop" id="delBackdrop">
        <div class="modal">
          <h3>Hapus Endpoint</h3>
          <p style="color:var(--muted); font-size:13px; margin:0 0 14px;">
            <span class="badge ${methodBadgeClass(method)}">${escapeHtml(method)}</span> <code>${escapeHtml(path)}</code> — ${escapeHtml(name)}
          </p>
          <div id="delModalResult"></div>
          <div class="actions">
            <button class="btn btn-secondary" id="delModalPreviewBtn">Preview Hapus</button>
            <button class="btn btn-danger" id="delModalApplyBtn" disabled>Hapus dari Project</button>
            <button class="btn btn-secondary" id="delModalCancelBtn">Batal</button>
          </div>
        </div>
      </div>
    `;
    $("delBackdrop").addEventListener("click", (e) => {
      if (e.target.id === "delBackdrop") closeModal();
    });
    $("delModalCancelBtn").addEventListener("click", closeModal);

    const payload = { path, method };
    const resultEl = $("delModalResult");

    $("delModalPreviewBtn").addEventListener("click", async () => {
      resultEl.innerHTML = `<div class="msg">Memproses preview...</div>`;
      $("delModalApplyBtn").disabled = true;
      try {
        const res = await adminFetch("/api/admin/delete/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        if (!json.status) {
          resultEl.innerHTML = renderMessages([json.error || "Gagal preview"], "err");
          return;
        }
        const { warnings, files, summary } = json.result;
        resultEl.innerHTML =
          `<div class="msg warn">Akan menghapus: ${escapeHtml(summary.method)} ${escapeHtml(summary.fullPath)}</div>` +
          renderMessages(warnings, "warn") +
          renderFiles(files);
        $("delModalApplyBtn").disabled = false;
      } catch (e) {
        resultEl.innerHTML = renderMessages(["Request gagal: " + e.message], "err");
      }
    });

    $("delModalApplyBtn").addEventListener("click", async () => {
      $("delModalApplyBtn").disabled = true;
      resultEl.innerHTML += `<div class="msg">Menghapus...</div>`;
      try {
        const res = await adminFetch("/api/admin/delete/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        if (!json.status) {
          resultEl.innerHTML += renderMessages(
            [json.error || "Gagal hapus (semua perubahan sudah di-rollback)"],
            "err"
          );
          $("delModalApplyBtn").disabled = false;
          return;
        }
        resultEl.innerHTML += `<div class="msg ok">${escapeHtml(json.result.message)}</div>`;
        setTimeout(() => {
          closeModal();
          loadEndpoints();
        }, 900);
      } catch (e) {
        resultEl.innerHTML += renderMessages(["Request gagal: " + e.message], "err");
        $("delModalApplyBtn").disabled = false;
      }
    });
  }

  loadEndpoints();
  loadClientStats();
})();

(async function () {
  "use strict";
  const { $, adminFetch, escapeHtml, renderMessages, renderNav, guardAdminAccess, tierBadgeClass } = window.AdminShared;
  if (!(await guardAdminAccess())) return;
  renderNav("clients");

  let clients = [];
  const revealed = new Set();

  function maskKey(key) {
    return key.slice(0, 8) + "…" + key.slice(-4);
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
    } catch {
      return iso;
    }
  }

  async function loadClients() {
    try {
      const res = await adminFetch("/api/admin/clients");
      const json = await res.json();
      if (!json.status) {
        $("clientTableWrap").innerHTML = renderMessages([json.error || "Gagal memuat daftar client"], "err");
        return;
      }
      clients = json.result.clients || [];
      renderTable();
    } catch (e) {
      $("clientTableWrap").innerHTML = renderMessages(["Request gagal: " + e.message], "err");
    }
  }

  function renderTable() {
    $("clientCount").textContent = `${clients.length} total`;
    const wrap = $("clientTableWrap");
    if (!clients.length) {
      wrap.innerHTML = `<div class="empty-hint">Belum ada client. Buat yang pertama di form atas.</div>`;
      return;
    }
    const rows = clients.map((c) => `
      <tr data-key="${escapeHtml(c.apiKey)}">
        <td>${escapeHtml(c.name)}</td>
        <td><span class="badge ${tierBadgeClass(c.tier)}">${escapeHtml(c.tier)}</span>${c.expired ? ' <span class="badge" style="color:var(--red);border-color:var(--red);">EXPIRED</span>' : ""}</td>
        <td>${c.provider ? `${escapeHtml(c.provider)}<div class="hint" style="margin:2px 0 0;">${escapeHtml(c.email || "—")}</div>` : "manual"}</td>
        <td>
          <div class="key-cell">
            <code>${escapeHtml(revealed.has(c.apiKey) ? c.apiKey : maskKey(c.apiKey))}</code>
            <button type="button" class="icon-btn reveal-btn" data-key="${escapeHtml(c.apiKey)}">${revealed.has(c.apiKey) ? "sembunyikan" : "lihat"}</button>
            <button type="button" class="icon-btn copy-btn" data-key="${escapeHtml(c.apiKey)}">salin</button>
          </div>
        </td>
        <td>${escapeHtml(fmtDate(c.createdAt))}</td>
        <td>${c.expiresAt ? escapeHtml(fmtDate(c.expiresAt)) : "—"}</td>
        <td>${c.dailyQuota ? `${c.dailyQuota}/hari` : "—"}</td>
        <td style="white-space:nowrap;">
          <button type="button" class="icon-btn edit-btn" data-key="${escapeHtml(c.apiKey)}">Edit</button>
          <button type="button" class="icon-btn danger revoke-btn" data-key="${escapeHtml(c.apiKey)}">Cabut</button>
        </td>
      </tr>
    `).join("");

    wrap.innerHTML = `
      <div class="table-scroll">
        <table class="dtable">
          <thead><tr><th>Nama</th><th>Tier</th><th>Sumber</th><th>API Key</th><th>Dibuat</th><th>Expired</th><th>Kuota</th><th>Aksi</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;

    wrap.querySelectorAll(".reveal-btn").forEach((btn) => btn.addEventListener("click", () => {
      const k = btn.dataset.key;
      if (revealed.has(k)) revealed.delete(k); else revealed.add(k);
      renderTable();
    }));
    wrap.querySelectorAll(".copy-btn").forEach((btn) => btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.key);
        btn.textContent = "tersalin!";
        setTimeout(() => { btn.textContent = "salin"; }, 1400);
      } catch {
        window.prompt("Salin manual:", btn.dataset.key);
      }
    }));
    wrap.querySelectorAll(".edit-btn").forEach((btn) => btn.addEventListener("click", () => openEditModal(btn.dataset.key)));
    wrap.querySelectorAll(".revoke-btn").forEach((btn) => btn.addEventListener("click", () => openRevokeModal(btn.dataset.key)));
  }

  /* ---------------- Buat client baru ---------------- */
  $("createClientBtn").addEventListener("click", async () => {
    const name = $("newClientName").value.trim();
    const tier = $("newClientTier").value;
    const expiresAt = $("newClientExpires").value;
    const dailyQuota = $("newClientQuota").value.trim();
    const resultEl = $("createResult");
    if (!name) {
      resultEl.innerHTML = renderMessages(["Nama client wajib diisi."], "err");
      return;
    }
    $("createClientBtn").disabled = true;
    resultEl.innerHTML = `<div class="msg">Membuat client...</div>`;
    try {
      const res = await adminFetch("/api/admin/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, tier, expiresAt, dailyQuota })
      });
      const json = await res.json();
      if (!json.status) {
        resultEl.innerHTML = renderMessages([json.error || "Gagal membuat client"], "err");
        $("createClientBtn").disabled = false;
        return;
      }
      const client = json.result.client;
      resultEl.innerHTML = `
        <div class="newkey-box">
          <div class="lbl">Client dibuat — salin key-nya sekarang</div>
          <code>${escapeHtml(client.apiKey)}</code>
          <div class="hint" style="margin:0;">Client kirim request pakai header: <code>x-api-key: ${escapeHtml(client.apiKey)}</code>. Key ini tetap bisa dilihat lagi kapan aja lewat tabel di bawah (klik "lihat").</div>
        </div>
      `;
      $("newClientName").value = "";
      $("newClientExpires").value = "";
      $("newClientQuota").value = "";
      loadClients();
    } catch (e) {
      resultEl.innerHTML = renderMessages(["Request gagal: " + e.message], "err");
    }
    $("createClientBtn").disabled = false;
  });

  /* ---------------- Modal edit ---------------- */
  function closeModal() { $("modalMount").innerHTML = ""; }

  function openEditModal(apiKey) {
    const c = clients.find((x) => x.apiKey === apiKey);
    if (!c) return;
    const expiresDate = c.expiresAt ? String(c.expiresAt).slice(0, 10) : "";
    $("modalMount").innerHTML = `
      <div class="modal-backdrop" id="editBackdrop">
        <div class="modal">
          <h3>Edit Client</h3>
          <label>Nama</label>
          <input type="text" id="editName" value="${escapeHtml(c.name)}">
          <label>Tier</label>
          <select id="editTier">
            <option value="free" ${c.tier === "free" ? "selected" : ""}>free</option>
            <option value="premium" ${c.tier === "premium" ? "selected" : ""}>premium</option>
            <option value="admin" ${c.tier === "admin" ? "selected" : ""}>admin (unlimited)</option>
          </select>
          <label>Berlaku sampai (kosong = selamanya)</label>
          <input type="date" id="editExpires" value="${escapeHtml(expiresDate)}">
          <label>Kuota harian (kosong = tanpa batas)</label>
          <input type="number" id="editQuota" min="1" value="${c.dailyQuota || ""}">
          <div id="editModalResult"></div>
          <div class="actions">
            <button class="btn btn-primary" id="editSaveBtn">Simpan</button>
            <button class="btn btn-secondary" id="editCancelBtn">Batal</button>
          </div>
        </div>
      </div>
    `;
    $("editBackdrop").addEventListener("click", (e) => { if (e.target.id === "editBackdrop") closeModal(); });
    $("editCancelBtn").addEventListener("click", closeModal);
    $("editSaveBtn").addEventListener("click", async () => {
      const resultEl = $("editModalResult");
      $("editSaveBtn").disabled = true;
      resultEl.innerHTML = `<div class="msg">Menyimpan...</div>`;
      try {
        const res = await adminFetch(`/api/admin/clients/${encodeURIComponent(apiKey)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: $("editName").value.trim(),
            tier: $("editTier").value,
            expiresAt: $("editExpires").value,
            dailyQuota: $("editQuota").value.trim()
          })
        });
        const json = await res.json();
        if (!json.status) {
          resultEl.innerHTML = renderMessages([json.error || "Gagal update"], "err");
          $("editSaveBtn").disabled = false;
          return;
        }
        closeModal();
        loadClients();
      } catch (e) {
        resultEl.innerHTML = renderMessages(["Request gagal: " + e.message], "err");
        $("editSaveBtn").disabled = false;
      }
    });
  }

  /* ---------------- Modal cabut/revoke ---------------- */
  function openRevokeModal(apiKey) {
    const c = clients.find((x) => x.apiKey === apiKey);
    if (!c) return;
    $("modalMount").innerHTML = `
      <div class="modal-backdrop" id="revokeBackdrop">
        <div class="modal">
          <h3>Cabut API Key</h3>
          <p style="color:var(--muted); font-size:13px;">Yakin cabut key milik <b>${escapeHtml(c.name)}</b>? Key lamanya langsung gak bisa dipakai — request berikutnya ditolak 401 (endpoint API wajib key). Gak bisa di-undo.${c.provider ? " Catatan: key ini hasil login " + escapeHtml(c.provider) + " — kalau orangnya login docs lagi, key BARU dibuat otomatis." : ""}</p>
          <div id="revokeModalResult"></div>
          <div class="actions">
            <button class="btn btn-danger" id="revokeConfirmBtn">Ya, Cabut</button>
            <button class="btn btn-secondary" id="revokeCancelBtn">Batal</button>
          </div>
        </div>
      </div>
    `;
    $("revokeBackdrop").addEventListener("click", (e) => { if (e.target.id === "revokeBackdrop") closeModal(); });
    $("revokeCancelBtn").addEventListener("click", closeModal);
    $("revokeConfirmBtn").addEventListener("click", async () => {
      const resultEl = $("revokeModalResult");
      $("revokeConfirmBtn").disabled = true;
      resultEl.innerHTML = `<div class="msg">Mencabut...</div>`;
      try {
        const res = await adminFetch(`/api/admin/clients/${encodeURIComponent(apiKey)}`, { method: "DELETE" });
        const json = await res.json();
        if (!json.status) {
          resultEl.innerHTML = renderMessages([json.error || "Gagal mencabut"], "err");
          $("revokeConfirmBtn").disabled = false;
          return;
        }
        closeModal();
        loadClients();
      } catch (e) {
        resultEl.innerHTML = renderMessages(["Request gagal: " + e.message], "err");
        $("revokeConfirmBtn").disabled = false;
      }
    });
  }

  loadClients();
})();

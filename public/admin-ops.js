/**
 * admin-ops.js — halaman Ops: health check, riwayat scaffold (undo),
 * usage analytics, cache per endpoint, log viewer, ekspor OpenAPI.
 * Load setelah admin-shared.js.
 */
(async function () {
  "use strict";
  const { $, adminFetch, escapeHtml, renderMessages, renderNav, guardAdminAccess, methodBadgeClass, tierBadgeClass, getStoredAdminKey } = window.AdminShared;
  if (!(await guardAdminAccess())) return;
  renderNav("ops");

  /* ---------------- Health check ---------------- */
  $("healthRunBtn").addEventListener("click", async () => {
    const btn = $("healthRunBtn");
    btn.disabled = true;
    $("healthSummary").innerHTML = "";
    $("healthTableWrap").innerHTML = `<div class="empty-hint">Menge-hit semua endpoint... (bisa agak lama kalau ada scraper yang lemot)</div>`;
    try {
      const res = await adminFetch("/api/admin/health/run", { method: "POST" });
      const json = await res.json();
      if (!json.status) {
        $("healthTableWrap").innerHTML = renderMessages([json.error || "Gagal"], "err");
        return;
      }
      const { counts, results } = json.result;
      $("healthSummary").innerHTML =
        `<span class="hstat ok">${counts.ok || 0} OK</span>` +
        `<span class="hstat degraded">${counts.degraded || 0} degraded</span>` +
        `<span class="hstat fail">${counts.fail || 0} fail</span>` +
        `<span class="hstat skipped">${counts.skipped || 0} skip</span>`;

      const rows = results.map((r) => {
        const statusCell =
          r.status === "ok" ? `<span class="hstat ok">OK ${r.httpStatus}</span>`
          : r.status === "degraded" ? `<span class="hstat degraded">${r.httpStatus}</span>`
          : r.status === "fail" ? `<span class="hstat fail">${r.httpStatus || "ERR"}</span>`
          : `<span class="hstat skipped">skip</span>`;
        const detail = r.status === "skipped" ? r.reason
          : r.assertFailures && r.assertFailures.length ? `⚠ ${escapeHtml(r.assertFailures.join("; "))}`
          : r.status === "ok" ? `${r.ms} ms`
          : escapeHtml((r.error || r.bodyPreview || "").slice(0, 120));
        return `
          <tr class="health-row">
            <td><span class="badge ${methodBadgeClass(r.method)}">${escapeHtml(r.method)}</span></td>
            <td><code>${escapeHtml(r.path)}</code></td>
            <td>${statusCell}</td>
            <td>${detail || ""}</td>
            <td><button type="button" class="icon-btn" data-setparams="${escapeHtml(r.path)}" data-method="${escapeHtml(r.method)}">set params</button></td>
          </tr>`;
      }).join("");
      $("healthTableWrap").innerHTML =
        `<div class="table-scroll"><table class="dtable"><thead><tr><th>Method</th><th>Path</th><th>Status</th><th>Detail</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;

      $("healthTableWrap").querySelectorAll("[data-setparams]").forEach((btn2) => {
        btn2.addEventListener("click", () => openParamsModal(btn2.dataset.setparams, btn2.dataset.method));
      });
    } catch (e) {
      $("healthTableWrap").innerHTML = renderMessages(["Request gagal: " + e.message], "err");
    } finally {
      btn.disabled = false;
    }
  });

  function openParamsModal(path, method) {
    $("modalMount").innerHTML = `
      <div class="modal-backdrop" id="paramsBackdrop">
        <div class="modal">
          <h3>Test Params — ${escapeHtml(path)}</h3>
          <p style="color:var(--muted); font-size:13px;">JSON object nama→nilai yang dipakai health check buat nge-hit endpoint ini. Termasuk nilai path param kalau path-nya pakai <code>:id</code>.</p>
          <textarea id="paramsJson" style="min-height:120px;" placeholder='{ "query": "naruto" }'></textarea>
          <p style="color:var(--muted); font-size:13px; margin-top:10px;">Field wajib ada di response (opsional, pisah koma, dot-path mis. <code>result.url, result.title</code>) — nangkep endpoint yang balas 200 tapi isinya kosong.</p>
          <input type="text" id="paramsAssertFields" placeholder="result.url, result.title">
          <div id="paramsModalResult"></div>
          <div class="actions">
            <button class="btn btn-primary" id="paramsSaveBtn">Simpan</button>
            <button class="btn btn-danger" id="paramsDeleteBtn" style="display:none;">Hapus Test</button>
            <button class="btn btn-secondary" id="paramsCancelBtn">Batal</button>
          </div>
        </div>
      </div>`;
    const close = () => { $("modalMount").innerHTML = ""; };
    $("paramsBackdrop").addEventListener("click", (e) => { if (e.target.id === "paramsBackdrop") close(); });
    $("paramsCancelBtn").addEventListener("click", close);

    // Prefill dari yang tersimpan; tombol hapus cuma muncul kalau emang
    // ada test tersimpan buat endpoint ini.
    adminFetch("/api/admin/health-tests").then((r) => r.json()).then((json) => {
      const key = `${String(method || "ALL").toUpperCase()} ${path}`;
      const t = json.result?.tests?.[key];
      if (t) {
        $("paramsJson").value = JSON.stringify(t.params, null, 2);
        $("paramsAssertFields").value = (t.assertFields || []).join(", ");
        $("paramsDeleteBtn").style.display = "";
      }
    }).catch(() => {});

    $("paramsDeleteBtn").addEventListener("click", async () => {
      try {
        const res = await adminFetch(
          `/api/admin/health-tests?path=${encodeURIComponent(path)}&method=${encodeURIComponent(method || "ALL")}`,
          { method: "DELETE" }
        );
        const json = await res.json();
        if (!json.status) {
          $("paramsModalResult").innerHTML = renderMessages([json.error || "Gagal"], "err");
          return;
        }
        close();
      } catch (e) {
        $("paramsModalResult").innerHTML = renderMessages(["Request gagal: " + e.message], "err");
      }
    });

    $("paramsSaveBtn").addEventListener("click", async () => {
      let params;
      try {
        params = JSON.parse($("paramsJson").value || "{}");
      } catch {
        $("paramsModalResult").innerHTML = renderMessages(["JSON tidak valid."], "err");
        return;
      }
      const assertFields = $("paramsAssertFields").value.split(",").map((s) => s.trim()).filter(Boolean);
      try {
        const res = await adminFetch("/api/admin/health-tests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, method, params, assertFields })
        });
        const json = await res.json();
        if (!json.status) {
          $("paramsModalResult").innerHTML = renderMessages([json.error || "Gagal"], "err");
          return;
        }
        close();
      } catch (e) {
        $("paramsModalResult").innerHTML = renderMessages(["Request gagal: " + e.message], "err");
      }
    });
  }

  /* ---------------- Riwayat + rollback ---------------- */
  async function loadHistory() {
    try {
      const res = await adminFetch("/api/admin/history");
      const json = await res.json();
      if (!json.status) {
        $("historyWrap").innerHTML = renderMessages([json.error || "Gagal memuat riwayat"], "err");
        return;
      }
      const history = json.result.history || [];
      if (!history.length) {
        $("historyWrap").innerHTML = `<div class="empty-hint">Belum ada riwayat — apply endpoint dulu, nanti kecatat di sini.</div>`;
        return;
      }
      const rows = history.map((h) => `
        <tr>
          <td style="white-space:nowrap;">${escapeHtml(new Date(h.createdAt).toLocaleString("id-ID"))}</td>
          <td><span class="badge badge-all">${escapeHtml(h.action)}</span></td>
          <td>${escapeHtml(h.summary)}${h.conflictsWith.length ? ` <span class="conflict-tag">⚠ ada ${h.conflictsWith.length} perubahan lebih baru di file yang sama</span>` : ""}
            <div class="hint" style="margin:2px 0 0;">${h.files.map((f) => `<code>${escapeHtml(f)}</code>`).join(" · ")}</div>
          </td>
          <td style="white-space:nowrap;">
            <button type="button" class="icon-btn rollback-btn" data-id="${escapeHtml(h.id)}" data-summary="${escapeHtml(h.summary)}" data-conflicts="${h.conflictsWith.length}">Rollback</button>
            <button type="button" class="icon-btn danger histdel-btn" data-id="${escapeHtml(h.id)}">Hapus</button>
          </td>
        </tr>`).join("");
      $("historyWrap").innerHTML =
        `<div class="table-scroll"><table class="dtable"><thead><tr><th>Waktu</th><th>Aksi</th><th>Ringkasan</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;

      $("historyWrap").querySelectorAll(".rollback-btn").forEach((btn) => {
        btn.addEventListener("click", () => openRollbackModal(btn.dataset.id, btn.dataset.summary, Number(btn.dataset.conflicts)));
      });
      $("historyWrap").querySelectorAll(".histdel-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await adminFetch(`/api/admin/history/${encodeURIComponent(btn.dataset.id)}`, { method: "DELETE" }).catch(() => {});
          loadHistory();
        });
      });
    } catch (e) {
      $("historyWrap").innerHTML = renderMessages(["Request gagal: " + e.message], "err");
    }
  }

  function openRollbackModal(id, summary, conflicts) {
    $("modalMount").innerHTML = `
      <div class="modal-backdrop" id="rbBackdrop">
        <div class="modal">
          <h3>Rollback</h3>
          <p style="color:var(--muted); font-size:13px;">Kembalikan file-file ke kondisi SEBELUM: <b>${escapeHtml(summary)}</b>?</p>
          ${conflicts ? `<div class="msg warn">⚠ Ada ${conflicts} perubahan LEBIH BARU yang nyentuh file sama — rollback ini bakal MENIMPA perubahan itu juga. Kondisi sebelum rollback tetap kecatat sebagai entry riwayat baru, jadi masih bisa dibalikin lagi.</div>` : ""}
          <div id="rbModalResult"></div>
          <div class="actions">
            <button class="btn btn-danger" id="rbConfirmBtn">Ya, Rollback</button>
            <button class="btn btn-secondary" id="rbCancelBtn">Batal</button>
          </div>
        </div>
      </div>`;
    const close = () => { $("modalMount").innerHTML = ""; };
    $("rbBackdrop").addEventListener("click", (e) => { if (e.target.id === "rbBackdrop") close(); });
    $("rbCancelBtn").addEventListener("click", close);
    $("rbConfirmBtn").addEventListener("click", async () => {
      $("rbConfirmBtn").disabled = true;
      $("rbModalResult").innerHTML = `<div class="msg">Rollback...</div>`;
      try {
        const res = await adminFetch("/api/admin/history/rollback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id })
        });
        const json = await res.json();
        if (!json.status) {
          $("rbModalResult").innerHTML = renderMessages([json.error || "Gagal rollback"], "err");
          $("rbConfirmBtn").disabled = false;
          return;
        }
        $("rbModalResult").innerHTML =
          `<div class="msg ok">${escapeHtml(json.result.message)}</div>` +
          (json.result.actions || []).map((a) => `<div class="hint">· ${escapeHtml(a)}</div>`).join("");
        setTimeout(() => { close(); loadHistory(); }, 1400);
      } catch (e) {
        $("rbModalResult").innerHTML = renderMessages(["Request gagal: " + e.message], "err");
        $("rbConfirmBtn").disabled = false;
      }
    });
  }

  /* ---------------- Usage analytics ---------------- */
  async function loadUsage() {
    const days = $("usageDays").value;
    try {
      const res = await adminFetch(`/api/admin/usage?days=${encodeURIComponent(days)}`);
      const json = await res.json();
      if (!json.status) {
        $("usageWrap").innerHTML = renderMessages([json.error || "Gagal memuat usage"], "err");
        return;
      }
      const { clients, topPaths } = json.result;
      if (!clients.length) {
        $("usageWrap").innerHTML = `<div class="empty-hint">Belum ada pemakaian tercatat di rentang ini.</div>`;
        $("usageTopPaths").innerHTML = "";
        return;
      }
      const rows = clients.map((c) => `
        <tr>
          <td>${c.name ? escapeHtml(c.name) : `<span class="hint" style="margin:0;">anonim/IP</span>`}<div class="hint" style="margin:2px 0 0;"><code>${escapeHtml(c.clientKey.length > 20 ? c.clientKey.slice(0, 8) + "…" + c.clientKey.slice(-4) : c.clientKey)}</code></div></td>
          <td><span class="badge ${tierBadgeClass(c.tier)}">${escapeHtml(c.tier)}</span></td>
          <td>${c.total}</td>
          <td>${c.today}</td>
          <td>${c.limited || 0}</td>
          <td>${c.topPaths.map((p) => `<code>${escapeHtml(p.path)}</code> (${p.hits})`).join("<br>")}</td>
        </tr>`).join("");
      $("usageWrap").innerHTML =
        `<div class="table-scroll"><table class="dtable"><thead><tr><th>Client</th><th>Tier</th><th>Total</th><th>Hari ini</th><th>Kena limit</th><th>Endpoint tersering</th></tr></thead><tbody>${rows}</tbody></table></div>`;
      $("usageTopPaths").innerHTML = topPaths.length
        ? `<div class="table-scroll"><table class="dtable"><thead><tr><th>Path</th><th>Hit</th></tr></thead><tbody>${topPaths.map((p) => `<tr><td><code>${escapeHtml(p.path)}</code></td><td>${p.hits}</td></tr>`).join("")}</tbody></table></div>`
        : "";
    } catch (e) {
      $("usageWrap").innerHTML = renderMessages(["Request gagal: " + e.message], "err");
    }
  }
  $("usageReloadBtn").addEventListener("click", loadUsage);
  $("usageDays").addEventListener("change", loadUsage);

  /* ---------------- Cache ---------------- */
  async function loadCache() {
    try {
      const res = await adminFetch("/api/admin/cache");
      const json = await res.json();
      if (!json.status) return;
      const { config, stats } = json.result;
      $("cacheStats").textContent = `${stats.live} entry aktif di memory`;
      const entries = Object.entries(config);
      $("cacheTableWrap").innerHTML = entries.length
        ? `<div class="table-scroll"><table class="dtable"><thead><tr><th>Path (prefix)</th><th>TTL</th><th></th></tr></thead><tbody>${
            entries.map(([p, c]) => `
              <tr>
                <td><code>${escapeHtml(p)}</code></td>
                <td>${c.ttlSeconds} detik</td>
                <td><button type="button" class="icon-btn danger cache-del-btn" data-path="${escapeHtml(p)}">Hapus rule</button></td>
              </tr>`).join("")
          }</tbody></table></div>`
        : `<div class="empty-hint">Belum ada rule cache.</div>`;
      $("cacheTableWrap").querySelectorAll(".cache-del-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await setCacheRule(btn.dataset.path, 0);
        });
      });
    } catch { /* diemin */ }
  }

  async function setCacheRule(path, ttl) {
    try {
      const res = await adminFetch("/api/admin/cache", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, ttlSeconds: ttl })
      });
      const json = await res.json();
      $("cacheResult").innerHTML = json.status
        ? `<div class="msg ok">${escapeHtml(json.result.message)}</div>`
        : renderMessages([json.error || "Gagal"], "err");
      loadCache();
    } catch (e) {
      $("cacheResult").innerHTML = renderMessages(["Request gagal: " + e.message], "err");
    }
  }

  $("cacheSetBtn").addEventListener("click", () => {
    const path = $("cachePath").value.trim();
    const ttl = Number($("cacheTtl").value.trim());
    if (!path || !Number.isInteger(ttl) || ttl < 0) {
      $("cacheResult").innerHTML = renderMessages(["Isi path (/api/...) dan TTL detik (bilangan bulat ≥ 0)."], "err");
      return;
    }
    setCacheRule(path, ttl);
  });
  $("cacheClearBtn").addEventListener("click", async () => {
    try {
      const res = await adminFetch("/api/admin/cache/clear", { method: "POST" });
      const json = await res.json();
      $("cacheResult").innerHTML = json.status ? `<div class="msg ok">${escapeHtml(json.result.message)}</div>` : renderMessages([json.error], "err");
      loadCache();
    } catch (e) {
      $("cacheResult").innerHTML = renderMessages(["Request gagal: " + e.message], "err");
    }
  });

  /* ---------------- Log viewer ---------------- */
  async function loadLogs() {
    const filter = $("logFilter").value.trim();
    const lines = $("logLines").value;
    try {
      const res = await adminFetch(`/api/admin/logs?lines=${encodeURIComponent(lines)}&filter=${encodeURIComponent(filter)}`);
      const json = await res.json();
      if (!json.status) {
        $("logBox").textContent = json.error || "Gagal memuat log";
        return;
      }
      const { lines: logLines, totalMatched } = json.result;
      $("logCount").textContent = `${logLines.length} / ${totalMatched} baris`;
      $("logBox").textContent = logLines.length ? logLines.join("\n") : "(kosong — belum ada traffic tercatat, atau server jalan mode development sebelum fitur ini)";
      $("logBox").scrollTop = $("logBox").scrollHeight;
    } catch (e) {
      $("logBox").textContent = "Request gagal: " + e.message;
    }
  }
  $("logReloadBtn").addEventListener("click", loadLogs);
  $("logFilter").addEventListener("keydown", (e) => { if (e.key === "Enter") loadLogs(); });

  /* ---------------- OpenAPI ---------------- */
  $("openapiBtn").addEventListener("click", async () => {
    try {
      const res = await adminFetch("/api/admin/openapi.json");
      if (!res.ok) {
        $("openapiResult").innerHTML = renderMessages(["Gagal generate openapi.json"], "err");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "openapi.json";
      a.click();
      URL.revokeObjectURL(url);
      $("openapiResult").innerHTML = `<div class="msg ok">openapi.json didownload — import ke Postman/Insomnia/Swagger UI.</div>`;
    } catch (e) {
      $("openapiResult").innerHTML = renderMessages(["Request gagal: " + e.message], "err");
    }
  });

  /* ---------------- Backup & restore ---------------- */
  $("backupDownloadBtn").addEventListener("click", async () => {
    try {
      const res = await adminFetch("/api/admin/backup");
      if (!res.ok) {
        $("backupResult").innerHTML = renderMessages(["Gagal generate backup."], "err");
        return;
      }
      // Nama file dari header Content-Disposition (server yang nge-stamp
      // waktunya), fallback nama polos kalau header-nya gak kebaca.
      const cd = res.headers.get("Content-Disposition") || "";
      const fname = /filename="([^"]+)"/.exec(cd)?.[1] || "febry-api-backup.json";
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fname;
      a.click();
      URL.revokeObjectURL(url);
      $("backupResult").innerHTML = `<div class="msg ok">Backup didownload (${fname}) — simpen di tempat aman, isinya termasuk API key client.</div>`;
    } catch (e) {
      $("backupResult").innerHTML = renderMessages(["Request gagal: " + e.message], "err");
    }
  });

  $("backupRestoreBtn").addEventListener("click", () => $("backupFile").click());
  $("backupFile").addEventListener("change", async () => {
    const file = $("backupFile").files[0];
    $("backupFile").value = ""; // biar file yang sama bisa dipilih ulang
    if (!file) return;

    let bundle;
    try {
      bundle = JSON.parse(await file.text());
    } catch {
      $("backupResult").innerHTML = renderMessages(["File bukan JSON valid."], "err");
      return;
    }
    const fileCount = bundle && bundle.files && typeof bundle.files === "object" ? Object.keys(bundle.files).length : 0;
    if (!confirm(`Restore ${fileCount} file dari backup${bundle.createdAt ? ` (dibuat ${bundle.createdAt})` : ""}?\n\nFile yang ada sekarang bakal DITIMPA. Kondisi sebelum restore kecatat di Riwayat, jadi masih bisa di-rollback.`)) return;

    $("backupResult").innerHTML = `<div class="msg">Restore...</div>`;
    try {
      const res = await adminFetch("/api/admin/backup/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bundle)
      });
      const json = await res.json();
      if (!json.status) {
        $("backupResult").innerHTML = renderMessages([json.error || "Gagal restore"], "err");
        return;
      }
      $("backupResult").innerHTML =
        `<div class="msg ok">${escapeHtml(json.result.message)}</div>` +
        (json.result.skipped || []).map((s) => `<div class="hint">di-skip: ${escapeHtml(s)}</div>`).join("");
      loadHistory();
    } catch (e) {
      $("backupResult").innerHTML = renderMessages(["Request gagal: " + e.message], "err");
    }
  });

  loadHistory();
  loadUsage();
  loadCache();
  loadLogs();
})();

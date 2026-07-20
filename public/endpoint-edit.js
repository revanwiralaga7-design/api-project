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
  renderNav(null);

  const params = new URLSearchParams(location.search);
  const originalPath = params.get("path") || "";
  const originalMethod = params.get("method") || "ALL";

  const form = window.EndpointForm.init();

  if (!originalPath) {
    $("origBadge").textContent = "";
    $("notFoundMsg").style.display = "block";
    $("notFoundMsg").innerHTML =
      renderMessages(
        ['Gak ada endpoint yang dipilih. Kembali ke dashboard dan klik "Edit" di salah satu endpoint.'],
        "err"
      ) + `<div class="actions"><a class="btn btn-secondary" href="/admin.html">&larr; Dashboard</a></div>`;
    return;
  }

  $("origBadge").innerHTML =
    `<span class="badge ${methodBadgeClass(originalMethod)}">${escapeHtml(originalMethod)}</span> <code>${escapeHtml(originalPath)}</code>`;
  $("regenOrigLabel").textContent = `${originalMethod} ${originalPath}`;

  function renderQeParams(query) {
    const wrap = $("qeParamsList");
    if (!query.length) {
      wrap.innerHTML = `<div class="hint">Endpoint ini gak punya query parameter.</div>`;
      return;
    }
    wrap.innerHTML = query
      .map(
        (p, i) => `
      <div class="qe-param-row" data-idx="${i}" data-name="${escapeHtml(p.name)}">
        <div>
          <div class="qname">${escapeHtml(p.name)}</div>
          <input type="text" class="qe-desc" placeholder="deskripsi" value="${escapeHtml(p.desc || "")}">
        </div>
        <label><input type="checkbox" class="qe-req" ${p.required ? "checked" : ""}> wajib</label>
      </div>
    `
      )
      .join("");
  }

  function renderQePathParams(pathParams) {
    if (!pathParams.length) return;
    $("qePathParamsWrap").style.display = "block";
    $("qePathParamsList").innerHTML = pathParams
      .map(
        (p) => `
      <div class="qe-pathparam">:${escapeHtml(p.name)} — ${escapeHtml(p.desc || "(tanpa deskripsi)")}</div>
    `
      )
      .join("");
  }

  async function loadQeCategories(selectedId) {
    try {
      const res = await adminFetch("/api/admin/meta");
      const json = await res.json();
      if (!json.status) return;
      const sel = $("qeCategory");
      sel.innerHTML = json.result.categories
        .map((c) => `<option value="${c.id}">${escapeHtml(c.label)} (${escapeHtml(c.id)})</option>`)
        .join("");
      if (selectedId) sel.value = selectedId;
    } catch (e) {
      console.error("Gagal load kategori", e);
    }
  }

  function guessSubPath(fullPath, routeSlug) {
    const prefix = `/api/${routeSlug}`;
    return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) || "/" : fullPath;
  }

  async function loadDetail() {
    try {
      const res = await adminFetch(
        `/api/admin/endpoints/detail?path=${encodeURIComponent(originalPath)}&method=${encodeURIComponent(originalMethod)}`
      );
      const json = await res.json();
      if (!json.status) {
        $("notFoundMsg").style.display = "block";
        $("notFoundMsg").innerHTML =
          renderMessages([json.error || "Endpoint gak ketemu."], "err") +
          `<div class="actions"><a class="btn btn-secondary" href="/admin.html">&larr; Dashboard</a></div>`;
        return;
      }
      const ep = json.result.endpoint;
      $("editWrap").style.display = "block";

      // --- Section A: quick edit ---
      $("qeName").value = ep.name;
      $("qeDesc").value = ep.desc;
      renderQePathParams(ep.pathParams || []);
      renderQeParams(ep.query || []);
      await loadQeCategories(ep.categoryId);

      // --- Section B: prefill "Regenerate Penuh" ---
      const routeSlug = ep.routeFileBase || (originalPath.match(/^\/api\/([^/]+)/) || ["", ""])[1];
      $("endpointName").value = ep.name;
      $("endpointDesc").value = ep.desc;
      $("httpMethod").value = ["GET", "POST", "ALL"].includes(ep.method) ? ep.method : "ALL";
      $("subPath").value = guessSubPath(originalPath, routeSlug);
      $("serviceFileName").value = ep.suggestedServiceFileName || routeSlug;
      $("instanceName").value = ep.suggestedInstanceName || ep.suggestedServiceFileName || routeSlug;

      const bestGuessParams = (ep.query || []).map((q) => ({
        serviceParamName: q.name,
        requestParamName: q.name,
        required: q.required,
        desc: q.desc,
      }));
      form.setParamPrefill(bestGuessParams);

      await form.loadMeta();
      if (ep.endpointCountInSameFile === 1) {
        form.setRouteMode("new");
        $("newRouteSlug").value = routeSlug;
      } else {
        form.setRouteMode("existing");
        if ([...document.querySelectorAll("#routeFile option")].some((o) => o.value === routeSlug)) {
          $("routeFile").value = routeSlug;
        }
      }
      form.setCategoryMode("existing");
      if (ep.categoryId) $("categoryId").value = ep.categoryId;
    } catch (e) {
      $("notFoundMsg").style.display = "block";
      $("notFoundMsg").innerHTML = renderMessages(["Request gagal: " + e.message], "err");
    }
  }
  loadDetail();

  /* ---------------- Section A: simpan quick edit ---------------- */
  $("qeSaveBtn").addEventListener("click", async () => {
    const qeResultEl = $("qeResult");
    const paramsPayload = [];
    $("qeParamsList")
      .querySelectorAll(".qe-param-row")
      .forEach((row) => {
        paramsPayload.push({
          name: row.dataset.name,
          required: row.querySelector(".qe-req").checked,
          desc: row.querySelector(".qe-desc").value.trim(),
        });
      });

    qeResultEl.innerHTML = `<div class="msg">Menyimpan...</div>`;
    $("qeSaveBtn").disabled = true;
    try {
      const res = await adminFetch("/api/admin/endpoints/quick-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: originalPath,
          method: originalMethod,
          endpointName: $("qeName").value.trim(),
          endpointDesc: $("qeDesc").value.trim(),
          categoryId: $("qeCategory").value,
          params: paramsPayload,
        }),
      });
      const json = await res.json();
      if (!json.status) {
        qeResultEl.innerHTML = renderMessages([json.error || "Gagal update"], "err");
        $("qeSaveBtn").disabled = false;
        return;
      }
      qeResultEl.innerHTML =
        `<div class="msg ok">${escapeHtml(json.result.message)}</div>` +
        renderMessages(json.result.warnings, "warn") +
        `<div class="actions"><a class="btn btn-secondary" href="/admin.html">&larr; Kembali ke Dashboard</a></div>`;
    } catch (e) {
      qeResultEl.innerHTML = renderMessages(["Request gagal: " + e.message], "err");
    }
    $("qeSaveBtn").disabled = false;
  });

  /* ---------------- Section B: preview & apply regenerate penuh ---------------- */
  const resultEl = $("result");
  let lastPayload = null;

  $("previewBtn").addEventListener("click", async () => {
    resultEl.innerHTML = `<div class="msg">Memproses preview...</div>`;
    $("applyBtn").disabled = true;
    lastPayload = { ...form.buildPayload(), originalPath, originalMethod };
    try {
      const res = await adminFetch("/api/admin/edit/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lastPayload),
      });
      const json = await res.json();
      if (!json.status) {
        resultEl.innerHTML = renderMessages([json.error || "Gagal preview"], "err");
        return;
      }
      const { warnings, files, summary } = json.result;
      resultEl.innerHTML =
        `<div class="msg ok">${escapeHtml(summary.removedMethod)} ${escapeHtml(summary.removedPath)} akan diganti jadi ${escapeHtml(summary.newMethod)} ${escapeHtml(summary.newPath)}</div>` +
        renderMessages(warnings, "warn") +
        renderFiles(files);
      $("applyBtn").disabled = false;
    } catch (e) {
      resultEl.innerHTML = renderMessages(["Request gagal: " + e.message], "err");
    }
  });

  $("applyBtn").addEventListener("click", async () => {
    if (!lastPayload) return;
    $("applyBtn").disabled = true;
    resultEl.innerHTML += `<div class="msg">Menulis file...</div>`;
    try {
      const res = await adminFetch("/api/admin/edit/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lastPayload),
      });
      const json = await res.json();
      if (!json.status) {
        resultEl.innerHTML += renderMessages(
          [json.error || "Gagal apply (semua perubahan sudah di-rollback, project aman)"],
          "err"
        );
        $("applyBtn").disabled = false;
        return;
      }
      resultEl.innerHTML +=
        `<div class="msg ok">${escapeHtml(json.result.message)}</div>` +
        `<div class="actions"><a class="btn btn-secondary" href="/admin.html">&larr; Kembali ke Dashboard</a></div>`;
    } catch (e) {
      resultEl.innerHTML += renderMessages(["Request gagal: " + e.message], "err");
      $("applyBtn").disabled = false;
    }
  });
})();

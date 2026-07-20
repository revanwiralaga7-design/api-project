(async function () {
  "use strict";
  const { $, adminFetch, escapeHtml, renderMessages, renderFiles, renderNav, guardAdminAccess } = window.AdminShared;
  if (!(await guardAdminAccess())) return;
  renderNav("add");

  const form = window.EndpointForm.init();
  const resultEl = $("result");
  let lastPayload = null;
  let lastApplyResult = null;
  let batchMode = false;

  /* ---------------- Mode batch (banyak method -> banyak endpoint) ---------------- */
  form.onAnalyzed((analyzed) => {
    const wrap = $("batchWrap");
    if (!analyzed.methods.length || analyzed.methods.length < 2) {
      wrap.style.display = "none";
      return;
    }
    wrap.style.display = "block";
    $("batchToggle").checked = false;
    batchMode = false;
    renderBatchList(analyzed);
    $("batchList").style.display = "none";
    $("batchHint").style.display = "none";
  });

  $("batchToggle").addEventListener("change", () => {
    batchMode = $("batchToggle").checked;
    $("batchList").style.display = batchMode ? "block" : "none";
    $("batchHint").style.display = batchMode ? "block" : "none";
    // Di mode batch, pemilihan method satuan gak dipakai — preview boleh
    // langsung tanpa klik method dulu.
    if (batchMode) $("previewBtn").disabled = false;
  });

  function renderBatchList(analyzed) {
    const el = $("batchList");
    el.innerHTML = analyzed.methods.map((m) => {
      const suggested = "/" + m.name.toLowerCase();
      const internal = m.isCalledInternally;
      return `
        <div class="param-row batch-row" data-method="${escapeHtml(m.name)}" style="grid-template-columns:auto 1fr 1fr;">
          <label style="display:flex; align-items:center; gap:6px; margin:0; cursor:pointer;">
            <input type="checkbox" class="b-pick" style="width:auto;" ${internal ? "" : "checked"}>
            <code>${escapeHtml(m.name)}</code>${internal ? ' <span class="hint" style="display:inline; margin:0;">🔗 internal</span>' : ""}
          </label>
          <input type="text" class="b-subpath" value="${escapeHtml(suggested)}" placeholder="/sub-path">
          <input type="text" class="b-name" value="${escapeHtml(m.name)}" placeholder="nama endpoint">
        </div>`;
    }).join("");
  }

  function buildBatchPayload() {
    const base = form.buildPayload();
    const analyzed = form.getAnalyzed();
    const endpoints = [];
    $("batchList").querySelectorAll(".batch-row").forEach((row) => {
      if (!row.querySelector(".b-pick").checked) return;
      const methodName = row.dataset.method;
      const m = analyzed.methods.find((x) => x.name === methodName);
      endpoints.push({
        selectedMethod: methodName,
        subPath: row.querySelector(".b-subpath").value.trim() || "/" + methodName.toLowerCase(),
        httpMethod: base.httpMethod,
        endpointName: row.querySelector(".b-name").value.trim() || methodName,
        endpointDesc: base.endpointDesc,
        // Mapping otomatis: nama field request = nama parameter service.
        methodParams: (m ? m.paramNames : []).map((n) => ({ serviceParamName: n, requestParamName: n, required: true })),
        ctorParams: base.ctorParams
      });
    });
    const { selectedMethod, subPath, httpMethod, endpointName, endpointDesc, methodParams, ctorParams, ...shared } = base;
    return { ...shared, httpMethod: base.httpMethod, endpointDesc: base.endpointDesc, ctorParams: base.ctorParams, endpoints };
  }

  $("previewBtn").addEventListener("click", async () => {
    resultEl.innerHTML = `<div class="msg">Memproses preview...</div>`;
    $("applyBtn").disabled = true;
    $("verifyWrap").style.display = "none";
    const url = batchMode ? "/api/admin/batch/preview" : "/api/admin/preview";
    lastPayload = batchMode ? buildBatchPayload() : form.buildPayload();
    if (batchMode && (!lastPayload.endpoints || !lastPayload.endpoints.length)) {
      resultEl.innerHTML = renderMessages(["Centang minimal 1 method di daftar batch."], "err");
      return;
    }
    try {
      const res = await adminFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lastPayload)
      });
      const json = await res.json();
      if (!json.status) {
        resultEl.innerHTML = renderMessages([json.error || "Gagal preview"], "err");
        return;
      }
      const { warnings, files, summary } = json.result;
      const headline = batchMode
        ? `<div class="msg ok">${summary.endpoints.length} endpoint akan dibuat: ${summary.endpoints.map((e) => `${escapeHtml(e.method)} ${escapeHtml(e.fullPath)}`).join(" · ")}</div>`
        : `<div class="msg ok">Endpoint akan dibuat di: ${escapeHtml(summary.method)} ${escapeHtml(summary.fullPath)}</div>`;
      resultEl.innerHTML = headline + renderMessages(warnings, "warn") + renderFiles(files);
      $("applyBtn").disabled = false;
    } catch (e) {
      resultEl.innerHTML = renderMessages(["Request gagal: " + e.message], "err");
    }
  });

  $("applyBtn").addEventListener("click", async () => {
    if (!lastPayload) return;
    $("applyBtn").disabled = true;
    resultEl.innerHTML += `<div class="msg">Menulis file...</div>`;
    const url = batchMode ? "/api/admin/batch/apply" : "/api/admin/apply";
    try {
      const res = await adminFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lastPayload)
      });
      const json = await res.json();
      if (!json.status) {
        resultEl.innerHTML += renderMessages([json.error || "Gagal apply (semua perubahan sudah di-rollback, project aman)"], "err");
        $("applyBtn").disabled = false;
        return;
      }
      lastApplyResult = json.result;
      resultEl.innerHTML +=
        `<div class="msg ok">${escapeHtml(json.result.message)}</div>` +
        `<div class="msg ok">File ditulis: ${json.result.filesWritten.join(", ")}</div>` +
        `<div class="actions"><a class="btn btn-secondary" href="/admin.html">&larr; Kembali ke Dashboard</a></div>`;

      if (batchMode) return; // verify satuan cuma buat mode single

      $("verifyWrap").style.display = "block";
      $("verifyResult").innerHTML = `<div class="msg">Nunggu server restart (nodemon) sebelum bisa di-test...</div>`;
      setTimeout(runVerify, 2500);
    } catch (e) {
      resultEl.innerHTML += renderMessages(["Request gagal: " + e.message], "err");
      $("applyBtn").disabled = false;
    }
  });

  async function runVerify() {
    if (!lastApplyResult) return;
    const verifyResultEl = $("verifyResult");
    verifyResultEl.innerHTML = `<div class="msg">Testing endpoint...</div>`;
    const testParams = {};
    $("methodParamsList").querySelectorAll(".param-row").forEach((row) => {
      const reqName = row.querySelector(".p-reqname").value.trim();
      if (reqName) testParams[reqName] = "test";
    });
    $("ctorParamsList").querySelectorAll(".ctor-row").forEach((row) => {
      if (row.querySelector(".c-source").value === "request") {
        const v = row.querySelector(".c-value").value.trim();
        if (v) testParams[v] = "test";
      }
    });
    try {
      const res = await adminFetch("/api/admin/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullPath: lastApplyResult.fullPath, method: lastApplyResult.method, testParams })
      });
      const json = await res.json();
      const r = json.result || {};
      if (r.success) {
        verifyResultEl.innerHTML = `<div class="msg ok">Endpoint berhasil dijalankan (status ${r.status}). Response: ${escapeHtml(JSON.stringify(r.body).slice(0, 300))}</div>`;
      } else {
        verifyResultEl.innerHTML =
          renderMessages([r.message || "Test gagal."], "warn") +
          (r.body ? `<div class="msg err">${escapeHtml(JSON.stringify(r.body).slice(0, 300))}</div>` : "") +
          `<div class="actions"><button class="btn btn-secondary" id="verifyRetryBtn">Test Lagi</button></div>`;
        const retry = $("verifyRetryBtn");
        if (retry) retry.addEventListener("click", runVerify);
      }
    } catch (e) {
      verifyResultEl.innerHTML = renderMessages(["Gagal test: " + e.message], "err");
    }
  }
  $("verifyBtn").addEventListener("click", runVerify);
})();

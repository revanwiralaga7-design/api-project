/**
 * endpoint-form.js — logic form "definisi endpoint" (paste class code ->
 * pilih method -> atur parameter -> pilih route file & kategori) yang
 * PERSIS SAMA dipakai di endpoint-add.html (bikin baru) dan
 * endpoint-edit.html (bagian "Regenerate Penuh"). Satu modul, dua pemakai
 * — supaya perilakunya gak pernah beda-beda antara dua halaman itu.
 *
 * Butuh markup dengan id yang sama seperti di endpoint-add.html. Load
 * SETELAH admin-shared.js.
 */
(function () {
  "use strict";
  const { $, adminFetch, escapeHtml, renderMessages } = window.AdminShared;

  function initEndpointForm() {
    let routeMode = "new";
    let catMode = "existing";
    let analyzed = null; // { className, methods, constructor, depWarnings }
    let selectedMethodName = null;
    let onAnalyzedCb = null;
    let pendingParamPrefill = null;

    function setupToggle(newBtn, existingBtn, onChange) {
      newBtn.addEventListener("click", () => {
        newBtn.classList.add("active");
        existingBtn.classList.remove("active");
        onChange(newBtn.dataset.mode);
      });
      existingBtn.addEventListener("click", () => {
        existingBtn.classList.add("active");
        newBtn.classList.remove("active");
        onChange(existingBtn.dataset.mode);
      });
    }

    setupToggle($("routeModeNewBtn"), $("routeModeExistingBtn"), (mode) => {
      routeMode = mode;
      $("newRouteWrap").style.display = mode === "new" ? "block" : "none";
      $("existingRouteWrap").style.display = mode === "existing" ? "block" : "none";
    });

    setupToggle($("catModeNewBtn"), $("catModeExistingBtn"), (mode) => {
      catMode = mode;
      $("catExistingWrap").style.display = mode === "existing" ? "block" : "none";
      $("catNewWrap").style.display = mode === "new" ? "block" : "none";
    });
    $("catModeExistingBtn").classList.add("active");
    $("catModeNewBtn").classList.remove("active");

    /* ---------------- Load meta (kategori & route file existing) ---------------- */
    async function loadMeta() {
      try {
        const res = await adminFetch("/api/admin/meta");
        const json = await res.json();
        if (!json.status) return;
        const { categories, routeFiles } = json.result;

        const catSel = $("categoryId");
        catSel.innerHTML = categories.map((c) => `<option value="${c.id}">${escapeHtml(c.label)} (${escapeHtml(c.id)})</option>`).join("");

        const routeSel = $("routeFile");
        routeSel.innerHTML = routeFiles.map((r) => `<option value="${r}">${escapeHtml(r)}.routes.js</option>`).join("");
      } catch (e) {
        console.error("Gagal load meta", e);
      }
    }
    loadMeta();

    function signatureLabel(m) {
      if (m.paramStyle === "none") return `${m.name}()`;
      const metaList = m.paramsMeta || [];
      const parts = m.paramNames.map((n, i) => {
        const meta = metaList[i];
        if (!meta) return n;
        if (meta.kind === "rest") return `...${meta.name}`;
        if (meta.kind === "alias") return meta.hasDefault ? `${meta.source}: ${meta.target} = ${meta.defaultValue}` : `${meta.source}: ${meta.target}`;
        if (meta.hasDefault) return `${meta.name} = ${meta.defaultValue}`;
        return meta.name || n;
      });
      if (m.paramStyle === "object") return `${m.name}({ ${parts.join(", ")} }${m.paramsOptional ? " = {}" : ""})`;
      return `${m.name}(${parts.join(", ")})`;
    }

    /* ---------------- 1. Analisis Class ---------------- */
    $("analyzeBtn").addEventListener("click", async () => {
      const code = $("classCode").value;
      const analyzeResultEl = $("analyzeResult");
      if (!code.trim()) {
        analyzeResultEl.innerHTML = renderMessages(["Paste kode class dulu."], "err");
        return;
      }
      analyzeResultEl.innerHTML = `<div class="msg">Menganalisis...</div>`;
      try {
        const res = await adminFetch("/api/admin/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ classCode: code })
        });
        const json = await res.json();
        if (!json.status) {
          analyzeResultEl.innerHTML = renderMessages([json.error || "Gagal analisis"], "err");
          $("methodPanel").classList.add("disabled");
          $("restPanel").classList.add("disabled");
          $("previewBtn").disabled = true;
          return;
        }
        analyzed = json.result;
        selectedMethodName = null;

        analyzeResultEl.innerHTML =
          `<div class="msg ok">Class "${escapeHtml(analyzed.className)}" kedetect, ${analyzed.methods.length} method ketemu.</div>` +
          renderMessages(
            analyzed.depWarnings.length ? [`Package belum ke-install: ${analyzed.depWarnings.join(", ")}`] : [],
            "warn"
          );

        $("classNameTag").textContent = analyzed.className;
        renderMethodList();
        renderCtorSection();
        $("methodPanel").classList.remove("disabled");

        const depsWrap = $("depsWrap");
        if (analyzed.depWarnings.length) {
          depsWrap.style.display = "block";
          $("depsLabel").textContent = `Auto tambahkan ke package.json: ${analyzed.depWarnings.join(", ")}`;
        } else {
          depsWrap.style.display = "none";
        }
        if (onAnalyzedCb) onAnalyzedCb(analyzed);
      } catch (e) {
        analyzeResultEl.innerHTML = renderMessages(["Request gagal: " + e.message], "err");
      }
    });

    function renderMethodList() {
      const wrap = $("methodList");
      if (!analyzed.methods.length) {
        wrap.innerHTML = `<div class="msg warn">Class ini gak punya method publik sama sekali.</div>`;
        return;
      }
      wrap.innerHTML = analyzed.methods.map((m) => {
        const validationLabel = m.validation && m.validation.lines.length ? ` · ${m.validation.lines.join(" ")}` : "";
        const internalLabel = m.isCalledInternally ? ` · 🔗 dipanggil internal (kemungkinan helper, gak wajib jadi endpoint)` : "";
        return `
        <div class="method-card" data-name="${escapeHtml(m.name)}">
          <div class="mname">${escapeHtml(signatureLabel(m))}</div>
          <div class="msig">${m.isAsync ? "async" : "sync"}${m.isArrowField ? " · arrow field" : ""}${escapeHtml(internalLabel)}${escapeHtml(validationLabel)}</div>
        </div>
      `;
      }).join("");
      wrap.querySelectorAll(".method-card").forEach((card) => {
        card.addEventListener("click", () => selectMethod(card.dataset.name, pendingParamPrefill));
      });
    }

    function selectMethod(name, prefillParams) {
      selectedMethodName = name;
      $("methodList").querySelectorAll(".method-card").forEach((c) => {
        c.classList.toggle("selected", c.dataset.name === name);
      });
      const m = analyzed.methods.find((x) => x.name === name);
      if (!m) return;
      renderMethodParams(m, prefillParams);
      $("restPanel").classList.remove("disabled");
      $("previewBtn").disabled = false;
    }

    function renderMethodParams(method, prefillParams) {
      const wrap = $("methodParamsList");
      const prefillMap = new Map((prefillParams || []).map((p) => [p.serviceParamName, p]));
      if (!method.paramNames.length) {
        wrap.innerHTML = `<div class="hint">Method ini gak butuh parameter.</div>`;
        return;
      }
      const metaList = method.paramsMeta || [];
      wrap.innerHTML = method.paramNames.map((n, i) => {
        const meta = metaList[i] || {};
        const isRest = meta.kind === "rest";
        const isAlias = meta.kind === "alias";
        const hasDefault = !!meta.hasDefault;
        let badge = "";
        if (isRest) badge = " · rest (nampung sisa properti apa aja)";
        else if (isAlias) badge = ` · alias → var lokal "${meta.target}" di service`;
        if (hasDefault) badge += ` · default: ${meta.defaultValue}`;
        const lockRequired = isRest || hasDefault;
        const pre = prefillMap.get(n);
        const reqName = pre ? pre.requestParamName : n;
        const isChecked = pre ? pre.required : !lockRequired;
        const checked = lockRequired ? "" : (isChecked ? "checked" : "");
        const disabled = lockRequired ? "disabled" : "";
        const descVal = pre ? (pre.desc || "") : "";
        return `
        <div class="param-row" data-svc="${escapeHtml(n)}">
          <div class="svc-key" title="nama parameter di service">${escapeHtml(n)}${escapeHtml(badge)}</div>
          <input type="text" class="p-reqname" placeholder="nama field request" value="${escapeHtml(reqName)}">
          <label><input type="checkbox" class="p-req" ${checked} ${disabled}> wajib</label>
          <div></div>
        </div>
        <input type="text" class="p-desc" placeholder="deskripsi parameter '${escapeHtml(n)}'" value="${escapeHtml(descVal)}" style="margin-top:-4px;">
      `;
      }).join("");
    }

    function renderCtorSection(prefillCtor) {
      const ctorWrap = $("ctorWrap");
      const listEl = $("ctorParamsList");
      const ctor = analyzed.constructor;
      if (!ctor || !ctor.paramNames.length) {
        ctorWrap.style.display = "none";
        listEl.innerHTML = "";
        return;
      }
      const prefillMap = new Map((prefillCtor || []).map((p) => [p.serviceParamName, p]));
      ctorWrap.style.display = "block";
      listEl.innerHTML = ctor.paramNames.map((n) => {
        const pre = prefillMap.get(n);
        const source = pre ? pre.source : "request";
        const value = pre ? (pre.source === "static" ? pre.staticValue : pre.requestParamName) : n;
        return `
        <div class="ctor-row" data-svc="${escapeHtml(n)}">
          <div class="svc-key" title="nama parameter constructor">${escapeHtml(n)}</div>
          <select class="c-source">
            <option value="request" ${source === "request" ? "selected" : ""}>Dari request</option>
            <option value="static" ${source === "static" ? "selected" : ""}>Nilai tetap</option>
          </select>
          <input type="text" class="c-value" placeholder="nama field request, mis. ${escapeHtml(n)}" value="${escapeHtml(value || "")}">
          <div></div>
        </div>
      `;
      }).join("");
      listEl.querySelectorAll(".ctor-row").forEach((row) => {
        const source = row.querySelector(".c-source");
        const valueInput = row.querySelector(".c-value");
        const svc = row.dataset.svc;
        source.addEventListener("change", () => {
          if (source.value === "static") {
            valueInput.placeholder = `nilai tetap buat "${svc}", mis. API key`;
            valueInput.value = "";
          } else {
            valueInput.placeholder = `nama field request, mis. ${svc}`;
            valueInput.value = svc;
          }
        });
      });
    }

    /* ---------------- Build payload ---------------- */
    function buildPayload() {
      const methodParams = [];
      $("methodParamsList").querySelectorAll(".param-row").forEach((row) => {
        const serviceParamName = row.dataset.svc;
        const requestParamName = row.querySelector(".p-reqname").value.trim() || serviceParamName;
        const required = row.querySelector(".p-req").checked;
        const descInput = row.nextElementSibling && row.nextElementSibling.classList.contains("p-desc") ? row.nextElementSibling : null;
        methodParams.push({ serviceParamName, requestParamName, required, desc: descInput ? descInput.value.trim() : "" });
      });

      const ctorParams = [];
      $("ctorParamsList").querySelectorAll(".ctor-row").forEach((row) => {
        const serviceParamName = row.dataset.svc;
        const source = row.querySelector(".c-source").value;
        const value = row.querySelector(".c-value").value.trim();
        if (source === "static") {
          ctorParams.push({ serviceParamName, source: "static", staticValue: value });
        } else {
          ctorParams.push({ serviceParamName, source: "request", requestParamName: value || serviceParamName, required: true });
        }
      });

      const payload = {
        classCode: $("classCode").value,
        serviceFileName: $("serviceFileName").value.trim(),
        instanceName: $("instanceName").value.trim(),
        routeMode,
        routeFile: $("routeFile").value,
        newRouteSlug: $("newRouteSlug").value.trim(),
        subPath: $("subPath").value.trim(),
        httpMethod: $("httpMethod").value,
        selectedMethod: selectedMethodName,
        methodParams,
        ctorParams,
        endpointName: $("endpointName").value.trim(),
        endpointDesc: $("endpointDesc").value.trim(),
        categoryMode: catMode,
        autoInstallDeps: $("autoInstallDeps").checked
      };

      if (catMode === "existing") {
        payload.categoryId = $("categoryId").value;
      } else {
        payload.newCategory = {
          id: $("newCatId").value.trim(),
          tag: $("newCatTag").value.trim(),
          label: $("newCatLabel").value.trim(),
          desc: $("newCatDesc").value.trim()
        };
      }
      return payload;
    }

    /**
     * Set mode route/kategori secara programatik (dipakai endpoint-edit.html
     * buat default ke slug/kategori endpoint yang sedang diedit).
     */
    function setRouteMode(mode) {
      const btn = mode === "existing" ? $("routeModeExistingBtn") : $("routeModeNewBtn");
      btn.click();
    }
    function setCategoryMode(mode) {
      const btn = mode === "new" ? $("catModeNewBtn") : $("catModeExistingBtn");
      btn.click();
    }

    return {
      buildPayload,
      loadMeta,
      setRouteMode,
      setCategoryMode,
      selectMethod,
      renderCtorSection,
      setParamPrefill(arr) { pendingParamPrefill = arr; },
      onAnalyzed(cb) { onAnalyzedCb = cb; },
      getAnalyzed() { return analyzed; }
    };
  }

  window.EndpointForm = { init: initEndpointForm };
})();

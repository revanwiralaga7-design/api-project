(function () {
  "use strict";

  const jackGrid = document.getElementById("jackGrid");
  const sidebar = document.getElementById("sidebar");
  const main = document.getElementById("mainContent");
  const baseUrlInput = document.getElementById("baseUrlInput");
  const baseLed = document.getElementById("baseLed");
  const pingBtn = document.getElementById("pingBtn");
  const totalMeta = document.getElementById("totalMeta");

  const totalEndpoints = CATEGORIES.reduce((n, c) => n + c.endpoints.length, 0);
  totalMeta.textContent = `${CATEGORIES.length} kategori · ${totalEndpoints} endpoint · Express.js`;

  // ---------- Base URL: auto-detect dari origin halaman ini, bukan ----------
  // hardcode localhost. Jadi kalau diakses lewat tunnel (Railway, ngrok,
  // dst) atau domain production, otomatis kepake, bukan localhost mulu.
  // Tetep bisa diganti manual (misal buat nembak backend lain buat tes),
  // dan pilihan manual itu diinget lewat localStorage biar gak reset
  // tiap reload.
  const BASE_URL_STORAGE = "justice_api_base_url";
  const savedBaseUrl = localStorage.getItem(BASE_URL_STORAGE);
  baseUrlInput.value = savedBaseUrl || window.location.origin;
  baseUrlInput.addEventListener("change", () => {
    localStorage.setItem(BASE_URL_STORAGE, getBaseUrl());
  });

  function getBaseUrl() {
    return baseUrlInput.value.trim().replace(/\/+$/, "");
  }

  // ---------- Patch panel + sidebar ----------
  CATEGORIES.forEach((cat) => {
    const jack = document.createElement("a");
    jack.href = `#cat-${cat.id}`;
    jack.className = "jack";
    jack.style.setProperty("--jack-accent", cat.accent);
    jack.innerHTML = `
      <div class="jack-top">
        <span class="jack-tag">${cat.tag}</span>
        <span class="jack-led" data-jackled="${cat.id}"></span>
      </div>
      <span class="jack-name">${cat.label}</span>
      <span class="jack-count">${cat.endpoints.length} rute</span>
    `;
    jackGrid.appendChild(jack);

    const link = document.createElement("a");
    link.href = `#cat-${cat.id}`;
    link.dataset.navfor = cat.id;
    link.style.setProperty("--sidebar-accent", cat.accent);
    link.innerHTML = `<span class="sw" style="background:${cat.accent}"></span>${cat.label}<span class="count">${cat.endpoints.length}</span>`;
    sidebar.appendChild(link);
  });

  // ---------- Sections ----------
  CATEGORIES.forEach((cat) => {
    const section = document.createElement("section");
    section.className = "section";
    section.id = `cat-${cat.id}`;

    const head = document.createElement("div");
    head.className = "section-head";
    head.innerHTML = `
      <span class="bar" style="--sec-accent:${cat.accent}; background:${cat.accent}"></span>
      <h2>${cat.label}</h2>
      <span class="scount">${cat.endpoints.length} endpoint</span>
    `;
    section.appendChild(head);

    const desc = document.createElement("p");
    desc.className = "section-desc";
    desc.textContent = cat.desc;
    section.appendChild(desc);

    cat.endpoints.forEach((ep) => section.appendChild(buildCard(ep, cat)));
    main.appendChild(section);
  });

  // ---------- Card builder ----------
  function buildCard(ep, cat) {
    const card = document.createElement("div");
    card.className = "card";

    const badgeClass = ep.method === "GET" ? "badge-get" : ep.method === "POST" ? "badge-post" : "badge-all";
    const badgeLabel = ep.method === "ALL" ? "GET/POST" : ep.method;

    const head = document.createElement("div");
    head.className = "card-head";
    head.innerHTML = `
      <span class="badge ${badgeClass}">${badgeLabel}</span>
      <span class="card-path">${ep.path}</span>
      <span class="chev">&#9656;</span>
    `;
    head.addEventListener("click", () => card.classList.toggle("open"));
    card.appendChild(head);

    const body = document.createElement("div");
    body.className = "card-body";

    const desc = document.createElement("p");
    desc.className = "card-desc";
    desc.textContent = `${ep.name} — ${ep.desc}`;
    body.appendChild(desc);

    if (ep.note) {
      const note = document.createElement("div");
      note.className = "card-note";
      note.textContent = ep.note;
      body.appendChild(note);
    }

    const allParams = [...(ep.pathParams || []), ...(ep.query || []), ...(ep.headers || [])];
    if (allParams.length) {
      const table = document.createElement("table");
      table.className = "params-table";
      table.innerHTML = `
        <thead><tr><th>Parameter</th><th>Tipe</th><th>Keterangan</th></tr></thead>
        <tbody>
          ${allParams
            .map(
              (p) => `
            <tr>
              <td><code>${p.name}</code></td>
              <td>${p.required ? '<span class="req-tag">wajib</span>' : '<span class="opt-tag">opsional</span>'}${
                (ep.pathParams || []).includes(p)
                  ? " · path"
                  : (ep.headers || []).includes(p)
                    ? " · header"
                    : " · query"
              }</td>
              <td>${p.desc}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      `;
      body.appendChild(table);
    }

    body.appendChild(buildTester(ep, cat));
    card.appendChild(body);
    return card;
  }

  // ---------- Tester builder ----------
  function buildTester(ep, _cat) {
    const tester = document.createElement("div");
    tester.className = "tester";

    const canToggleMethod = ep.method === "ALL";
    let currentMethod = ep.method === "ALL" ? "GET" : ep.method;

    const title = document.createElement("div");
    title.className = "tester-title";
    title.innerHTML = `<span>COBA API</span>`;

    if (canToggleMethod) {
      const toggle = document.createElement("div");
      toggle.className = "method-toggle";
      toggle.innerHTML = `<button type="button" data-m="GET" class="active">GET</button><button type="button" data-m="POST">POST</button>`;
      toggle.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("click", () => {
          currentMethod = btn.dataset.m;
          toggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
        });
      });
      title.appendChild(toggle);
    }
    tester.appendChild(title);

    const inputs = {}; // name -> input element
    (ep.pathParams || []).forEach((p) => tester.appendChild(buildField(p, inputs, "path")));
    (ep.query || []).forEach((p) => tester.appendChild(buildField(p, inputs, "query")));
    (ep.headers || []).forEach((p) => tester.appendChild(buildField(p, inputs, "header")));

    const actions = document.createElement("div");
    actions.className = "tester-actions";
    const sendBtn = document.createElement("button");
    sendBtn.className = "btn-send";
    sendBtn.innerHTML = `<span class="spinner"></span><span class="btn-send-label">Kirim Request</span>`;
    actions.appendChild(sendBtn);
    tester.appendChild(actions);

    // ---------- Contoh kode siap salin (curl / fetch / axios) ----------
    // Digenerate ULANG tiap tab dibuka/di-klik salin dari nilai field saat
    // itu — jadi snippet-nya selalu ngikutin apa yang lagi diketik user,
    // lengkap dengan base URL + API key akun ini (kalau login).
    const snippet = document.createElement("div");
    snippet.className = "code-snippet";
    snippet.innerHTML = `
      <div class="tester-title" style="margin-top:14px;"><span>CONTOH KODE</span>
        <div class="method-toggle">
          <button type="button" data-lang="curl" class="active">curl</button>
          <button type="button" data-lang="fetch">fetch</button>
          <button type="button" data-lang="axios">axios</button>
        </div>
      </div>
      <pre class="result-body" style="display:block;margin-top:8px;"></pre>
      <div class="tester-actions" style="margin-top:8px;">
        <button type="button" class="btn-copy" data-act="copy-snippet">Salin kode</button>
      </div>
    `;
    let snippetLang = "curl";
    const snippetPre = snippet.querySelector("pre");

    // Kumpulin nilai field saat ini (tanpa validasi wajib — snippet boleh
    // pakai placeholder buat field kosong biar tetap kebentuk contoh utuh).
    function collectForSnippet() {
      const queryObj = {};
      let path = ep.path;
      const headers = {};
      Object.entries(inputs).forEach(([name, meta]) => {
        const val = meta.el.value.trim() || `<${name}>`;
        if (meta.kind === "path")
          path = path.replace(`:${name}`, encodeURIComponent(meta.el.value.trim()) || `{${name}}`);
        else if (meta.kind === "header") headers[name] = val;
        else queryObj[name] = val;
      });
      if (window.JUSTICE_API_KEY && !headers["x-api-key"]) headers["x-api-key"] = window.JUSTICE_API_KEY;
      else if (!headers["x-api-key"]) headers["x-api-key"] = "<api-key-kamu>";
      return { url: getBaseUrl() + path, queryObj, headers };
    }

    function buildSnippet() {
      const { url, queryObj, headers } = collectForSnippet();
      const isGet = currentMethod === "GET";
      const qs = new URLSearchParams(queryObj).toString();
      const fullUrl = isGet && qs ? `${url}?${qs}` : url;

      if (snippetLang === "curl") {
        return buildCurl(fullUrl, currentMethod, queryObj, headers);
      }
      if (snippetLang === "fetch") {
        const opts = [
          `method: "${currentMethod}"`,
          `headers: ${JSON.stringify(isGet ? headers : { ...headers, "Content-Type": "application/json" }, null, 2).replace(/\n/g, "\n  ")}`,
        ];
        if (!isGet) opts.push(`body: JSON.stringify(${JSON.stringify(queryObj)})`);
        return `const res = await fetch("${fullUrl}", {\n  ${opts.join(",\n  ")}\n});\nconst data = await res.json();\nconsole.log(data);`;
      }
      // axios
      if (isGet) {
        return `const { data } = await axios.get("${url}", {\n  params: ${JSON.stringify(queryObj)},\n  headers: ${JSON.stringify(headers)}\n});\nconsole.log(data);`;
      }
      return `const { data } = await axios.post("${url}", ${JSON.stringify(queryObj)}, {\n  headers: ${JSON.stringify(headers)}\n});\nconsole.log(data);`;
    }

    function refreshSnippet() {
      snippetPre.textContent = buildSnippet();
    }
    snippet.querySelectorAll("[data-lang]").forEach((btn) => {
      btn.addEventListener("click", () => {
        snippetLang = btn.dataset.lang;
        snippet.querySelectorAll("[data-lang]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        refreshSnippet();
      });
    });
    snippet.querySelector('[data-act="copy-snippet"]').addEventListener("click", (e) => {
      refreshSnippet();
      copyText(snippetPre.textContent);
      e.target.textContent = "tersalin ✓";
      setTimeout(() => {
        e.target.textContent = "Salin kode";
      }, 1500);
    });
    // Refresh pas field diketik — murah (string building doang), gak fetch.
    Object.values(inputs).forEach((meta) => meta.el.addEventListener("input", refreshSnippet));
    // Ikut refresh pas method GET/POST di-toggle (listener kedua di tombol
    // yang sama — yang pertama udah ngubah currentMethod duluan).
    tester
      .querySelectorAll(".method-toggle [data-m]")
      .forEach((btn) => btn.addEventListener("click", refreshSnippet));
    refreshSnippet();
    tester.appendChild(snippet);

    const result = document.createElement("div");
    result.className = "result";
    result.innerHTML = `
      <div class="result-meta">
        <span class="status-pill" id="status-ph"></span>
        <span class="result-time"></span>
      </div>
      <div class="quota-line" style="display:none;font-family:var(--mono);font-size:11.5px;color:var(--amber);background:rgba(255,180,84,0.08);border:1px solid rgba(255,180,84,0.25);border-radius:4px;padding:7px 10px;margin-bottom:8px;"></div>
      <div class="result-url"></div>
      <img class="result-img" style="display:none;max-width:100%;border:1px solid var(--line);border-radius:4px;margin-bottom:8px;" alt="hasil">
      <pre class="result-body"></pre>
      <div class="tester-actions" style="margin-top:8px;">
        <button type="button" class="btn-copy" data-act="copy-json">Salin JSON</button>
        <button type="button" class="btn-copy" data-act="copy-curl">Salin cURL</button>
      </div>
    `;
    tester.appendChild(result);

    sendBtn.addEventListener("click", async () => {
      // validate required fields
      let missing = false;
      let queryObj = {};
      let pathObj = {};
      let headerObj = {};
      Object.entries(inputs).forEach(([name, meta]) => {
        const val = meta.el.value.trim();
        if (meta.required && !val) {
          meta.el.classList.add("invalid");
          missing = true;
        } else {
          meta.el.classList.remove("invalid");
        }
        if (val) {
          if (meta.kind === "path") pathObj[name] = val;
          else if (meta.kind === "header") headerObj[name] = val;
          else queryObj[name] = val;
        }
      });
      if (missing) return;

      let path = ep.path;
      Object.entries(pathObj).forEach(([k, v]) => {
        path = path.replace(`:${k}`, encodeURIComponent(v));
      });

      const base = getBaseUrl();
      let url = base + path;
      let fetchOpts = { method: currentMethod, headers: { ...headerObj } };

      // Endpoint API sekarang wajib API key — sisipin otomatis key milik
      // akun yang lagi login (di-set index.html dari /auth/me). User yang
      // ngisi field header x-api-key manual (mis. tes key premium) menang.
      if (window.JUSTICE_API_KEY && !fetchOpts.headers["x-api-key"]) {
        fetchOpts.headers["x-api-key"] = window.JUSTICE_API_KEY;
      }

      if (currentMethod === "GET") {
        const qs = new URLSearchParams(queryObj).toString();
        if (qs) url += `?${qs}`;
      } else {
        fetchOpts.headers["Content-Type"] = "application/json";
        fetchOpts.body = JSON.stringify(queryObj);
      }

      sendBtn.classList.add("loading");
      sendBtn.disabled = true;
      const t0 = performance.now();
      let statusCode = null;
      let bodyText;
      let imgBlobUrl = null;
      let errored = false;
      let res = null;

      try {
        res = await fetch(url, fetchOpts);
        statusCode = res.status;
        // Endpoint canvas balikin PNG, bukan JSON — tampilin sebagai gambar,
        // jangan dipaksa .text() (hasilnya cuma binary kacau di panel hasil).
        const ctype = res.headers.get("content-type") || "";
        if (ctype.startsWith("image/")) {
          imgBlobUrl = URL.createObjectURL(await res.blob());
          bodyText = `(gambar ${ctype})`;
        } else {
          bodyText = await res.text();
        }
      } catch (e) {
        errored = true;
        bodyText = JSON.stringify(
          {
            error: "Request gagal — cek apakah Base URL benar, backend jalan, dan CORS diizinkan.",
            detail: String(e),
          },
          null,
          2
        );
      }
      const dt = Math.round(performance.now() - t0);

      sendBtn.classList.remove("loading");
      sendBtn.disabled = false;

      let pretty = bodyText;
      try {
        pretty = JSON.stringify(JSON.parse(bodyText), null, 2);
      } catch {
        /* not json, leave as-is */
      }

      const pill = result.querySelector(".status-pill");
      pill.className = "status-pill " + statusClass(statusCode, errored);
      pill.textContent = errored ? "ERROR" : `${statusCode} ${currentMethod}`;
      result.querySelector(".result-time").textContent = errored ? "" : `${dt} ms`;
      result.querySelector(".result-url").textContent = url;
      const imgEl = result.querySelector(".result-img");
      const bodyEl = result.querySelector(".result-body");
      // Lepas blob URL render sebelumnya biar gak numpuk di memory.
      if (imgEl.dataset.blobUrl) URL.revokeObjectURL(imgEl.dataset.blobUrl);
      if (imgBlobUrl) {
        imgEl.src = imgBlobUrl;
        imgEl.dataset.blobUrl = imgBlobUrl;
        imgEl.style.display = "block";
        bodyEl.style.display = "none";
      } else {
        imgEl.style.display = "none";
        imgEl.dataset.blobUrl = "";
        bodyEl.style.display = "block";
        bodyEl.innerHTML = highlightJson(pretty);
      }
      result.classList.add("show");

      const quotaEl = result.querySelector(".quota-line");
      const quota = res ? readQuota(res) : null;
      if (quota) {
        quotaEl.style.display = "block";
        quotaEl.textContent = `Sisa kuota: ${quota.remaining}/${quota.limit} request/jam${
          quota.reset ? ` · reset dalam ${quota.reset}` : ""
        }`;
      } else {
        quotaEl.style.display = "none";
      }

      result.querySelector('[data-act="copy-json"]').onclick = () => copyText(pretty);
      result.querySelector('[data-act="copy-curl"]').onclick = () =>
        // fetchOpts.headers (bukan headerObj mentah) biar x-api-key yang
        // disisipkan otomatis ikut kebawa di contoh cURL-nya.
        copyText(buildCurl(url, currentMethod, queryObj, fetchOpts.headers));
    });

    return tester;
  }

  // Baca header rate-limit standar (dipasang express-rate-limit di
  // src/middleware/tierRateLimit.js: RateLimit-Limit/Remaining/Reset, atau
  // fallback X-RateLimit-* buat versi/proxy lain). Balikin null kalau gak
  // ada sama sekali (mis. endpoint di luar /api/* yang gak kena limiter).
  function readQuota(res) {
    const limit = res.headers.get("ratelimit-limit") || res.headers.get("x-ratelimit-limit");
    const remaining = res.headers.get("ratelimit-remaining") || res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("ratelimit-reset") || res.headers.get("x-ratelimit-reset");
    if (limit === null || remaining === null) return null;
    return { limit, remaining, reset: reset ? `${reset} detik` : null };
  }

  function buildField(p, inputs, kind) {
    const row = document.createElement("div");
    row.className = "field-row";
    const label = document.createElement("label");
    label.innerHTML = `${p.name}${p.required ? '<span class="req">wajib</span>' : ""}${
      kind === "header" ? ' <span class="field-hint" style="display:inline;">(header)</span>' : ""
    }`;
    row.appendChild(label);
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = p.name;
    row.appendChild(input);
    if (p.desc) {
      const hint = document.createElement("div");
      hint.className = "field-hint";
      hint.textContent = p.desc;
      row.appendChild(hint);
    }
    inputs[p.name] = { el: input, required: p.required, kind };
    return row;
  }

  function statusClass(code, errored) {
    if (errored || !code) return "status-err";
    if (code >= 500) return "status-5xx";
    if (code >= 400) return "status-4xx";
    return "status-2xx";
  }

  function buildCurl(url, method, bodyObj, headerObj) {
    const headerFlags = Object.entries(headerObj || {})
      // Content-Type udah ditambahin manual di branch POST bawah — jangan dobel.
      .filter(([k]) => k.toLowerCase() !== "content-type")
      .map(([k, v]) => ` \\\n  -H "${k}: ${v}"`)
      .join("");
    if (method === "GET") {
      return `curl -X GET "${url}"${headerFlags}`;
    }
    return `curl -X POST "${url}"${headerFlags} \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(bodyObj)}'`;
  }

  function copyText(text) {
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  function highlightJson(str) {
    const escaped = str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return escaped.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(\.\d+)?([eE][+-]?\d+)?)/g,
      (match) => {
        let cls = "tok-num";
        if (/^"/.test(match)) {
          cls = /:$/.test(match) ? "tok-key" : "tok-str";
        } else if (/true|false/.test(match)) {
          cls = "tok-bool";
        } else if (/null/.test(match)) {
          cls = "tok-null";
        }
        return `<span class="${cls}">${match}</span>`;
      }
    );
  }

  // ---------- Connection ping ----------
  async function ping() {
    baseLed.className = "led pending";
    document.querySelectorAll("[data-jackled]").forEach((el) => (el.className = "jack-led"));
    try {
      const res = await fetch(`${getBaseUrl()}/health`, { method: "GET" });
      if (res.ok) {
        baseLed.className = "led ok";
        document.querySelectorAll("[data-jackled]").forEach((el) => (el.className = "jack-led ok"));
      } else {
        baseLed.className = "led bad";
      }
    } catch {
      baseLed.className = "led bad";
    }
  }
  pingBtn.addEventListener("click", ping);
  window.addEventListener("load", () => setTimeout(ping, 400));

  // ---------- Sidebar active state ----------
  const sectionEls = Array.from(document.querySelectorAll(".section"));
  const navLinks = Array.from(sidebar.querySelectorAll("a"));
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const id = entry.target.id.replace("cat-", "");
          navLinks.forEach((l) => l.classList.toggle("active", l.dataset.navfor === id));
        }
      });
    },
    { rootMargin: "-20% 0px -70% 0px" }
  );
  sectionEls.forEach((s) => io.observe(s));
})();

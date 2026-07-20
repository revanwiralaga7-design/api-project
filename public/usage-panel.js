// Panel usage di docs (index.html): grafik batang harian per key + kuota +
// top endpoint. Sumber data /auth/usage-series (cuma akun OAuth — kalau
// /auth/keys jawab 401, panel dibiarkan tersembunyi, halaman lain jalan
// normal). Sengaja file terpisah (bukan inline di index.html) biar kena
// guard tests/publicSyntax.test.js.
(function () {
  var panel = document.getElementById("usagePanel");
  var select = document.getElementById("usageKeySelect");
  var chartEl = document.getElementById("usageChart");
  var quotaEl = document.getElementById("usageQuota");
  var topEl = document.getElementById("usageTopPaths");
  var errEl = document.getElementById("usageError");
  if (!panel) return;

  var DAYS = 14;

  function showError(msg) {
    errEl.textContent = msg;
    errEl.style.display = "block";
  }

  function renderChart(days) {
    chartEl.innerHTML = "";
    var max = 1;
    days.forEach(function (d) {
      if (d.total > max) max = d.total;
    });
    days.forEach(function (d) {
      var col = document.createElement("div");
      col.style.flex = "1";
      col.style.display = "flex";
      col.style.flexDirection = "column";
      col.style.justifyContent = "flex-end";
      col.style.height = "100%";
      col.title = d.day + " · " + d.total + " request" + (d.limited ? " (" + d.limited + " kena limit)" : "");

      var ok = d.total - d.limited;
      // Bagian kena 429 di atas (merah), sisanya hijau — bar 0 tetap
      // dikasih alas 2px biar sumbu X-nya kelihatan kontinu.
      if (d.limited > 0) {
        var segLim = document.createElement("div");
        segLim.style.height = Math.max(2, (d.limited / max) * 100) + "%";
        segLim.style.background = "var(--red)";
        segLim.style.borderRadius = "2px 2px 0 0";
        col.appendChild(segLim);
      }
      var segOk = document.createElement("div");
      segOk.style.height = d.total === 0 ? "2px" : Math.max(2, (ok / max) * 100) + "%";
      segOk.style.background = d.total === 0 ? "var(--line)" : "var(--green)";
      segOk.style.borderRadius = d.limited > 0 ? "0" : "2px 2px 0 0";
      col.appendChild(segOk);
      chartEl.appendChild(col);
    });
  }

  function renderMeta(result) {
    var q = result.quota || {};
    var parts = ["hari ini " + (q.todayUsed || 0) + " request"];
    parts.push(q.hourly === null ? "limit: unlimited" : "limit " + q.hourly + "/jam");
    if (q.daily) parts.push("kuota " + (q.todayUsed || 0) + "/" + q.daily + " per hari");
    quotaEl.textContent = parts.join(" · ");
    quotaEl.style.display = "block";

    if (result.topPaths && result.topPaths.length) {
      topEl.textContent =
        "terpopuler: " +
        result.topPaths
          .map(function (t) {
            return t.path + " (" + t.hits + "×)";
          })
          .join(" · ");
      topEl.style.display = "block";
    } else {
      topEl.style.display = "none";
    }
  }

  function loadSeries(apiKey) {
    errEl.style.display = "none";
    fetch("/auth/usage-series?key=" + encodeURIComponent(apiKey) + "&days=" + DAYS)
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (!j.status) {
          showError(j.error || "Gagal memuat data pemakaian.");
          return;
        }
        renderChart(j.result.days);
        renderMeta(j.result);
      })
      .catch(function () {
        showError("Gagal memuat data pemakaian — muat ulang halaman buat coba lagi.");
      });
  }

  // Daftar key dari /auth/keys — juga jadi gerbang: 401/gagal = bukan akun
  // OAuth (mis. session admin-key), panel tetap tersembunyi.
  fetch("/auth/keys")
    .then(function (r) {
      if (!r.ok) throw new Error("bukan akun OAuth");
      return r.json();
    })
    .then(function (j) {
      if (!j.status || !j.result.keys.length) return;
      j.result.keys.forEach(function (k) {
        var opt = document.createElement("option");
        opt.value = k.apiKey;
        // textContent (bukan innerHTML): label key itu input user.
        opt.textContent = (k.label || "key utama") + " · " + k.apiKey.slice(0, 6) + "…";
        select.appendChild(opt);
      });
      select.addEventListener("change", function () {
        loadSeries(select.value);
      });
      panel.classList.add("show");
      loadSeries(select.value);
    })
    .catch(function () {
      /* diem — halaman docs lain tetap jalan */
    });
})();

/* Barber Ratings (1-5) for Location Check-in — folded in from 8-step report.
   Loads after app.js. Replaces the free-text "Barber feedback" with structured ratings. */
(function () {
  "use strict";
  var DIMS = [
    ["attitude", "Attitude"], ["workEthic", "Work Ethic"],
    ["customerService", "Customer Service"], ["cleanliness", "Cleanliness"],
    ["attendance", "Attendance"], ["teamwork", "Teamwork"]
  ];

  function ratingRowHtml() {
    var h = '<div class="loc-rate-row" style="border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:10px">' +
      '<div class="field" style="margin-bottom:8px"><label>Barber name</label>' +
      '<input type="text" data-rname placeholder="Name"></div>';
    DIMS.forEach(function (dm) {
      h += '<div class="seg-label">' + dm[1] + '</div>' +
        '<div class="status-opts seg" data-rdim="' + dm[0] + '" style="grid-template-columns:repeat(5,1fr)">' +
        [1, 2, 3, 4, 5].map(function (n) {
          return '<label data-val="' + n + '" data-tone="' + (n >= 3 ? "ok" : "no") + '">' + n + "</label>";
        }).join("") + "</div>";
    });
    h += '<div class="field" style="margin-top:8px"><label>Comments</label><textarea data-rcomments placeholder="Shout-outs, concerns…"></textarea></div>' +
      '<button type="button" class="add-btn" data-rremove style="color:#a3271a">Remove</button></div>';
    return h;
  }

  function init() {
    // Replace the free-text Barber feedback with structured ratings.
    var feedbackField = document.querySelector('#locShopForm [data-mnotes="barbers"]');
    if (!feedbackField) return; // form not built yet, retry
    var fieldWrap = feedbackField.closest(".field");
    if (!fieldWrap || fieldWrap.dataset.ratingsDone) return;
    fieldWrap.dataset.ratingsDone = "1";
    fieldWrap.querySelector("label").innerHTML = 'Barber ratings <span style="font-weight:400;font-size:12.5px;color:var(--muted)">(1–5)</span>';
    // Keep a hidden field with data-mnotes="barbers" so the main app collects our JSON.
    feedbackField.outerHTML = '<div id="locRatingRows"></div>' +
      '<button type="button" class="add-btn" id="locAddRating">＋ Rate a barber</button>' +
      '<textarea data-mnotes="barbers" id="locBarbersJson" style="display:none"></textarea>';

    function syncJson() {
      var el = document.getElementById("locBarbersJson");
      if (el) el.value = JSON.stringify(collectRatings());
    }

    document.getElementById("locAddRating").addEventListener("click", function () {
      var host = document.getElementById("locRatingRows");
      host.insertAdjacentHTML("beforeend", ratingRowHtml());
      var rows = host.querySelectorAll(".loc-rate-row");
      rows[rows.length - 1].scrollIntoView({ behavior: "smooth", block: "center" });
      syncJson();
    });
    document.getElementById("locRatingRows").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-rremove]");
      if (btn) { btn.closest(".loc-rate-row").remove(); syncJson(); return; }
      // Rating seg clicked — sync after the main handler sets the value.
      var lab = e.target.closest(".seg label");
      if (lab) setTimeout(syncJson, 50);
    });
    document.getElementById("locRatingRows").addEventListener("input", syncJson);
  }

  // Collect ratings — called by patching locCollect via the payload.
  // We hook into the submit by observing the payload construction.
  function collectRatings() {
    var out = [];
    document.querySelectorAll("#locRatingRows .loc-rate-row").forEach(function (row) {
      var nameEl = row.querySelector("[data-rname]");
      var name = nameEl ? nameEl.value.trim() : "";
      if (!name) return;
      var r = { name: name };
      var sum = 0, count = 0;
      DIMS.forEach(function (dm) {
        var seg = row.querySelector('[data-rdim="' + dm[0] + '"]');
        var v = seg && seg.dataset.val ? parseInt(seg.dataset.val, 10) : 0;
        r[dm[0]] = v;
        if (v > 0) { sum += v; count++; }
      });
      r.overall = count ? Math.round((sum / count) * 10) / 10 : 0;
      var cEl = row.querySelector("[data-rcomments]");
      r.comments = cEl ? cEl.value.trim() : "";
      out.push(r);
    });
    return out;
  }

  // Initialize when the shop form appears.
  var observer = new MutationObserver(function () { init(); });
  observer.observe(document.body, { childList: true, subtree: true });
  // Also try on load.
  if (document.readyState === "complete") init();
  else window.addEventListener("load", init);
})();

/* =========================================================================
   Barber & Co. Weekly Manager Report — front-end application
   -------------------------------------------------------------------------
   No secrets live in this file. The only configured value is the public
   Web App URL (safe to expose). All email/credential handling is server-side.
   ========================================================================= */
(function () {
  "use strict";

  // ---- CONFIG -------------------------------------------------------------
  // Paste your Google Apps Script Web App URL between the quotes (see README).
  var ENDPOINT_URL = "https://script.google.com/macros/s/AKfycbzLK3sjTTwxJVDO2LNqyGJ6t1Vw3gf1SgyeqbzxCbR1c-HYgfk9ZAilFPn0TS91aQWH/exec";

  var DRAFT_KEY = "barberco_report_draft_v3";
  var SUBMIT_ID_KEY = "barberco_submit_id";
  var MAX_IMG_DIM = 1600;          // px — downscale but keep receipts readable
  var IMG_QUALITY = 0.75;
  var MAX_FILES_PER_BUCKET = 10;
  var MAX_FILE_MB = 12;            // per file
  var MAX_TOTAL_UPLOAD_MB = 22;    // across the whole report
  var ACCEPTED = ["image/jpeg", "image/jpg", "image/png", "application/pdf"];
  var ACCEPTED_LABEL = "JPG, JPEG, PNG, or PDF";

  // ---- helpers ------------------------------------------------------------
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var form = $("#reportForm");
  var errorNote = $("#errorNote");
  var warnNote = $("#warnNote");

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c];
    });
  }
  function money(n) {
    n = Number(n) || 0;
    return (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function parseNum(v) { var n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; }
  function fv(name) { var el = form.elements[name]; return el ? String(el.value || "").trim() : ""; }
  function fb(name) { var el = form.elements[name]; return !!(el && el.checked); }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.floor(Math.random() * 1e9);
  }

  // Uploads live in JS (not the DOM / not localStorage): { bucket: [{name,type,dataUrl}] }
  var uploads = {};
  var dirty = false;

  // =========================================================================
  // WEEKLY TASKS
  // =========================================================================
  var WEEKLY_TASKS = [
    { key: "expense_report", label: "Manager Expense Report completed before Monday at 8:00 PM", upload: false },
    { key: "stations_cleaned", label: "Confirm every barber cleaned their station", upload: true },
    { key: "station_proof", label: "Confirm barbers sent a photo / WhatsApp showing their station was cleaned", upload: true },
    { key: "steamers", label: "Steamers cleaned", upload: true },
    { key: "lather_machines", label: "Lather machines cleaned", upload: true },
    { key: "deep_clean", label: "Shop deep cleaning completed by manager, barbers, and hostess", upload: true },
    { key: "shop_condition", label: "General weekly shop condition reviewed", upload: false },
    { key: "concerns", label: "Maintenance, cleanliness, supply, staffing, or customer-service concerns documented", upload: false }
  ];

  function buildWeeklyTasks() {
    var host = $("#weeklyTasks");
    WEEKLY_TASKS.forEach(function (t, i) {
      var el = document.createElement("div");
      el.className = "task";
      el.dataset.taskKey = t.key;
      var up = t.upload
        ? '<div class="uploader" data-upload="task_' + t.key + '">' +
            '<label class="upload-btn"><input type="file" class="upload-input" accept="image/*,application/pdf" multiple>📷 Upload photo(s)</label>' +
            '<div class="thumbs"></div>' +
            '<div class="upload-meta">Accepted: ' + ACCEPTED_LABEL + '. Multiple allowed. Large images are optimized automatically.</div>' +
          '</div>'
        : "";
      el.innerHTML =
        '<div class="task-title">' + (i + 1) + '. ' + escapeHtml(t.label) + '</div>' +
        '<div class="status-opts" data-status="' + t.key + '" role="radiogroup" aria-label="' + escapeHtml(t.label) + '">' +
          '<label><input type="radio" name="task_' + t.key + '" value="completed">✅ Completed</label>' +
          '<label><input type="radio" name="task_' + t.key + '" value="not_completed">❌ Not Completed</label>' +
          '<label><input type="radio" name="task_' + t.key + '" value="na">➖ N/A</label>' +
        '</div>' +
        '<div class="field explain-box" data-explain="' + t.key + '"><label class="mini-label">Why not completed? Include a follow-up plan. <span class="req">*</span></label>' +
          '<textarea name="taskexplain_' + t.key + '" maxlength="2000"></textarea></div>' +
        '<div class="field" style="margin-bottom:0"><label class="mini-label">Notes</label><textarea name="tasknote_' + t.key + '" maxlength="2000"></textarea></div>' +
        up;
      host.appendChild(el);
    });
    $$(".status-opts").forEach(function (grp) {
      grp.addEventListener("change", function () { paintStatus(grp); toggleExplain(grp.dataset.status); });
    });
  }
  function paintStatus(grp) {
    $$("label", grp).forEach(function (l) { l.classList.remove("sel-ok", "sel-no", "sel-na"); });
    var c = $("input:checked", grp); if (!c) return;
    var lbl = c.closest("label");
    lbl.classList.add(c.value === "completed" ? "sel-ok" : c.value === "not_completed" ? "sel-no" : "sel-na");
  }
  function toggleExplain(key) {
    var box = $('[data-explain="' + key + '"]');
    if (!box) return;
    var val = form.elements["task_" + key] ? form.elements["task_" + key].value : "";
    box.classList.toggle("show", val === "not_completed");
  }

  // =========================================================================
  // RATING SCALES (1–5 buttons)
  // =========================================================================
  function buildRatingScales() {
    $$("[data-rate]").forEach(function (sc) {
      if (sc.__built) return; sc.__built = true;
      var name = sc.dataset.rate;
      sc.setAttribute("role", "radiogroup");
      sc.innerHTML = [1, 2, 3, 4, 5].map(function (n) {
        return '<label><input type="radio" name="' + name + '" value="' + n + '" aria-label="' + n + ' out of 5">' + n + '</label>';
      }).join("");
      sc.addEventListener("change", function () { paintRate(sc); });
    });
  }
  function paintRate(sc) {
    $$("label", sc).forEach(function (l) { l.classList.remove("on"); });
    var c = $("input:checked", sc); if (c) c.closest("label").classList.add("on");
  }

  // =========================================================================
  // REPEATABLE ROW TYPES
  // =========================================================================
  var RATE_OPTS = ["", "1", "2", "3", "4", "5"];
  var ROW_DEFS = {
    mkt: { container: "#mktRows", calc: true, fields: [
      { k: "date", label: "Date", type: "date" },
      { k: "barber", label: "Barber", type: "text" },
      { k: "service", label: "Service", type: "text" },
      { k: "total", label: "Total", type: "currency" },
      { k: "promo", label: "Promo Type", type: "text" },
      { k: "notes", label: "Notes (optional)", type: "text" }
    ]},
    host: { container: "#hostRows", fields: [
      { k: "name", label: "Name", type: "text" },
      { k: "hours", label: "Hours", type: "number" }
    ]},
    expense: { container: "#expenseRows", calc: true, upload: "exp_receipt", fields: [
      { k: "date", label: "Date", type: "date" },
      { k: "vendor", label: "Vendor", type: "text" },
      { k: "category", label: "Expense Category", type: "text" },
      { k: "description", label: "Description (optional)", type: "text" },
      { k: "amount", label: "Amount", type: "currency" },
      { k: "method", label: "Payment Method", type: "select", options: ["Business debit card", "Business credit card", "Cash", "Reimbursement", "Other"] },
      { k: "methodOther", label: "If Other, specify", type: "text", showIf: { k: "method", val: "Other" } },
      { k: "notes", label: "Notes", type: "text" }
    ]},
    fwTimeoff: { container: "#fwTimeoffRows", fields: [
      { k: "employee", label: "Employee Name", type: "text" },
      { k: "dates", label: "Requested Dates", type: "text" },
      { k: "status", label: "Status", type: "select", options: ["Approved", "Denied", "Pending"] },
      { k: "notes", label: "Manager Notes", type: "text" }
    ]},
    inv: { container: "#invRows", calc: true, fields: [
      { k: "brand", label: "Brand", type: "select", options: ["Layrite", "Level 3", "Other"] },
      { k: "product", label: "Product Name", type: "text" },
      { k: "currentQty", label: "Current Qty", type: "number" },
      { k: "minQty", label: "Min Desired Qty", type: "number" },
      { k: "orderQty", label: "Qty to Order", type: "number" },
      { k: "unitCost", label: "Unit Cost", type: "currency" },
      { k: "totalCost", label: "Est. Total", type: "readonly" },
      { k: "vendor", label: "Vendor / Supplier", type: "text" },
      { k: "orderPlaced", label: "Order Placed?", type: "select", options: ["No", "Yes"] },
      { k: "orderDate", label: "Order Date", type: "date" },
      { k: "notes", label: "Notes", type: "text" }
    ]},
    barber: { container: "#barberRows", calc: true, fields: [
      { k: "name", label: "Barber Name", type: "text" },
      { k: "currentSales", label: "Current Sales", type: "currency" },
      { k: "salesGoal", label: "Sales Goal", type: "currency" },
      { k: "difference", label: "Difference", type: "readonly" },
      { k: "concerns", label: "Current Performance Concerns", type: "textarea" },
      { k: "positive", label: "Positive Performance", type: "textarea" },
      { k: "habits", label: "Habits Preventing Growth", type: "textarea" },
      { k: "improvementGoal", label: "Improvement Goal", type: "textarea" },
      { k: "actionSteps", label: "Action Steps", type: "textarea" },
      { k: "support", label: "Support Needed From Management", type: "textarea" },
      { k: "followUp", label: "Follow-up Date", type: "date" },
      { k: "notes", label: "Manager Notes", type: "textarea" }
    ]},
    supply: { container: "#supplyRows", fields: [
      { k: "item", label: "Supply / Item Name", type: "text" },
      { k: "category", label: "Category", type: "text" },
      { k: "currentQty", label: "Current Qty", type: "number" },
      { k: "needed", label: "Qty Needed", type: "number" },
      { k: "vendor", label: "Vendor", type: "text" },
      { k: "estCost", label: "Estimated Cost", type: "currency" },
      { k: "orderPlaced", label: "Order Placed?", type: "select", options: ["No", "Yes"] },
      { k: "orderDate", label: "Order Date", type: "date" },
      { k: "notes", label: "Notes", type: "text" }
    ]},
    incident: { container: "#incidentRows", upload: "incident_files", fields: [
      { k: "date", label: "Incident Date", type: "date" },
      { k: "time", label: "Incident Time", type: "time" },
      { k: "location", label: "Store Location", type: "text" },
      { k: "people", label: "People Involved", type: "text" },
      { k: "category", label: "Incident Category", type: "select", options: ["Client fall", "Injury", "Client complaint", "Employee conflict", "Property damage", "Safety concern", "Other"] },
      { k: "description", label: "Detailed Description", type: "textarea" },
      { k: "action", label: "Immediate Action Taken", type: "textarea" },
      { k: "medical", label: "Medical assistance required?", type: "select", options: ["No", "Yes"] },
      { k: "clientContacted", label: "Client contacted afterward?", type: "select", options: ["N/A", "No", "Yes"] },
      { k: "witnesses", label: "Witnesses present?", type: "select", options: ["No", "Yes"] },
      { k: "witnessInfo", label: "Witness names & contact (if any)", type: "textarea" },
      { k: "followUp", label: "Manager Follow-up", type: "textarea" },
      { k: "status", label: "Current Status", type: "select", options: ["Open", "In progress", "Resolved"] }
    ]},
    oneonone: { container: "#oneononeRows", fields: [
      { k: "name", label: "Barber Name", type: "text" },
      { k: "date", label: "Meeting Date", type: "date" },
      { k: "reason", label: "Reason for Meeting", type: "textarea" },
      { k: "concerns", label: "Concerns Discussed", type: "textarea" },
      { k: "feedback", label: "Barber Feedback", type: "textarea" },
      { k: "support", label: "Support Requested", type: "textarea" },
      { k: "actionSteps", label: "Agreed Action Steps", type: "textarea" },
      { k: "followUp", label: "Follow-up Date", type: "date" },
      { k: "notes", label: "Manager Notes", type: "textarea" }
    ]},
    late: { container: "#lateRows", calc: true, fields: [
      { k: "name", label: "Employee / Barber Name", type: "text" },
      { k: "date", label: "Date", type: "date" },
      { k: "type", label: "Type", type: "select", options: ["Late arrival", "Early departure"] },
      { k: "scheduled", label: "Scheduled Time", type: "time" },
      { k: "actual", label: "Actual Time", type: "time" },
      { k: "minutes", label: "Minutes Late/Early", type: "readonly" },
      { k: "reason", label: "Reason", type: "text" },
      { k: "notified", label: "Management notified in advance?", type: "select", options: ["No", "Yes"] },
      { k: "corrective", label: "Corrective Action / Follow-up", type: "text" },
      { k: "notes", label: "Notes", type: "text" }
    ]},
    absent: { container: "#absentRows", fields: [
      { k: "name", label: "Barber Name", type: "text" },
      { k: "date", label: "Date", type: "date" },
      { k: "shift", label: "Scheduled Shift", type: "text" },
      { k: "reason", label: "Reason", type: "text" },
      { k: "notified", label: "Management notified?", type: "select", options: ["No", "Yes"] },
      { k: "approved", label: "Absence approved?", type: "select", options: ["No", "Yes"] },
      { k: "coverage", label: "Coverage arranged?", type: "select", options: ["No", "Yes"] },
      { k: "coverPerson", label: "Coverage Provided By", type: "text" },
      { k: "corrective", label: "Corrective Action / Follow-up", type: "text" },
      { k: "notes", label: "Notes", type: "text" }
    ]},
    rating: { container: "#ratingRows", calc: true, fields: [
      { k: "name", label: "Barber Name", type: "text" },
      { k: "attitude", label: "Attitude", type: "select", options: RATE_OPTS },
      { k: "workEthic", label: "Work Ethic", type: "select", options: RATE_OPTS },
      { k: "customerService", label: "Customer Service", type: "select", options: RATE_OPTS },
      { k: "cleanliness", label: "Station Cleanliness & Organization", type: "select", options: RATE_OPTS },
      { k: "attendance", label: "Attendance & Punctuality", type: "select", options: RATE_OPTS },
      { k: "teamwork", label: "Teamwork", type: "select", options: RATE_OPTS },
      { k: "overall", label: "Overall (auto)", type: "readonly" },
      { k: "comments", label: "Manager Comments", type: "textarea" },
      { k: "recognition", label: "Recognition / Praise", type: "textarea" },
      { k: "improvement", label: "Area Requiring Improvement", type: "textarea" },
      { k: "followupNeeded", label: "Follow-up needed?", type: "select", options: ["No", "Yes"] },
      { k: "followupDate", label: "Follow-up Date", type: "date" }
    ]}
  };

  function fieldHtml(f) {
    var span = (f.type === "textarea") ? ";grid-column:1/-1" : "";
    var showAttr = f.showIf ? ' data-rowshowif="' + f.showIf.k + "=" + f.showIf.val + '"' : "";
    var inner;
    if (f.type === "select") {
      inner = '<select data-k="' + f.k + '"><option value="">—</option>' +
        f.options.filter(function (o) { return o !== ""; }).map(function (o) { return "<option>" + escapeHtml(o) + "</option>"; }).join("") + "</select>";
    } else if (f.type === "textarea") {
      inner = '<textarea data-k="' + f.k + '" maxlength="2000"></textarea>';
    } else if (f.type === "readonly") {
      inner = '<input type="text" data-k="' + f.k + '" readonly tabindex="-1">';
    } else if (f.type === "currency") {
      inner = '<div class="currency"><input type="text" inputmode="decimal" data-k="' + f.k + '" data-currency placeholder="0.00"></div>';
    } else if (f.type === "number") {
      inner = '<input type="number" data-k="' + f.k + '" inputmode="numeric" min="0" step="any">';
    } else if (f.type === "date") {
      inner = '<input type="date" data-k="' + f.k + '">';
    } else if (f.type === "time") {
      inner = '<input type="time" data-k="' + f.k + '">';
    } else {
      inner = '<input type="text" data-k="' + f.k + '" maxlength="400">';
    }
    return '<div class="field" style="margin-bottom:10px' + span + '"' + showAttr + '><span class="mini-label">' + escapeHtml(f.label) + '</span>' + inner + "</div>";
  }

  function rowHtml(type, n, uid) {
    var def = ROW_DEFS[type];
    var cols = def.fields.length > 3 ? "repeat(auto-fit,minmax(150px,1fr))" : "repeat(auto-fit,minmax(130px,1fr))";
    var up = def.upload
      ? '<div class="uploader" data-upload="' + def.upload + "_" + uid + '" style="grid-column:1/-1">' +
          '<label class="upload-btn"><input type="file" class="upload-input" accept="image/*,application/pdf" multiple>📎 Upload file(s)</label>' +
          '<div class="thumbs"></div>' +
          '<div class="upload-meta">Accepted: ' + ACCEPTED_LABEL + '.</div>' +
        '</div>'
      : "";
    return '<div class="row-num">' + n + '</div>' +
      '<button type="button" class="row-remove" title="Remove" aria-label="Remove entry">&times;</button>' +
      '<div class="row-grid" style="grid-template-columns:' + cols + '">' +
      def.fields.map(fieldHtml).join("") + up + "</div>";
  }

  function addRow(type, values) {
    var def = ROW_DEFS[type];
    var div = document.createElement("div");
    div.className = "row-item";
    div.dataset.type = type;
    div.dataset.uid = uuid().slice(0, 8);
    $(def.container).appendChild(div);
    renumber(type);
    if (values) {
      $$("[data-k]", div).forEach(function (inp) { if (values[inp.dataset.k] != null) inp.value = values[inp.dataset.k]; });
      refreshRow(div, type);
    }
    dirty = true; scheduleSave();
    return div;
  }

  function renumber(type) {
    var def = ROW_DEFS[type];
    Array.prototype.slice.call($(def.container).children).forEach(function (el, i) {
      var vals = {}; $$("[data-k]", el).forEach(function (inp) { vals[inp.dataset.k] = inp.value; });
      el.innerHTML = rowHtml(type, i + 1, el.dataset.uid);
      $$("[data-k]", el).forEach(function (inp) { if (vals[inp.dataset.k] != null) inp.value = vals[inp.dataset.k]; });
      if (def.upload) $$(".uploader", el).forEach(initUploader);
      refreshRow(el, type);
    });
  }

  function refreshRow(rowEl, type) {
    var def = ROW_DEFS[type];
    // row-level conditional fields
    $$("[data-rowshowif]", rowEl).forEach(function (box) {
      var cond = box.dataset.rowshowif.split("=");
      var src = $("[data-k=" + cond[0] + "]", rowEl);
      box.style.display = (src && src.value === cond[1]) ? "" : "none";
    });
    if (!def.calc) return;
    var g = function (k) { return parseNum(($("[data-k=" + k + "]", rowEl) || {}).value); };
    var set = function (k, v) { var o = $("[data-k=" + k + "]", rowEl); if (o) o.value = v; };
    if (type === "inv") { var t = g("orderQty") * g("unitCost"); set("totalCost", t ? money(t) : ""); }
    else if (type === "barber") { var d = g("salesGoal") - g("currentSales"); set("difference", (g("salesGoal") || g("currentSales")) ? money(d) : ""); }
    else if (type === "late") { set("minutes", diffMinutes(($("[data-k=scheduled]", rowEl) || {}).value, ($("[data-k=actual]", rowEl) || {}).value)); }
    else if (type === "rating") {
      var keys = ["attitude", "workEthic", "customerService", "cleanliness", "attendance", "teamwork"];
      var vals = keys.map(g).filter(function (v) { return v > 0; });
      set("overall", vals.length ? (vals.reduce(function (a, b) { return a + b; }, 0) / vals.length).toFixed(1) + " / 5" : "");
    }
  }

  function diffMinutes(a, b) {
    if (!a || !b) return "";
    var pa = a.split(":"), pb = b.split(":");
    if (pa.length < 2 || pb.length < 2) return "";
    var m = Math.abs((parseInt(pb[0], 10) * 60 + parseInt(pb[1], 10)) - (parseInt(pa[0], 10) * 60 + parseInt(pa[1], 10)));
    return isNaN(m) ? "" : m + " min";
  }

  // =========================================================================
  // CURRENCY
  // =========================================================================
  function attachCurrency(scope) {
    $$("[data-currency]", scope || document).forEach(function (inp) {
      if (inp.__cur) return; inp.__cur = true;
      inp.addEventListener("blur", function () {
        var raw = String(inp.value).replace(/[^0-9.\-]/g, "");
        if (raw === "") { inp.value = ""; return; }
        var v = Math.abs(parseFloat(raw)); // no negative currency
        inp.value = isNaN(v) ? "" : money(v);
      });
    });
  }

  // =========================================================================
  // FILE UPLOADS
  // =========================================================================
  function totalUploadBytes() {
    var total = 0;
    Object.keys(uploads).forEach(function (b) {
      (uploads[b] || []).forEach(function (f) { total += f.dataUrl.length * 0.75; });
    });
    return total;
  }
  function compressImage(file) {
    return new Promise(function (resolve) {
      if (file.type !== "image/jpeg" && file.type !== "image/png" && file.type !== "image/jpg") {
        var r = new FileReader();
        r.onload = function () { resolve({ name: file.name, type: file.type, dataUrl: r.result }); };
        r.onerror = function () { resolve(null); };
        r.readAsDataURL(file);
        return;
      }
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var scale = Math.min(1, MAX_IMG_DIM / Math.max(img.width, img.height));
        var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        var c = document.createElement("canvas"); c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve({ name: (file.name || "photo").replace(/\.[^.]+$/, "") + ".jpg", type: "image/jpeg", dataUrl: c.toDataURL("image/jpeg", IMG_QUALITY) });
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }
  function initUploader(u) {
    if (u.__init) { renderThumbs(u.dataset.upload, $(".thumbs", u)); return; }
    u.__init = true;
    var bucket = u.dataset.upload;
    uploads[bucket] = uploads[bucket] || [];
    var input = $(".upload-input", u), thumbs = $(".thumbs", u);
    input.addEventListener("change", function () {
      var files = Array.prototype.slice.call(input.files || []); input.value = "";
      files.forEach(function (file) {
        if (ACCEPTED.indexOf(file.type) === -1) { flashError("“" + file.name + "” isn't an accepted file type (" + ACCEPTED_LABEL + ")."); return; }
        if (file.size > MAX_FILE_MB * 1024 * 1024) { flashError("“" + file.name + "” is larger than " + MAX_FILE_MB + " MB."); return; }
        if ((uploads[bucket] || []).length >= MAX_FILES_PER_BUCKET) { flashError("Up to " + MAX_FILES_PER_BUCKET + " files per item."); return; }
        compressImage(file).then(function (obj) {
          if (!obj) { flashError("Couldn't read “" + file.name + "”."); return; }
          if (totalUploadBytes() + obj.dataUrl.length * 0.75 > MAX_TOTAL_UPLOAD_MB * 1024 * 1024) {
            flashError("Total attachments exceed ~" + MAX_TOTAL_UPLOAD_MB + " MB. Please remove some files.");
            return;
          }
          uploads[bucket].push(obj); renderThumbs(bucket, thumbs); dirty = true;
        });
      });
    });
    renderThumbs(bucket, thumbs);
  }
  function renderThumbs(bucket, thumbs) {
    if (!thumbs) return;
    thumbs.innerHTML = "";
    (uploads[bucket] || []).forEach(function (f, idx) {
      var d = document.createElement("div"); d.className = "thumb";
      if (/^image\//.test(f.type)) d.innerHTML = '<img src="' + f.dataUrl + '" alt="' + escapeHtml(f.name) + '"><span class="fn">' + escapeHtml(f.name) + '</span>';
      else d.innerHTML = '<div class="doc">📄 ' + escapeHtml(f.name) + "</div>";
      var x = document.createElement("button");
      x.type = "button"; x.className = "x"; x.textContent = "×"; x.setAttribute("aria-label", "Remove file");
      x.onclick = function () { uploads[bucket].splice(idx, 1); renderThumbs(bucket, thumbs); dirty = true; };
      d.appendChild(x); thumbs.appendChild(d);
    });
  }

  // =========================================================================
  // CONDITIONAL VISIBILITY
  // =========================================================================
  function setupConditionals() {
    var loc = form.elements.storeLocation, otherField = $("#storeOtherField");
    var toggleOther = function () {
      var show = loc.value === "Other";
      otherField.style.display = show ? "" : "none";
      form.elements.storeLocationOther.required = show;
    };
    loc.addEventListener("change", toggleOther); toggleOther();

    var wom = form.elements.weekOfMonth;
    wom.addEventListener("change", function () {
      var v = wom.value, banner = $("#weekBanner");
      $$(".week-block").forEach(function (b) { b.open = (b.dataset.week === v); });
      if (v) {
        var names = { first: "First", second: "Second", third: "Third", fourth: "Fourth", fifth: "Fifth" };
        banner.innerHTML = "Showing tasks for the <b>" + names[v] + " week</b>. Other weeks remain available below if needed.";
      }
    });

    $$("[data-yesno]").forEach(function (yn) {
      yn.addEventListener("change", function () { paintYesNo(yn.dataset.yesno); });
    });

    var noMkt = $("#noMarketing");
    noMkt.addEventListener("change", function () {
      $("#marketingWrap").style.display = noMkt.checked ? "none" : "";
    });
  }
  function paintYesNo(name) {
    var yn = $('[data-yesno="' + name + '"]'); if (!yn) return;
    $$("label", yn).forEach(function (l) { l.classList.remove("on-yes", "on-no"); });
    var c = $("input:checked", yn);
    if (c) c.closest("label").classList.add(c.value === "yes" ? "on-yes" : "on-no");
    $$('[data-showif]').forEach(function (box) {
      var cond = box.dataset.showif.split("=");
      if (cond[0] === name) box.style.display = (c && c.value === cond[1]) ? "" : "none";
    });
  }

  // =========================================================================
  // TOTALS
  // =========================================================================
  function updateTotals() {
    // Marketing
    var mkt = serializeRows("mkt").filter(function (r) { return (r.service || r.total || r.barber); });
    var mTotal = 0, byBarber = {}, byPromo = {};
    mkt.forEach(function (r) {
      var amt = parseNum(r.total); mTotal += amt;
      if (r.barber) byBarber[r.barber] = (byBarber[r.barber] || 0) + amt;
      if (r.promo) byPromo[r.promo] = (byPromo[r.promo] || 0) + amt;
    });
    var mHtml = '<h4>Marketing Totals</h4>' +
      '<div class="row"><span>Number of services</span><span>' + mkt.length + '</span></div>' +
      '<div class="row grand"><span>Total amount</span><span>' + money(mTotal) + '</span></div>';
    if (Object.keys(byBarber).length) mHtml += '<div class="row"><span><small>By barber</small></span><span></span></div>' +
      Object.keys(byBarber).map(function (b) { return '<div class="row"><span><small>' + escapeHtml(b) + '</small></span><span>' + money(byBarber[b]) + '</span></div>'; }).join("");
    if (Object.keys(byPromo).length) mHtml += '<div class="row"><span><small>By promo type</small></span><span></span></div>' +
      Object.keys(byPromo).map(function (p) { return '<div class="row"><span><small>' + escapeHtml(p) + '</small></span><span>' + money(byPromo[p]) + '</span></div>'; }).join("");
    $("#mktTotals").innerHTML = mHtml;

    // Expenses
    var exp = serializeRows("expense").filter(function (r) { return (r.vendor || r.amount || r.category); });
    var eTotal = 0, byMethod = {}, byCat = {};
    exp.forEach(function (r) {
      var amt = parseNum(r.amount); eTotal += amt;
      var m = r.method === "Other" && r.methodOther ? r.methodOther : (r.method || "Unspecified");
      byMethod[m] = (byMethod[m] || 0) + amt;
      var c = r.category || "Uncategorized";
      byCat[c] = (byCat[c] || 0) + amt;
    });
    var eHtml = '<h4>Expense Totals</h4><div class="row grand"><span>Total weekly expenses</span><span>' + money(eTotal) + '</span></div>';
    if (Object.keys(byMethod).length) eHtml += '<div class="row"><span><small>By payment method</small></span><span></span></div>' +
      Object.keys(byMethod).map(function (m) { return '<div class="row"><span><small>' + escapeHtml(m) + '</small></span><span>' + money(byMethod[m]) + '</span></div>'; }).join("");
    if (Object.keys(byCat).length) eHtml += '<div class="row"><span><small>By category</small></span><span></span></div>' +
      Object.keys(byCat).map(function (c) { return '<div class="row"><span><small>' + escapeHtml(c) + '</small></span><span>' + money(byCat[c]) + '</span></div>'; }).join("");
    $("#expTotals").innerHTML = eHtml;
  }

  // =========================================================================
  // DRAFT AUTOSAVE (text only; files are not stored in the draft)
  // =========================================================================
  var saveTimer = null;
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 500); }
  function serializeRows(type) {
    return Array.prototype.slice.call($(ROW_DEFS[type].container).children).map(function (el) {
      var o = {}; $$("[data-k]", el).forEach(function (i) { o[i.dataset.k] = i.value; }); return o;
    });
  }
  var ROW_TYPES = Object.keys(ROW_DEFS);
  function saveDraft() {
    try {
      var data = { fields: {}, rows: {}, step: currentStep };
      $$("input, select, textarea", form).forEach(function (el) {
        if (!el.name || el.type === "file") return;
        if (el.type === "radio") { if (el.checked) data.fields[el.name] = el.value; }
        else if (el.type === "checkbox") data.fields[el.name] = el.checked;
        else data.fields[el.name] = el.value;
      });
      ROW_TYPES.forEach(function (t) { data.rows[t] = serializeRows(t); });
      localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
      $("#autosaveNote").innerHTML = "<b>✓ Progress saved</b> on this device.";
    } catch (e) { /* storage unavailable — degrade quietly */ }
  }
  function loadDraft() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch (e) { return null; } }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) {} }
  function restoreDraft(data) {
    ROW_TYPES.forEach(function (t) { ((data.rows && data.rows[t]) || []).forEach(function (v) { addRow(t, v); }); });
    Object.keys(data.fields || {}).forEach(function (name) {
      var val = data.fields[name], els = $$('[name="' + name + '"]', form);
      if (!els.length) return;
      if (els[0].type === "radio") els.forEach(function (r) { if (r.value === val) r.checked = true; });
      else if (els[0].type === "checkbox") els[0].checked = !!val;
      else els[0].value = val;
    });
  }

  // =========================================================================
  // VALIDATION
  // =========================================================================
  function clearInvalid() { $$(".invalid").forEach(function (el) { el.classList.remove("invalid"); }); }
  function mark(el) { if (el) el.classList.add("invalid"); }

  function validateStep(step) {
    var problems = [];
    if (step === 1) {
      [["managerName", "Manager Name"], ["storeLocation", "Store Location"], ["weekStart", "Week Start Date"], ["weekEnd", "Week End Date"], ["weekOfMonth", "Week of the Month"]]
        .forEach(function (r) { var el = form.elements[r[0]]; if (!String(el.value).trim()) { problems.push(r[1] + " is required."); mark(el); } });
      if (form.elements.storeLocation.value === "Other" && !fv("storeLocationOther")) { problems.push("Please enter the location."); mark(form.elements.storeLocationOther); }
      var ws = fv("weekStart"), we = fv("weekEnd");
      if (ws && we && we < ws) { problems.push("Week End Date cannot be before Week Start Date."); mark(form.elements.weekEnd); }
      var c = fv("managerContact");
      if (c && !/@/.test(c) && c.replace(/[^0-9]/g, "").length < 7) { problems.push("Manager Email or Phone doesn't look valid."); mark(form.elements.managerContact); }
      if (c && /@/.test(c) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) { problems.push("Manager email address isn't valid."); mark(form.elements.managerContact); }
    }
    if (step === 2) {
      WEEKLY_TASKS.forEach(function (t) {
        var el = form.elements["task_" + t.key];
        if (!el || !el.value) { problems.push("Choose a status for: " + t.label); }
        else if (el.value === "not_completed" && !fv("taskexplain_" + t.key)) {
          problems.push("Explain why “" + t.label + "” was not completed (with a follow-up plan).");
          mark(form.elements["taskexplain_" + t.key]);
        }
      });
    }
    if (step === 4) {
      if (!fb("expense_confirm")) problems.push("Please confirm expenses & receipts were entered accurately.");
      negativeCurrencyProblems(problems);
    }
    if (step === 8) {
      ["cert_reviewed", "cert_accurate", "cert_uploaded", "cert_contact"].forEach(function (n) {
        if (!fb(n)) problems.push("Please check all certification boxes.");
      });
      // de-dup identical cert message
      problems = problems.filter(function (v, i, a) { return a.indexOf(v) === i; });
      if (!fv("signature")) { problems.push("Type your full name as an electronic signature."); mark(form.elements.signature); }
    }
    return problems;
  }
  function negativeCurrencyProblems(problems) {
    $$("[data-currency]").forEach(function (inp) {
      if (parseNum(inp.value) < 0) { problems.push("Currency amounts cannot be negative."); mark(inp); }
    });
  }

  function flashError(msg) { showError(msg); setTimeout(function () { if (errorNote.textContent === msg) errorNote.style.display = "none"; }, 4000); }
  function showError(msgOrList) {
    if (Array.isArray(msgOrList)) errorNote.innerHTML = "Please fix the following:<ul>" + msgOrList.map(function (m) { return "<li>" + escapeHtml(m) + "</li>"; }).join("") + "</ul>";
    else errorNote.textContent = msgOrList;
    errorNote.style.display = "block";
    // Move the visible error into the active step so the user sees it
    var active = $(".step.active");
    if (active && errorNote.parentElement !== active) active.appendChild(errorNote);
    errorNote.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function hideError() { errorNote.style.display = "none"; }

  // =========================================================================
  // WIZARD
  // =========================================================================
  var steps = $$(".step");
  var currentStep = 1;
  var totalSteps = steps.length;

  function buildChips() {
    $("#stepTotal").textContent = totalSteps;
    $("#stepsChips").innerHTML = steps.map(function (s) {
      return '<span class="chip" data-goto="' + s.dataset.step + '">' + s.dataset.step + ". " + escapeHtml(s.dataset.name) + "</span>";
    }).join("");
    $$("#stepsChips .chip").forEach(function (ch) {
      ch.addEventListener("click", function () { gotoStep(parseInt(ch.dataset.goto, 10), true); });
    });
  }
  function showStep(n) {
    steps.forEach(function (s) { s.classList.toggle("active", parseInt(s.dataset.step, 10) === n); });
    var active = steps[n - 1];
    $("#stepName").textContent = active.dataset.name;
    $("#stepNum").textContent = n;
    $("#progressFill").style.width = Math.round((n / totalSteps) * 100) + "%";
    $$("#stepsChips .chip").forEach(function (ch) {
      var num = parseInt(ch.dataset.goto, 10);
      ch.classList.toggle("active", num === n);
      ch.classList.toggle("done", num < n);
    });
    $("#btnPrev").hidden = (n === 1);
    var last = (n === totalSteps);
    $("#btnNext").style.display = last ? "none" : "";
    $("#btnSubmit").style.display = last ? "" : "none";
    if (last) renderReview();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function gotoStep(n, skipValidation) {
    if (n > currentStep && !skipValidation) {
      // validate each step from current up to the target
      for (var s = currentStep; s < n; s++) {
        var probs = validateStep(s);
        if (probs.length) { showStep(s); currentStep = s; showError(probs); return; }
      }
    }
    hideError();
    currentStep = Math.max(1, Math.min(totalSteps, n));
    showStep(currentStep);
    saveDraft();
  }

  // =========================================================================
  // REVIEW
  // =========================================================================
  function kv(k, v) { if (v == null || v === "") return ""; return '<div class="kv"><span class="k">' + escapeHtml(k) + '</span><span class="v">' + escapeHtml(v) + "</span></div>"; }
  function block(title, editStep, inner) {
    if (!inner) return "";
    return '<div class="review-block"><h4>' + escapeHtml(title) + '<button type="button" class="review-edit" data-edit="' + editStep + '">Edit</button></h4>' + inner + "</div>";
  }
  function fileCount() { var n = 0; Object.keys(uploads).forEach(function (b) { n += (uploads[b] || []).length; }); return n; }

  function renderReview() {
    updateTotals();
    var mgr = kv("Manager", fv("managerName")) +
      kv("Store", form.elements.storeLocation.value === "Other" ? fv("storeLocationOther") : fv("storeLocation")) +
      kv("Reporting period", fv("weekStart") + (fv("weekEnd") ? " to " + fv("weekEnd") : "")) +
      kv("Week of month", fv("weekOfMonth")) +
      kv("Sales to date", fv("salesToDate")) + kv("Sales goal", fv("salesGoal")) +
      kv("Report completed", fv("completedDate")) + kv("Contact", fv("managerContact"));

    var tasks = WEEKLY_TASKS.map(function (t) {
      var st = form.elements["task_" + t.key] ? form.elements["task_" + t.key].value : "";
      var label = st === "completed" ? "✅ Completed" : st === "not_completed" ? "❌ Not Completed" : st === "na" ? "➖ N/A" : "—";
      return kv(t.label, label + (st === "not_completed" && fv("taskexplain_" + t.key) ? " — " + fv("taskexplain_" + t.key) : ""));
    }).join("");

    var mkt = serializeRows("mkt").filter(function (r) { return r.service || r.total; });
    var mTotal = mkt.reduce(function (a, r) { return a + parseNum(r.total); }, 0);
    var mktHtml = fb("no_marketing") ? kv("Marketing", "No marketing services this week")
      : kv("Marketing services", mkt.length + " · " + money(mTotal) + " total");

    var exp = serializeRows("expense").filter(function (r) { return r.vendor || r.amount; });
    var eTotal = exp.reduce(function (a, r) { return a + parseNum(r.amount); }, 0);
    var expHtml = kv("Expenses", exp.length + " · " + money(eTotal) + " total") + kv("Expense confirmation", fb("expense_confirm") ? "Confirmed" : "Not confirmed");

    var att = "";
    if (fv("att_late") === "yes") att += kv("Late/early entries", String(serializeRows("late").filter(function (r) { return r.name; }).length));
    if (fv("att_absent") === "yes") att += kv("Absences", String(serializeRows("absent").filter(function (r) { return r.name; }).length));
    if (!att) att = kv("Attendance", "No issues reported");

    var ratings = serializeRows("rating").filter(function (r) { return r.name; });
    var ratingHtml = ratings.length
      ? ratings.map(function (r) { return kv(r.name, "Overall " + (r.overall || "—")); }).join("")
      : kv("Barber ratings", "None entered");

    var shop = kv("Overall condition", fv("shop_condition") ? fv("shop_condition") + " / 5" : "") +
      kv("Priorities next week", fv("shop_priorities")) + kv("Assistance needed", fv("shop_assistance"));

    var files = kv("Files attached", String(fileCount()));

    $("#reviewArea").innerHTML =
      block("Manager Information", 1, mgr) +
      block("Weekly Tasks", 2, tasks) +
      block("Marketing & Expenses", 4, mktHtml + expHtml) +
      block("Attendance", 5, att) +
      block("Barber Ratings", 6, ratingHtml) +
      block("Shop Report", 7, shop) +
      block("Attachments", 7, files);

    $$("#reviewArea .review-edit").forEach(function (b) {
      b.addEventListener("click", function () { gotoStep(parseInt(b.dataset.edit, 10), true); });
    });
  }

  // =========================================================================
  // PAYLOAD
  // =========================================================================
  function collectRows(type) {
    var def = ROW_DEFS[type];
    var rows = Array.prototype.slice.call($(def.container).children);
    return rows.map(function (el) {
      var o = {}; $$("[data-k]", el).forEach(function (i) { o[i.dataset.k] = i.value.trim ? i.value.trim() : i.value; });
      if (def.upload) o.__bucket = def.upload + "_" + el.dataset.uid;
      return o;
    }).filter(function (row) {
      return def.fields.some(function (f) { return String(row[f.k] || "").trim() !== ""; }) ||
        (row.__bucket && (uploads[row.__bucket] || []).length);
    });
  }

  function collectPayload(submissionId) {
    var yn = function (n) { return fv(n); };
    return {
      submissionId: submissionId,
      hp: fv("company_website"),
      completedDate: fv("completedDate"),
      submittedAtClient: new Date().toISOString(),
      signature: fv("signature"),
      certification: { reviewed: fb("cert_reviewed"), accurate: fb("cert_accurate"), uploaded: fb("cert_uploaded"), contact: fb("cert_contact") },
      manager: {
        name: fv("managerName"),
        storeLocation: form.elements.storeLocation.value === "Other" ? fv("storeLocationOther") : fv("storeLocation"),
        storeLocationRaw: fv("storeLocation"),
        weekStart: fv("weekStart"), weekEnd: fv("weekEnd"), weekOfMonth: fv("weekOfMonth"),
        salesToDate: fv("salesToDate"), salesGoal: fv("salesGoal"), contact: fv("managerContact")
      },
      weeklyTasks: WEEKLY_TASKS.map(function (t) {
        return { key: t.key, label: t.label,
          status: form.elements["task_" + t.key] ? form.elements["task_" + t.key].value : "",
          explanation: fv("taskexplain_" + t.key), notes: fv("tasknote_" + t.key) };
      }),
      monthly: {
        weekOfMonth: fv("weekOfMonth"),
        first: {
          teamMeeting: { date: fv("fw_meeting_date"), attendees: fv("fw_meeting_attendees"), summary: fv("fw_meeting_summary"),
            feedback: fv("fw_meeting_feedback"), decisions: fv("fw_meeting_decisions"), responsible: fv("fw_meeting_responsible"), dueDate: fv("fw_meeting_due") },
          timeOff: { reviewed: fb("fw_timeoff_reviewed"), askedBarbers: fb("fw_timeoff_asked"), requests: collectRows("fwTimeoff") },
          hostessEval: yn("fw_hostess_needed") === "yes" ? {
            needed: true, name: fv("fw_hostess_name"), date: fv("fw_hostess_date"),
            attendance: fv("fw_hostess_attendance"), customerService: fv("fw_hostess_service"), communication: fv("fw_hostess_comm"),
            workEthic: fv("fw_hostess_ethic"), cleanliness: fv("fw_hostess_clean"),
            strengths: fv("fw_hostess_strengths"), improvement: fv("fw_hostess_improve"), actionPlan: fv("fw_hostess_action"),
            followUp: fv("fw_hostess_followup"), comments: fv("fw_hostess_comments")
          } : { needed: yn("fw_hostess_needed") === "no" ? false : null }
        },
        second: {
          inventory: collectRows("inv"),
          barberPlan: yn("sw_barber_needed") === "yes" ? { needed: true, entries: collectRows("barber") } : { needed: yn("sw_barber_needed") === "no" ? false : null }
        },
        third: { supplies: collectRows("supply") },
        fourth: {
          whatsapp: { sent: yn("fw4_sent"), dateSent: fv("fw4_date_sent"), meetingDate: fv("fw4_meeting_date"), meetingTime: fv("fw4_meeting_time"), notes: fv("fw4_notes") },
          incidents: yn("fw4_incidents") === "yes" ? { any: true, reports: collectRows("incident") } : { any: yn("fw4_incidents") === "no" ? false : null },
          oneOnOne: yn("fw4_oneonone") === "yes" ? { needed: true, entries: collectRows("oneonone") } : { needed: yn("fw4_oneonone") === "no" ? false : null }
        },
        fifth: { notes: fv("ffw_notes") }
      },
      marketing: { none: fb("no_marketing"), services: fb("no_marketing") ? [] : collectRows("mkt") },
      expenses: { confirmed: fb("expense_confirm"), items: collectRows("expense") },
      hostessHours: collectRows("host"),
      attendance: {
        late: yn("att_late") === "yes" ? { any: true, entries: collectRows("late") } : { any: yn("att_late") === "no" ? false : null },
        absent: yn("att_absent") === "yes" ? { any: true, entries: collectRows("absent") } : { any: yn("att_absent") === "no" ? false : null }
      },
      barberRatings: collectRows("rating"),
      shopReport: {
        condition: fv("shop_condition"), cleanliness: fv("shop_cleanliness"), maintenance: fv("shop_maintenance"),
        equipment: fv("shop_equipment"), supply: fv("shop_supply"), complaints: fv("shop_complaints"), positive: fv("shop_positive"),
        team: fv("shop_team"), staffing: fv("shop_staffing"), schedule: fv("shop_schedule"), ownership: fv("shop_ownership"),
        assistance: fv("shop_assistance"), priorities: fv("shop_priorities"), comments: fv("shop_comments")
      },
      uploads: uploads
    };
  }

  // =========================================================================
  // SUBMISSION
  // =========================================================================
  var submitting = false;
  function submissionId() {
    var id = null; try { id = sessionStorage.getItem(SUBMIT_ID_KEY); } catch (e) {}
    if (!id) { id = uuid(); try { sessionStorage.setItem(SUBMIT_ID_KEY, id); } catch (e) {} }
    return id;
  }

  function setSubmitting(on) {
    submitting = on;
    var b = $("#btnSubmit"); b.disabled = on; b.textContent = on ? "Submitting…" : "Submit Report";
    $("#btnPrev").disabled = on;
  }

  function doSubmit() {
    hideError(); warnNote.classList.remove("show");
    if (fv("company_website")) { showSuccess("", true); return; } // honeypot tripped

    // full validation across required steps
    var all = [];
    [1, 2, 4, 8].forEach(function (s) { all = all.concat(validateStep(s)); });
    all = all.filter(function (v, i, a) { return a.indexOf(v) === i; });
    if (all.length) { showError(all); return; }

    if (ENDPOINT_URL.indexOf("PASTE_") === 0) {
      showError("The form isn't connected to email yet. Add your Apps Script Web App URL at the top of app.js (see README).");
      return;
    }

    setSubmitting(true);
    var payload = collectPayload(submissionId());
    var body = JSON.stringify(payload);

    // Primary attempt: readable response so we can CONFIRM delivery.
    fetch(ENDPOINT_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: body })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.status === "success") {
          clearDraft(); dirty = false;
          try { sessionStorage.removeItem(SUBMIT_ID_KEY); } catch (e) {}
          showSuccess(data.ref || "", data.emailDelivered !== false, data.emailDelivered === false);
        } else {
          throw new Error((data && data.message) || "Server error");
        }
      })
      .catch(function () {
        // Couldn't read a confirmation. Best-effort delivery so data isn't lost
        // (server dedupes by submissionId, so this won't double-send/email),
        // then tell the user honestly that delivery is unconfirmed.
        fetch(ENDPOINT_URL, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: body })
          .catch(function () {})
          .then(function () { showUnconfirmed(); });
      });
  }

  function showSuccess(ref, delivered, needsAttention) {
    form.style.display = "none";
    $("#restoreBanner").classList.remove("show");
    var box = $("#refBox");
    if (ref) { box.textContent = "Ref: " + ref; box.style.display = ""; }
    else { box.style.display = "none"; }
    if (needsAttention) {
      $("#successText").innerHTML = "Your report was <b>received and saved</b>. Email delivery to the office needs attention — the team has been notified and no information was lost.";
    }
    $("#successMsg").classList.add("show");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showUnconfirmed() {
    setSubmitting(false);
    warnNote.innerHTML = "We sent your report but <b>couldn't confirm email delivery</b> from this device. Your information is saved and was not lost. " +
      "You can safely <b>press Submit again to retry</b> — duplicates are prevented automatically.";
    warnNote.classList.add("show");
    warnNote.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // =========================================================================
  // OPTIONAL LOGO
  // =========================================================================
  function tryLogo() {
    var candidates = ["logo.png", "logo.svg", "logo.jpg", "logo.jpeg", "assets/logo.png", "images/logo.png"];
    (function next(i) {
      if (i >= candidates.length) return;
      var img = new Image();
      img.onload = function () { var h = $("#brandHeader"); h.innerHTML = ""; img.alt = "Barber & Co. Miami"; h.appendChild(img); };
      img.onerror = function () { next(i + 1); };
      img.src = candidates[i];
    })(0);
  }

  // =========================================================================
  // INIT
  // =========================================================================
  function init() {
    buildWeeklyTasks();
    buildRatingScales();
    buildChips();
    setupConditionals();
    tryLogo();

    var today = new Date();
    form.elements.completedDate.value = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");

    var draft = loadDraft();
    var hasDraft = draft && (Object.keys(draft.fields || {}).length || (draft.rows && ROW_TYPES.some(function (k) { return (draft.rows[k] || []).length; })));
    if (hasDraft) {
      restoreDraft(draft);
      $("#restoreBanner").classList.add("show");
    } else {
      for (var i = 0; i < 3; i++) addRow("mkt");
      for (var j = 0; j < 2; j++) addRow("host");
      addRow("expense"); addRow("inv"); addRow("rating");
    }

    // uploaders + paint states after restore
    $$("[data-upload]").forEach(initUploader);
    $$(".status-opts").forEach(function (g) { paintStatus(g); toggleExplain(g.dataset.status); });
    $$("[data-rate]").forEach(paintRate);
    $$("[data-yesno]").forEach(function (yn) { paintYesNo(yn.dataset.yesno); });
    form.elements.storeLocation.dispatchEvent(new Event("change"));
    if (form.elements.weekOfMonth.value) form.elements.weekOfMonth.dispatchEvent(new Event("change"));
    $("#noMarketing").dispatchEvent(new Event("change"));

    attachCurrency(document);
    updateTotals();

    // global listeners
    form.addEventListener("input", function (e) {
      dirty = true; scheduleSave(); attachCurrency(form);
      var row = e.target.closest && e.target.closest(".row-item");
      if (row && row.dataset.type) refreshRow(row, row.dataset.type);
      updateTotals();
    });
    form.addEventListener("change", function (e) {
      scheduleSave();
      var row = e.target.closest && e.target.closest(".row-item");
      if (row && row.dataset.type) refreshRow(row, row.dataset.type);
      updateTotals();
    });

    $$("[data-add]").forEach(function (btn) { btn.addEventListener("click", function () { addRow(btn.dataset.add); }); });

    document.addEventListener("click", function (e) {
      if (e.target.classList && e.target.classList.contains("row-remove")) {
        var item = e.target.closest(".row-item");
        var type = item.dataset.type;
        var hasContent = $$("[data-k]", item).some(function (i) { return String(i.value).trim() !== ""; });
        var bucket = ROW_DEFS[type].upload ? ROW_DEFS[type].upload + "_" + item.dataset.uid : null;
        var hasFiles = bucket && (uploads[bucket] || []).length;
        if ((hasContent || hasFiles) && !confirm("Remove this entry? Any information typed here will be deleted.")) return;
        if (bucket) delete uploads[bucket];
        item.remove(); renumber(type); dirty = true; scheduleSave(); updateTotals();
      }
    });

    $("#btnNext").addEventListener("click", function () { gotoStep(currentStep + 1); });
    $("#btnPrev").addEventListener("click", function () { gotoStep(currentStep - 1, true); });
    form.addEventListener("submit", function (e) { e.preventDefault(); if (!submitting) doSubmit(); });

    $("#discardDraft").addEventListener("click", function () {
      clearDraft();
      try { sessionStorage.removeItem(SUBMIT_ID_KEY); } catch (e) {}
      dirty = false; location.reload();
    });

    // warn before leaving with unsaved changes
    window.addEventListener("beforeunload", function (e) {
      if (dirty && !submitting) { e.preventDefault(); e.returnValue = ""; return ""; }
    });

    // restore step position
    currentStep = (draft && draft.step) ? Math.min(draft.step, totalSteps) : 1;
    showStep(currentStep);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

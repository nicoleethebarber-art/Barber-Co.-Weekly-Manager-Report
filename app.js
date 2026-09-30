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
  var ENDPOINT_URL = "https://script.google.com/macros/s/AKfycbwiFsWO-VU25vyCEoXvUq7XX36Hwkoxt5I1TXkRthwEexMhm3Td--KQs3Xct_kOAsY4/exec";

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

  // ---- Access session (set after a valid 6-digit code) ---------------------
  var SESSION_KEY = "barberco_session_v1";
  var session = null; // { token, name, location }
  function loadSession() {
    try {
      var s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
      return (s && s.token) ? s : null;
    } catch (e) { return null; }
  }
  function saveSession(s) { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {} }
  function clearSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {} }

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
  // ORDER CHECKLISTS (fixed item lists from the shop's paper forms)
  // Each item has: Count / Order / Delivered(✓). Write-ins handled separately.
  // =========================================================================
  var CHECKLISTS = {
    productOrder: {
      groups: [
        { name: "Level 3", items: [
          "Deodorant", "LvL 3 Barber Clipper Spray", "LvL 3 Barber Gloves", "LvL 3 Barber Neck Strip",
          "LvL 3 Beard Oil", "LvL 3 Black Mask", "LvL 3 Hair Conditioner", "LvL 3 Hair Shampoo",
          "LvL 3 Hair Spray", "LvL 3 Razor Holder", "LvL 3 Styling Powder", "LvL 3 Texturizing Salt Spray"
        ]},
        { name: "Layrite", items: [
          "Layrite Super Hold Pomade (brown)", "Layrite Cement Clay (black)", "Layrite Grooming Spray",
          "Layrite Natural Matte Cream (blue)", "Layrite Travel Size Natural Matte Cream (little blue)",
          "Layrite Travel Size Super Hold Pomade (little brown)"
        ]}
      ]
    },
    supplyOrder: {
      groups: [
        { name: "Bar Supplies", items: [
          "Coffee Cups", "Sugar", "Straws", "Cocktail Napkins", "Coffee", "Plastic Cups", "Candy",
          "Coca-Cola", "Coca Zero", "Sprite", "Ginger", "Sparkling Water"
        ]},
        { name: "Shop Supplies", items: [
          "Black Towels", "White Towels", "Barbicide", "Towel Oil", "Black Mask", "Wax", "Wax Sticks", "Shaving Cream"
        ]},
        { name: "Liquor", items: ["Rum", "Gin", "Vodka", "Tequila", "Whiskey"] },
        { name: "Cleaning Supplies", items: [
          "Dish Soap", "Paper Towels", "Mouth Wash", "Sponges", "Vinegar", "Purified Water", "Windex",
          "All Purpose Cleaner", "Garbage Bag (Black)", "Garbage Bag (White)", "Incense", "Handsoap",
          "Floor Cleaner", "Detergent", "Toilet Paper"
        ]}
      ]
    }
  };

  function buildChecklist(key, hostId) {
    var def = CHECKLISTS[key]; var host = $("#" + hostId); if (!host) return;
    var html = "";
    def.groups.forEach(function (g, gi) {
      html += '<div class="chk-group"><h4>' + escapeHtml(g.name) + "</h4>" +
        '<div class="chk-head"><span>Item</span><span>Count</span><span>Order</span><span>✓</span></div>';
      g.items.forEach(function (it, ii) {
        var base = "chk_" + key + "_" + gi + "_" + ii;
        html += '<div class="chk-row"><span class="nm">' + escapeHtml(it) + "</span>" +
          '<input class="cctl" type="number" inputmode="numeric" min="0" name="' + base + '_count" aria-label="' + escapeHtml(it) + ' count">' +
          '<input class="cctl" type="number" inputmode="numeric" min="0" name="' + base + '_order" aria-label="' + escapeHtml(it) + ' order">' +
          '<input type="checkbox" name="' + base + '_delivered" aria-label="' + escapeHtml(it) + ' delivered">' +
          "</div>";
      });
      html += "</div>";
    });
    host.innerHTML = html;
  }

  function collectChecklist(key) {
    var def = CHECKLISTS[key]; var out = [];
    def.groups.forEach(function (g, gi) {
      g.items.forEach(function (it, ii) {
        var base = "chk_" + key + "_" + gi + "_" + ii;
        var count = fv(base + "_count"), order = fv(base + "_order"), delivered = fb(base + "_delivered");
        if (count || order || delivered) out.push({ category: g.name, item: it, count: count, order: order, delivered: delivered ? "Yes" : "" });
      });
    });
    return out;
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
      { k: "position", label: "Position", type: "text" },
      { k: "leaveType", label: "Type of Leave", type: "select", options: ["Vacation", "Sick", "Personal", "Unpaid", "Bereavement", "Other"] },
      { k: "startDate", label: "Start Date", type: "date" },
      { k: "endDate", label: "End Date", type: "date" },
      { k: "totalDays", label: "Total Days", type: "number" },
      { k: "daysLeft", label: "Days Left (of 25/yr)", type: "number" },
      { k: "reason", label: "Reason for Leave", type: "textarea" },
      { k: "status", label: "Status", type: "select", options: ["Approved", "Denied", "Pending"] },
      { k: "approvalDate", label: "Approval Date", type: "date" },
      { k: "comments", label: "Manager Comments", type: "textarea" }
    ]},
    prodMisc: { container: "#prodMiscRows", fields: [
      { k: "item", label: "Product", type: "text" },
      { k: "count", label: "Count", type: "number" },
      { k: "order", label: "Order", type: "number" },
      { k: "delivered", label: "Delivered?", type: "select", options: ["No", "Yes"] }
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
    supplyMisc: { container: "#supplyMiscRows", fields: [
      { k: "item", label: "Item", type: "text" },
      { k: "count", label: "Count", type: "number" },
      { k: "order", label: "Order", type: "number" },
      { k: "delivered", label: "Delivered?", type: "select", options: ["No", "Yes"] }
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
      token: session ? session.token : "",
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
          productOrder: collectChecklist("productOrder"),
          productMisc: collectRows("prodMisc"),
          barberPlan: yn("sw_barber_needed") === "yes" ? { needed: true, entries: collectRows("barber") } : { needed: yn("sw_barber_needed") === "no" ? false : null }
        },
        third: { supplyOrder: collectChecklist("supplyOrder"), supplyMisc: collectRows("supplyMisc") },
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
        } else if (data && /access code|session has expired/i.test(data.message || "")) {
          // Session no longer valid — send them back to the code screen.
          clearSession();
          setSubmitting(false);
          showError((data.message || "Your session expired.") + " Your answers are saved on this device.");
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
  // =========================================================================
  // ACCESS GATE — verify the 6-digit code before revealing the form
  // =========================================================================
  function showGate() {
    $("#gateCard").style.display = "";
    form.style.display = "none";
    var btn = $("#gateBtn"), input = $("#accessCode"), err = $("#gateError");

    function fail(msg) {
      err.textContent = msg; err.style.display = "block";
      btn.disabled = false; btn.textContent = "Unlock Report";
    }
    function attempt() {
      var code = String(input.value || "").replace(/[^0-9]/g, "");
      err.style.display = "none";
      if (code.length !== 6) { fail("Please enter your 6-digit access code."); return; }
      if (ENDPOINT_URL.indexOf("PASTE_") === 0) { fail("The form isn't connected yet (see README)."); return; }
      btn.disabled = true; btn.textContent = "Checking…";

      fetch(ENDPOINT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "verify", code: code })
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.status === "success" && d.token) {
            session = { token: d.token, name: (d.manager || {}).name || "", location: (d.manager || {}).location || "", isAdmin: !!(d.manager || {}).isAdmin };
            saveSession(session);
            $("#gateCard").style.display = "none";
            afterAuth();
          } else {
            fail((d && d.message) || "That access code is not recognized.");
          }
        })
        .catch(function () { fail("Couldn't reach the server. Check your connection and try again."); });
    }

    btn.addEventListener("click", attempt);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") attempt(); });
    input.focus();
  }

  /** Lock identity fields to the verified manager. */
  function applyIdentity() {
    if (!session) return;
    if (session.name) {
      form.elements.managerName.value = session.name;
      form.elements.managerName.readOnly = true;
      form.elements.managerName.style.background = "#26221a";
    }
    if (session.location) {
      var sel = form.elements.storeLocation;
      var found = false;
      Array.prototype.slice.call(sel.options).forEach(function (o) { if (o.value === session.location) found = true; });
      if (!found && session.location) { var o = document.createElement("option"); o.textContent = session.location; sel.appendChild(o); }
      sel.value = session.location;
      // Restrict to the assigned location only.
      Array.prototype.slice.call(sel.options).forEach(function (opt) {
        if (opt.value && opt.value !== session.location) opt.disabled = true;
      });
      sel.dispatchEvent(new Event("change"));
    }
  }

  function init() {
    session = loadSession();
    if (!session) { showGate(); return; }
    afterAuth();
  }

  /** After a verified session: admins choose report vs office docs; managers go straight to the report. */
  function afterAuth() {
    if (session && session.isAdmin) { showChooser(); return; }
    showReportForm();
  }

  function showChooser() {
    form.style.display = "none";
    $("#officeCard").style.display = "none";
    $("#areaCard").style.display = "none";
    $("#dashCard").style.display = "none";
    $("#kCard").style.display = "none";
    $("#chooserCard").style.display = "";
    var nm = String((session && session.name) || "").trim();
    var isDario = /^dario\b/i.test(nm), isKrystal = /^krystal\b/i.test(nm), isNicole = /^nicole\b/i.test(nm);
    $("#chooseArea").style.display = (isDario || isNicole) ? "" : "none";
    $("#chooseK").style.display = (isKrystal || isNicole) ? "" : "none";
    $("#chooseDash").style.display = isNicole ? "" : "none";
    if (!showChooser.__init) {
      showChooser.__init = true;
      $("#chooseReport").addEventListener("click", showReportForm);
      $("#chooseOffice").addEventListener("click", showOffice);
      $("#chooseArea").addEventListener("click", showArea);
      $("#chooseK").addEventListener("click", showK);
      $("#chooseDash").addEventListener("click", showDash);
    }
  }

  var formStarted = false;
  function showReportForm() {
    $("#chooserCard").style.display = "none";
    $("#officeCard").style.display = "none";
    $("#areaCard").style.display = "none";
    $("#dashCard").style.display = "none";
    $("#kCard").style.display = "none";
    form.style.display = "";
    if (!formStarted) { formStarted = true; startForm(); }
  }

  // =========================================================================
  // OFFICE DOCUMENTS (admins) — commission payouts, hostess hours,
  // bank & checks, monthly expense reports. Filed instantly on submit.
  // =========================================================================
  var OFFICE_ACCEPTED_EXT = ["pdf", "jpg", "jpeg", "png", "heic", "xlsx", "xls", "csv"];
  var odUploads = [];

  // =========================================================================
  // AREA MANAGER CHECK-IN (Dario) — Tuesday Check and Friday Sales Check
  // =========================================================================
  var AREA_SHOPS = ["Edgewater", "Pinecrest", "Studio"];
  var areaMode = "";

  function showArea() {
    $("#chooserCard").style.display = "none";
    form.style.display = "none";
    $("#officeCard").style.display = "none";
    $("#dashCard").style.display = "none";
    $("#kCard").style.display = "none";
    $("#areaCard").style.display = "";
    initArea();
  }

  function segHtml(key, options) {
    // options: [["All good","ok"], ["Issue found","no"], ...]
    var cols = options.length;
    var html = '<div class="status-opts seg" data-seg="' + key + '" style="grid-template-columns:repeat(' + cols + ',1fr)">';
    options.forEach(function (o) {
      html += '<label data-val="' + escapeHtml(o[0]) + '" data-tone="' + o[1] + '">' + escapeHtml(o[0]) + "</label>";
    });
    return html + "</div>";
  }

  function segValue(root, key) {
    var seg = root.querySelector('[data-seg="' + key + '"]');
    return (seg && seg.dataset.val) || "";
  }

  function buildAreaForms() {
    var tue = "";
    AREA_SHOPS.forEach(function (shop) {
      tue += '<div class="group" data-shop="' + shop + '"><h3>' + shop + "</h3>" +
        '<div class="seg-label">MER reviewed *</div>' + segHtml("mer_" + shop, [["All good", "ok"], ["Issue found", "no"]]) +
        '<div class="field area-notes" data-notes="' + shop + '" style="display:none;margin-top:10px"><label>Notes (required for issues) *</label>' +
        '<textarea data-notesbox="' + shop + '" placeholder="What did you find at ' + shop + '?"></textarea></div></div>';
    });
    tue += '<div class="group"><h3>Once this week</h3>' +
      '<div class="field"><label>Squire duplicates merged this week *</label>' +
      '<input type="text" inputmode="numeric" id="areaDups" placeholder="0">' +
      '<div class="hint">Minimum 30 per week while we clear the backlog (there are thousands).</div></div>' +
      '<div class="seg-label">Careers form replies *</div>' + segHtml("careers", [["Done", "ok"], ["None this week", "na"]]) +
      '<div class="seg-label">Training paperwork printed *</div>' + segHtml("training", [["Yes", "ok"], ["Need to reprint", "no"]]) +
      '<div class="seg-label">Holiday campaigns scheduled *</div>' + segHtml("campaigns", [["Yes", "ok"], ["No holiday coming", "na"], ["Not yet", "no"]]) +
      '<div class="seg-label">Payroll — new contractors / staff changes added *</div>' + segHtml("payroll", [["Updated", "ok"], ["No changes this week", "na"]]) +
      '<div class="seg-label">Monthly sit-down with Nicole *</div>' + segHtml("sitdown", [["Done this month", "ok"], ["Scheduled", "na"], ["Not yet", "no"]]) +
      '<div class="field" style="margin-top:8px"><label>Improvement idea <span class="opt">(optional)</span></label><textarea id="areaIdea"></textarea></div>' +
      '<div class="field" style="margin-top:10px"><label>Anything Nicole needs to know? <span class="opt">(optional)</span></label>' +
      '<textarea id="areaForNicole"></textarea></div></div>';
    $("#areaTueForm").innerHTML = tue;

    var fri = "";
    AREA_SHOPS.forEach(function (shop) {
      fri += '<div class="group" data-fshop="' + shop + '"><h3>' + shop + ' <span class="pct-tag" data-tag="' + shop + '"></span></h3>' +
        '<div class="two-col"><div class="field"><label>Sales so far ($) *</label>' +
        '<input type="text" inputmode="decimal" data-sales="' + shop + '" placeholder="0.00"></div>' +
        '<div class="field"><label>Weekly goal ($) *</label>' +
        '<input type="text" inputmode="decimal" data-goal="' + shop + '" placeholder="0.00"></div></div>' +
        '<div class="hint" data-pct="' + shop + '">Enter sales and goal to see % vs goal.</div>' +
        '<div data-behindwrap="' + shop + '" style="display:none;margin-top:10px">' +
        '<div class="seg-label">Campaign sent? *</div>' + segHtml("camp_" + shop, [["Yes", "ok"], ["No", "no"]]) +
        '<div class="field" data-whywrap="' + shop + '" style="display:none;margin-top:8px"><label>Why not? *</label>' +
        '<textarea data-why="' + shop + '"></textarea></div></div></div>';
    });
    $("#areaFriForm").innerHTML = fri;
  }

  function areaTueRefresh() {
    // show/require notes per shop when an issue is picked
    AREA_SHOPS.forEach(function (shop) {
      var root = $("#areaTueForm");
      var issue = segValue(root, "mer_" + shop) === "Issue found";
      var wrap = root.querySelector('[data-notes="' + shop + '"]');
      if (wrap) wrap.style.display = issue ? "" : "none";
    });
  }

  function areaFriRefresh(shop) {
    var root = $("#areaFriForm");
    var sales = parseFloat(String(root.querySelector('[data-sales="' + shop + '"]').value).replace(/[^0-9.\-]/g, ""));
    var goal = parseFloat(String(root.querySelector('[data-goal="' + shop + '"]').value).replace(/[^0-9.\-]/g, ""));
    var pctEl = root.querySelector('[data-pct="' + shop + '"]');
    var tagEl = root.querySelector('[data-tag="' + shop + '"]');
    var wrap = root.querySelector('[data-behindwrap="' + shop + '"]');
    if (!(goal > 0) || isNaN(sales)) {
      pctEl.textContent = "Enter sales and goal to see % vs goal.";
      tagEl.innerHTML = ""; wrap.style.display = "none"; return;
    }
    var pct = (sales / goal - 1) * 100;
    var rounded = Math.round(pct * 10) / 10;
    var behind = pct <= -3;
    pctEl.textContent = (rounded >= 0 ? "+" : "") + rounded + "% vs goal";
    tagEl.innerHTML = behind ? '<span class="behind-tag">BEHIND</span>' : '<span class="ontrack-tag">On pace</span>';
    wrap.style.display = behind ? "" : "none";
  }

  function areaSetMode(mode) {
    areaMode = mode;
    $("#areaTabTue").classList.toggle("on", mode === "tuesday");
    $("#areaTabFri").classList.toggle("on", mode === "friday");
    $("#areaTueForm").style.display = mode === "tuesday" ? "" : "none";
    $("#areaFriForm").style.display = mode === "friday" ? "" : "none";
    $("#areaSubmit").style.display = mode ? "" : "none";
    $("#areaError").style.display = "none";
  }

  function areaFail(msg) {
    var e = $("#areaError");
    e.textContent = msg; e.style.display = "block";
    e.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function initArea() {
    if (initArea.__init) return;
    initArea.__init = true;
    buildAreaForms();
    $("#areaCard").addEventListener("click", function (e) {
      var lab = e.target.closest(".seg label");
      if (!lab) return;
      var seg = lab.parentElement;
      seg.dataset.val = lab.dataset.val;
      Array.prototype.slice.call(seg.children).forEach(function (l) { l.classList.remove("sel-ok", "sel-no", "sel-na"); });
      lab.classList.add("sel-" + lab.dataset.tone);
      if (seg.dataset.seg.indexOf("mer_") === 0) areaTueRefresh();
      if (seg.dataset.seg.indexOf("camp_") === 0) {
        var shop = seg.dataset.seg.slice(5);
        var why = $("#areaFriForm").querySelector('[data-whywrap="' + shop + '"]');
        if (why) why.style.display = seg.dataset.val === "No" ? "" : "none";
      }
    });
    $("#areaFriForm").addEventListener("input", function (e) {
      var shop = e.target.getAttribute("data-sales") || e.target.getAttribute("data-goal");
      if (shop) areaFriRefresh(shop);
    });
    $("#areaTabTue").addEventListener("click", function () { areaSetMode("tuesday"); });
    $("#areaTabFri").addEventListener("click", function () { areaSetMode("friday"); });
    $("#areaBack").addEventListener("click", showChooser);
    $("#areaSubmit").addEventListener("click", areaSubmit);
  }

  function areaCollect() {
    var shops = {};
    if (areaMode === "tuesday") {
      var root = $("#areaTueForm");
      AREA_SHOPS.forEach(function (shop) {
        shops[shop] = {
          mer: segValue(root, "mer_" + shop),
          notes: root.querySelector('[data-notesbox="' + shop + '"]').value.trim()
        };
      });
      return {
        checkType: "tuesday", shops: shops,
        duplicates: $("#areaDups").value,
        careers: segValue(root, "careers"), training: segValue(root, "training"),
        campaigns: segValue(root, "campaigns"), payroll: segValue(root, "payroll"),
        sitdown: segValue(root, "sitdown"), idea: $("#areaIdea").value.trim(),
        forNicole: $("#areaForNicole").value.trim()
      };
    }
    var froot = $("#areaFriForm");
    AREA_SHOPS.forEach(function (shop) {
      shops[shop] = {
        sales: froot.querySelector('[data-sales="' + shop + '"]').value,
        goal: froot.querySelector('[data-goal="' + shop + '"]').value,
        campaign: segValue(froot, "camp_" + shop),
        campaignWhy: froot.querySelector('[data-why="' + shop + '"]').value.trim()
      };
    });
    return { checkType: "friday", shops: shops };
  }

  function areaValidate(d) {
    var p = [];
    if (d.checkType === "tuesday") {
      AREA_SHOPS.forEach(function (shop) {
        var s = d.shops[shop];
        if (!s.mer) p.push(shop + ": pick an answer for MER reviewed.");
        if (s.mer === "Issue found" && !s.notes) p.push(shop + ": notes are required when an issue is found.");
      });
      var dups = parseInt(String(d.duplicates).replace(/[^0-9]/g, ""), 10);
      if (isNaN(dups) || dups < 30) p.push("Enter how many Squire duplicates you merged — minimum 30 per week while we clear the backlog.");
      if (!d.careers) p.push("Pick an answer for Careers form replies.");
      if (!d.training) p.push("Pick an answer for Training paperwork.");
      if (!d.campaigns) p.push("Pick an answer for Holiday campaigns.");
      if (!d.payroll) p.push("Pick an answer for Payroll (new contractors / staff changes).");
      if (!d.sitdown) p.push("Pick an answer for the monthly sit-down with Nicole.");
    } else {
      AREA_SHOPS.forEach(function (shop) {
        var s = d.shops[shop];
        var sales = parseFloat(String(s.sales).replace(/[^0-9.\-]/g, ""));
        var goal = parseFloat(String(s.goal).replace(/[^0-9.\-]/g, ""));
        if (isNaN(sales)) p.push(shop + ": enter sales so far.");
        if (!(goal > 0)) p.push(shop + ": enter the weekly goal.");
        if (goal > 0 && !isNaN(sales) && sales / goal - 1 <= -0.03) {
          if (!s.campaign) p.push(shop + " is behind — answer \"Campaign sent?\".");
          if (s.campaign === "No" && !s.campaignWhy) p.push(shop + ": say why no campaign was sent.");
        }
      });
    }
    return p;
  }

  function areaSubmit() {
    var btn = $("#areaSubmit"), ok = $("#areaSuccess");
    $("#areaError").style.display = "none"; ok.style.display = "none";
    if (!areaMode) { areaFail("Pick Tuesday Check or Friday Sales first."); return; }
    var d = areaCollect();
    var problems = areaValidate(d);
    if (problems.length) { areaFail(problems.join(" ")); return; }
    btn.disabled = true; btn.textContent = "Submitting…";
    d.action = "areacheck";
    d.token = session && session.token;
    d.submissionId = uuid();
    fetch(ENDPOINT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(d)
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = "Submit Check-in";
        if (res && res.status === "success") {
          ok.innerHTML = "✅ <strong>Check-in submitted!</strong> Nicole has been emailed.<br>Reference: " + escapeHtml(res.ref || "");
          ok.style.display = "";
          ok.scrollIntoView({ behavior: "smooth", block: "center" });
        } else if (res && /access code|session has expired/i.test(res.message || "")) {
          clearSession(); session = null;
          $("#areaCard").style.display = "none";
          showGate();
        } else {
          areaFail((res && res.message) || "The server could not save the check-in. Please try again.");
        }
      })
      .catch(function () {
        btn.disabled = false; btn.textContent = "Submit Check-in";
        areaFail("Couldn't reach the server. Check your connection and try again.");
      });
  }

  // =========================================================================
  // KRYSTAL'S CHECK-IN — payroll, Tuesday duties, sales vs last week, card
  // =========================================================================
  var kMode = "";

  function showK() {
    $("#chooserCard").style.display = "none";
    form.style.display = "none";
    $("#officeCard").style.display = "none";
    $("#areaCard").style.display = "none";
    $("#dashCard").style.display = "none";
    $("#kCard").style.display = "";
    initK();
  }

  function kWeekOfMonth() { return Math.ceil(new Date().getDate() / 7); }

  function buildKForms() {
    $("#kPayrollForm").innerHTML =
      '<div class="group"><h3>Payroll review (hours, commissions, tips)</h3>' +
      segHtml("k_payroll", [["All good", "ok"], ["Discrepancies found", "no"]]) +
      '<div class="field" id="kPayNotesWrap" style="display:none;margin-top:10px"><label>What discrepancies? *</label><textarea id="kPayNotes"></textarea>' +
      '<div class="seg-label">Resolved? *</div>' + segHtml("k_resolved", [["Resolved", "ok"], ["Still working on it", "no"]]) + "</div>" +
      '<div class="seg-label">"Bank &amp; Checks" file emailed to Attaf *</div>' + segHtml("k_attaf", [["Sent", "ok"], ["Not yet", "no"]]) +
      '<div class="field" id="kAttafWhyWrap" style="display:none;margin-top:8px"><label>Why not yet? *</label><textarea id="kAttafWhy"></textarea></div></div>';

    var wk = kWeekOfMonth();
    var sales = '<div class="group"><h3>Sales vs last week</h3>';
    AREA_SHOPS.forEach(function (shop) {
      sales += '<div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px"><b>' + shop + ' <span data-ktag="' + shop + '"></span></b>' +
        '<div class="two-col" style="margin-top:8px"><div class="field"><label>This week ($) *</label><input type="text" inputmode="decimal" data-kthis="' + shop + '" placeholder="0.00"></div>' +
        '<div class="field"><label>Last week ($) *</label><input type="text" inputmode="decimal" data-klast="' + shop + '" placeholder="0.00"></div></div>' +
        '<div class="hint" data-kpct="' + shop + '">Enter both weeks to compare.</div>' +
        '<div data-kdownwrap="' + shop + '" style="display:none;margin-top:10px">' +
        '<div class="seg-label">Engage campaign sent? *</div>' + segHtml("kcamp_" + shop, [["Campaign sent", "ok"], ["No campaign", "no"]]) +
        '<div data-kchatwrap="' + shop + '" style="display:none;margin-top:8px">' +
        '<div class="seg-label">Posted in managers chat? *</div>' + segHtml("kchat_" + shop, [["Posted in chat", "ok"], ["Not posted yet", "no"]]) +
        "</div></div></div>";
    });
    sales += "</div>";

    var card = '<p class="hint">Split shared purchases; confirm each shop paid its share to the Chase card.</p>';
    AREA_SHOPS.forEach(function (shop) {
      card += '<div style="margin-top:8px"><b>' + shop + "</b>" +
        segHtml("kshare_" + shop, [["Paid - matches", "ok"], ["Mismatch", "no"]]) +
        '<div class="field" data-ksharewrap="' + shop + '" style="display:none;margin-top:8px"><label>Describe the mismatch *</label><textarea data-kshare-notes="' + shop + '"></textarea></div></div>';
    });

    function weekBlock(n, title, inner) {
      return '<details class="collapse"' + (wk === n ? " open" : "") + '><summary>Week ' + n + " — " + title + (wk === n ? " ← this week" : "") + "</summary>" +
        '<div class="inner">' + (wk === n ? inner : '<p class="tbd">Not this week — nothing to fill.</p>') + "</div></details>";
    }
    var monthly =
      weekBlock(1, "Card expense + paperwork", card +
        '<div class="seg-label" style="margin-top:12px">Employee paperwork organized *</div>' + segHtml("k_paperwork", [["Organized", "ok"], ["Needs work", "no"]])) +
      weekBlock(2, "Inventory count",
        '<div class="seg-label">Inventory counted *</div>' + segHtml("k_inventory", [["Done", "ok"], ["Not yet", "no"]]) +
        '<div class="field" style="margin-top:8px"><label>What\u2019s running low? *</label><textarea id="kLowItems" placeholder="Write \u201cnothing low\u201d if fully stocked"></textarea></div>') +
      weekBlock(3, "Place the order",
        '<div class="seg-label">Order placed (email list + low items) *</div>' + segHtml("k_order", [["Done", "ok"], ["Not yet", "no"]]) +
        '<div class="field" id="kOrderNotesWrap" style="display:none;margin-top:8px"><label>Why not yet? *</label><textarea id="kOrderNotes"></textarea></div>') +
      weekBlock(4, "Follow-up + performance report",
        '<div class="seg-label">Order delivery *</div>' + segHtml("k_delivery", [["All delivered", "ok"], ["Missing items", "no"]]) +
        '<div class="field" id="kDeliveryNotesWrap" style="display:none;margin-top:8px"><label>What\u2019s missing? *</label><textarea id="kDeliveryNotes"></textarea></div>' +
        '<div class="seg-label">Monthly performance report *</div>' + segHtml("k_perf", [["Done", "ok"], ["Not yet", "no"]]));

    $("#kTueForm").innerHTML =
      '<p class="hint" style="margin:4px 0 10px">Week ' + wk + " of the month" + (wk === 5 ? " — no monthly items this week" : "") + "</p>" +
      '<div class="group"><h3>Every Tuesday</h3>' +
      '<div class="seg-label">New hires in the "Bank &amp; Checks" file *</div>' + segHtml("k_hires", [["All in the file", "ok"], ["Missing - told Dario", "no"]]) +
      '<div class="field" id="kHiresNotesWrap" style="display:none;margin-top:8px"><label>Who / what is missing? *</label><textarea id="kHiresNotes"></textarea></div>' +
      '<div class="seg-label">Google reviews (all 3 shops) *</div>' + segHtml("k_reviews", [["Done all 3 shops", "ok"], ["Not yet", "no"]]) + "</div>" +
      sales +
      (wk <= 4 ? '<h3 style="margin:14px 0 8px">This month\u2019s duties</h3>' + monthly : "") +
      '<div class="field" style="margin-top:12px"><label>Anything Nicole needs to know? <span class="opt">(optional)</span></label><textarea id="kForNicole"></textarea></div>';
  }

  function kSalesRefresh(shop) {
    var root = $("#kTueForm");
    var t = parseFloat(String(root.querySelector('[data-kthis="' + shop + '"]').value).replace(/[^0-9.\-]/g, ""));
    var l = parseFloat(String(root.querySelector('[data-klast="' + shop + '"]').value).replace(/[^0-9.\-]/g, ""));
    var pctEl = root.querySelector('[data-kpct="' + shop + '"]');
    var tagEl = root.querySelector('[data-ktag="' + shop + '"]');
    var wrap = root.querySelector('[data-kdownwrap="' + shop + '"]');
    if (!(l > 0) || isNaN(t)) { pctEl.textContent = "Enter both weeks to compare."; tagEl.innerHTML = ""; wrap.style.display = "none"; return; }
    var pct = Math.round((t / l - 1) * 1000) / 10;
    var down = t < l;
    pctEl.textContent = (pct >= 0 ? "+" : "") + pct + "% vs last week";
    tagEl.innerHTML = down ? '<span class="behind-tag">DOWN</span>' : '<span class="ontrack-tag">Up</span>';
    wrap.style.display = down ? "" : "none";
  }

  function kSetMode(mode) {
    kMode = mode;
    [["payroll", "#kTabPayroll", "#kPayrollForm"], ["tuesday", "#kTabTue", "#kTueForm"]].forEach(function (t) {
      $(t[1]).classList.toggle("on", mode === t[0]);
      $(t[2]).style.display = mode === t[0] ? "" : "none";
    });
    $("#kSubmit").style.display = mode ? "" : "none";
    $("#kError").style.display = "none";
  }

  function kFail(msg) {
    var e = $("#kError");
    e.textContent = msg; e.style.display = "block";
    e.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function initK() {
    if (initK.__init) return;
    initK.__init = true;
    buildKForms();
    $("#kCard").addEventListener("click", function (e) {
      var lab = e.target.closest(".seg label");
      if (!lab) return;
      var seg = lab.parentElement;
      seg.dataset.val = lab.dataset.val;
      Array.prototype.slice.call(seg.children).forEach(function (l) { l.classList.remove("sel-ok", "sel-no", "sel-na"); });
      lab.classList.add("sel-" + lab.dataset.tone);
      var k = seg.dataset.seg, v = seg.dataset.val;
      if (k === "k_payroll") $("#kPayNotesWrap").style.display = v === "Discrepancies found" ? "" : "none";
      if (k === "k_attaf") $("#kAttafWhyWrap").style.display = v === "Not yet" ? "" : "none";
      if (k === "k_hires") $("#kHiresNotesWrap").style.display = v === "Missing - told Dario" ? "" : "none";
      if (k === "k_order") { var w = $("#kOrderNotesWrap"); if (w) w.style.display = v === "Not yet" ? "" : "none"; }
      if (k === "k_delivery") { var w2 = $("#kDeliveryNotesWrap"); if (w2) w2.style.display = v === "Missing items" ? "" : "none"; }
      if (k.indexOf("kcamp_") === 0) {
        var shop = k.slice(6);
        $("#kTueForm").querySelector('[data-kchatwrap="' + shop + '"]').style.display = v === "No campaign" ? "" : "none";
      }
      if (k.indexOf("kshare_") === 0) {
        var shop2 = k.slice(7);
        $("#kTueForm").querySelector('[data-ksharewrap="' + shop2 + '"]').style.display = v === "Mismatch" ? "" : "none";
      }
    });
    $("#kTueForm").addEventListener("input", function (e) {
      var shop = e.target.getAttribute("data-kthis") || e.target.getAttribute("data-klast");
      if (shop) kSalesRefresh(shop);
    });
    $("#kTabPayroll").addEventListener("click", function () { kSetMode("payroll"); });
    $("#kTabTue").addEventListener("click", function () { kSetMode("tuesday"); });
    $("#kBack").addEventListener("click", showChooser);
    $("#kSubmit").addEventListener("click", kSubmitForm);
  }

  function kCollect() {
    var d = { checkType: kMode };
    if (kMode === "payroll") {
      var r = $("#kPayrollForm");
      d.payroll = segValue(r, "k_payroll"); d.notes = $("#kPayNotes").value.trim();
      d.resolved = segValue(r, "k_resolved"); d.attaf = segValue(r, "k_attaf"); d.attafWhy = $("#kAttafWhy").value.trim();
      return d;
    }
    var t = $("#kTueForm");
    d.hires = segValue(t, "k_hires"); d.hiresNotes = $("#kHiresNotes").value.trim();
    d.reviews = segValue(t, "k_reviews"); d.forNicole = $("#kForNicole").value.trim();
    d.sales = {};
    AREA_SHOPS.forEach(function (shop) {
      d.sales[shop] = {
        thisWeek: t.querySelector('[data-kthis="' + shop + '"]').value,
        lastWeek: t.querySelector('[data-klast="' + shop + '"]').value,
        campaign: segValue(t, "kcamp_" + shop), chat: segValue(t, "kchat_" + shop)
      };
    });
    var wk = kWeekOfMonth();
    if (wk === 1) {
      d.card = {};
      AREA_SHOPS.forEach(function (shop) {
        d.card[shop] = { share: segValue(t, "kshare_" + shop), notes: t.querySelector('[data-kshare-notes="' + shop + '"]').value.trim() };
      });
      d.paperwork = segValue(t, "k_paperwork");
    } else if (wk === 2) {
      d.inventory = segValue(t, "k_inventory");
      d.lowItems = ($("#kLowItems") || { value: "" }).value.trim();
    } else if (wk === 3) {
      d.order = segValue(t, "k_order"); d.orderNotes = ($("#kOrderNotes") || { value: "" }).value.trim();
    } else if (wk === 4) {
      d.delivery = segValue(t, "k_delivery"); d.deliveryNotes = ($("#kDeliveryNotes") || { value: "" }).value.trim();
      d.perfReport = segValue(t, "k_perf");
    }
    return d;
  }

  function kValidate(d) {
    var p = [];
    var money = function (v) { return parseFloat(String(v).replace(/[^0-9.\-]/g, "")); };
    if (d.checkType === "payroll") {
      if (!d.payroll) p.push("Pick an answer for the payroll review.");
      if (d.payroll === "Discrepancies found") {
        if (!d.notes) p.push("Describe the discrepancies you found.");
        if (!d.resolved) p.push("Say whether the discrepancies are resolved.");
      }
      if (!d.attaf) p.push("Pick an answer for the Bank & Checks file to Attaf.");
      if (d.attaf === "Not yet" && !d.attafWhy) p.push("Say why the file wasn't sent to Attaf yet.");
      return p;
    }
    if (!d.hires) p.push("Pick an answer for new hires in the Bank & Checks file.");
    if (d.hires === "Missing - told Dario" && !d.hiresNotes) p.push("Say who or what is missing.");
    if (!d.reviews) p.push("Pick an answer for Google reviews.");
    AREA_SHOPS.forEach(function (shop) {
      var sd = d.sales[shop];
      var t = money(sd.thisWeek), l = money(sd.lastWeek);
      if (isNaN(t)) p.push(shop + ": enter this week's sales.");
      if (!(l > 0)) p.push(shop + ": enter last week's sales.");
      if (l > 0 && !isNaN(t) && t < l) {
        if (!sd.campaign) p.push(shop + " is down — say whether an Engage campaign was sent.");
        if (sd.campaign === "No campaign" && !sd.chat) p.push(shop + ": post it in the managers chat and pick an answer.");
      }
    });
    var wk = kWeekOfMonth();
    if (wk === 1) {
      AREA_SHOPS.forEach(function (shop) {
        var cd = d.card[shop];
        if (!cd.share) p.push(shop + ": say whether its Chase card share matches.");
        if (cd.share === "Mismatch" && !cd.notes) p.push(shop + ": describe the mismatch.");
      });
      if (!d.paperwork) p.push("Pick an answer for employee paperwork.");
    } else if (wk === 2) {
      if (!d.inventory) p.push("Pick an answer for the inventory count.");
      if (d.inventory === "Done" && !d.lowItems) p.push("List what's running low (or write \u201cnothing low\u201d).");
    } else if (wk === 3) {
      if (!d.order) p.push("Pick an answer for placing the order.");
      if (d.order === "Not yet" && !d.orderNotes) p.push("Say why the order wasn't placed yet.");
    } else if (wk === 4) {
      if (!d.delivery) p.push("Pick an answer for the order delivery.");
      if (d.delivery === "Missing items" && !d.deliveryNotes) p.push("Say what's missing from the delivery.");
      if (!d.perfReport) p.push("Pick an answer for the monthly performance report.");
    }
    return p;
  }

  function kSubmitForm() {
    var btn = $("#kSubmit"), ok = $("#kSuccess");
    $("#kError").style.display = "none"; ok.style.display = "none";
    if (!kMode) { kFail("Pick which check-in you're doing first."); return; }
    var d = kCollect();
    var problems = kValidate(d);
    if (problems.length) { kFail(problems.join(" ")); return; }
    d.action = "krystalcheck"; d.token = session && session.token; d.submissionId = uuid();
    btn.disabled = true; btn.textContent = "Submitting…";
    fetch(ENDPOINT_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(d) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = "Submit Check-in";
        if (res && res.status === "success") {
          ok.innerHTML = "✅ <strong>Check-in submitted!</strong> Nicole has been emailed.<br>Reference: " + escapeHtml(res.ref || "");
          ok.style.display = ""; ok.scrollIntoView({ behavior: "smooth", block: "center" });
        } else if (res && /access code|session has expired/i.test(res.message || "")) {
          clearSession(); session = null; $("#kCard").style.display = "none"; showGate();
        } else {
          kFail((res && res.message) || "The server could not save the check-in. Please try again.");
        }
      })
      .catch(function () { btn.disabled = false; btn.textContent = "Submit Check-in"; kFail("Couldn't reach the server. Check your connection and try again."); });
  }

  // =========================================================================
  // ADMIN DASHBOARD (Nicole) — read-only: what's done, what's missing
  // =========================================================================
  function showDash() {
    $("#chooserCard").style.display = "none";
    form.style.display = "none";
    $("#officeCard").style.display = "none";
    $("#areaCard").style.display = "none";
    $("#kCard").style.display = "none";
    $("#dashCard").style.display = "";
    if (!showDash.__init) {
      showDash.__init = true;
      $("#dashBack").addEventListener("click", showChooser);
      $("#dashRefresh").addEventListener("click", loadDash);
    }
    loadDash();
  }

  function dashRow(okFlag, label, detail, ref) {
    return '<div style="display:flex;gap:8px;align-items:flex-start;padding:5px 0;border-bottom:1px solid var(--line)">' +
      '<span>' + (okFlag ? "✅" : "❌") + '</span><div style="flex:1"><b>' + label + "</b>" +
      (detail ? '<div style="color:var(--muted);font-size:12.5px">' + detail + "</div>" : "") + "</div>" +
      (ref ? '<button type="button" class="dview" data-ref="' + escapeHtml(ref) + '" style="background:none;border:1px solid var(--mustard);color:var(--mustard);border-radius:8px;padding:5px 11px;font-weight:700;cursor:pointer;white-space:nowrap;font-size:12.5px">View</button>' : "") +
      "</div>";
  }

  // Opens one report and shows every answer inside it.
  function dashDetail(ref) {
    var body = $("#dashBody");
    body.innerHTML = '<p style="color:var(--muted);text-align:center">Opening ' + escapeHtml(ref) + "…</p>";
    fetch(ENDPOINT_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "reportDetail", ref: ref, token: session && session.token, submissionId: uuid() }) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res || res.status !== "success" || !res.detail) {
          window.alert((res && res.message) || "Could not open that report.");
          loadDash(); return;
        }
        var d = res.detail, h = "";
        h += '<button type="button" id="dashDetailBack" style="background:none;border:none;color:var(--mustard);font-weight:700;cursor:pointer;padding:0 0 10px;font-size:14px">← Back to dashboard</button>';
        h += '<div class="group"><h3>' + escapeHtml(d.title) + "</h3>";
        h += '<p style="color:var(--muted);font-size:13px;margin:4px 0 2px">' + escapeHtml(d.ref) + " · submitted by " + escapeHtml(d.by) + (d.at ? " · " + escapeHtml(d.at) : "") + "</p>";
        var good = /APPROVED|COMPLETED|FILED|Submitted/i.test(d.status || "");
        h += '<p style="font-weight:700;font-size:13px;margin:2px 0;color:' + (good ? "var(--ok)" : "var(--no)") + '">' + escapeHtml(d.status || "") + "</p>";
        if (d.summary) h += '<p style="font-size:13.5px;margin:4px 0 0">' + escapeHtml(d.summary) + "</p>";
        h += "</div>";
        h += '<div class="group"><h3>📝 Everything in this report</h3>';
        if (!d.rows || !d.rows.length) h += '<p class="hint">No saved answers found for this one.</p>';
        (d.rows || []).forEach(function (row) {
          var pad = Math.min(row.sub || 0, 3) * 14;
          if (row.head) {
            h += '<div style="padding:9px 0 3px ' + pad + 'px;font-weight:800;color:var(--mustard);font-size:12.5px;text-transform:uppercase;letter-spacing:.4px">' + escapeHtml(row.label) + "</div>";
          } else {
            h += '<div style="display:flex;gap:10px;justify-content:space-between;padding:5px 0 5px ' + pad + 'px;border-bottom:1px solid var(--line);font-size:13.5px">' +
              '<span style="color:var(--muted)">' + escapeHtml(row.label) + "</span>" +
              '<span style="text-align:right;max-width:62%;word-break:break-word"><b>' + escapeHtml(row.value) + "</b></span></div>";
          }
        });
        h += "</div>";
        body.innerHTML = h;
        $("#dashDetailBack").addEventListener("click", loadDash);
        body.scrollIntoView({ behavior: "smooth", block: "start" });
      })
      .catch(function () { window.alert("Couldn't reach the server. Try again."); loadDash(); });
  }

  function dashCleanup() {
    if (!window.confirm("Delete ALL reports from before this week that were never approved?\n\nApproved reports are kept. This cannot be undone.")) return;
    var body = $("#dashBody");
    fetch(ENDPOINT_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "cleanupOld", token: session && session.token, submissionId: uuid() }) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.status === "success") {
          window.alert(res.deleted ? "Deleted " + res.deleted + " old unapproved report(s)." : "Nothing to delete \u2014 no old unapproved reports.");
          loadDash();
        } else {
          window.alert((res && res.message) || "Could not delete. Try again.");
        }
      })
      .catch(function () { window.alert("Couldn't reach the server. Try again."); });
  }

  function loadDash() {
    var body = $("#dashBody");
    body.innerHTML = '<p style="color:var(--muted);text-align:center">Loading…</p>';
    fetch(ENDPOINT_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "dashboard", token: session && session.token, submissionId: uuid() }) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res || res.status !== "success") {
          if (res && /access code|session has expired/i.test(res.message || "")) { clearSession(); session = null; showGate(); return; }
          body.innerHTML = '<p style="color:var(--warn)">' + escapeHtml((res && res.message) || "Couldn't load.") + "</p>"; return;
        }
        var d = res.dashboard, h = "";
        h += '<div class="group"><h3>📋 Manager reports — last week</h3>';
        AREA_SHOPS.forEach(function (shop) {
          var r = d.reports.lastWeek[shop];
          h += dashRow(!!r, shop, r ? escapeHtml(r.ref) + " · " + escapeHtml(r.status) : "No report for last week yet — chase it", r ? r.ref : null);
        });
        h += "</div>";
        h += '<div class="group"><h3>⏳ Waiting on your approval (' + d.reports.pending.length + ")</h3>";
        if (!d.reports.pending.length) h += '<p class="hint">Nothing pending. 🎉</p>';
        d.reports.pending.forEach(function (p) {
          h += dashRow(false, escapeHtml(p.ref), escapeHtml(p.manager + " · " + p.location + " · " + p.week) + " — approve from its email, or the sheet menu", p.ref);
        });
        h += '<button type="button" id="dashCleanup" style="width:100%;margin-top:8px;background:none;border:1.5px dashed var(--no);color:var(--no);border-radius:10px;padding:11px;font-weight:700;cursor:pointer">🗑 Delete old unapproved reports</button>';
        h += "</div>";
        h += '<div class="group"><h3>🧭 Dario this week</h3>' +
          dashRow(!!d.dario.tuesday, "Tuesday Check", d.dario.tuesday ? escapeHtml(d.dario.tuesday.summary) : "Not submitted yet", d.dario.tuesday ? d.dario.tuesday.ref : null) +
          dashRow(!!d.dario.friday, "Friday Sales Check", d.dario.friday ? escapeHtml(d.dario.friday.summary) : "Not submitted yet", d.dario.friday ? d.dario.friday.ref : null) + "</div>";
        h += '<div class="group"><h3>🗓️ Krystal this week</h3>' +
          dashRow(!!d.krystal.payroll, "Payroll (Sun–Mon)", d.krystal.payroll ? escapeHtml(d.krystal.payroll.summary) : "Not submitted yet", d.krystal.payroll ? d.krystal.payroll.ref : null) +
          dashRow(!!d.krystal.tuesday, "Tuesday check-in (sales + week " + d.weekOfMonth + " duties)", d.krystal.tuesday ? escapeHtml(d.krystal.tuesday.summary) : "Not submitted yet", d.krystal.tuesday ? d.krystal.tuesday.ref : null) +
          "</div>";
        h += '<div class="group"><h3>🗂️ Office documents this week (' + d.office.length + ")</h3>";
        if (!d.office.length) h += '<p class="hint">None filed yet this week.</p>';
        d.office.forEach(function (o) {
          h += dashRow(true, escapeHtml(o.type + (o.location && o.location !== "ALL" ? " · " + o.location : "")), escapeHtml(o.period + " · by " + o.by), o.ref || null);
        });
        h += "</div>";
        body.innerHTML = h;
        var cbtn = $("#dashCleanup");
        if (cbtn) cbtn.addEventListener("click", dashCleanup);
        Array.prototype.forEach.call(body.querySelectorAll(".dview"), function (b) {
          b.addEventListener("click", function () { dashDetail(b.getAttribute("data-ref")); });
        });
      })
      .catch(function () { body.innerHTML = '<p style="color:var(--warn)">Couldn\u2019t reach the server. Tap Refresh to retry.</p>'; });
  }

  function showOffice() {
    $("#chooserCard").style.display = "none";
    form.style.display = "none";
    $("#areaCard").style.display = "none";
    $("#dashCard").style.display = "none";
    $("#kCard").style.display = "none";
    $("#officeCard").style.display = "";
    initOffice();
  }

  function odToggle() {
    var t = $("#odType").value;
    $("#odLocWrap").style.display = (t === "commission" || t === "hostess") ? "" : "none";
    $("#odWeekWrap").style.display = (t === "commission" || t === "hostess" || t === "bank") ? "" : "none";
    $("#odMonthWrap").style.display = (t === "expense") ? "" : "none";
  }

  function odRenderFiles() {
    var list = $("#odFileList");
    if (!odUploads.length) { list.textContent = "No files chosen yet."; return; }
    list.innerHTML = "";
    odUploads.forEach(function (f, idx) {
      var row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:8px;padding:4px 0";
      var span = document.createElement("span");
      span.textContent = "📄 " + f.name;
      var x = document.createElement("button");
      x.type = "button"; x.textContent = "×";
      x.style.cssText = "border:none;background:#eee;border-radius:50%;width:22px;height:22px;cursor:pointer";
      x.setAttribute("aria-label", "Remove file");
      x.onclick = function () { odUploads.splice(idx, 1); odRenderFiles(); };
      row.appendChild(span); row.appendChild(x); list.appendChild(row);
    });
  }

  function odFail(msg) {
    var err = $("#odError");
    err.textContent = msg; err.style.display = "block";
  }

  function initOffice() {
    if (initOffice.__init) return;
    initOffice.__init = true;
    odRenderFiles();
    $("#odType").addEventListener("change", odToggle);
    $("#odWeekStart").addEventListener("change", function () {
      var v = this.value;
      if (v && !$("#odWeekEnd").value) {
        var d = new Date(v + "T12:00:00");
        d.setDate(d.getDate() + 6);
        $("#odWeekEnd").value = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      }
    });
    $("#odFiles").addEventListener("change", function () {
      var files = Array.prototype.slice.call(this.files || []); this.value = "";
      $("#odError").style.display = "none";
      files.forEach(function (file) {
        var ext = (String(file.name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || "";
        if (OFFICE_ACCEPTED_EXT.indexOf(ext) === -1) { odFail("“" + file.name + "” isn't an accepted type (PDF, JPG, PNG, HEIC, Excel, CSV)."); return; }
        if (file.size > MAX_FILE_MB * 1024 * 1024) { odFail("“" + file.name + "” is larger than " + MAX_FILE_MB + " MB."); return; }
        compressImage(file).then(function (obj) {
          if (!obj) { odFail("Couldn't read “" + file.name + "”."); return; }
          odUploads.push(obj); odRenderFiles();
        });
      });
    });
    $("#odBack").addEventListener("click", showChooser);
    $("#odSubmit").addEventListener("click", odSubmit);
  }

  function odSubmit() {
    var err = $("#odError"), ok = $("#odSuccess"), btn = $("#odSubmit");
    err.style.display = "none"; ok.style.display = "none";
    var t = $("#odType").value;
    if (!t) { odFail("Please choose a document type."); return; }
    var needsLoc = (t === "commission" || t === "hostess");
    var location = $("#odLocation").value;
    if (needsLoc && !location) { odFail("Please choose a location."); return; }
    var weekStart = $("#odWeekStart").value, weekEnd = $("#odWeekEnd").value, month = $("#odMonth").value;
    if (t !== "expense" && (!weekStart || !weekEnd)) { odFail("Please pick the week start and end dates."); return; }
    if (t === "expense" && !month) { odFail("Please pick the month."); return; }
    if (!odUploads.length) { odFail("Please attach at least one file."); return; }

    btn.disabled = true; btn.textContent = "Filing…";
    var payload = {
      action: "officedoc",
      token: session && session.token,
      submissionId: uuid(),
      docType: t,
      location: needsLoc ? location : "",
      weekStart: weekStart, weekEnd: weekEnd, month: month,
      uploads: { office: odUploads }
    };
    fetch(ENDPOINT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        btn.disabled = false; btn.textContent = "Submit & File";
        if (d && d.status === "success") {
          odUploads = []; odRenderFiles();
          ok.innerHTML = "✅ <strong>Filed!</strong> Saved to <strong>" + escapeHtml(d.filedTo || "Drive") + "</strong>.<br>Reference: " + escapeHtml(d.ref || "");
          ok.style.display = "";
        } else if (d && /access code|session has expired/i.test(d.message || "")) {
          clearSession(); session = null;
          $("#officeCard").style.display = "none";
          showGate();
        } else {
          odFail((d && d.message) || "The server could not file the document. Please try again.");
        }
      })
      .catch(function () {
        btn.disabled = false; btn.textContent = "Submit & File";
        odFail("Couldn't reach the server. Check your connection and try again.");
      });
  }

  function startForm() {
    buildWeeklyTasks();
    buildRatingScales();
    buildChecklist("productOrder", "productOrder");
    buildChecklist("supplyOrder", "supplyOrder");
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
      addRow("expense"); addRow("rating");
    }

    // uploaders + paint states after restore
    $$("[data-upload]").forEach(initUploader);
    $$(".status-opts").forEach(function (g) { paintStatus(g); toggleExplain(g.dataset.status); });
    $$("[data-rate]").forEach(paintRate);
    $$("[data-yesno]").forEach(function (yn) { paintYesNo(yn.dataset.yesno); });
    form.elements.storeLocation.dispatchEvent(new Event("change"));
    if (form.elements.weekOfMonth.value) form.elements.weekOfMonth.dispatchEvent(new Event("change"));
    $("#noMarketing").dispatchEvent(new Event("change"));

    applyIdentity();
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

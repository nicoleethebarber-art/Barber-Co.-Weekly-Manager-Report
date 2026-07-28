/**
 * Barber & Co. Weekly Manager Report — backend (Google Apps Script Web App)
 * ---------------------------------------------------------------------------
 * Responsibilities on each submission:
 *   1. Anti-spam: honeypot + lightweight rate limiting (no manager login).
 *   2. Duplicate-safe: idempotent by submissionId (prevents double sends).
 *   3. Validate + sanitize all input server-side.
 *   4. Save supporting files to a PRIVATE Drive folder (never public).
 *   5. Store the submission in a Google Sheet (incl. email-delivery status).
 *   6. Build a PDF copy of the report.
 *   7. Email the full report to the office; confirm delivery in the response.
 *   8. Send the manager a confirmation copy (if they gave an email).
 *   9. On email failure: keep the data, report emailDelivered:false, allow retry.
 *
 * NO credentials live in this file. All configuration is read from
 * Script Properties (Project Settings ▸ Script Properties). Email is sent
 * through the authorizing Google account (Gmail/Workspace) via MailApp —
 * there is no API key or SMTP password to store. See README.md.
 */

// ---- Configuration keys (Script Properties) --------------------------------
var DEFAULTS = {
  OFFICE_EMAIL: 'info@barberandco.miami',
  DRIVE_FOLDER_ID: '',        // parent folder for uploads/PDFs (auto-created if blank)
  SHEET_ID: '',               // spreadsheet to log to (uses bound/active or auto-created if blank)
  RATE_LIMIT_PER_MIN: '15',   // max submissions per minute across the form
  SEND_CONFIRMATION: 'true',  // email the manager a confirmation copy
  MAX_EMAIL_ATTACH_MB: '20'   // if attachments exceed this, send Drive links instead
};

function cfg(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === undefined || v === '') ? DEFAULTS[key] : v;
}

// ===========================================================================
// ENTRY POINTS
// ===========================================================================
function doGet() {
  return json({ status: 'ok', service: 'Barber & Co. Weekly Manager Report' });
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    // 1) Honeypot — a filled hidden field means a bot. Pretend success.
    if (data.hp) return json({ status: 'success', ref: 'IGNORED', emailDelivered: true });

    // 2) Rate limit
    if (isRateLimited_()) return json({ status: 'error', message: 'Too many submissions right now. Please wait a moment and try again.' });

    var cache = CacheService.getScriptCache();
    var subId = sanitizeToken_(data.submissionId) || Utilities.getUuid();
    var cacheKey = 'sub_' + subId;

    // 3) Duplicate handling (idempotent)
    var prior = cache.get(cacheKey);
    if (prior) {
      prior = JSON.parse(prior);
      if (prior.delivered) {
        return json({ status: 'success', ref: prior.ref, emailDelivered: true, duplicate: true });
      }
      // Prior attempt saved data but email failed — retry email only.
      var retry = sendReport_(data, prior.ref, prior.folderUrl, null);
      updateEmailStatus_(prior.ref, retry.delivered);
      cache.put(cacheKey, JSON.stringify({ ref: prior.ref, delivered: retry.delivered, folderUrl: prior.folderUrl }), 21600);
      return json({ status: 'success', ref: prior.ref, emailDelivered: retry.delivered });
    }

    // 4) New submission
    var now = new Date();
    var ref = makeRef_(now, subId);

    // Save files to a private Drive subfolder
    var saved = saveFiles_(data, ref);

    // Persist to the sheet (email status pending)
    var rowInfo = saveToSheet_(data, now, ref, saved.folderUrl);

    // Send emails (returns delivery status; never throws)
    var result = sendReport_(data, ref, saved.folderUrl, saved.blobs);
    updateEmailStatus_(ref, result.delivered);

    cache.put(cacheKey, JSON.stringify({ ref: ref, delivered: result.delivered, folderUrl: saved.folderUrl }), 21600);

    return json({ status: 'success', ref: ref, emailDelivered: result.delivered });
  } catch (err) {
    logError_(err);
    return json({ status: 'error', message: 'The server could not process the report. Please try again.' });
  }
}

// ===========================================================================
// HELPERS: response, ids, sanitizing
// ===========================================================================
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function makeRef_(now, subId) {
  var d = Utilities.formatDate(now, tz_(), 'yyyyMMdd');
  var tail = String(subId).replace(/[^A-Za-z0-9]/g, '').slice(-5).toUpperCase() || Math.floor(Math.random() * 1e5);
  return 'BC-' + d + '-' + tail;
}
function tz_() { return Session.getScriptTimeZone() || 'America/New_York'; }
function sanitizeToken_(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9\-]/g, '').slice(0, 60); }

/** Strip control chars, cap length, and neutralize spreadsheet formula injection. */
function clean_(s, max) {
  s = String(s == null ? '' : s).replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}
function cell_(s) {
  s = clean_(s, 5000);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // prevent formula injection in Sheets
  return s;
}
function esc_(s) {
  return clean_(s, 8000).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; });
}
function money_(n) {
  n = parseFloat(String(n).replace(/[^0-9.\-]/g, '')); if (isNaN(n)) n = 0;
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function num_(n) { var v = parseFloat(String(n).replace(/[^0-9.\-]/g, '')); return isNaN(v) ? 0 : v; }

// ===========================================================================
// RATE LIMITING (CacheService rolling counter)
// ===========================================================================
function isRateLimited_() {
  try {
    var cache = CacheService.getScriptCache();
    var key = 'rl_' + Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHHmm');
    var n = parseInt(cache.get(key) || '0', 10) + 1;
    cache.put(key, String(n), 120);
    return n > parseInt(cfg('RATE_LIMIT_PER_MIN'), 10);
  } catch (e) { return false; }
}

// ===========================================================================
// DRIVE STORAGE (private)
// ===========================================================================
function parentFolder_() {
  var id = cfg('DRIVE_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* fall through */ } }
  // Auto-create once, then remember it.
  var it = DriveApp.getFoldersByName('Barber & Co Manager Reports');
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder('Barber & Co Manager Reports');
  PropertiesService.getScriptProperties().setProperty('DRIVE_FOLDER_ID', folder.getId());
  return folder;
}

/** Save all uploaded files (base64 data URLs) into a private per-report folder. */
function saveFiles_(data, ref) {
  var blobs = [];
  var uploads = data.uploads || {};
  var hasAny = Object.keys(uploads).some(function (b) { return (uploads[b] || []).length; });
  if (!hasAny) return { folderUrl: '', blobs: [] };

  var mgr = clean_(data.manager && data.manager.name, 60) || 'Manager';
  var sub = parentFolder_().createFolder(ref + ' - ' + mgr);
  // Explicitly keep private: no public/anyone sharing is set (owner-only by default).

  Object.keys(uploads).forEach(function (bucket) {
    (uploads[bucket] || []).forEach(function (f, i) {
      try {
        var parts = String(f.dataUrl).split(',');
        var bytes = Utilities.base64Decode(parts[1] || parts[0]);
        var type = (f.type) || 'application/octet-stream';
        var name = clean_(f.name, 120) || (bucket + '_' + (i + 1));
        var blob = Utilities.newBlob(bytes, type, bucket + '__' + name);
        sub.createFile(blob);
        blobs.push(blob);
      } catch (e) { logError_(e); }
    });
  });
  return { folderUrl: sub.getUrl(), blobs: blobs };
}

// ===========================================================================
// SHEET STORAGE
// ===========================================================================
function getSpreadsheet_() {
  var id = cfg('SHEET_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { /* fall through */ } }
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  var ss = SpreadsheetApp.create('Barber & Co Manager Reports');
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());
  return ss;
}

var SHEET_HEADERS = [
  'Reference #', 'Submitted At', 'Manager', 'Store Location', 'Week Start', 'Week End',
  'Week of Month', 'Sales to Date', 'Sales Goal', 'Marketing Total', 'Expense Total',
  'Attendance Issues', 'Incidents', 'Signature', 'Contact', 'Email Status', 'Files Folder', 'Full Data (JSON)'
];

function saveToSheet_(data, now, ref, folderUrl) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName('Responses') || ss.getSheets()[0];
  if (sheet.getName() !== 'Responses' && !ss.getSheetByName('Responses')) sheet.setName('Responses');
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(SHEET_HEADERS);
    sheet.getRange(1, 1, 1, SHEET_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  var m = data.manager || {};
  var mkt = (data.marketing && data.marketing.services) || [];
  var exp = (data.expenses && data.expenses.items) || [];
  var mktTotal = mkt.reduce(function (a, r) { return a + num_(r.total); }, 0);
  var expTotal = exp.reduce(function (a, r) { return a + num_(r.amount); }, 0);
  var attCount = ((data.attendance && data.attendance.late && data.attendance.late.entries) || []).length +
                 ((data.attendance && data.attendance.absent && data.attendance.absent.entries) || []).length;
  var incCount = ((data.monthly && data.monthly.fourth && data.monthly.fourth.incidents && data.monthly.fourth.incidents.reports) || []).length;

  sheet.appendRow([
    ref, Utilities.formatDate(now, tz_(), 'yyyy-MM-dd HH:mm:ss'),
    cell_(m.name), cell_(m.storeLocation), cell_(m.weekStart), cell_(m.weekEnd), cell_(m.weekOfMonth),
    cell_(m.salesToDate), cell_(m.salesGoal), money_(mktTotal), money_(expTotal),
    attCount, incCount, cell_(data.signature), cell_(m.contact),
    'PENDING', folderUrl || '', clean_(JSON.stringify(stripUploads_(data)), 45000)
  ]);
  return { row: sheet.getLastRow() };
}

/** Don't store raw file bytes in the sheet JSON — keep only file names/counts. */
function stripUploads_(data) {
  var copy = JSON.parse(JSON.stringify(data));
  if (copy.uploads) {
    var summary = {};
    Object.keys(copy.uploads).forEach(function (b) { summary[b] = (copy.uploads[b] || []).map(function (f) { return f.name; }); });
    copy.uploads = summary;
  }
  return copy;
}

function updateEmailStatus_(ref, delivered) {
  try {
    var sheet = getSpreadsheet_().getSheetByName('Responses');
    if (!sheet) return;
    var refs = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
    for (var i = refs.length - 1; i >= 0; i--) {
      if (refs[i][0] === ref) { sheet.getRange(i + 1, 16).setValue(delivered ? 'SENT' : 'FAILED — needs attention'); return; }
    }
  } catch (e) { logError_(e); }
}

// ===========================================================================
// EMAIL + PDF
// ===========================================================================
function subjectLine_(data) {
  var m = data.manager || {};
  var period = clean_(m.weekStart, 30) + (m.weekEnd ? ' to ' + clean_(m.weekEnd, 30) : '');
  return 'Weekly Manager Report – ' + (clean_(m.storeLocation, 60) || 'Location') +
         ' – ' + (clean_(m.name, 60) || 'Manager') + ' – ' + (period || 'Week');
}

/** Sends office + confirmation emails. Returns {delivered:boolean}. Never throws. */
function sendReport_(data, ref, folderUrl, blobs) {
  try {
    var m = data.manager || {};
    var now = new Date();
    var stamp = Utilities.formatDate(now, tz_(), "MMMM d, yyyy 'at' h:mm a");
    var subject = subjectLine_(data);
    var html = buildReportHtml_(data, ref, stamp, folderUrl);
    var pdf = Utilities.newBlob(html, 'text/html', 'report.html').getAs('application/pdf')
      .setName('Weekly Manager Report - ' + ref + '.pdf');

    // Gather attachments (payload files if provided, else none — links used instead).
    var attachments = [pdf];
    var attachBytes = pdf.getBytes().length;
    var limit = parseFloat(cfg('MAX_EMAIL_ATTACH_MB')) * 1024 * 1024;
    var fileBlobs = blobs || dataToBlobs_(data);
    var linkOnly = false;
    fileBlobs.forEach(function (b) { attachBytes += b.getBytes().length; });
    if (attachBytes <= limit) {
      attachments = attachments.concat(fileBlobs);
    } else {
      linkOnly = true; // too big to attach; rely on Drive folder link
    }

    var office = cfg('OFFICE_EMAIL');
    var body = buildPlainBody_(data, ref, stamp, folderUrl, linkOnly);

    MailApp.sendEmail({
      to: office,
      replyTo: (m.contact && /@/.test(m.contact)) ? m.contact : office,
      subject: subject,
      body: body,
      htmlBody: html + emailFooterHtml_(ref, folderUrl, linkOnly),
      attachments: attachments,
      name: 'Barber & Co. Manager Reports'
    });

    // Confirmation to the manager (if they supplied an email)
    if (cfg('SEND_CONFIRMATION') === 'true' && m.contact && /@/.test(m.contact)) {
      MailApp.sendEmail({
        to: m.contact.trim(),
        subject: 'Confirmation: ' + subject,
        body: 'Hi ' + (clean_(m.name, 60) || '') + ',\n\n' +
              'Thank you — we received your Weekly Manager Report for ' + (clean_(m.storeLocation, 60) || 'your store') +
              ' (' + clean_(m.weekStart, 30) + (m.weekEnd ? ' to ' + clean_(m.weekEnd, 30) : '') + ').\n' +
              'Reference number: ' + ref + '\nSubmitted ' + stamp + '.\n\nA PDF copy is attached for your records.\n\n— Barber & Co. Miami',
        htmlBody: '<p>Hi ' + esc_(m.name) + ',</p><p>Thank you — we received your Weekly Manager Report for <b>' +
                  esc_(m.storeLocation) + '</b> (' + esc_(m.weekStart) + (m.weekEnd ? ' to ' + esc_(m.weekEnd) : '') + ').</p>' +
                  '<p><b>Reference number:</b> ' + esc_(ref) + '<br><b>Submitted:</b> ' + esc_(stamp) + '</p>' +
                  '<p>A PDF copy is attached for your records.</p><p>— Barber &amp; Co. Miami</p>',
        attachments: [pdf],
        name: 'Barber & Co. Miami'
      });
    }
    return { delivered: true };
  } catch (err) {
    logError_(err);
    return { delivered: false };
  }
}

function dataToBlobs_(data) {
  var out = [];
  var uploads = (data && data.uploads) || {};
  Object.keys(uploads).forEach(function (bucket) {
    (uploads[bucket] || []).forEach(function (f, i) {
      try {
        var parts = String(f.dataUrl).split(',');
        var bytes = Utilities.base64Decode(parts[1] || parts[0]);
        out.push(Utilities.newBlob(bytes, f.type || 'application/octet-stream', clean_(f.name, 120) || (bucket + '_' + (i + 1))));
      } catch (e) { /* skip bad file */ }
    });
  });
  return out;
}

function emailFooterHtml_(ref, folderUrl, linkOnly) {
  var s = '<hr><p style="color:#777;font-size:12px">Reference ' + esc_(ref) + '.';
  if (folderUrl) s += ' Supporting files' + (linkOnly ? ' (attachments were too large to email)' : '') + ': <a href="' + esc_(folderUrl) + '">open Drive folder</a> (private).';
  s += '</p>';
  return s;
}

function buildPlainBody_(data, ref, stamp, folderUrl, linkOnly) {
  var m = data.manager || {};
  var L = [];
  L.push('A new Weekly Manager Report has been submitted.');
  L.push('');
  L.push('Reference:      ' + ref);
  L.push('Manager:        ' + clean_(m.name));
  L.push('Store Location: ' + clean_(m.storeLocation));
  L.push('Reporting Week: ' + clean_(m.weekStart) + (m.weekEnd ? ' to ' + clean_(m.weekEnd) : ''));
  L.push('Week of Month:  ' + clean_(m.weekOfMonth));
  L.push('Submitted:      ' + stamp);
  L.push('Signed by:      ' + clean_(data.signature));
  L.push('');
  var mkt = (data.marketing && data.marketing.services) || [];
  var exp = (data.expenses && data.expenses.items) || [];
  L.push('Marketing total: ' + money_(mkt.reduce(function (a, r) { return a + num_(r.total); }, 0)) + ' (' + mkt.length + ' services)');
  L.push('Expense total:   ' + money_(exp.reduce(function (a, r) { return a + num_(r.amount); }, 0)) + ' (' + exp.length + ' items)');
  L.push('');
  L.push('The complete, formatted report is attached as a PDF.');
  if (folderUrl) L.push('Supporting files' + (linkOnly ? ' (too large to attach)' : '') + ': ' + folderUrl);
  return L.join('\n');
}

// ---- PDF / HTML report -----------------------------------------------------
function buildReportHtml_(data, ref, stamp, folderUrl) {
  var m = data.manager || {};
  var s = [];
  s.push('<html><head><meta charset="utf-8"><style>' +
    'body{font-family:Helvetica,Arial,sans-serif;color:#1a1a1a;padding:26px;font-size:12px}' +
    'h1{font-family:Georgia,serif;letter-spacing:1px;margin:0;font-size:26px}' +
    '.miami{color:#b8912a;font-style:italic;font-size:20px;margin:-3px 0 2px}' +
    '.bar{background:#e0b73f;color:#111;text-align:center;font-weight:bold;text-transform:uppercase;letter-spacing:2px;padding:8px;margin:12px 0;font-size:12px}' +
    'h2{font-variant:small-caps;border-bottom:2px solid #d4af37;padding-bottom:3px;font-size:15px;margin:18px 0 8px}' +
    'table{width:100%;border-collapse:collapse;font-size:11px;margin:6px 0}' +
    'th,td{border:1px solid #ccc;padding:5px 7px;text-align:left;vertical-align:top}' +
    'th{background:#faf3df}' +
    '.kv{margin:2px 0}.kv b{display:inline-block;min-width:150px}' +
    '.muted{color:#888}.stamp{color:#777;font-size:10px;margin-top:20px}' +
    '</style></head><body>');
  s.push('<h1>BARBER &amp; CO</h1><div class="miami">Miami</div><div class="bar">Weekly Manager Report</div>');
  s.push('<div class="kv"><b>Reference #</b>' + esc_(ref) + '</div>');
  s.push('<div class="kv"><b>Submitted</b>' + esc_(stamp) + '</div>');

  s.push('<h2>Manager Information</h2>');
  s.push(kvHtml_('Manager Name', m.name) + kvHtml_('Store Location', m.storeLocation) +
    kvHtml_('Reporting Period', clean_(m.weekStart) + (m.weekEnd ? ' to ' + clean_(m.weekEnd) : '')) +
    kvHtml_('Week of Month', m.weekOfMonth) + kvHtml_('Sales to Date', m.salesToDate) +
    kvHtml_('Sales Goal', m.salesGoal) + kvHtml_('Report Completed', data.completedDate) +
    kvHtml_('Contact', m.contact));

  // Weekly tasks
  s.push('<h2>Weekly Manager Tasks</h2><table><tr><th>Task</th><th>Status</th><th>Notes / Explanation</th></tr>');
  (data.weeklyTasks || []).forEach(function (t) {
    var st = t.status === 'completed' ? 'Completed' : t.status === 'not_completed' ? 'NOT completed' : t.status === 'na' ? 'N/A' : '—';
    var note = clean_(t.notes); if (t.status === 'not_completed' && t.explanation) note = 'Why: ' + clean_(t.explanation) + (note ? ' | ' + note : '');
    s.push('<tr><td>' + esc_(t.label) + '</td><td>' + esc_(st) + '</td><td>' + esc_(note) + '</td></tr>');
  });
  s.push('</table>');

  // Monthly week tasks
  s.push(monthlyHtml_(data.monthly || {}));

  // Marketing
  s.push('<h2>Marketing Services</h2>');
  if (data.marketing && data.marketing.none) s.push('<p class="muted">No marketing services this week.</p>');
  else s.push(tableHtml_(data.marketing && data.marketing.services, ['date', 'barber', 'service', 'total', 'promo', 'notes'], ['Date', 'Barber', 'Service', 'Total', 'Promo', 'Notes']));

  // Expenses
  s.push('<h2>Expenses</h2>');
  s.push(tableHtml_(data.expenses && data.expenses.items, ['date', 'vendor', 'category', 'amount', 'method', 'methodOther', 'notes'], ['Date', 'Vendor', 'Category', 'Amount', 'Method', 'If Other', 'Notes']));
  s.push('<div class="kv"><b>Expenses confirmed</b>' + (data.expenses && data.expenses.confirmed ? 'Yes' : 'No') + '</div>');

  // Hostess hours
  if ((data.hostessHours || []).length) { s.push('<h2>Hostess Hours</h2>'); s.push(tableHtml_(data.hostessHours, ['name', 'hours'], ['Name', 'Hours'])); }

  // Attendance
  s.push('<h2>Attendance</h2>');
  var late = data.attendance && data.attendance.late;
  var absent = data.attendance && data.attendance.absent;
  if (late && late.any) s.push('<h3>Late / Early</h3>' + tableHtml_(late.entries, ['name', 'date', 'type', 'scheduled', 'actual', 'minutes', 'reason', 'notified', 'corrective'], ['Name', 'Date', 'Type', 'Scheduled', 'Actual', 'Min', 'Reason', 'Notified', 'Follow-up']));
  else s.push('<p class="muted">No late arrivals or early departures reported.</p>');
  if (absent && absent.any) s.push('<h3>Absences</h3>' + tableHtml_(absent.entries, ['name', 'date', 'shift', 'reason', 'notified', 'approved', 'coverage', 'coverPerson', 'corrective'], ['Name', 'Date', 'Shift', 'Reason', 'Notified', 'Approved', 'Coverage', 'By', 'Follow-up']));
  else s.push('<p class="muted">No absences reported.</p>');

  // Barber ratings
  s.push('<h2>Barber Ratings</h2>');
  s.push(tableHtml_(data.barberRatings, ['name', 'attitude', 'workEthic', 'customerService', 'cleanliness', 'attendance', 'teamwork', 'overall', 'followupNeeded'], ['Barber', 'Attitude', 'Work Ethic', 'Cust. Svc', 'Cleanliness', 'Attend.', 'Teamwork', 'Overall', 'Follow-up?']));
  (data.barberRatings || []).forEach(function (r) {
    if (r.comments || r.recognition || r.improvement) {
      s.push('<div class="kv"><b>' + esc_(r.name) + '</b>' + esc_([clean_(r.recognition) && ('Praise: ' + clean_(r.recognition)), clean_(r.improvement) && ('Improve: ' + clean_(r.improvement)), clean_(r.comments)].filter(String).join(' | ')) + '</div>');
    }
  });

  // Shop report
  var sh = data.shopReport || {};
  s.push('<h2>General Shop Report</h2>');
  s.push(kvHtml_('Overall Condition', sh.condition ? sh.condition + ' / 5' : '') +
    kvHtml_('Cleanliness', sh.cleanliness) + kvHtml_('Maintenance', sh.maintenance) + kvHtml_('Equipment', sh.equipment) +
    kvHtml_('Supply Shortages', sh.supply) + kvHtml_('Client Complaints', sh.complaints) + kvHtml_('Positive Feedback', sh.positive) +
    kvHtml_('Team Concerns', sh.team) + kvHtml_('Staffing Needs', sh.staffing) + kvHtml_('Schedule Concerns', sh.schedule) +
    kvHtml_('Ownership Should Know', sh.ownership) + kvHtml_('Assistance Needed', sh.assistance) +
    kvHtml_('Priorities Next Week', sh.priorities) + kvHtml_('Manager Comments', sh.comments));

  // Certification
  s.push('<h2>Certification</h2>');
  var cert = data.certification || {};
  s.push(kvHtml_('Reviewed', cert.reviewed ? 'Yes' : 'No') + kvHtml_('Accurate', cert.accurate ? 'Yes' : 'No') +
    kvHtml_('Docs Uploaded', cert.uploaded ? 'Yes' : 'No') + kvHtml_('May Be Contacted', cert.contact ? 'Yes' : 'No') +
    kvHtml_('Electronic Signature', data.signature));
  if (folderUrl) s.push('<div class="kv"><b>Supporting Files</b>' + esc_(folderUrl) + ' (private)</div>');

  s.push('<div class="stamp">Barber &amp; Co. Miami · Generated ' + esc_(stamp) + ' · Ref ' + esc_(ref) + '</div>');
  s.push('</body></html>');
  return s.join('');
}

function kvHtml_(k, v) { v = clean_(v); if (!v) return ''; return '<div class="kv"><b>' + esc_(k) + '</b>' + esc_(v) + '</div>'; }
function tableHtml_(rows, keys, heads) {
  rows = rows || [];
  if (!rows.length) return '<p class="muted">None reported.</p>';
  var s = '<table><tr>' + heads.map(function (h) { return '<th>' + esc_(h) + '</th>'; }).join('') + '</tr>';
  rows.forEach(function (r) {
    s += '<tr>' + keys.map(function (k) { return '<td>' + esc_(r[k]) + '</td>'; }).join('') + '</tr>';
  });
  return s + '</table>';
}
function monthlyHtml_(mon) {
  var wk = mon.weekOfMonth;
  if (!wk) return '';
  var s = '<h2>Week-of-Month Tasks (' + esc_(wk) + ' week)</h2>';
  if (wk === 'first' && mon.first) {
    var tm = mon.first.teamMeeting || {};
    s += '<h3>Team Meeting</h3>' + kvHtml_('Date', tm.date) + kvHtml_('Attended', tm.attendees) + kvHtml_('Summary', tm.summary) +
      kvHtml_('Feedback', tm.feedback) + kvHtml_('Decisions', tm.decisions) + kvHtml_('Responsible', tm.responsible) + kvHtml_('Due', tm.dueDate);
    var to = mon.first.timeOff || {};
    s += '<h3>Time-Off Review</h3>' + kvHtml_('Calendar Reviewed', to.reviewed ? 'Yes' : 'No') + kvHtml_('Barbers Asked', to.askedBarbers ? 'Yes' : 'No');
    s += tableHtml_(to.requests, ['employee', 'dates', 'status', 'notes'], ['Employee', 'Dates', 'Status', 'Notes']);
    var he = mon.first.hostessEval || {};
    if (he.needed) s += '<h3>Hostess Evaluation</h3>' + kvHtml_('Name', he.name) + kvHtml_('Date', he.date) +
      kvHtml_('Attendance', he.attendance) + kvHtml_('Customer Service', he.customerService) + kvHtml_('Communication', he.communication) +
      kvHtml_('Work Ethic', he.workEthic) + kvHtml_('Cleanliness', he.cleanliness) + kvHtml_('Strengths', he.strengths) +
      kvHtml_('Improvement', he.improvement) + kvHtml_('Action Plan', he.actionPlan) + kvHtml_('Follow-up', he.followUp) + kvHtml_('Comments', he.comments);
  }
  if (wk === 'second' && mon.second) {
    s += '<h3>Product Count & Orders</h3>' + tableHtml_(mon.second.inventory, ['brand', 'product', 'currentQty', 'minQty', 'orderQty', 'unitCost', 'totalCost', 'vendor', 'orderPlaced', 'orderDate', 'notes'], ['Brand', 'Product', 'Cur', 'Min', 'Order', 'Unit', 'Total', 'Vendor', 'Placed', 'Date', 'Notes']);
    var bp = mon.second.barberPlan || {};
    if (bp.needed) s += '<h3>Barber Sales / Scale Plan</h3>' + tableHtml_(bp.entries, ['name', 'currentSales', 'salesGoal', 'difference', 'improvementGoal', 'actionSteps', 'followUp'], ['Barber', 'Current', 'Goal', 'Diff', 'Improve Goal', 'Action', 'Follow-up']);
  }
  if (wk === 'third' && mon.third) {
    s += '<h3>Supply Order Form</h3>' + tableHtml_(mon.third.supplies, ['item', 'category', 'currentQty', 'needed', 'vendor', 'estCost', 'orderPlaced', 'orderDate', 'notes'], ['Item', 'Category', 'Cur', 'Needed', 'Vendor', 'Est. Cost', 'Placed', 'Date', 'Notes']);
  }
  if (wk === 'fourth' && mon.fourth) {
    var wa = mon.fourth.whatsapp || {};
    s += '<h3>Team Meeting Announcement (WhatsApp)</h3>' + kvHtml_('Sent', wa.sent) + kvHtml_('Date Sent', wa.dateSent) +
      kvHtml_('Proposed Date', wa.meetingDate) + kvHtml_('Proposed Time', wa.meetingTime) + kvHtml_('Notes', wa.notes);
    var inc = mon.fourth.incidents || {};
    if (inc.any) s += '<h3>Incident Reports</h3>' + tableHtml_(inc.reports, ['date', 'time', 'location', 'category', 'people', 'description', 'action', 'medical', 'clientContacted', 'witnesses', 'followUp', 'status'], ['Date', 'Time', 'Location', 'Category', 'People', 'Description', 'Action', 'Medical', 'Client', 'Witness', 'Follow-up', 'Status']);
    var oo = mon.fourth.oneOnOne || {};
    if (oo.needed) s += '<h3>One-on-One Meetings</h3>' + tableHtml_(oo.entries, ['name', 'date', 'reason', 'concerns', 'feedback', 'support', 'actionSteps', 'followUp'], ['Barber', 'Date', 'Reason', 'Concerns', 'Feedback', 'Support', 'Action', 'Follow-up']);
  }
  if (wk === 'fifth' && mon.fifth) s += kvHtml_('Notes', mon.fifth.notes);
  return s;
}

// ===========================================================================
// ERROR LOGGING (no credentials exposed)
// ===========================================================================
function logError_(err) {
  try {
    console.error(err && err.stack ? err.stack : err);
    var ss = getSpreadsheet_();
    var sh = ss.getSheetByName('Errors') || ss.insertSheet('Errors');
    if (sh.getLastRow() === 0) sh.appendRow(['Time', 'Error']);
    sh.appendRow([Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm:ss'), clean_(String(err && err.message ? err.message : err), 1000)]);
  } catch (e) { /* last resort: swallow */ }
}

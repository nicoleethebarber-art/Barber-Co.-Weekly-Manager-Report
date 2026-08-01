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
  ADMIN_EMAIL: '',            // security alerts (falls back to OFFICE_EMAIL)
  DRIVE_FOLDER_ID: '',        // PRIVATE staging parent (auto-created if blank)
  OFFICIAL_FOLDER_ID: '',     // official MER folder — files land here only after APPROVAL
  SHEET_ID: '',               // spreadsheet to log to (uses bound/active or auto-created if blank)
  RATE_LIMIT_PER_MIN: '15',   // global submissions per minute (bot guard)
  SEND_CONFIRMATION: 'true',  // email the manager a confirmation copy
  MAX_EMAIL_ATTACH_MB: '20',  // if attachments exceed this, send Drive links instead

  // ---- Access control & upload protection ----
  REQUIRE_ACCESS_CODE: 'true',   // managers must enter their 6-digit code
  MAX_REPORTS_PER_HOUR: '3',     // per manager
  MAX_FILES: '20',               // attachments per report
  MAX_FILE_MB: '10',             // per file
  MAX_TOTAL_MB: '50',            // all attachments combined
  MAX_CODE_ATTEMPTS: '5'         // wrong codes before temporary lockout
};

// Only these formats are accepted. Everything else is rejected outright.
var ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'heic'];
var ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'image/heif'];
var BLOCKED_EXT = ['exe', 'dmg', 'app', 'bat', 'cmd', 'com', 'js', 'jse', 'vbs', 'scr', 'msi', 'zip', 'rar', '7z', 'tar', 'gz',
  'docm', 'xlsm', 'pptm', 'dotm', 'xlam', 'jar', 'sh', 'ps1', 'apk', 'deb', 'pkg'];

// Submission lifecycle statuses.
var STATUS = {
  RECEIVED: 'SUBMISSION RECEIVED',
  SCREENING: 'SECURITY SCREENING',
  QUARANTINED: 'QUARANTINED',
  PENDING: 'PENDING REVIEW',
  CHANGES: 'CHANGES REQUESTED',
  REJECTED: 'REJECTED',
  APPROVED: 'APPROVED',
  UPLOAD_PENDING: 'DRIVE UPLOAD PENDING',
  COMPLETED: 'COMPLETED',
  FAILED: 'EXECUTION FAILED'
};

function cfg(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === undefined || v === '') ? DEFAULTS[key] : v;
}

// ===========================================================================
// AUTHORIZED MANAGER REGISTRY  (private tab: "Authorized Managers")
// ===========================================================================
var MGR_HEADERS = ['Manager Name', 'Access Code', 'Assigned Location', 'Role', 'Status', 'Email (optional)', 'Notes'];

/** Creates the registry on first run, seeded with the four managers. */
function ensureManagerSheet_() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName('Authorized Managers');
  if (sh) return sh;
  sh = ss.insertSheet('Authorized Managers');
  sh.appendRow(MGR_HEADERS);
  sh.getRange(1, 1, 1, MGR_HEADERS.length).setFontWeight('bold');
  sh.setFrozenRows(1);
  // Assigned Location: exact location name, or ALL. Role: Admin may approve reports.
  [['Nicole', '481902', 'ALL', 'Admin', 'Active', '', 'Administrator — all locations'],
   ['Dario', '730514', 'ALL', 'Admin', 'Active', '', 'Owner — all locations (manages Pinecrest)'],
   ['Krystal', '619473', 'ALL', 'Admin', 'Active', '', 'Area manager — all locations'],
   ['Juan', '265837', 'Miami / Edgewater', 'Manager', 'Active', '', 'Edgewater manager']].forEach(function (r) { sh.appendRow(r); });
  sh.getRange(2, 2, 4, 1).setNumberFormat('@'); // keep leading zeros
  return sh;
}

/** Look up a manager by access code. Returns null when unknown/inactive. */
function lookupByCode_(code) {
  code = String(code == null ? '' : code).replace(/[^0-9]/g, '');
  if (!code) return null;
  var sh = ensureManagerSheet_();
  if (sh.getLastRow() < 2) return null;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, MGR_HEADERS.length).getValues();
  for (var i = 0; i < rows.length; i++) {
    var rowCode = String(rows[i][1]).replace(/[^0-9]/g, '');
    if (rowCode && rowCode === code) {
      var status = String(rows[i][4] || '').trim().toLowerCase();
      if (status && status !== 'active') return { inactive: true, name: clean_(rows[i][0], 80) };
      var loc = clean_(rows[i][2], 80);
      return {
        name: clean_(rows[i][0], 80),
        location: (loc.toUpperCase() === 'ALL') ? '' : loc,   // '' = any location
        isAdmin: String(rows[i][3] || '').trim().toLowerCase() === 'admin',
        email: clean_(rows[i][5], 120),
        row: i + 2
      };
    }
  }
  return null;
}

/** Per-code lockout after repeated wrong codes. */
function codeAttemptBlocked_(fingerprint) {
  var cache = CacheService.getScriptCache();
  var n = parseInt(cache.get('att_' + fingerprint) || '0', 10);
  return n >= parseInt(cfg('MAX_CODE_ATTEMPTS'), 10);
}
function noteBadCode_(fingerprint) {
  var cache = CacheService.getScriptCache();
  var key = 'att_' + fingerprint;
  var n = parseInt(cache.get(key) || '0', 10) + 1;
  cache.put(key, String(n), 1800); // 30-minute lockout window
  return n;
}
function clearBadCodes_(fingerprint) { CacheService.getScriptCache().remove('att_' + fingerprint); }

// ---- Session token (so the code isn't re-sent with every request) ----------
function tokenSecret_() {
  var p = PropertiesService.getScriptProperties();
  var s = p.getProperty('TOKEN_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('TOKEN_SECRET', s); }
  return s;
}
function makeToken_(mgr) {
  var payload = [mgr.name, mgr.location || '', String(Date.now() + 12 * 3600 * 1000)].join('|');
  var sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, tokenSecret_()));
  return Utilities.base64EncodeWebSafe(payload) + '.' + sig;
}
function readToken_(token) {
  try {
    var parts = String(token).split('.');
    if (parts.length !== 2) return null;
    var payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
    var expect = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, tokenSecret_()));
    if (expect !== parts[1]) return null;
    var f = payload.split('|');
    if (parseInt(f[2], 10) < Date.now()) return null;
    return { name: f[0], location: f[1] };
  } catch (e) { return null; }
}

// ===========================================================================
// ENTRY POINTS
// ===========================================================================
function doGet(e) {
  var p = (e && e.parameter) || {};
  // One-click approve / reject straight from the notification email.
  if (p.a === 'approve' || p.a === 'reject') return handleDecision_(p);
  return json({ status: 'ok', service: 'Barber & Co. Weekly Manager Report' });
}

// ---- Signed approval links -------------------------------------------------
function decisionSig_(ref, action) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(action + '|' + ref, tokenSecret_())).slice(0, 32);
}
function decisionUrl_(ref, action) {
  var base;
  try { base = ScriptApp.getService().getUrl(); } catch (err) { return ''; }
  if (!base) return '';
  return base + '?a=' + action + '&ref=' + encodeURIComponent(ref) + '&s=' + encodeURIComponent(decisionSig_(ref, action));
}

/** Handles an approve/reject click. Signature-protected, so links can't be guessed. */
function handleDecision_(p) {
  var ref = clean_(p.ref, 40);
  var action = p.a === 'approve' ? 'approve' : 'reject';
  if (!ref || p.s !== decisionSig_(ref, action)) {
    return decisionPage_('Link not valid', 'This approval link is not valid or has been altered. Please approve from the spreadsheet instead.', false);
  }
  try {
    if (action === 'reject') {
      setReviewStatus_(ref, STATUS.REJECTED);
      audit_('REJECTED', { ref: ref, status: STATUS.REJECTED, detail: 'Rejected via email link' });
      return decisionPage_('Report rejected', ref + ' was marked REJECTED. Nothing was filed to the official Drive folder.', true);
    }
    setReviewStatus_(ref, STATUS.APPROVED);
    audit_('APPROVED', { ref: ref, status: STATUS.APPROVED, detail: 'Approved via email link' });
    var result = fileApproved_(ref);
    return decisionPage_('Report approved', ref + ' was approved. ' + result, true);
  } catch (err) {
    logError_(err);
    return decisionPage_('Something went wrong', 'The decision could not be completed. Please try from the spreadsheet.', false);
  }
}

function decisionPage_(title, message, good) {
  var color = good ? '#1f8a4c' : '#a3271a';
  return HtmlService.createHtmlOutput(
    '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:520px;margin:60px auto;text-align:center;padding:0 20px">' +
    '<div style="font-family:Georgia,serif;font-size:30px;font-weight:800;letter-spacing:1px">BARBER &amp; CO</div>' +
    '<div style="color:#b8912a;font-style:italic;font-size:20px;margin-bottom:24px">Miami</div>' +
    '<div style="font-size:46px">' + (good ? '&#9989;' : '&#9888;&#65039;') + '</div>' +
    '<h2 style="color:' + color + ';margin:10px 0 8px">' + esc_(title) + '</h2>' +
    '<p style="color:#555;font-size:15px;line-height:1.5">' + esc_(message) + '</p>' +
    '</div>').setTitle(title);
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    // 1) Honeypot — a filled hidden field means a bot. Pretend success.
    if (data.hp) return json({ status: 'success', ref: 'IGNORED', emailDelivered: true });

    // 2) Rate limit
    if (isRateLimited_()) return json({ status: 'error', message: 'Too many submissions right now. Please wait a moment and try again.' });

    // 2a) ACCESS CODE VERIFICATION (action=verify) — unlocks the form.
    if (data.action === 'verify') return handleVerify_(data);

    // 2b) Every submission must carry a valid session token or access code.
    var auth = authorize_(data);
    if (!auth.ok) {
      audit_('SUBMISSION BLOCKED', { verification: 'FAILED', detail: auth.message, status: STATUS.REJECTED });
      return json({ status: 'error', message: auth.message });
    }
    var mgr = auth.manager;

    // 2c) Identity & location are taken from the registry — never from the form.
    data.manager = data.manager || {};
    var requested = clean_(data.manager.storeLocation, 80);
    if (mgr.location && requested && requested.toLowerCase() !== mgr.location.toLowerCase()) {
      audit_('LOCATION VIOLATION', { manager: mgr.name, location: requested, verification: 'OK', status: STATUS.REJECTED,
        detail: 'Attempted to file for ' + requested + ' but is assigned to ' + mgr.location });
      alertAdmin_('Unauthorized location attempt', mgr.name + ' attempted to submit a report for "' + requested +
        '" but is assigned to "' + mgr.location + '".');
      return json({ status: 'error', message: 'You are not authorized to submit reports for that location.' });
    }
    data.manager.name = mgr.name;
    if (mgr.location) data.manager.storeLocation = mgr.location;
    data.verifiedManager = mgr.name;

    // 2d) Per-manager submission cap
    if (managerRateBlocked_(mgr.name)) {
      audit_('RATE LIMIT', { manager: mgr.name, verification: 'OK', status: STATUS.REJECTED, detail: 'Exceeded ' + cfg('MAX_REPORTS_PER_HOUR') + '/hour' });
      alertAdmin_('Submission rate limit hit', mgr.name + ' exceeded ' + cfg('MAX_REPORTS_PER_HOUR') + ' reports in one hour.');
      return json({ status: 'error', message: 'You have reached the submission limit for this hour. Please try again later.' });
    }

    // 2e) SECURITY SCREENING of attachments (type / size / count / duplicates)
    var screen = screenFiles_(data);
    if (!screen.ok) {
      audit_('SCREENING FAILED', { manager: mgr.name, location: data.manager.storeLocation, screening: 'BLOCKED',
        fileCount: screen.files.length, status: STATUS.QUARANTINED, detail: screen.problems.join(' | ') });
      alertAdmin_('Attachment screening blocked a submission',
        mgr.name + ' — the following was rejected:\n\n' + screen.problems.join('\n'));
      return json({ status: 'error', message: screen.problems.join(' ') });
    }

    // 2f) Duplicate-report detection (same manager + same week)
    var dupReport = duplicateReport_(mgr.name, clean_(data.manager.weekStart, 30), clean_(data.manager.weekEnd, 30));

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

    // Files go to a PRIVATE staging folder — never the official MER folder yet.
    var saved = saveFiles_(data, ref);

    // Persist to the sheet, awaiting review
    saveToSheet_(data, now, ref, saved.folderUrl);
    setReviewStatus_(ref, dupReport ? STATUS.PENDING + ' (possible duplicate)' : STATUS.PENDING);

    audit_('SUBMISSION RECEIVED', {
      ref: ref, manager: mgr.name, location: data.manager.storeLocation,
      fileCount: screen.files.length, fileNames: screen.files.map(function (f) { return f.name; }),
      totalBytes: screen.totalBytes, verification: 'OK',
      duplicate: dupReport ? 'POSSIBLE DUPLICATE' : 'none', screening: 'PASSED', status: STATUS.PENDING
    });
    if (dupReport) {
      alertAdmin_('Possible duplicate report', mgr.name + ' submitted a report for ' +
        clean_(data.manager.weekStart, 30) + ' to ' + clean_(data.manager.weekEnd, 30) +
        ', which appears to already exist. Reference ' + ref + '.');
    }

    // Notify reviewers (email only — nothing is filed officially yet)
    var result = sendReport_(data, ref, saved.folderUrl, saved.blobs);
    updateEmailStatus_(ref, result.delivered);

    // Separate, action-ready order email whenever anything needs ordering.
    sendOrderEmail_(data, ref);

    cache.put(cacheKey, JSON.stringify({ ref: ref, delivered: result.delivered, folderUrl: saved.folderUrl }), 21600);

    return json({ status: 'success', ref: ref, emailDelivered: result.delivered, review: STATUS.PENDING });
  } catch (err) {
    logError_(err);
    return json({ status: 'error', message: 'The server could not process the report. Please try again.' });
  }
}

// ===========================================================================
// ACCESS CONTROL
// ===========================================================================
/** action=verify — checks a 6-digit code and returns a short-lived session token. */
function handleVerify_(data) {
  var code = String(data.code == null ? '' : data.code).replace(/[^0-9]/g, '');
  var fp = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, code || 'empty')).slice(0, 24);

  if (codeAttemptBlocked_(fp)) {
    audit_('CODE LOCKOUT', { verification: 'LOCKED', detail: 'Too many incorrect codes' });
    return json({ status: 'error', message: 'Too many incorrect attempts. Please try again later.' });
  }
  if (code.length !== 6) {
    noteBadCode_(fp);
    return json({ status: 'error', message: 'Please enter your 6-digit access code.' });
  }

  var mgr = lookupByCode_(code);
  if (!mgr || mgr.inactive) {
    var n = noteBadCode_(fp);
    audit_('INVALID CODE', { verification: 'FAILED', detail: mgr && mgr.inactive ? 'Inactive manager: ' + mgr.name : 'Unknown code (attempt ' + n + ')' });
    if (n >= parseInt(cfg('MAX_CODE_ATTEMPTS'), 10)) {
      alertAdmin_('Repeated invalid access codes', 'The manager report form received ' + n +
        ' incorrect access-code attempts. The code has been temporarily locked out.');
    }
    return json({ status: 'error', message: 'That access code is not recognized.' });
  }

  clearBadCodes_(fp);
  audit_('CODE VERIFIED', { manager: mgr.name, location: mgr.location || 'ALL', verification: 'OK', status: 'IDENTITY VERIFICATION' });
  return json({
    status: 'success',
    token: makeToken_(mgr),
    manager: { name: mgr.name, location: mgr.location, isAdmin: !!mgr.isAdmin }
  });
}

/** Validates a submission's token (preferred) or raw access code. */
function authorize_(data) {
  if (cfg('REQUIRE_ACCESS_CODE') !== 'true') {
    return { ok: true, manager: { name: clean_(data.manager && data.manager.name, 80), location: '' } };
  }
  var t = data.token ? readToken_(data.token) : null;
  if (t) return { ok: true, manager: { name: t.name, location: t.location } };
  var mgr = data.code ? lookupByCode_(data.code) : null;
  if (mgr && !mgr.inactive) return { ok: true, manager: mgr };
  return { ok: false, message: 'Your session has expired. Please re-enter your access code and submit again.' };
}

// ===========================================================================
// HELPERS: response, ids, sanitizing
// ===========================================================================
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
/**
 * Builds a reference like BC-20260731-92F16 and guarantees it is unique in the
 * sheet. Client-supplied ids can repeat (shared devices, restored drafts), so
 * a collision gets a fresh random tail rather than reusing another report's
 * reference.
 */
function makeRef_(now, subId) {
  var d = Utilities.formatDate(now, tz_(), 'yyyyMMdd');
  var tail = String(subId).replace(/[^A-Za-z0-9]/g, '').slice(-5).toUpperCase();
  if (tail.length < 5) tail = randomTail_();
  var ref = 'BC-' + d + '-' + tail;
  for (var i = 0; i < 8 && refExists_(ref); i++) ref = 'BC-' + d + '-' + randomTail_();
  return ref;
}
function randomTail_() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '';
  for (var i = 0; i < 5; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
function refExists_(ref) {
  try {
    var sheet = getSpreadsheet_().getSheetByName('Responses');
    if (!sheet || sheet.getLastRow() < 2) return false;
    var vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === ref) return true;
    return false;
  } catch (e) { return false; }
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
// SECURITY SCREENING — type / size / count / duplicate checks
// Files are never opened or executed; only metadata and bytes-length are read.
// ===========================================================================
function extOf_(name) {
  var m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}
function approxBytes_(dataUrl) {
  var s = String(dataUrl || '');
  var i = s.indexOf(',');
  return Math.floor((s.length - (i + 1)) * 0.75);
}

/**
 * Screens every attachment. Returns
 * { ok, problems[], files:[{bucket,name,type,bytes,hash,dataUrl}], hashes[] }
 */
function screenFiles_(data) {
  var problems = [], files = [], seen = {};
  var uploads = (data && data.uploads) || {};
  var maxFiles = parseInt(cfg('MAX_FILES'), 10);
  var maxFileBytes = parseFloat(cfg('MAX_FILE_MB')) * 1024 * 1024;
  var maxTotalBytes = parseFloat(cfg('MAX_TOTAL_MB')) * 1024 * 1024;
  var total = 0;

  Object.keys(uploads).forEach(function (bucket) {
    (uploads[bucket] || []).forEach(function (f) {
      var name = clean_(f && f.name, 160) || 'file';
      var type = String((f && f.type) || '').toLowerCase();
      var ext = extOf_(name);

      if (BLOCKED_EXT.indexOf(ext) !== -1) { problems.push('Blocked file type rejected: ' + name); return; }
      if (ALLOWED_EXT.indexOf(ext) === -1) { problems.push('Unsupported file type rejected: ' + name + ' (allowed: PDF, JPG, JPEG, PNG, HEIC)'); return; }
      if (type && ALLOWED_MIME.indexOf(type) === -1) { problems.push('File content type not allowed: ' + name); return; }
      if (/\.(exe|bat|cmd|js|scr|msi)\./i.test(name)) { problems.push('Misleading filename rejected: ' + name); return; }

      var bytes = approxBytes_(f.dataUrl);
      if (bytes > maxFileBytes) { problems.push(name + ' exceeds the ' + cfg('MAX_FILE_MB') + ' MB per-file limit.'); return; }

      var hash;
      try {
        hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(f.dataUrl)));
      } catch (e) { hash = name + ':' + bytes; }
      if (seen[hash]) { problems.push('Duplicate file skipped: ' + name); return; }
      seen[hash] = true;

      total += bytes;
      files.push({ bucket: bucket, name: name, type: type || 'application/octet-stream', bytes: bytes, hash: hash, dataUrl: f.dataUrl });
    });
  });

  if (files.length > maxFiles) problems.push('Too many attachments (' + files.length + '). Limit is ' + maxFiles + '.');
  if (total > maxTotalBytes) problems.push('Attachments total too large. Limit is ' + cfg('MAX_TOTAL_MB') + ' MB.');

  return { ok: problems.length === 0, problems: problems, files: files, totalBytes: total, hashes: Object.keys(seen) };
}

/** Per-manager submission cap (default 3/hour). */
function managerRateBlocked_(managerName) {
  try {
    var cache = CacheService.getScriptCache();
    var key = 'mrl_' + Utilities.base64Encode(String(managerName)).slice(0, 40) + '_' +
      Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHH');
    var n = parseInt(cache.get(key) || '0', 10) + 1;
    cache.put(key, String(n), 3900);
    return n > parseInt(cfg('MAX_REPORTS_PER_HOUR'), 10);
  } catch (e) { return false; }
}

/** Same manager + same reporting week already filed? */
function duplicateReport_(managerName, weekStart, weekEnd) {
  try {
    var sheet = getSpreadsheet_().getSheetByName('Responses');
    if (!sheet || sheet.getLastRow() < 2) return false;
    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues();
    for (var i = rows.length - 1; i >= 0 && i > rows.length - 60; i--) {
      if (String(rows[i][2]) === String(managerName) &&
          String(rows[i][4]) === String(weekStart) &&
          String(rows[i][5]) === String(weekEnd)) return true;
    }
    return false;
  } catch (e) { return false; }
}

// ===========================================================================
// AUDIT LOG + ADMIN ALERTS
// ===========================================================================
var AUDIT_HEADERS = ['Time', 'Event', 'Submission ID', 'Manager', 'Location', 'Files', 'File Names', 'Total Bytes',
  'Verification', 'Duplicate', 'Screening', 'Status', 'Detail'];

function audit_(event, info) {
  try {
    var ss = getSpreadsheet_();
    var sh = ss.getSheetByName('Audit Log') || ss.insertSheet('Audit Log');
    if (sh.getLastRow() === 0) {
      sh.appendRow(AUDIT_HEADERS);
      sh.getRange(1, 1, 1, AUDIT_HEADERS.length).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    info = info || {};
    sh.appendRow([
      Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm:ss'), event,
      cell_(info.ref), cell_(info.manager), cell_(info.location),
      info.fileCount == null ? '' : info.fileCount, cell_((info.fileNames || []).join(', ')),
      info.totalBytes == null ? '' : info.totalBytes,
      cell_(info.verification), cell_(info.duplicate), cell_(info.screening),
      cell_(info.status), cell_(info.detail)
    ]);
  } catch (e) { /* never block a submission on logging */ }
}

function alertAdmin_(subject, body) {
  try {
    var to = cfg('ADMIN_EMAIL') || cfg('OFFICE_EMAIL');
    MailApp.sendEmail({ to: to, subject: '[Manager Report Security] ' + subject, body: body, name: 'Barber & Co. Report Security' });
  } catch (e) { /* alerting must never throw */ }
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
      htmlBody: decisionButtonsHtml_(ref) + html + emailFooterHtml_(ref, folderUrl, linkOnly),
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

/** Approve / Reject buttons shown at the top of the office notification email. */
function decisionButtonsHtml_(ref) {
  var ok = decisionUrl_(ref, 'approve'), no = decisionUrl_(ref, 'reject');
  if (!ok) return '';
  return '<div style="font-family:Helvetica,Arial,sans-serif;background:#faf6e8;border:1px solid #e0b73f;border-radius:10px;padding:16px;margin:0 0 18px;text-align:center">' +
    '<div style="font-size:13px;color:#555;margin-bottom:10px"><b>Status: PENDING REVIEW</b> — this report has <u>not</u> been filed to the official Drive folder yet.</div>' +
    '<a href="' + ok + '" style="display:inline-block;background:#1f8a4c;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px;margin:4px">✅ Approve &amp; File</a>' +
    '<a href="' + no + '" style="display:inline-block;background:#a3271a;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px;margin:4px">✕ Reject</a>' +
    '</div>';
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

/** Tag write-in rows {item,count,order,delivered} with a category for the checklist view. */
function taggedMisc_(rows, cat) {
  return (rows || []).map(function (r) {
    return { category: r.category || cat, item: r.item, count: r.count, order: r.order, delivered: r.delivered };
  });
}

/** Render order-checklist items grouped by category (Item / Count / Order / Delivered). */
function checklistHtml_(items) {
  items = items || [];
  if (!items.length) return '<p class="muted">Nothing ordered.</p>';
  var order = [], byCat = {};
  items.forEach(function (r) {
    var c = r.category || 'Other';
    if (!byCat[c]) { byCat[c] = []; order.push(c); }
    byCat[c].push(r);
  });
  var s = '';
  order.forEach(function (cat) {
    s += '<h3>' + esc_(cat) + '</h3><table><tr><th>Item</th><th>Count</th><th>Order</th><th>Delivered</th></tr>';
    byCat[cat].forEach(function (r) {
      var d = (r.delivered === true || r.delivered === 'Yes') ? 'Yes' : clean_(r.delivered);
      s += '<tr><td>' + esc_(r.item) + '</td><td>' + esc_(r.count) + '</td><td>' + esc_(r.order) + '</td><td>' + esc_(d) + '</td></tr>';
    });
    s += '</table>';
  });
  return s;
}
function tableHtml_(rows, keys, heads) {
  rows = rows || [];
  if (!rows.length) return '<p class="muted">None reported.</p>';
  var s = '<table><tr>' + heads.map(function (h) { return '<th>' + esc_(h) + '</th>'; }).join('') + '</tr>';
  rows.forEach(function (r) {
    s += '<tr>' + keys.map(function (k) { return '<td>' + esc_(r[k]) + '</td>'; }).join('') + '</tr>';
  });
  return s + '</table>';
}
/** True if an object/array holds anything a manager actually filled in. */
function hasData_(v) {
  if (v == null || v === '' || v === false) return false;
  if (Array.isArray(v)) return v.some(hasData_);
  if (typeof v === 'object') return Object.keys(v).some(function (k) { return k !== 'needed' && k !== 'any' && hasData_(v[k]); });
  return true;
}

function monthlyHtml_(mon) {
  var wk = mon.weekOfMonth;
  if (!wk) return '';
  var s = '<h2>Week-of-Month Tasks (' + esc_(wk) + ' week selected)</h2>';
  s += weekHtml_(mon, wk, false);
  // Also print any OTHER week the manager filled in — a late submission often
  // has a prior week's tasks completed under a later week selection.
  ['first', 'second', 'third', 'fourth', 'fifth'].forEach(function (w) {
    if (w !== wk && hasData_(mon[w])) s += weekHtml_(mon, w, true);
  });
  return s;
}

function weekHtml_(mon, wk, alsoNote) {
  var s = alsoNote ? '<h3 style="color:#b8912a">Also completed — ' + esc_(wk) + ' week tasks</h3>' : '';
  if (wk === 'first' && mon.first) {
    var tm = mon.first.teamMeeting || {};
    s += '<h3>Team Meeting</h3>' + kvHtml_('Date', tm.date) + kvHtml_('Attended', tm.attendees) + kvHtml_('Summary', tm.summary) +
      kvHtml_('Feedback', tm.feedback) + kvHtml_('Decisions', tm.decisions) + kvHtml_('Responsible', tm.responsible) + kvHtml_('Due', tm.dueDate);
    var to = mon.first.timeOff || {};
    s += '<h3>Time-Off Review</h3>' + kvHtml_('Calendar Reviewed', to.reviewed ? 'Yes' : 'No') + kvHtml_('Barbers Asked', to.askedBarbers ? 'Yes' : 'No');
    s += tableHtml_(to.requests, ['employee', 'position', 'leaveType', 'startDate', 'endDate', 'totalDays', 'daysLeft', 'reason', 'status', 'approvalDate', 'comments'], ['Employee', 'Position', 'Type', 'Start', 'End', 'Days', 'Left', 'Reason', 'Status', 'Approved', 'Comments']);
    var he = mon.first.hostessEval || {};
    if (he.needed) s += '<h3>Hostess Evaluation</h3>' + kvHtml_('Name', he.name) + kvHtml_('Date', he.date) +
      kvHtml_('Attendance', he.attendance) + kvHtml_('Customer Service', he.customerService) + kvHtml_('Communication', he.communication) +
      kvHtml_('Work Ethic', he.workEthic) + kvHtml_('Cleanliness', he.cleanliness) + kvHtml_('Strengths', he.strengths) +
      kvHtml_('Improvement', he.improvement) + kvHtml_('Action Plan', he.actionPlan) + kvHtml_('Follow-up', he.followUp) + kvHtml_('Comments', he.comments);
  }
  if (wk === 'second' && mon.second) {
    s += '<h3>Product Order Form — Level 3 & Layrite</h3>' +
      checklistHtml_((mon.second.productOrder || []).concat(taggedMisc_(mon.second.productMisc, 'Other')));
    var bp = mon.second.barberPlan || {};
    if (bp.needed) s += '<h3>Barber Sales / Scale Plan</h3>' + tableHtml_(bp.entries, ['name', 'currentSales', 'salesGoal', 'difference', 'improvementGoal', 'actionSteps', 'followUp'], ['Barber', 'Current', 'Goal', 'Diff', 'Improve Goal', 'Action', 'Follow-up']);
  }
  if (wk === 'third' && mon.third) {
    s += '<h3>Supply Order Form</h3>' +
      checklistHtml_((mon.third.supplyOrder || []).concat(taggedMisc_(mon.third.supplyMisc, 'Miscellaneous')));
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
// ORDER LIST — a separate, action-ready email of what needs ordering
// ===========================================================================
/** Collects every checklist item with an Order quantity, from any week. */
function orderItems_(data) {
  var mon = (data && data.monthly) || {};
  var out = [];
  var push = function (rows, fallbackCat) {
    (rows || []).forEach(function (r) {
      var qty = num_(r.order);
      if (qty > 0) out.push({
        category: clean_(r.category, 60) || fallbackCat,
        item: clean_(r.item, 120),
        count: clean_(r.count, 20),
        order: qty,
        delivered: (r.delivered === true || r.delivered === 'Yes') ? 'Yes' : clean_(r.delivered, 20)
      });
    });
  };
  if (mon.second) { push(mon.second.productOrder, 'Product'); push(mon.second.productMisc, 'Other products'); }
  if (mon.third) { push(mon.third.supplyOrder, 'Supplies'); push(mon.third.supplyMisc, 'Miscellaneous'); }
  return out;
}

function orderListHtml_(items, data, ref) {
  var m = (data && data.manager) || {};
  var byCat = {}, order = [];
  items.forEach(function (r) {
    if (!byCat[r.category]) { byCat[r.category] = []; order.push(r.category); }
    byCat[r.category].push(r);
  });
  var s = '<div style="font-family:Helvetica,Arial,sans-serif;color:#1a1a1a">' +
    '<h2 style="font-family:Georgia,serif;margin:0 0 2px">Order List</h2>' +
    '<div style="color:#b8912a;font-style:italic;margin-bottom:10px">Barber &amp; Co. Miami</div>' +
    '<p style="font-size:13px;margin:0 0 12px">' +
      '<b>Location:</b> ' + esc_(m.storeLocation) + '<br>' +
      '<b>Requested by:</b> ' + esc_(m.name) + '<br>' +
      '<b>Week:</b> ' + esc_(m.weekStart) + (m.weekEnd ? ' to ' + esc_(m.weekEnd) : '') + '<br>' +
      '<b>Reference:</b> ' + esc_(ref) + '</p>';
  order.forEach(function (cat) {
    s += '<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#b8912a;margin:14px 0 4px">' + esc_(cat) + '</h3>' +
      '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
      '<tr><th style="border:1px solid #ccc;padding:5px 7px;background:#faf3df;text-align:left">Item</th>' +
      '<th style="border:1px solid #ccc;padding:5px 7px;background:#faf3df;text-align:left">On Hand</th>' +
      '<th style="border:1px solid #ccc;padding:5px 7px;background:#faf3df;text-align:left">ORDER</th>' +
      '<th style="border:1px solid #ccc;padding:5px 7px;background:#faf3df;text-align:left">Delivered</th></tr>';
    byCat[cat].forEach(function (r) {
      s += '<tr><td style="border:1px solid #ccc;padding:5px 7px">' + esc_(r.item) + '</td>' +
        '<td style="border:1px solid #ccc;padding:5px 7px">' + esc_(r.count) + '</td>' +
        '<td style="border:1px solid #ccc;padding:5px 7px;font-weight:bold">' + esc_(String(r.order)) + '</td>' +
        '<td style="border:1px solid #ccc;padding:5px 7px">' + esc_(r.delivered) + '</td></tr>';
    });
    s += '</table>';
  });
  s += '<p style="color:#777;font-size:11px;margin-top:16px">' + items.length + ' item(s) to order · Reference ' + esc_(ref) + '</p></div>';
  return s;
}

function orderListText_(items, data, ref) {
  var m = (data && data.manager) || {};
  var L = ['ORDER LIST — Barber & Co. Miami', '',
    'Location:     ' + clean_(m.storeLocation),
    'Requested by: ' + clean_(m.name),
    'Week:         ' + clean_(m.weekStart) + (m.weekEnd ? ' to ' + clean_(m.weekEnd) : ''),
    'Reference:    ' + ref, ''];
  var cat = '';
  items.forEach(function (r) {
    if (r.category !== cat) { cat = r.category; L.push('--- ' + cat + ' ---'); }
    L.push('  ' + r.item + '  |  on hand: ' + (r.count || '-') + '  |  ORDER: ' + r.order + (r.delivered ? '  |  delivered: ' + r.delivered : ''));
  });
  L.push('', items.length + ' item(s) to order.');
  return L.join('\n');
}

/** Sends the order list as its own email. Returns true when sent. */
function sendOrderEmail_(data, ref, to) {
  var items = orderItems_(data);
  if (!items.length) return false;
  var m = (data && data.manager) || {};
  var subject = 'Order List – ' + (clean_(m.storeLocation, 60) || 'Location') +
    ' – ' + (clean_(m.weekStart, 30) || '') + (m.weekEnd ? ' to ' + clean_(m.weekEnd, 30) : '');
  try {
    MailApp.sendEmail({
      to: to || cfg('OFFICE_EMAIL'),
      subject: subject,
      body: orderListText_(items, data, ref),
      htmlBody: orderListHtml_(items, data, ref),
      name: 'Barber & Co. Orders'
    });
    audit_('ORDER LIST EMAILED', { ref: ref, manager: m.name, location: m.storeLocation, fileCount: items.length, status: 'SENT' });
    return true;
  } catch (err) {
    logError_(err);
    return false;
  }
}

/** Menu: email the order list for the selected report (works for past reports). */
function menuEmailOrderList() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== 'Responses') { ui.alert('Select a report row on the "Responses" tab first.'); return; }
  var row = sheet.getActiveRange().getRow();
  if (row < 2) { ui.alert('Select a report row (not the header).'); return; }

  var ref = String(sheet.getRange(row, 1).getValue() || '');
  var jsonCell = String(sheet.getRange(row, 18).getValue() || '');
  if (!jsonCell) { ui.alert('No stored data found for that row.'); return; }

  var data;
  try { data = JSON.parse(jsonCell); }
  catch (e) { ui.alert('Could not read the stored data for ' + ref + '.'); return; }

  var items = orderItems_(data);
  if (!items.length) { ui.alert('That report has no items with an order quantity.'); return; }
  ui.alert(sendOrderEmail_(data, ref, cfg('OFFICE_EMAIL'))
    ? 'Order list for ' + ref + ' (' + items.length + ' item(s)) emailed to ' + cfg('OFFICE_EMAIL') + '.'
    : 'Could not send the order list — see the Errors tab.');
}

// ===========================================================================
// REVIEW → APPROVAL → OFFICIAL DRIVE
// Nothing reaches the official MER folder until an admin marks it APPROVED.
// ===========================================================================
function reviewColumn_(sheet) {
  var head = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  for (var i = 0; i < head.length; i++) if (String(head[i]).trim() === 'Review Status') return i + 1;
  var col = sheet.getLastColumn() + 1;
  sheet.getRange(1, col).setValue('Review Status').setFontWeight('bold');
  return col;
}

function setReviewStatus_(ref, status) {
  try {
    var sheet = getSpreadsheet_().getSheetByName('Responses');
    if (!sheet) return;
    var col = reviewColumn_(sheet);
    var refs = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
    for (var i = refs.length - 1; i >= 0; i--) {
      if (refs[i][0] === ref) { sheet.getRange(i + 1, col).setValue(status); return; }
    }
  } catch (e) { logError_(e); }
}

function officialFolder_() {
  var id = cfg('OFFICIAL_FOLDER_ID');
  if (!id) return null;
  try { return DriveApp.getFolderById(id); } catch (e) { logError_(e); return null; }
}

/**
 * Files an approved report into the official MER folder, organised by
 * OFFICIAL FOLDER ▸ <year> ▸ <month> ▸ <ref - manager>.
 * Returns a human-readable result string.
 */
function fileApproved_(ref) {
  var sheet = getSpreadsheet_().getSheetByName('Responses');
  if (!sheet) return 'No Responses sheet.';
  var lastCol = sheet.getLastColumn();
  var refs = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
  var rowIdx = -1;
  for (var i = refs.length - 1; i >= 1; i--) if (refs[i][0] === ref) { rowIdx = i + 1; break; }
  if (rowIdx < 0) return 'Reference ' + ref + ' not found.';

  var row = sheet.getRange(rowIdx, 1, 1, lastCol).getValues()[0];
  var manager = String(row[2] || 'Manager');
  var weekStart = String(row[4] || '');
  var stagingUrl = String(row[16] || '');

  var dest = officialFolder_();
  if (!dest) { setReviewStatus_(ref, STATUS.FAILED); return 'OFFICIAL_FOLDER_ID is not set — cannot file.'; }

  try {
    setReviewStatus_(ref, STATUS.UPLOAD_PENDING);
    var d = weekStart ? new Date(weekStart) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    var year = Utilities.formatDate(d, tz_(), 'yyyy');
    var month = Utilities.formatDate(d, tz_(), 'MM - MMMM');
    var target = childFolder_(childFolder_(dest, year), month);
    var reportFolder = target.createFolder(ref + ' - ' + manager);

    var moved = 0;
    if (stagingUrl) {
      var m = stagingUrl.match(/folders\/([A-Za-z0-9_\-]+)/);
      if (m) {
        var staging = DriveApp.getFolderById(m[1]);
        var files = staging.getFiles();
        while (files.hasNext()) { files.next().makeCopy(reportFolder); moved++; }
      }
    }
    setReviewStatus_(ref, STATUS.COMPLETED);
    audit_('FILED TO OFFICIAL DRIVE', { ref: ref, manager: manager, fileCount: moved, status: STATUS.COMPLETED, detail: reportFolder.getUrl() });
    return 'Filed ' + ref + ' (' + moved + ' file(s)) → ' + year + '/' + month;
  } catch (err) {
    logError_(err);
    setReviewStatus_(ref, STATUS.FAILED);
    audit_('DRIVE FILING FAILED', { ref: ref, manager: manager, status: STATUS.FAILED, detail: String(err && err.message ? err.message : err) });
    alertAdmin_('Drive filing failed', 'Reference ' + ref + ' could not be filed into the official folder. It remains in staging. Error: ' + err);
    return 'Filing failed for ' + ref + ' — see Audit Log.';
  }
}

function childFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** Spreadsheet menu: review helpers for admins. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Manager Reports')
    .addItem('Approve selected report', 'menuApproveSelected')
    .addItem('Reject selected report', 'menuRejectSelected')
    .addItem('Request changes on selected report', 'menuRequestChanges')
    .addSeparator()
    .addItem('Email order list for selected report', 'menuEmailOrderList')
    .addItem('File all APPROVED reports to Drive', 'menuFileAllApproved')
    .addSeparator()
    .addItem('Remove junk rows (code checks)', 'menuCleanupJunkRows')
    .addItem('Set up manager registry', 'setupManagerRegistry')
    .addToUi();
}

/** Menu-safe wrapper (Apps Script menus cannot call private functions). */
function setupManagerRegistry() {
  ensureManagerSheet_();
  SpreadsheetApp.getUi().alert('Manager registry is ready. Open the "Authorized Managers" tab to view or change access codes.');
}

function selectedRef_() {
  var sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== 'Responses') return null;
  var r = sheet.getActiveRange().getRow();
  if (r < 2) return null;
  return String(sheet.getRange(r, 1).getValue() || '');
}

function menuApproveSelected() {
  var ui = SpreadsheetApp.getUi();
  var ref = selectedRef_();
  if (!ref) { ui.alert('Select a report row on the "Responses" tab first.'); return; }
  var who = Session.getActiveUser().getEmail() || 'admin';
  setReviewStatus_(ref, STATUS.APPROVED);
  audit_('APPROVED', { ref: ref, status: STATUS.APPROVED, detail: 'Approved by ' + who });
  ui.alert(fileApproved_(ref));
}
function menuRejectSelected() {
  var ui = SpreadsheetApp.getUi();
  var ref = selectedRef_();
  if (!ref) { ui.alert('Select a report row on the "Responses" tab first.'); return; }
  setReviewStatus_(ref, STATUS.REJECTED);
  audit_('REJECTED', { ref: ref, status: STATUS.REJECTED, detail: 'Rejected by ' + (Session.getActiveUser().getEmail() || 'admin') });
  ui.alert(ref + ' marked REJECTED. Nothing was filed to the official Drive.');
}
function menuRequestChanges() {
  var ui = SpreadsheetApp.getUi();
  var ref = selectedRef_();
  if (!ref) { ui.alert('Select a report row on the "Responses" tab first.'); return; }
  setReviewStatus_(ref, STATUS.CHANGES);
  audit_('CHANGES REQUESTED', { ref: ref, status: STATUS.CHANGES });
  ui.alert(ref + ' marked CHANGES REQUESTED.');
}
/**
 * Removes rows that were never real reports — access-code checks that the
 * previous backend logged by mistake. Only deletes rows with no manager name
 * AND stored data that is a verify request, so real reports are never touched.
 */
function menuCleanupJunkRows() {
  var ui = SpreadsheetApp.getUi();
  var sheet = getSpreadsheet_().getSheetByName('Responses');
  if (!sheet || sheet.getLastRow() < 2) { ui.alert('Nothing to clean up.'); return; }

  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 18).getValues();
  var doomed = [];
  for (var i = 0; i < rows.length; i++) {
    var manager = String(rows[i][2] || '').trim();
    var json = String(rows[i][17] || '');
    if (!manager && /"action"\s*:\s*"verify"/.test(json)) doomed.push(i + 2);
  }
  if (!doomed.length) { ui.alert('No junk rows found. Nothing was changed.'); return; }

  var resp = ui.alert('Remove ' + doomed.length + ' junk row(s)?',
    'These rows contain access-code checks, not reports (rows: ' + doomed.join(', ') + ').\n\nReal reports will not be touched.',
    ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;

  for (var j = doomed.length - 1; j >= 0; j--) sheet.deleteRow(doomed[j]);
  audit_('JUNK ROWS REMOVED', { fileCount: doomed.length, status: 'CLEANUP', detail: 'Rows: ' + doomed.join(', ') });
  ui.alert('Removed ' + doomed.length + ' junk row(s).');
}

function menuFileAllApproved() {
  var sheet = getSpreadsheet_().getSheetByName('Responses');
  if (!sheet || sheet.getLastRow() < 2) return;
  var col = reviewColumn_(sheet);
  var vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, col).getValues();
  var out = [];
  vals.forEach(function (r) {
    if (String(r[col - 1]).trim().toUpperCase() === STATUS.APPROVED) out.push(fileApproved_(String(r[0])));
  });
  SpreadsheetApp.getUi().alert(out.length ? out.join('\n') : 'No reports are marked APPROVED.');
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

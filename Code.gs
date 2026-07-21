/**
 * Barber & Co. Weekly Manager Report — backend (Google Apps Script)
 *
 * What this does on every submission:
 *   1. Records the date & time (server timestamp).
 *   2. Saves the response as a new row in a Google Sheet.
 *   3. Builds a PDF copy of the report.
 *   4. Emails the report (with PDF attached) to the office inbox.
 *   5. Emails a confirmation copy to the manager.
 *
 * Setup instructions are in README.md.
 */

// ====== CONFIG ======
var OFFICE_EMAIL = 'INFO@BARBERANDCO.MIAMI'; // where reports are sent
var SHEET_NAME   = 'Responses';               // tab name inside the bound spreadsheet
var BUSINESS     = 'Barber & Co. Miami';
// ====================

/**
 * Web App entry point. The form POSTs JSON as text/plain to avoid CORS preflight.
 */
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var now = new Date();

    saveToSheet(data, now);
    var pdf = buildPdf(data, now);
    sendEmails(data, now, pdf);

    return json({ status: 'success' });
  } catch (err) {
    console.error(err);
    return json({ status: 'error', message: String(err) });
  }
}

/** Simple health check when the URL is opened in a browser. */
function doGet() {
  return json({ status: 'ok', service: 'Barber & Co. Weekly Manager Report' });
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Append one row per report. Nested tables are flattened to readable text. */
function saveToSheet(data, now) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  // Use the "Responses" tab if it exists, otherwise reuse the first sheet.
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];

  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'Submitted At', 'Manager Name', 'Manager Email', 'Store Location', 'Week',
      'Sales to Date', 'Goal', 'Marketing Services', 'Hostess Hours'
    ]);
    sheet.getRange(1, 1, 1, 9).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  var mkt = (data.marketingServices || []).map(function (r) {
    return [r.date, r.barber, r.service, r.total, r.promo].filter(String).join(' | ');
  }).join('\n');

  var host = (data.hostessHours || []).map(function (r) {
    return [r.name, r.hours].filter(String).join(' — ');
  }).join('\n');

  sheet.appendRow([
    now, data.managerName, data.managerEmail, data.storeLocation, data.week,
    data.salesToDate, data.goal, mkt, host
  ]);
}

/** Render an HTML report and convert it to a PDF blob. */
function buildPdf(data, now) {
  var tz = Session.getScriptTimeZone();
  var stamp = Utilities.formatDate(now, tz, "MMMM d, yyyy 'at' h:mm a");
  var esc = function (s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };

  var mktRows = (data.marketingServices || []).map(function (r) {
    return '<tr><td>' + esc(r.date) + '</td><td>' + esc(r.barber) + '</td><td>' +
           esc(r.service) + '</td><td>' + esc(r.total) + '</td><td>' + esc(r.promo) + '</td></tr>';
  }).join('') || '<tr><td colspan="5" style="color:#999">None reported</td></tr>';

  var hostRows = (data.hostessHours || []).map(function (r) {
    return '<tr><td>' + esc(r.name) + '</td><td>' + esc(r.hours) + '</td></tr>';
  }).join('') || '<tr><td colspan="2" style="color:#999">None reported</td></tr>';

  var html =
    '<html><head><meta charset="utf-8"><style>' +
    'body{font-family:Helvetica,Arial,sans-serif;color:#1a1a1a;padding:24px;}' +
    'h1{font-family:Georgia,serif;letter-spacing:1px;margin:0;font-size:26px;}' +
    '.miami{color:#c69a2b;font-style:italic;font-size:22px;margin:-4px 0 2px;}' +
    '.bar{background:#e0b73f;color:#fff;text-align:center;font-weight:bold;text-transform:uppercase;' +
    'letter-spacing:2px;padding:8px;margin:14px 0;font-size:13px;}' +
    'h2{font-variant:small-caps;border-bottom:3px solid #d64a2b;padding-bottom:3px;font-size:16px;margin:20px 0 8px;}' +
    'table{width:100%;border-collapse:collapse;font-size:12px;}' +
    'th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;}' +
    'th{background:#faf3df;}' +
    '.info td{border:none;padding:3px 0;}' +
    '.info td.k{font-weight:bold;width:150px;}' +
    '.stamp{color:#777;font-size:11px;margin-top:24px;}' +
    '</style></head><body>' +
    '<h1>BARBER &amp; CO</h1><div class="miami">Miami</div>' +
    '<div class="bar">Weekly Manager Report</div>' +
    '<h2>Manager Information</h2>' +
    '<table class="info">' +
    '<tr><td class="k">Manager Name</td><td>' + esc(data.managerName) + '</td></tr>' +
    '<tr><td class="k">Store Location</td><td>' + esc(data.storeLocation) + '</td></tr>' +
    '<tr><td class="k">Week</td><td>' + esc(data.week) + '</td></tr>' +
    '<tr><td class="k">Sales to Date</td><td>' + esc(data.salesToDate) + '</td></tr>' +
    '<tr><td class="k">Goal</td><td>' + esc(data.goal) + '</td></tr>' +
    '</table>' +
    '<h2>Marketing Services</h2>' +
    '<table><tr><th>Date</th><th>Barber</th><th>Service</th><th>Total</th><th>Promo Type</th></tr>' +
    mktRows + '</table>' +
    '<h2>Hostess Hours</h2>' +
    '<table><tr><th>Name</th><th>Hours</th></tr>' + hostRows + '</table>' +
    '<div class="stamp">Submitted ' + esc(stamp) + ' · ' + esc(BUSINESS) + '</div>' +
    '</body></html>';

  var fileName = 'Manager Report - ' + safe(data.managerName) + ' - ' +
                 safe(data.storeLocation) + ' - ' + safe(data.week) + '.pdf';

  return Utilities.newBlob(html, 'text/html', 'report.html')
    .getAs('application/pdf')
    .setName(fileName);
}

function safe(s) {
  return String(s == null ? '' : s).replace(/[\\/:*?"<>|]/g, '').trim() || 'Unknown';
}

/** Send the office email + the manager's confirmation copy. */
function sendEmails(data, now, pdf) {
  var subject = 'Manager Report – ' + (data.managerName || 'Unknown') +
                ' – ' + (data.storeLocation || 'Unknown') +
                ' – ' + (data.week || 'Unknown');

  var tz = Session.getScriptTimeZone();
  var stamp = Utilities.formatDate(now, tz, "MMMM d, yyyy 'at' h:mm a");

  var bodyLines = [
    'A new Weekly Manager Report has been submitted.',
    '',
    'Manager:        ' + (data.managerName || ''),
    'Store Location: ' + (data.storeLocation || ''),
    'Week:           ' + (data.week || ''),
    'Sales to Date:  ' + (data.salesToDate || ''),
    'Goal:           ' + (data.goal || ''),
    'Submitted:      ' + stamp,
    '',
    'The full report is attached as a PDF.'
  ];
  var body = bodyLines.join('\n');

  // 1) Office inbox
  MailApp.sendEmail({
    to: OFFICE_EMAIL,
    replyTo: data.managerEmail || OFFICE_EMAIL,
    subject: subject,
    body: body,
    attachments: [pdf]
  });

  // 2) Manager confirmation copy
  if (data.managerEmail) {
    MailApp.sendEmail({
      to: data.managerEmail,
      subject: 'Confirmation: ' + subject,
      body: 'Hi ' + (data.managerName || '') + ',\n\n' +
            'Thank you — we received your Weekly Manager Report for ' +
            (data.storeLocation || 'your store') + ' (' + (data.week || 'this week') + ').\n' +
            'Submitted ' + stamp + '. A PDF copy is attached for your records.\n\n' +
            '— ' + BUSINESS,
      attachments: [pdf]
    });
  }
}

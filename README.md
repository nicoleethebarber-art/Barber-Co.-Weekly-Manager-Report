# Barber & Co. Weekly Manager Report

A professional, mobile-friendly, **step-by-step** digital form that replaces the
paper weekly manager report. Managers open a public link, complete it on a phone,
tablet, or computer, and submit — **no account, no login**.

On every submission the system automatically:

- ⏱️ Records the submission date & time and assigns a **reference number**
- 📊 Saves the response as a row in a **Google Sheet** (with email-delivery status)
- 🗂️ Saves photos/receipts to a **private Google Drive folder** (never public)
- 📄 Generates a **PDF copy** of the full report
- 📧 Emails the complete report (PDF + attachments) to **info@barberandco.miami**
  with the subject `Weekly Manager Report – [Store] – [Manager] – [Week Start to Week End]`
- ✅ Emails a **confirmation copy** to the manager (if they provide an email)
- 🔁 If email fails, the data is still saved and the form offers a **retry** — it
  never claims delivery it can't confirm

---

## What's in this repo

| File | Purpose |
|------|---------|
| `index.html` | The form UI (8-step wizard, all sections, branding) |
| `app.js` | Front-end logic: wizard, validation, conditional logic, dynamic rows, totals, autosave, uploads, submission |
| `Code.gs` | Google Apps Script backend: storage, PDF, email, dedupe, rate-limiting, sanitization |
| `README.md` | This guide |

> **Files are never stored in source control.** Uploaded photos/receipts live only
> in the private Drive folder created by the backend.

---

## The form (8 steps)

1. **Manager Information** — name, location (dropdown + "Other"), week start/end, week of month, sales, auto date, optional contact
2. **Weekly Manager Tasks** — 8 tasks, each Completed / Not Completed / N/A + notes + photo uploads (Not Completed requires an explanation)
3. **Tasks — Week of the Month** — the selected week opens automatically; others stay collapsed
   - First: Team Meeting · Time-Off Review · Hostess Evaluation *(if needed)*
   - Second: Product Count & Orders (Layrite/Level 3) · Barber Sales/Scale Plan *(if needed)*
   - Third: Supply Order Form + receipt uploads
   - Fourth: WhatsApp meeting announcement · Incident Reports *(if any)* · One-on-One *(if needed)*
   - Fifth: notes *(when applicable)*
4. **Marketing & Expenses** — marketing services (with "no marketing this week"), expenses with per-row receipts, live totals, confirmation checkbox, plus preserved **Hostess Hours**
5. **Attendance** — late arrivals/early departures *(if any)*, absences *(if any)*
6. **Barber Ratings** — one card per barber, 1–5 ratings, auto overall
7. **General Shop Report** — full condition report + uploads
8. **Review & Certify** — summary with Edit buttons, 4 certification checkboxes, electronic signature

---

## One-time setup (~15–20 minutes, no coding)

### Part A — Backend (Google Sheet + Apps Script)

1. Go to **[sheets.google.com](https://sheets.google.com)** and create a **blank spreadsheet**
   (e.g. `Barber & Co Manager Reports`). Use the Google account that should send the
   emails — ideally the one that owns **info@barberandco.miami**.
2. In that sheet: **Extensions → Apps Script**.
3. Delete the sample code, paste **all** of `Code.gs`, and click **💾 Save**.
4. **Deploy → New deployment** → select type **Web app**:
   - **Execute as:** `Me`
   - **Who has access:** **Anyone**  ← so managers need no login
   - **Deploy**, then **Authorize access** and allow the permissions.
     *(If you see "Google hasn't verified this app", click **Advanced → Go to (project)**. This is normal for your own script.)*
5. Copy the **Web app URL** (ends in `/exec`).

### Part B — Configure (environment variables = Script Properties)

In the Apps Script editor: **Project Settings (⚙️) → Script Properties → Add script property**.
All are optional except that the defaults are sensible.

| Property | Default | What it does |
|----------|---------|--------------|
| `OFFICE_EMAIL` | `info@barberandco.miami` | Where reports are emailed |
| `DRIVE_FOLDER_ID` | *(auto-created)* | Parent Drive folder for uploads/PDFs |
| `SHEET_ID` | *(bound sheet)* | Spreadsheet to log to |
| `RATE_LIMIT_PER_MIN` | `15` | Max submissions/minute (spam guard) |
| `SEND_CONFIRMATION` | `true` | Email the manager a confirmation copy |
| `MAX_EMAIL_ATTACH_MB` | `20` | Above this, email links to Drive instead of attaching |

> **Email service:** email is sent by Apps Script's `MailApp` **as the Google account
> you authorized in step 4** — there is **no API key, SMTP password, or credential to
> store anywhere**, and nothing sensitive is ever placed in the front-end. Gmail sending
> limits apply (~100/day consumer, ~1,500/day Workspace), which is far above this use.

### Part C — Connect & host the form

1. Open `app.js`, find near the top:
   ```js
   var ENDPOINT_URL = "PASTE_YOUR_APPS_SCRIPT_URL_HERE";
   ```
   Replace the placeholder with your Web app URL (keep the quotes). **This URL is not a
   secret** — it's safe to ship in the front-end.
2. *(Optional)* Add a `logo.png` (or `.svg`/`.jpg`) to the repo root and it will replace
   the text wordmark automatically.
3. Host with **GitHub Pages** (free): **Settings → Pages → Branch → `/root` → Save**.
   Your live link appears (e.g. `https://<user>.github.io/Barber-Co.-Weekly-Manager-Report/`).
   Send that link to managers.

---

## Testing checklist

After deploying, submit a test report and confirm:

1. Email arrives at `info@barberandco.miami` with the correct subject and PDF.
2. The manager's confirmation email arrives (if an email was entered).
3. A new row appears in the Google Sheet with **Email Status = SENT** and a reference #.
4. Uploaded photos appear in the private Drive folder.
5. Conditional sections show/hide correctly; totals calculate; drafts restore after refresh.

---

## Changing things later

- **Where reports go** → `OFFICE_EMAIL` script property.
- **Form fields** → edit `index.html` (markup) and `app.js` (payload/validation).
- After editing `Code.gs`: **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**.

---

## Privacy & security notes

- Incident reports, receipts, and employee information are stored in a **private** Drive
  folder — no public sharing is ever set.
- Input is **sanitized** server-side (control characters stripped, spreadsheet
  formula-injection neutralized, output HTML-escaped in the PDF/email).
- Spam is mitigated without logins via a **honeypot** field and **rate limiting**.
- Submissions are **idempotent** by a per-report ID, preventing accidental duplicates.

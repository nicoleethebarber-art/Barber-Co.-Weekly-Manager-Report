# Barber & Co. Weekly Manager Report

A mobile-friendly digital form that replaces the paper manager report. Managers
open a link, fill it out on their phone or computer, and submit — **no account, no login**.

On every submission the system automatically:

- ⏱️ Records the date & time
- 📊 Saves the response as a row in a Google Sheet
- 📄 Creates a PDF copy of the report
- 📧 Emails the report (PDF attached) to **INFO@BARBERANDCO.MIAMI**
  with the subject `Manager Report – Manager Name – Location – Week`
- ✅ Emails a confirmation copy to the manager

---

## What's in this repo

| File | What it is |
|------|-----------|
| `index.html` | The form managers fill out (the web page) |
| `Code.gs` | The backend that emails, saves, and makes PDFs (Google Apps Script) |
| `README.md` | This setup guide |

---

## One-time setup (about 15–20 minutes, no coding)

You'll do two things: **(A)** set up the backend in Google, then **(B)** put the form online.

### Part A — Backend (Google Sheet + Apps Script)

1. Go to **[sheets.google.com](https://sheets.google.com)** and create a **new blank spreadsheet**.
   Name it something like `Barber & Co. Manager Reports`.
2. In that spreadsheet's top menu, click **Extensions → Apps Script**.
3. Delete any sample code in the editor. Open `Code.gs` from this repo, copy **all**
   of it, and paste it into the Apps Script editor. Click the **💾 Save** icon.
4. Click **Deploy → New deployment**.
   - Click the ⚙️ gear next to "Select type" → choose **Web app**.
   - **Description:** `Manager Report`
   - **Execute as:** `Me`
   - **Who has access:** **Anyone**  ← important, so managers don't need to log in
   - Click **Deploy**.
5. Google will ask you to **authorize**. Click **Authorize access**, pick the Google
   account that should send the emails, and allow the permissions.
   > If you see a "Google hasn't verified this app" screen, click **Advanced →
   > Go to (project name)**. This is normal for your own scripts.
6. Copy the **Web app URL** it gives you (it ends in `/exec`). Keep it handy.

> 📧 **Note on the sending email:** the emails are sent from whichever Google
> account you authorized in step 5. If INFO@BARBERANDCO.MIAMI is a Google Workspace
> account, log in as that account for steps 1–5 so mail comes from it directly.

### Part B — Put the form online

1. Open `index.html` in this repo and find this line near the bottom:
   ```js
   const ENDPOINT_URL = "PASTE_YOUR_APPS_SCRIPT_URL_HERE";
   ```
   Replace the placeholder with the Web app URL you copied (keep the quotes):
   ```js
   const ENDPOINT_URL = "https://script.google.com/macros/s/AKfy..../exec";
   ```
2. Host the page so managers get a link. The easiest **free** option is **GitHub Pages**:
   - In this GitHub repo, go to **Settings → Pages**.
   - Under **Branch**, pick your branch and `/ (root)`, then **Save**.
   - After a minute, GitHub shows your live link, e.g.
     `https://<your-username>.github.io/Barber-Co.-Weekly-Manager-Report/`
   - That link is what you send to managers.

That's it. Send the link to your managers and every submission flows into your
inbox, your spreadsheet, and a PDF — automatically.

---

## Testing it

1. Open the live link (or `index.html` locally after adding the URL).
2. Fill it out with test data and submit.
3. Check: INFO@BARBERANDCO.MIAMI received the email with the PDF, the manager's
   email got a confirmation, and a new row appeared in the Google Sheet.

---

## Making changes later

- **Change where reports are emailed** → edit `OFFICE_EMAIL` at the top of `Code.gs`.
- **Add or remove form fields** → edit `index.html` (and the matching parts of `Code.gs`).
- After editing `Code.gs`, re-deploy: **Deploy → Manage deployments → ✏️ Edit →
  Version: New version → Deploy**.

---

## How it works (plain English)

The form is a normal web page. When a manager taps **Submit**, it sends the answers
to a small Google script you own. That script stamps the time, adds a row to your
spreadsheet, builds a PDF, and sends the two emails. Everything runs on Google's
free tier — there's no server for you to maintain and nothing to pay for.

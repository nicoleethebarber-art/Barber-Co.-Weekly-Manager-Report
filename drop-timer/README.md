# Drop Timer

A Chrome extension (Manifest V3) that makes sure you are **prepared** and **on time** for a
scheduled product release.

It does not buy anything for you. It never clicks a button, never submits a form, never fires a
synthetic event, and never sends a request to the retailer beyond one lightweight `HEAD` per minute
used to read the server's clock. The purchase is always your keypress or your mouse click.

---

## What it does

| Feature | What you get |
| --- | --- |
| **Server time sync** | One same-origin `HEAD` per minute, reading the `Date` response header. Round-trip corrected, median of a rolling 5-sample window, plus an extra sync at T-90s. Every countdown runs on server-corrected time, never the raw local clock. |
| **Countdown overlay** | Draggable panel pinned to the product page. 0.1s precision inside the final minute. Neutral > 5 min, amber 5 min–60s, red < 60s, green flash at T-0. Shows the live server-vs-local offset so you can confirm the sync is working. |
| **Audible cues** | One tone at T-60s, three at T-10s, a distinct alarm at T-0, and a warning tone at T-5 min if the checklist isn't green. Volume slider and mute, synthesised loud for a 3am drop. |
| **Pre-flight checklist** | Correct page open, logged in, variant selected (auto-detected); payment saved and shipping confirmed (manual ticks). Gaps get a warning tone and a highlight at T-5 min, and a hard "still not ready" banner at T-60s. |
| **Focus assist at T-0** | Scrolls the buy button into view, outlines it in high contrast, and calls `.focus()` so a single keypress activates it. Nothing else. |
| **Config** | Options page with a list of drops, each storing label, URL, drop time + timezone, and three CSS selectors. Stored in `chrome.storage.sync`. JSON import/export. Next drop shown on the toolbar badge. |

---

## Install (unpacked)

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked**.
5. Select the **`drop-timer/`** folder — the one containing `manifest.json`, not the repository root.

There is no build step. Edit any file and press the reload arrow on the extension card in
`chrome://extensions` to pick up the change. (Editing the options page or popup only needs the page
reopened; editing `content/` needs the extension reloaded *and* the product page reloaded.)

### Permissions it asks for

The manifest requests only `storage`, `alarms`, and `scripting`. **It declares no host permissions
at all** — on install it cannot read or touch a single website. You grant access to one origin at a
time from the options page, and the content script is registered dynamically for exactly that
origin. Revoking access from the options page (or from `chrome://extensions`) unregisters it again.

There is no `<all_urls>`, no proxy support, no user-agent or fingerprint modification, no CAPTCHA
handling, and no multi-account support. Those are deliberately absent and should stay absent.

---

## Adding your first drop

### 1. Open the settings

Click the Drop Timer toolbar icon → **Settings & drops**. (Or right-click the icon → **Options**.)

### 2. Create the drop

Press **+ Add drop** and fill in:

| Field | Example | Notes |
| --- | --- | --- |
| Label | `Dunk Low Panda` | Just for you — shows in the overlay, popup, and badge tooltip. |
| Product URL | `https://shop.example.com/products/dunk-low-panda` | The exact page you'll have open. |
| Drop time | `2026-08-20T10:00` | Wall-clock time **as announced by the retailer**. |
| Timezone | `America/New_York` | The zone that wall-clock time is in. Start typing for autocomplete. |
| Buy button selector | `button[name="add"]` | Required — this is what gets focused at T-0. |
| Logged-in indicator selector | `a[href*="/account/logout"]` | Optional. Blank = skip the check. |
| Size / variant selector | `fieldset[name="size"] input` | Optional. Blank = skip the check. |

The card shows a live preview: the drop time rendered in its own zone, the equivalent in your local
time, and a countdown. Check the local time line — a timezone mistake is the single most common way
to miss a drop.

### 3. Grant site access

Press **Grant site access** on the card. Chrome will ask you to confirm access to that origin. The
pill in the card header turns green (`site access ✓`).

**If you skip this, nothing will happen on the page.** The popup will warn you about it too.

### 4. Set your volume

In **Audible cues**, set the volume and press **Test T-0 tone** — at the actual volume you'll be
asleep at. Your system volume is the real ceiling; the extension can't exceed it.

### 5. Open the product page and check the overlay

Load the product URL. The overlay appears top-right. Verify:

- The countdown matches what you expect.
- The sync line reads something like `server +0.31s · 5 samples · ±0.09s · 12s ago`. If it says
  `sync failed: …`, see [Troubleshooting](#troubleshooting).
- The checklist auto-items go green. Tick the two manual items once you've confirmed your saved
  card and address on the retailer's account.

Drag the overlay anywhere by its header; the position is remembered. `–` minimises it to just the
clock, `×` hides it until you reload.

---

## Finding the right CSS selectors

You need up to three selectors. Here's how to get each one.

### The general method

1. On the product page, press <kbd>F12</kbd> to open DevTools.
2. Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> (<kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> on
   Mac) to activate the element picker.
3. Click the element on the page. DevTools jumps to it in the **Elements** panel.
4. Right-click the highlighted node → **Copy** → **Copy selector**.
5. **Then clean it up** (see below) and paste it into the options page.

### Always verify in the Console

Copy-selector output is often brittle and sometimes matches the wrong node. Before you trust it,
switch to the **Console** tab and run:

```js
document.querySelectorAll('YOUR-SELECTOR-HERE')
```

- **Buy button:** you want exactly **one** match, and it should be the visible one. Hover the result
  in the console — DevTools highlights it on the page.
- **Logged-in indicator:** you want **one or more** matches while signed in, and **zero** when signed
  out. Test both states — open the page in an incognito window to check the signed-out case.
- **Variant control:** you want the element (or container) whose selected state changes when you
  click a size.

### Write selectors that survive a redeploy

Chrome's *Copy selector* tends to produce things like
`#main > div:nth-child(3) > div.css-1x7yhk9 > button`. That will break the next time the retailer
ships a CSS change — quite possibly the morning of the drop. Prefer, in this order:

| Prefer | Example |
| --- | --- |
| Test/automation attributes | `[data-testid="add-to-cart"]`, `[data-test="buy"]` |
| Form semantics | `button[name="add"]`, `form[action*="/cart/add"] button[type="submit"]` |
| Stable IDs | `#AddToCart` |
| ARIA / accessible names | `button[aria-label="Add to bag"]` |
| Semantic class names | `.product-form__submit` |
| Generated class names | `.css-1x7yhk9` ← avoid |
| Long `nth-child` chains | ← avoid |

Tip: many stores render the buy button twice (a desktop one and a mobile one, one of them hidden).
That's fine — the focus assist automatically picks the first match that's actually rendered. But if
your selector matches five things, tighten it.

### Selector examples

These are illustrative shapes, not guaranteed to work on any particular store — always verify.

```
Buy button
  button[name="add"]
  form[action*="/cart/add"] button[type="submit"]
  [data-testid="add-to-cart-button"]

Logged-in indicator
  a[href*="/account/logout"]
  a[href$="/logout"]
  [data-testid="account-menu"]
  header a[href*="/account"]:not([href*="/login"])

Size / variant
  fieldset[name="size"] input          (radio inputs — checks :checked)
  select#size                          (native select — checks for a real value)
  .size-selector .swatch               (checks for .selected/.active/aria-checked on a match)
```

The variant check understands, in order: a `<select>` with a non-placeholder value, a checked
radio/checkbox (on the element or inside it), `aria-checked` / `aria-selected` / `aria-pressed`, and
`.selected` / `.is-selected` / `.active` / `.checked` / `[data-selected="true"]`. If your store marks
selection some other way, add it to `SELECTED_MARKERS` at the top of `content/checklist.js`.

---

## How the time sync works, and how accurate it really is

Every minute the content script sends one `HEAD` request to the site's own origin root, with
`cache: no-store` and **no cookies** (`credentials: 'omit'` — it never touches your session). It reads
the `Date` response header and computes:

```
offset = serverTime + 500ms − (requestStart + roundTrip/2)
```

- **`roundTrip/2`** compares the server's timestamp against the *midpoint* of the request rather
  than its start, which removes the latency bias.
- **`+500ms`** corrects for truncation. Servers floor their clock into the `Date` header, so a header
  reading `10:00:00` means "somewhere in [10:00:00, 10:00:01)". Without this correction every
  countdown would sit systematically half a second early.

The last 5 offsets are kept in a **rolling window** and the median is used, which discards the odd
sample ruined by network jitter. Rolling, rather than a burst of 5 requests, keeps it to one
request per minute against the retailer.

**Be realistic about the accuracy.** The `Date` header has one-second resolution. That's a hard
floor — no amount of sampling extracts sub-second truth from a second-granular signal. Expect the
offset to be good to roughly ±0.5s. The overlay shows the live offset, the sample count, and half the
sample spread (`±0.09s`) so you can judge the sync yourself rather than trusting it blindly.

An extra sample is taken at T-90s so the final minute runs on fresh data. Failed samples change
nothing — the countdown keeps running on the last good offset rather than falling back to your raw
local clock.

---

## Milestones

| Time remaining | What happens |
| --- | --- |
| > 5 min | Neutral colour. Sync every 60s. |
| T-5 min | Amber. If the checklist isn't fully green: warning tone, gaps highlighted, banner listing them. |
| T-90s | One extra time sync. |
| T-60s | Red. Single tone. Countdown switches to 0.1s precision. If the checklist still isn't green, a red "final minute and still not ready" banner. |
| T-10s | Triple rising tone. |
| T-0 | Distinct alarm, green flash, and the focus assist fires: scroll → outline → `.focus()`. |

Milestones only fire if you were *watching* when they were crossed. Opening the page at T-30s won't
retroactively blast every cue at you.

---

## Staying awake for a 3am drop

Two things will quietly sabotage you, and neither is the extension's fault:

1. **Chrome throttles timers in background tabs** — down to about once a minute. A minimised window
   or a tab in the background will not give you a 0.1s countdown.
2. **A sleeping machine has no timers at all.**

So: leave the product page in the **foreground**, in a **visible, non-minimised window**.

The **Awake** button in the overlay (also a checkbox in the options page) requests a screen wake lock
via the browser's own `navigator.wakeLock` API — no extra extension permission — which stops the
display sleeping while the page is open. It's best-effort: the OS can still override it, and some
platforms refuse it entirely. Set your system power settings too, and set a phone alarm as a backup.
The extension is a timing aid, not a guarantee you'll be conscious.

Also: browsers refuse to play audio on a page you have never interacted with. Click anywhere on the
product page once after loading it. If sound is still blocked, the overlay shows an **Enable sound**
banner — press it, and press **Test** to confirm you can actually hear it.

---

## File layout

```
drop-timer/
├── manifest.json                 MV3 manifest. No host permissions declared.
├── README.md                     this file
├── background/
│   └── service-worker.js         badge, alarms, dynamic content-script registration
├── content/                      injected into granted product pages, in this order:
│   ├── overlay-styles.js         the overlay's CSS, as a string (see note below)
│   ├── audio.js                  WebAudio cue synthesis
│   ├── clock.js                  server time sync
│   ├── checklist.js              auto-detection + manual ticks
│   ├── focus.js                  T-0 scroll / outline / focus — no clicking, ever
│   ├── overlay.js                the shadow-DOM panel
│   └── content.js                orchestrator: tick loop and milestones
├── lib/
│   ├── tz.js                     timezone + duration formatting
│   └── store.js                  drop schema, storage, URL matching, import/export
├── options/                      options.html / .css / .js
├── popup/                        popup.html / .js
└── icons/                        16 / 32 / 48 / 128 px
```

Everything is plain ES2020 in classic (non-module) scripts sharing one namespace — `DT_TZ`,
`DT_Store`, `DT_Clock`, `DT_Audio`, `DT_Checklist`, `DT_Focus`, `DT_Overlay`. No bundler, no
transpiler, no `node_modules`. Edit the files directly.

**Why the CSS is a JS string:** the overlay lives in a shadow root so the retailer's stylesheet can't
break it. A shadow root can't load a `.css` file that isn't in `web_accessible_resources`, and
listing one would mean declaring a broad match pattern in the manifest. Keeping the CSS as a string
in `content/overlay-styles.js` avoids that. It's still ordinary CSS — edit it as such.

---

## What this extension will not do

These are load-bearing constraints, not oversights. If you extend it, don't add them.

- **No automated clicking or submitting.** No `.click()`, no `dispatchEvent()`, no
  `form.submit()`/`requestSubmit()` anywhere in the codebase.
- **No requests to the retailer** beyond the one `HEAD` per minute for time sync, and the page you
  loaded yourself. No cart polling, no stock checking, no prefetching.
- **No proxy support, no user-agent or fingerprint modification, no CAPTCHA handling, no
  multi-account features.**
- **No broad host permissions.** Origins are granted one at a time, by you.

The time sync is one lightweight request per minute. If you shorten `SYNC_INTERVAL_MS` in
`content/clock.js`, you are choosing to hit the retailer harder than they've been asked for — don't.

---

## Troubleshooting

**Nothing appears on the product page.**
Check, in order: (1) the popup shows the drop as next; (2) the options card header shows
`site access ✓` — if not, press **Grant site access**; (3) reload the product page after granting;
(4) the drop is enabled and its time is in the future; (5) you're within 10 minutes after T-0 at the
latest — the overlay stops showing a drop older than that.

**The overlay shows but "Correct product page open" is red.**
The URL you're on doesn't match the configured one. Matching compares origin + path and ignores the
query string, the hash, and a trailing slash — so a genuine mismatch means a different path. Copy
the URL from the address bar into the drop's Product URL field.

**`sync failed: no Date header on the response`.**
Some CDNs strip or don't expose `Date` on `HEAD`. There is no workaround inside the constraints of
this extension — every countdown will fall back to your local clock offset by whatever it was at the
last good sample (or zero). Sync your OS clock to an NTP server and treat the countdown as
approximate.

**`sync failed: unparseable Date header` or wildly wrong offsets.**
Check your machine's clock is roughly right first. A multi-hour offset almost always means the local
clock is wrong, not the server's.

**The offset jumps around by more than a second.**
Look at the `±` figure in the sync line. High spread means a noisy connection. It'll settle as the
rolling window fills. If it doesn't, you're on a connection where sub-second timing isn't achievable.

**No sound.**
Interact with the page once (the browser blocks audio otherwise), check the mute button isn't on,
check the volume slider, check your system volume, and press **Test**.

**The buy button isn't focused at T-0.**
The overlay shows the reason in a red banner and retries for 30 seconds. Usually the selector doesn't
match — many stores only render the buy button when stock goes live, which is exactly why it retries.
Verify the selector in the Console (see above) and, if the button genuinely doesn't exist until T-0,
that's fine: the retry will catch it.

**The countdown froze or lost precision.**
The tab was backgrounded and Chrome throttled its timers. Keep the page in the foreground.

**Changes to `content/` aren't taking effect.**
Reload the extension in `chrome://extensions`, *then* reload the product page.

---

## A note on use

This is a preparation aid: it tells you the right time and checks you're ready. It doesn't give you
an automated advantage, and it isn't designed to. Retailer terms of service vary — where a site
prohibits automation, this extension's design (no clicking, no automated requests, no evasion) is
what keeps you on the right side of that line. Keep it that way.

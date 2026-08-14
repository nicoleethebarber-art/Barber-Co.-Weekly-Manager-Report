/*
 * background/service-worker.js
 *
 * Two jobs, and deliberately nothing else:
 *   1. Keep the toolbar badge showing time-to-next-drop.
 *   2. Keep the dynamically-registered content scripts in sync with the drops
 *      you've configured AND the host permissions you've actually granted.
 *
 * It never touches a retailer. It has no fetch, no XHR, no tab scripting
 * beyond registering the declarative content script.
 */

importScripts('/lib/tz.js', '/lib/store.js');

const BADGE_ALARM = 'dt-badge-tick';
const DROP_ALARM_PREFIX = 'dt-drop-';
const SCRIPT_ID_PREFIX = 'dt-site-';

// The content script, in load order. These are classic scripts sharing one
// isolated-world global, so tz/store must come first and content.js last.
const CONTENT_FILES = [
  '/lib/tz.js',
  '/lib/store.js',
  '/content/overlay-styles.js',
  '/content/audio.js',
  '/content/clock.js',
  '/content/checklist.js',
  '/content/focus.js',
  '/content/overlay.js',
  '/content/content.js'
];

// ---------------------------------------------------------------- badge

async function refreshBadge() {
  const drops = await DT_Store.getDrops();
  const next = DT_Store.nextUpcoming(drops, Date.now());

  if (!next) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'Drop Timer — no upcoming drops' });
    return;
  }

  const remaining = next.epoch - Date.now();

  // Red inside the last hour, amber inside the last day, otherwise slate.
  let colour = '#3d4451';
  if (remaining <= 60 * 60 * 1000) colour = '#c0392b';
  else if (remaining <= 24 * 60 * 60 * 1000) colour = '#b7791f';

  await chrome.action.setBadgeBackgroundColor({ color: colour });
  await chrome.action.setBadgeText({ text: DT_TZ.formatBadge(remaining) });
  await chrome.action.setTitle({
    title:
      'Drop Timer — next: ' +
      (next.drop.label || next.drop.url) +
      '\n' +
      DT_TZ.formatInZone(next.epoch, next.drop.timeZone) +
      '\nin ' +
      DT_TZ.formatRemaining(remaining)
  });
}

/**
 * Badge granularity is limited by chrome.alarms (1 minute is the practical
 * floor), so on top of the periodic tick we set a one-shot alarm for each
 * upcoming drop. That makes the badge flip to NOW at the right moment instead
 * of up to a minute late.
 */
async function scheduleDropAlarms() {
  const existing = await chrome.alarms.getAll();
  for (const alarm of existing) {
    if (alarm.name.startsWith(DROP_ALARM_PREFIX)) {
      await chrome.alarms.clear(alarm.name);
    }
  }

  const drops = await DT_Store.getDrops();
  const now = Date.now();

  for (const drop of drops) {
    if (!drop.enabled) continue;
    const epoch = DT_Store.dropEpoch(drop);
    if (epoch === null || epoch <= now) continue;
    // Only bother for drops inside the next day; anything further out is
    // covered by the periodic tick.
    if (epoch - now > 24 * 60 * 60 * 1000) continue;
    chrome.alarms.create(DROP_ALARM_PREFIX + drop.id, { when: epoch });
  }
}

// ------------------------------------------------- content script wiring

/**
 * Register the content script for every origin that is (a) used by an enabled
 * drop and (b) actually permitted. An origin we don't hold permission for is
 * skipped silently — the options page is where you grant it.
 */
async function syncContentScripts() {
  const drops = await DT_Store.getDrops();

  // Unique origin patterns we'd like to run on.
  const wanted = new Set();
  for (const drop of drops) {
    if (!drop.enabled) continue;
    const pattern = DT_Store.originPattern(drop.url);
    if (pattern) wanted.add(pattern);
  }

  // Drop the ones we haven't been granted.
  const permitted = [];
  for (const pattern of wanted) {
    let has = false;
    try {
      has = await chrome.permissions.contains({ origins: [pattern] });
    } catch (err) {
      has = false;
    }
    if (has) permitted.push(pattern);
  }

  let registered = [];
  try {
    registered = await chrome.scripting.getRegisteredContentScripts();
  } catch (err) {
    registered = [];
  }
  const ours = registered.filter((s) => s.id.startsWith(SCRIPT_ID_PREFIX));

  const idFor = (pattern) => SCRIPT_ID_PREFIX + patternToId(pattern);
  const wantedIds = new Set(permitted.map(idFor));

  // Remove registrations we no longer want (drop deleted, permission revoked).
  const stale = ours.filter((s) => !wantedIds.has(s.id)).map((s) => s.id);
  if (stale.length) {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: stale });
    } catch (err) {
      console.warn('[Drop Timer] could not unregister', stale, err);
    }
  }

  // Add the ones that are missing.
  const existingIds = new Set(ours.map((s) => s.id));
  const toAdd = permitted
    .filter((pattern) => !existingIds.has(idFor(pattern)))
    .map((pattern) => ({
      id: idFor(pattern),
      matches: [pattern],
      js: CONTENT_FILES,
      runAt: 'document_idle',
      allFrames: false,
      persistAcrossSessions: true
    }));

  if (toAdd.length) {
    try {
      await chrome.scripting.registerContentScripts(toAdd);
    } catch (err) {
      console.warn('[Drop Timer] could not register', toAdd, err);
    }
  }
}

/** Match patterns contain characters that aren't legal in a script id. */
function patternToId(pattern) {
  return pattern.replace(/[^a-zA-Z0-9]+/g, '-');
}

// -------------------------------------------------------------- lifecycle

async function bootstrap() {
  chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 1 });
  await syncContentScripts();
  await scheduleDropAlarms();
  await refreshBadge();
}

chrome.runtime.onInstalled.addListener(() => {
  bootstrap();
});

chrome.runtime.onStartup.addListener(() => {
  bootstrap();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BADGE_ALARM || alarm.name.startsWith(DROP_ALARM_PREFIX)) {
    refreshBadge();
  }
});

// Config changed in the options page (or synced in from another machine).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.drops) {
    syncContentScripts();
    scheduleDropAlarms();
  }
  refreshBadge();
});

// You granted or revoked a site from the options page.
chrome.permissions.onAdded.addListener(() => syncContentScripts());
chrome.permissions.onRemoved.addListener(() => syncContentScripts());

/**
 * The popup asks for the next drop rather than recomputing it, so there's one
 * source of truth for "what's next".
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'dt:next-drop') return false;

  (async () => {
    const drops = await DT_Store.getDrops();
    const next = DT_Store.nextUpcoming(drops, Date.now());
    sendResponse(
      next ? { drop: next.drop, epoch: next.epoch } : null
    );
  })();

  return true; // keep the message channel open for the async reply
});

// The service worker can be torn down and revived at any time; re-run the
// cheap idempotent setup on every wake.
bootstrap();

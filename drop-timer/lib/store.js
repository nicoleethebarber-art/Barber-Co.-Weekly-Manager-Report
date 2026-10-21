/*
 * lib/store.js — the shape of a drop, and every read/write to chrome.storage.
 *
 * Classic script (see lib/tz.js for why). Depends on DT_TZ being loaded first.
 * Everything hangs off globalThis.DT_Store.
 *
 * Storage layout
 * --------------
 * chrome.storage.sync
 *   drops     : Drop[]      the configured drops (syncs across your Chrome profiles)
 *   settings  : Settings    volume / mute / etc.
 *
 * chrome.storage.local
 *   overlayPos      : {x, y}            where you dragged the overlay to
 *   manual:<dropId> : {payment, shipping}  manual checklist ticks (device-local on purpose)
 */
(function (root) {
  'use strict';

  const SYNC_DROPS = 'drops';
  const SYNC_SETTINGS = 'settings';

  const DEFAULT_SETTINGS = {
    volume: 0.85, // 0..1, mapped to WebAudio gain
    muted: false,
    keepAwake: false // try to hold a screen wake lock while a drop is pending
  };

  /**
   * A drop. `url` and `dropDateTime`+`timeZone` are the source of truth; the
   * epoch is always derived, never stored, so editing the zone can't leave a
   * stale timestamp behind.
   *
   * @typedef {Object} Drop
   * @property {string} id
   * @property {string} label              human name, e.g. "Dunk Low Panda"
   * @property {string} url                exact product page URL
   * @property {string} dropDateTime       wall clock "YYYY-MM-DDTHH:MM"
   * @property {string} timeZone           IANA zone the wall clock is in
   * @property {string} buySelector        CSS selector for the buy button
   * @property {string} loggedInSelector   CSS selector proving you're signed in
   * @property {string} variantSelector    CSS selector for the size/variant control
   * @property {boolean} enabled
   */

  function newDrop() {
    return {
      id: 'd_' + Math.random().toString(36).slice(2, 10),
      label: '',
      url: '',
      dropDateTime: '',
      timeZone: root.DT_TZ.localZone(),
      buySelector: '',
      loggedInSelector: '',
      variantSelector: '',
      enabled: true
    };
  }

  /** Fill in anything missing so older/imported configs never crash a caller. */
  function normalizeDrop(raw) {
    const base = newDrop();
    if (!raw || typeof raw !== 'object') return base;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : base.id,
      label: String(raw.label || ''),
      url: String(raw.url || ''),
      dropDateTime: String(raw.dropDateTime || ''),
      timeZone: root.DT_TZ.isValidZone(raw.timeZone) ? raw.timeZone : base.timeZone,
      buySelector: String(raw.buySelector || ''),
      loggedInSelector: String(raw.loggedInSelector || ''),
      variantSelector: String(raw.variantSelector || ''),
      enabled: raw.enabled !== false
    };
  }

  /** @returns {number|null} epoch ms for a drop, or null if it isn't scheduled yet */
  function dropEpoch(drop) {
    if (!drop || !drop.dropDateTime) return null;
    return root.DT_TZ.wallClockToEpoch(drop.dropDateTime, drop.timeZone);
  }

  // ---------------------------------------------------------------- storage

  async function getDrops() {
    const got = await chrome.storage.sync.get(SYNC_DROPS);
    const list = Array.isArray(got[SYNC_DROPS]) ? got[SYNC_DROPS] : [];
    return list.map(normalizeDrop);
  }

  async function setDrops(drops) {
    await chrome.storage.sync.set({ [SYNC_DROPS]: drops.map(normalizeDrop) });
  }

  async function getSettings() {
    const got = await chrome.storage.sync.get(SYNC_SETTINGS);
    return Object.assign({}, DEFAULT_SETTINGS, got[SYNC_SETTINGS] || {});
  }

  async function setSettings(patch) {
    const current = await getSettings();
    const next = Object.assign({}, current, patch);
    await chrome.storage.sync.set({ [SYNC_SETTINGS]: next });
    return next;
  }

  async function getManualChecks(dropId) {
    const key = 'manual:' + dropId;
    const got = await chrome.storage.local.get(key);
    return Object.assign({ payment: false, shipping: false }, got[key] || {});
  }

  async function setManualChecks(dropId, patch) {
    const key = 'manual:' + dropId;
    const current = await getManualChecks(dropId);
    const next = Object.assign({}, current, patch);
    await chrome.storage.local.set({ [key]: next });
    return next;
  }

  // ------------------------------------------------------------------- urls

  /**
   * The match pattern we ask host permission for, and register the content
   * script against. We scope to the origin — not the full path — because most
   * drop pages bounce through a query string or a slightly different path, and
   * a path-scoped pattern would silently fail to inject.
   *
   * @returns {string|null} e.g. "https://www.example.com/*"
   */
  function originPattern(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      return u.protocol + '//' + u.hostname + '/*';
    } catch (err) {
      return null;
    }
  }

  /** Origin only, for the "is this even the right site" cheap check. */
  function originOf(url) {
    try {
      return new URL(url).origin;
    } catch (err) {
      return null;
    }
  }

  /**
   * Is `current` the configured product page?
   *
   * Compares origin + pathname, ignoring the query string, the hash, a
   * trailing slash, and case on the host. Query strings on product pages are
   * usually variant/tracking noise, so requiring them to match would make the
   * "Correct product page open" check fail constantly for no good reason.
   */
  function isSamePage(current, configured) {
    try {
      const a = new URL(current);
      const b = new URL(configured);
      if (a.origin.toLowerCase() !== b.origin.toLowerCase()) return false;
      const strip = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
      return strip(a.pathname) === strip(b.pathname);
    } catch (err) {
      return false;
    }
  }

  // ------------------------------------------------------------- selection

  /**
   * The drop the badge should count down to: soonest enabled drop that hasn't
   * happened yet.
   *
   * @param {Drop[]} drops
   * @param {number} nowMs
   * @returns {{drop: Drop, epoch: number}|null}
   */
  function nextUpcoming(drops, nowMs) {
    let best = null;
    for (const drop of drops) {
      if (!drop.enabled) continue;
      const epoch = dropEpoch(drop);
      if (epoch === null || epoch <= nowMs) continue;
      if (!best || epoch < best.epoch) best = { drop: drop, epoch: epoch };
    }
    return best;
  }

  /**
   * The drop the overlay on *this page* should show.
   *
   * Preference order:
   *   1. exact page match, still upcoming (or only just past)
   *   2. same-origin match, still upcoming — so you still get a countdown when
   *      you're on the wrong page, and the checklist tells you so loudly
   *
   * `graceMs` keeps the overlay on screen just after T-0 rather than yanking it
   * away at the exact moment you're trying to buy.
   */
  function dropForPage(drops, pageUrl, nowMs, graceMs) {
    const grace = typeof graceMs === 'number' ? graceMs : 10 * 60 * 1000;
    const pageOrigin = originOf(pageUrl);
    if (!pageOrigin) return null;

    let exact = null;
    let sameOrigin = null;

    for (const drop of drops) {
      if (!drop.enabled) continue;
      const epoch = dropEpoch(drop);
      if (epoch === null) continue;
      if (epoch < nowMs - grace) continue; // long gone
      if (originOf(drop.url) !== pageOrigin) continue;

      const candidate = { drop: drop, epoch: epoch };
      if (isSamePage(pageUrl, drop.url)) {
        if (!exact || epoch < exact.epoch) exact = candidate;
      } else if (!sameOrigin || epoch < sameOrigin.epoch) {
        sameOrigin = candidate;
      }
    }

    return exact || sameOrigin;
  }

  // ----------------------------------------------------------- import/export

  function exportJSON(drops, settings) {
    return JSON.stringify(
      {
        format: 'drop-timer',
        version: 1,
        exportedAt: new Date().toISOString(),
        drops: drops,
        settings: settings
      },
      null,
      2
    );
  }

  /**
   * Parse an exported file. Throws with a readable message on bad input so the
   * options page can show it verbatim.
   *
   * Also accepts a bare array of drops, which is what people tend to paste.
   */
  function parseImport(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error('That is not valid JSON: ' + err.message);
    }

    let drops;
    let settings = null;

    if (Array.isArray(data)) {
      drops = data;
    } else if (data && Array.isArray(data.drops)) {
      drops = data.drops;
      if (data.settings && typeof data.settings === 'object') settings = data.settings;
    } else {
      throw new Error('Expected an object with a "drops" array, or a bare array of drops.');
    }

    return {
      drops: drops.map(normalizeDrop),
      settings: settings ? Object.assign({}, DEFAULT_SETTINGS, settings) : null
    };
  }

  root.DT_Store = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    newDrop: newDrop,
    normalizeDrop: normalizeDrop,
    dropEpoch: dropEpoch,
    getDrops: getDrops,
    setDrops: setDrops,
    getSettings: getSettings,
    setSettings: setSettings,
    getManualChecks: getManualChecks,
    setManualChecks: setManualChecks,
    originPattern: originPattern,
    originOf: originOf,
    isSamePage: isSamePage,
    nextUpcoming: nextUpcoming,
    dropForPage: dropForPage,
    exportJSON: exportJSON,
    parseImport: parseImport
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);

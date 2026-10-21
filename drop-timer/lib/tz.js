/*
 * lib/tz.js — timezone + duration helpers.
 *
 * Deliberately a CLASSIC script (no ES module syntax) so the exact same file
 * can be used by:
 *   - the service worker, via importScripts()
 *   - the options/popup pages, via <script src>
 *   - the content script, via the manifest/registerContentScripts js array
 *
 * Everything hangs off globalThis.DT_TZ.
 */
(function (root) {
  'use strict';

  /**
   * How far ahead of UTC the given IANA zone is, at a given instant.
   *
   * There is no direct API for this, so we use the standard trick: format the
   * instant *in the target zone*, then read those wall-clock fields back as if
   * they were UTC. The difference is the zone's offset at that instant.
   *
   * @param {number} epochMs
   * @param {string} timeZone IANA name, e.g. "America/New_York"
   * @returns {number} offset in ms (e.g. -14400000 for EDT)
   */
  function zoneOffsetMs(epochMs, timeZone) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    const parts = {};
    for (const p of dtf.formatToParts(new Date(epochMs))) {
      parts[p.type] = p.value;
    }

    // Some ICU versions render midnight as hour "24" rather than "00".
    let hour = Number(parts.hour);
    if (hour === 24) hour = 0;

    const asIfUTC = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      hour,
      Number(parts.minute),
      Number(parts.second)
    );

    return asIfUTC - epochMs;
  }

  /**
   * Convert a wall-clock string ("2026-08-20T10:00" — exactly what an
   * <input type="datetime-local"> produces) plus an IANA zone into an epoch ms.
   *
   * We guess, then refine once. The refinement matters only near a DST
   * transition, where the offset at the naive guess differs from the offset at
   * the real instant.
   *
   * @param {string} wallClock "YYYY-MM-DDTHH:MM" or "YYYY-MM-DDTHH:MM:SS"
   * @param {string} timeZone
   * @returns {number|null} epoch ms, or null if the input is unparseable
   */
  function wallClockToEpoch(wallClock, timeZone) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
      String(wallClock || '').trim()
    );
    if (!m) return null;

    const naiveUTC = Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6] || 0)
    );

    try {
      let guess = naiveUTC - zoneOffsetMs(naiveUTC, timeZone);
      guess = naiveUTC - zoneOffsetMs(guess, timeZone);
      return guess;
    } catch (err) {
      // Invalid IANA name — surface as "unparseable" rather than throwing
      // somewhere far away from the config screen that caused it.
      return null;
    }
  }

  /** @returns {boolean} true if the string is an IANA zone this browser knows */
  function isValidZone(timeZone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timeZone });
      return true;
    } catch (err) {
      return false;
    }
  }

  /** The browser's own zone, used as the default for new drops. */
  function localZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (err) {
      return 'UTC';
    }
  }

  /** Every zone this browser knows, for the options page datalist. */
  function allZones() {
    try {
      if (typeof Intl.supportedValuesOf === 'function') {
        return Intl.supportedValuesOf('timeZone');
      }
    } catch (err) {
      /* fall through */
    }
    return [];
  }

  /**
   * Human-readable absolute time, rendered in the drop's own zone.
   * e.g. "Thu, Aug 20, 10:00:00 AM EDT"
   */
  function formatInZone(epochMs, timeZone) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: timeZone,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short'
      }).format(new Date(epochMs));
    } catch (err) {
      return new Date(epochMs).toString();
    }
  }

  /**
   * Countdown text.
   *
   * Inside the final minute we show tenths (2.4s precision is useless when the
   * whole point is hitting a specific second). Outside it, whole seconds.
   *
   * @param {number} ms milliseconds remaining (may be negative)
   * @returns {string}
   */
  function formatRemaining(ms) {
    const past = ms < 0;
    let t = Math.abs(ms);

    // Final minute: SS.S
    if (!past && t < 60000) {
      return (t / 1000).toFixed(1) + 's';
    }

    const totalSeconds = Math.floor(t / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    const pad = (n) => String(n).padStart(2, '0');

    let out;
    if (days > 0) {
      out = days + 'd ' + pad(hours) + ':' + pad(mins) + ':' + pad(secs);
    } else if (hours > 0) {
      out = hours + ':' + pad(mins) + ':' + pad(secs);
    } else {
      out = pad(mins) + ':' + pad(secs);
    }

    return past ? '+' + out : out;
  }

  /**
   * Very short form for the toolbar badge — Chrome shows roughly 4 characters.
   * @param {number} ms
   * @returns {string}
   */
  function formatBadge(ms) {
    if (ms <= 0) return 'NOW';

    const totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds >= 86400) return Math.floor(totalSeconds / 86400) + 'd';
    if (totalSeconds >= 3600) return Math.floor(totalSeconds / 3600) + 'h';
    if (totalSeconds >= 60) return Math.floor(totalSeconds / 60) + 'm';
    return totalSeconds + 's';
  }

  root.DT_TZ = {
    zoneOffsetMs: zoneOffsetMs,
    wallClockToEpoch: wallClockToEpoch,
    isValidZone: isValidZone,
    localZone: localZone,
    allZones: allZones,
    formatInZone: formatInZone,
    formatRemaining: formatRemaining,
    formatBadge: formatBadge
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);

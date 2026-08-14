/*
 * content/clock.js — server time sync.
 *
 * The whole extension counts down against the *server's* clock, never the
 * local one. We learn the server clock from the `Date` response header on a
 * single same-origin HEAD request.
 *
 * Accuracy, honestly
 * ------------------
 * The HTTP `Date` header has one-second resolution. That is a hard floor on
 * how well this can ever work — no amount of sampling gets you sub-second
 * truth out of a second-granular signal. Two things make it as good as it can
 * be:
 *
 *   1. Round-trip correction. We compare the server time against the midpoint
 *      of the request, not its start, which removes the latency bias.
 *   2. Truncation correction. Servers *floor* their clock into the header, so
 *      a header reading 10:00:00 means "somewhere in [10:00:00, 10:00:01)".
 *      The expected value is half a second later than the literal reading, so
 *      we add 500ms rather than sitting systematically half a second early.
 *
 * Realistically expect the offset to be good to roughly ±0.5s. The overlay
 * shows the live offset and the sample spread so you can see for yourself
 * whether the sync is behaving.
 *
 * Rate limiting
 * -------------
 * One HEAD per 60s, to the origin root, no cookies. The median is taken over a
 * ROLLING window of the last 5 samples, so we get jitter smoothing without
 * ever bursting 5 requests at the site.
 */
(function (root) {
  'use strict';

  const SAMPLE_WINDOW = 5; // median-of-5, rolling
  const SYNC_INTERVAL_MS = 60 * 1000;
  const MIN_GAP_MS = 5 * 1000; // hard floor between any two requests
  const TRUNCATION_BIAS_MS = 500; // see "Truncation correction" above
  const MAX_PLAUSIBLE_RTT_MS = 5000; // discard samples slower than this

  class ServerClock {
    constructor(origin) {
      this.origin = origin;

      /** @type {Array<{offset:number, rtt:number, at:number}>} newest last */
      this.samples = [];

      this.offsetMs = 0; // server - local, from the rolling median
      this.lastSyncAt = 0; // local ms of the last *successful* sample
      this.lastAttemptAt = 0; // local ms of the last attempt, success or not
      this.lastError = null; // string, shown in the overlay when sync is broken
      this.synced = false; // have we ever got a usable sample?

      this._timer = null;
      this._inFlight = false;
      this._listeners = [];
    }

    /** Server-corrected current time. Everything in the extension uses this. */
    now() {
      return Date.now() + this.offsetMs;
    }

    /** Spread of the current window, in ms — a rough confidence indicator. */
    spreadMs() {
      if (this.samples.length < 2) return 0;
      const offsets = this.samples.map((s) => s.offset);
      return Math.max(...offsets) - Math.min(...offsets);
    }

    sampleCount() {
      return this.samples.length;
    }

    /** Subscribe to sync state changes (the overlay redraws its status line). */
    onChange(fn) {
      this._listeners.push(fn);
    }

    _emit() {
      for (const fn of this._listeners) {
        try {
          fn(this);
        } catch (err) {
          console.warn('[Drop Timer] clock listener failed', err);
        }
      }
    }

    /**
     * Take one sample.
     *
     * @param {boolean} force bypass the 60s cadence (used for the T-90s
     *        re-sync). Still obeys MIN_GAP_MS so it can't double-fire.
     */
    async sync(force) {
      const now = Date.now();
      const gap = now - this.lastAttemptAt;

      if (this._inFlight) return;
      if (gap < MIN_GAP_MS) return;
      if (!force && this.lastAttemptAt && gap < SYNC_INTERVAL_MS - 1000) return;

      this._inFlight = true;
      this.lastAttemptAt = now;

      try {
        // performance.now() is monotonic, so a system clock adjustment
        // mid-request can't corrupt the round-trip measurement.
        const startPerf = performance.now();
        const startWall = Date.now();

        const res = await fetch(this.origin + '/', {
          method: 'HEAD',
          cache: 'no-store',
          credentials: 'omit', // never touch your session
          mode: 'same-origin',
          redirect: 'follow'
        });

        const rtt = performance.now() - startPerf;
        const dateHeader = res.headers.get('Date');

        if (!dateHeader) {
          throw new Error('no Date header on the response');
        }

        const serverMs = Date.parse(dateHeader);
        if (!Number.isFinite(serverMs)) {
          throw new Error('unparseable Date header: ' + dateHeader);
        }

        if (rtt > MAX_PLAUSIBLE_RTT_MS) {
          throw new Error('round trip too slow (' + Math.round(rtt) + 'ms)');
        }

        // The response was generated somewhere inside the round trip; the
        // midpoint is the best single guess.
        const localMidpoint = startWall + rtt / 2;
        const offset = serverMs + TRUNCATION_BIAS_MS - localMidpoint;

        this.samples.push({ offset: offset, rtt: rtt, at: Date.now() });
        if (this.samples.length > SAMPLE_WINDOW) {
          this.samples.shift(); // rolling window: oldest out
        }

        this.offsetMs = median(this.samples.map((s) => s.offset));
        this.lastSyncAt = Date.now();
        this.lastError = null;
        this.synced = true;
      } catch (err) {
        // A failed sample changes nothing — we keep counting down on the last
        // good offset rather than falling back to the raw local clock.
        this.lastError = err && err.message ? err.message : String(err);
        console.warn('[Drop Timer] time sync failed:', this.lastError);
      } finally {
        this._inFlight = false;
        this._emit();
      }
    }

    /** Sample immediately, then every 60s. */
    start() {
      this.sync(true);
      this.stop();
      this._timer = setInterval(() => this.sync(false), SYNC_INTERVAL_MS);
    }

    stop() {
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
    }

    /** Age of the newest sample, in seconds. */
    ageSeconds() {
      if (!this.lastSyncAt) return null;
      return (Date.now() - this.lastSyncAt) / 1000;
    }

    /**
     * One-line status for the overlay, e.g.
     *   "server +0.42s · 5 samples · ±0.18s · 12s ago"
     */
    statusText() {
      if (!this.synced) {
        return this.lastError ? 'sync failed: ' + this.lastError : 'syncing…';
      }

      const sign = this.offsetMs >= 0 ? '+' : '−';
      const secs = (Math.abs(this.offsetMs) / 1000).toFixed(2);
      const age = this.ageSeconds();

      let text =
        'server ' +
        sign +
        secs +
        's · ' +
        this.samples.length +
        (this.samples.length === 1 ? ' sample' : ' samples');

      if (this.samples.length > 1) {
        text += ' · ±' + (this.spreadMs() / 2000).toFixed(2) + 's';
      }
      if (age !== null) {
        text += ' · ' + Math.round(age) + 's ago';
      }
      if (this.lastError) {
        text += ' · last try failed';
      }

      return text;
    }
  }

  /** Median of a numeric array. Even lengths average the two middle values. */
  function median(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  root.DT_Clock = { ServerClock: ServerClock, median: median };
})(typeof globalThis !== 'undefined' ? globalThis : self);

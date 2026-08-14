/*
 * content/content.js — the orchestrator.
 *
 * Loads last (see CONTENT_FILES in the service worker). Owns the tick loop and
 * decides when each milestone fires; every other content file is a dumb
 * component it drives.
 *
 * Everything here is read-only with respect to the retailer, with two
 * exceptions, both of them explicitly asked for:
 *   - one HEAD request per minute to the origin root, for the clock
 *   - at T-0, scroll/outline/focus on the buy button
 *
 * There is no click, no synthetic event, no form submission, and no other
 * network request anywhere in this extension.
 */
(function (root) {
  'use strict';

  // Chrome can inject a registered content script more than once (e.g. after
  // a soft navigation in some SPAs). Guard so we never run two tick loops.
  if (root.__dropTimerLoaded) return;
  root.__dropTimerLoaded = true;

  const FAST_TICK_MS = 50; // inside the final minute — drives 0.1s precision
  const SLOW_TICK_MS = 200;
  const FAST_TICK_BELOW_MS = 65 * 1000;

  const GREEN_HOLD_MS = 6000; // how long the clock stays green after T-0
  const OVERLAY_GRACE_MS = 10 * 60 * 1000; // keep showing a drop this long past T-0

  // Crossed-downwards triggers. `at` is ms remaining.
  const MILESTONES = [
    { id: 'preflight', at: 5 * 60 * 1000 },
    { id: 'resync', at: 90 * 1000 },
    { id: 'cue60', at: 60 * 1000 },
    { id: 'cue10', at: 10 * 1000 },
    { id: 'zero', at: 0 }
  ];

  const state = {
    drop: null,
    epoch: 0,
    clock: null,
    cues: null,
    checklist: null,
    overlay: null,
    focus: null,
    settings: null,
    fired: new Set(),
    prevRemaining: null,
    tickTimer: null,
    wakeLock: null,
    focusRetry: null,
    closed: false
  };

  // ------------------------------------------------------------------ boot

  async function boot() {
    let drops;
    let settings;
    try {
      drops = await DT_Store.getDrops();
      settings = await DT_Store.getSettings();
    } catch (err) {
      console.warn('[Drop Timer] could not read config', err);
      return;
    }

    const match = DT_Store.dropForPage(drops, location.href, Date.now(), OVERLAY_GRACE_MS);
    if (!match) {
      // Right site, but no drop scheduled here (or it's long past). Stay quiet.
      return;
    }

    state.drop = match.drop;
    state.epoch = match.epoch;
    state.settings = settings;

    state.clock = new DT_Clock.ServerClock(location.origin);
    state.cues = new DT_Audio.Cues(settings);
    state.focus = new DT_Focus.FocusAssist(state.drop.buySelector);

    const manual = await DT_Store.getManualChecks(state.drop.id);
    state.checklist = new DT_Checklist.Checklist(state.drop, manual);

    state.overlay = new DT_Overlay.Overlay({
      drop: state.drop,
      epoch: state.epoch,
      clock: state.clock,
      cues: state.cues,
      checklist: state.checklist,
      onManualToggle: handleManualToggle,
      onSettingsChange: handleSettingsChange,
      onClose: teardown
    });

    await state.overlay.mount();
    state.overlay.setAwake(!!settings.keepAwake);

    state.clock.onChange(() => state.overlay && state.overlay.renderSync());
    state.checklist.onChange(() => state.overlay && state.overlay.renderChecklist());
    state.cues.onChange(() => state.overlay && state.overlay.renderAudio());

    state.clock.start();
    state.checklist.start();

    if (settings.keepAwake) requestWakeLock();

    tick();

    console.info(
      '[Drop Timer] armed for "%s" at %s',
      state.drop.label || state.drop.url,
      DT_TZ.formatInZone(state.epoch, state.drop.timeZone)
    );
  }

  // ------------------------------------------------------------ tick loop

  function tick() {
    if (state.closed) return;

    const remaining = state.epoch - state.clock.now();
    const visual = colourState(remaining);

    state.overlay.update(remaining, visual);
    state.overlay.renderSync();

    // Fire anything we just crossed. On the very first tick prevRemaining is
    // null, so a page opened at T-30s doesn't retroactively blast every cue.
    if (state.prevRemaining !== null) {
      for (const milestone of MILESTONES) {
        if (state.prevRemaining > milestone.at && remaining <= milestone.at) {
          fire(milestone.id, remaining);
        }
      }
    }
    state.prevRemaining = remaining;

    const delay = remaining < FAST_TICK_BELOW_MS && remaining > -GREEN_HOLD_MS ? FAST_TICK_MS : SLOW_TICK_MS;
    state.tickTimer = setTimeout(tick, delay);
  }

  /** @returns {'neutral'|'amber'|'red'|'green'|'past'} */
  function colourState(remaining) {
    if (remaining <= 0) {
      return remaining > -GREEN_HOLD_MS ? 'green' : 'past';
    }
    if (remaining < 60 * 1000) return 'red';
    if (remaining <= 5 * 60 * 1000) return 'amber';
    return 'neutral';
  }

  // ----------------------------------------------------------- milestones

  function fire(id, remaining) {
    if (state.fired.has(id)) return;
    state.fired.add(id);

    switch (id) {
      case 'preflight':
        // T-5min: everything should be green by now.
        checkPreflight(
          'T-5 minutes and not ready — ',
          'warn',
          /* audible */ true
        );
        break;

      case 'resync':
        // T-90s: one extra sample so the final minute runs on fresh data.
        state.clock.sync(true);
        break;

      case 'cue60':
        state.cues.play('t60');
        // The checklist is supposed to be green before the final minute. If it
        // isn't, say so loudly rather than letting it slide.
        checkPreflight('Final minute and still not ready — ', 'danger', false);
        break;

      case 'cue10':
        state.cues.play('t10');
        break;

      case 'zero':
        state.cues.play('zero');
        state.overlay.flash();
        engageFocus();
        break;
    }
  }

  /**
   * Highlight outstanding checklist items, optionally with the warning tone.
   * Clears the banner if everything is green.
   */
  function checkPreflight(prefix, tone, audible) {
    const gaps = state.checklist.gaps();

    if (gaps.length === 0) {
      state.overlay.flagGaps([], '', tone);
      return;
    }

    if (audible) state.cues.play('warning');

    state.overlay.flagGaps(
      gaps.map((g) => g.id),
      prefix + gaps.map((g) => g.label).join(', '),
      tone
    );
  }

  /**
   * T-0: put the buy button under the cursor and under keyboard focus.
   *
   * If the selector doesn't resolve yet (lazy-rendered buttons are common on
   * drop pages — the button often only appears when stock flips live) we keep
   * retrying for a while rather than giving up on the one moment that matters.
   */
  function engageFocus() {
    const attempt = () => {
      const result = state.focus.engage();

      if (result.ok && !result.error) {
        state.overlay.flagGaps([], '', 'warn');
        stopFocusRetry();
        return true;
      }

      state.overlay.flagGaps(
        [],
        'Buy button: ' + (result.error || 'not focusable') + ' — retrying…',
        'danger'
      );
      return false;
    };

    if (attempt()) return;

    const startedAt = Date.now();
    state.focusRetry = setInterval(() => {
      if (attempt() || Date.now() - startedAt > 30000) {
        stopFocusRetry();
      }
    }, 400);
  }

  function stopFocusRetry() {
    if (state.focusRetry) {
      clearInterval(state.focusRetry);
      state.focusRetry = null;
    }
  }

  // -------------------------------------------------------------- handlers

  async function handleManualToggle(id, value) {
    state.checklist.setManual(id, value);
    try {
      await DT_Store.setManualChecks(state.drop.id, { [id]: value });
    } catch (err) {
      console.warn('[Drop Timer] could not persist manual check', err);
    }
  }

  async function handleSettingsChange(patch) {
    try {
      state.settings = await DT_Store.setSettings(patch);
    } catch (err) {
      console.warn('[Drop Timer] could not persist settings', err);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'keepAwake')) {
      state.overlay.setAwake(state.settings.keepAwake);
      if (state.settings.keepAwake) requestWakeLock();
      else releaseWakeLock();
    }
  }

  /**
   * Optional screen wake lock.
   *
   * This matters more than it looks: Chrome heavily throttles timers in
   * backgrounded tabs, and a sleeping machine has no timers at all. For a 3am
   * drop, keeping the display awake with this tab in front is the difference
   * between a countdown and a surprise.
   *
   * navigator.wakeLock is a page API — it needs no extension permission.
   */
  async function requestWakeLock() {
    if (!navigator.wakeLock || state.wakeLock) return;
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => {
        state.wakeLock = null;
      });
    } catch (err) {
      // Denied when the document isn't visible; we retry on visibilitychange.
      console.info('[Drop Timer] wake lock unavailable right now:', err.message);
    }
  }

  function releaseWakeLock() {
    if (!state.wakeLock) return;
    state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.settings && state.settings.keepAwake) {
      requestWakeLock();
    }
  });

  // Live-apply volume/mute changes made from the popup while a page is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.settings || !state.cues) return;

    const next = Object.assign({}, DT_Store.DEFAULT_SETTINGS, changes.settings.newValue || {});
    state.settings = next;
    state.cues.setVolume(next.volume);
    state.cues.setMuted(next.muted);

    if (state.overlay) {
      state.overlay.renderAudio();
      state.overlay.setAwake(next.keepAwake);
    }
    if (next.keepAwake) requestWakeLock();
    else releaseWakeLock();
  });

  function teardown() {
    state.closed = true;
    clearTimeout(state.tickTimer);
    stopFocusRetry();
    if (state.clock) state.clock.stop();
    if (state.checklist) state.checklist.stop();
    if (state.focus) state.focus.release();
    if (state.overlay) state.overlay.destroy();
    releaseWakeLock();
  }

  boot();
})(typeof globalThis !== 'undefined' ? globalThis : self);

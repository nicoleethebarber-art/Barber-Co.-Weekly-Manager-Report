/*
 * content/overlay.js — the on-page countdown panel.
 *
 * Lives entirely inside a shadow root attached to a single <div> appended to
 * <body>. Nothing the retailer's CSS does can reach inside it, and nothing we
 * style can leak out onto their page.
 *
 * It renders; it does not decide. All timing/cue logic lives in content.js,
 * which calls update() on every tick.
 */
(function (root) {
  'use strict';

  const HOST_ID = 'drop-timer-overlay-root';
  const POS_KEY = 'overlayPos';

  class Overlay {
    /**
     * @param {object} opts
     * @param {object} opts.drop
     * @param {number} opts.epoch      drop time, epoch ms
     * @param {object} opts.clock      DT_Clock.ServerClock
     * @param {object} opts.cues       DT_Audio.Cues
     * @param {object} opts.checklist  DT_Checklist.Checklist
     * @param {Function} opts.onManualToggle (id, value)
     * @param {Function} opts.onSettingsChange (patch)
     * @param {Function} opts.onClose
     */
    constructor(opts) {
      this.drop = opts.drop;
      this.epoch = opts.epoch;
      this.clock = opts.clock;
      this.cues = opts.cues;
      this.checklist = opts.checklist;
      this.onManualToggle = opts.onManualToggle || function () {};
      this.onSettingsChange = opts.onSettingsChange || function () {};
      this.onClose = opts.onClose || function () {};

      this.host = null;
      this.shadow = null;
      this.nodes = {};
      this.minimised = false;
      this.gapIds = new Set();
      this._drag = null;
      this._lastChecksSignature = '';
    }

    // ------------------------------------------------------------- mount

    async mount() {
      // Never stack two overlays if the content script somehow runs twice.
      const existing = document.getElementById(HOST_ID);
      if (existing) existing.remove();

      this.host = document.createElement('div');
      this.host.id = HOST_ID;
      this.shadow = this.host.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent = root.DT_STYLES;
      this.shadow.appendChild(style);

      this.shadow.appendChild(this._build());
      (document.body || document.documentElement).appendChild(this.host);

      await this._restorePosition();
      this._wireDrag();
      this._wireUnlockOnInteraction();

      this.renderChecklist();
      this.renderSync();
      this.renderAudio();
      this.renderWhen();
    }

    _build() {
      const panel = el('div', { class: 'panel' });
      this.nodes.panel = panel;

      // --- header -------------------------------------------------------
      const head = el('div', { class: 'head' });
      this.nodes.dot = el('div', { class: 'dot' });
      this.nodes.title = el('div', {
        class: 'title',
        text: this.drop.label || hostnameOf(this.drop.url) || 'Drop'
      });

      const minBtn = el('button', { title: 'Minimise', text: '–', type: 'button' });
      minBtn.addEventListener('click', () => this.toggleMinimise());

      const closeBtn = el('button', { title: 'Hide until reload', text: '×', type: 'button' });
      closeBtn.addEventListener('click', () => this.onClose());

      head.append(this.nodes.dot, this.nodes.title, minBtn, closeBtn);

      // --- minimised readout --------------------------------------------
      this.nodes.mini = el('div', { class: 'mini', text: '—' });

      // --- body ---------------------------------------------------------
      const body = el('div', { class: 'body' });

      this.nodes.clock = el('div', { class: 'clock neutral', text: '—' });
      this.nodes.when = el('div', { class: 'when', text: '' });
      this.nodes.sync = el('div', { class: 'sync', text: 'syncing…' });

      const sectionLabel = el('div', { class: 'section-label' });
      sectionLabel.append(
        el('span', { text: 'Pre-flight' }),
        (this.nodes.readyState = el('span', { class: 'notready', text: 'NOT READY' }))
      );

      this.nodes.checks = el('ul', { class: 'checks' });

      // --- audio row ----------------------------------------------------
      const audio = el('div', { class: 'audio' });

      this.nodes.muteBtn = el('button', { type: 'button', text: '🔊 On', title: 'Mute / unmute cues' });
      this.nodes.muteBtn.addEventListener('click', async () => {
        await this.cues.unlock();
        const next = !this.cues.muted;
        this.cues.setMuted(next);
        this.onSettingsChange({ muted: next });
        this.renderAudio();
      });

      this.nodes.vol = el('input', {
        type: 'range',
        min: '0',
        max: '100',
        step: '1',
        title: 'Cue volume'
      });
      this.nodes.vol.value = String(Math.round(this.cues.volume * 100));
      this.nodes.vol.addEventListener('input', () => {
        this.cues.setVolume(Number(this.nodes.vol.value) / 100);
        this.renderAudio();
      });
      // Only persist when you let go, not on every pixel of drag.
      this.nodes.vol.addEventListener('change', () => {
        this.onSettingsChange({ volume: Number(this.nodes.vol.value) / 100 });
      });

      this.nodes.volLabel = el('span', { class: 'vol-label', text: '85%' });

      const testBtn = el('button', { type: 'button', text: 'Test', title: 'Play the T-0 cue' });
      testBtn.addEventListener('click', async () => {
        await this.cues.unlock();
        this.cues.test();
        this.renderAudio();
      });

      this.nodes.awakeBtn = el('button', {
        type: 'button',
        text: 'Awake',
        title: 'Hold a screen wake lock so the machine does not sleep before the drop'
      });
      this.nodes.awakeBtn.addEventListener('click', () => {
        this.onSettingsChange({ keepAwake: !this.nodes.awakeBtn.classList.contains('on') });
      });

      audio.append(this.nodes.muteBtn, this.nodes.vol, this.nodes.volLabel, testBtn, this.nodes.awakeBtn);

      // --- banners ------------------------------------------------------
      this.nodes.audioBanner = el('div', { class: 'banner danger' });
      const unlockBtn = el('button', { type: 'button', text: 'Enable sound' });
      unlockBtn.addEventListener('click', async () => {
        const ok = await this.cues.unlock();
        if (ok) this.cues.play('t60');
        this.renderAudio();
      });
      this.nodes.audioBanner.append(
        document.createTextNode('Sound is blocked by the browser until you interact with this page. '),
        unlockBtn
      );

      this.nodes.gapBanner = el('div', { class: 'banner warn' });

      const foot = el('div', {
        class: 'foot',
        text: 'Preparation aid only — it never clicks or submits for you.'
      });

      body.append(
        this.nodes.clock,
        this.nodes.when,
        this.nodes.sync,
        sectionLabel,
        this.nodes.checks,
        audio,
        this.nodes.audioBanner,
        this.nodes.gapBanner,
        foot
      );

      panel.append(head, this.nodes.mini, body);
      return panel;
    }

    // ------------------------------------------------------------ render

    /**
     * Called on every tick by content.js.
     * @param {number} remainingMs server-corrected ms until the drop
     * @param {'neutral'|'amber'|'red'|'green'|'past'} state
     */
    update(remainingMs, state) {
      const text = DT_TZ.formatRemaining(remainingMs);

      if (this.nodes.clock.textContent !== text) {
        this.nodes.clock.textContent = text;
        this.nodes.mini.textContent = text;
      }

      this.nodes.clock.className = 'clock ' + state;
      this.nodes.mini.className = 'mini ' + state;
      this.nodes.dot.style.background = DOT_COLOURS[state] || '#6b7688';
    }

    renderWhen() {
      this.nodes.when.textContent = DT_TZ.formatInZone(this.epoch, this.drop.timeZone);
    }

    renderSync() {
      const clock = this.clock;
      this.nodes.sync.textContent = clock.statusText();
      this.nodes.sync.classList.toggle('bad', !clock.synced || !!clock.lastError);
    }

    renderAudio() {
      const cues = this.cues;

      this.nodes.muteBtn.textContent = cues.muted ? '🔇 Muted' : '🔊 On';
      this.nodes.muteBtn.classList.toggle('on', cues.muted);
      this.nodes.volLabel.textContent = Math.round(cues.volume * 100) + '%';

      if (document.activeElement !== this.host) {
        this.nodes.vol.value = String(Math.round(cues.volume * 100));
      }

      this.nodes.audioBanner.classList.toggle('show', cues.isBlocked() && !cues.muted);
    }

    setAwake(on) {
      this.nodes.awakeBtn.classList.toggle('on', !!on);
    }

    renderChecklist() {
      const items = this.checklist.items;

      // Cheap change detection so the 1s poll doesn't rebuild the DOM forever.
      const signature = items.map((i) => i.id + ':' + i.ok + ':' + i.detail).join('|');
      if (signature === this._lastChecksSignature) return;
      this._lastChecksSignature = signature;

      this.nodes.checks.textContent = '';

      for (const item of items) {
        const li = el('li', {
          class:
            'check' +
            (item.ok ? ' ok' : '') +
            (item.kind === 'manual' ? ' manual' : '') +
            (this.gapIds.has(item.id) ? ' gap-flag' : '')
        });

        li.append(
          el('span', { class: 'mark', text: item.ok ? '✓' : '' }),
          (() => {
            const wrap = el('span', { class: 'check-text' });
            wrap.append(
              el('div', { class: 'check-label', text: item.label }),
              el('div', { class: 'check-detail', text: item.detail })
            );
            return wrap;
          })(),
          el('span', { class: 'tag', text: item.kind === 'manual' ? 'manual' : 'auto' })
        );

        if (item.kind === 'manual') {
          li.setAttribute('role', 'checkbox');
          li.setAttribute('tabindex', '0');
          li.setAttribute('aria-checked', String(item.ok));
          const toggle = () => this.onManualToggle(item.id, !item.ok);
          li.addEventListener('click', toggle);
          li.addEventListener('keydown', (e) => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              toggle();
            }
          });
        }

        this.nodes.checks.appendChild(li);
      }

      const green = this.checklist.allGreen();
      this.nodes.readyState.textContent = green ? 'READY' : 'NOT READY';
      this.nodes.readyState.className = green ? 'ready' : 'notready';
    }

    /**
     * Highlight the outstanding items — used by the T-5min warning and the
     * final-minute "not ready" state.
     * @param {string[]} ids
     * @param {string} message banner text ('' clears the banner)
     * @param {'warn'|'danger'} tone
     */
    flagGaps(ids, message, tone) {
      this.gapIds = new Set(ids || []);
      this._lastChecksSignature = ''; // force a rebuild so classes apply
      this.renderChecklist();

      const banner = this.nodes.gapBanner;
      banner.className = 'banner ' + (tone || 'warn') + (message ? ' show' : '');
      banner.textContent = message || '';
    }

    /** Green flash at T-0. */
    flash() {
      this.nodes.panel.classList.remove('flash');
      // Force a reflow so the animation restarts if it's already running.
      void this.nodes.panel.offsetWidth;
      this.nodes.panel.classList.add('flash');
      setTimeout(() => this.nodes.panel.classList.remove('flash'), 2000);
    }

    toggleMinimise() {
      this.minimised = !this.minimised;
      this.nodes.panel.classList.toggle('min', this.minimised);
    }

    destroy() {
      if (this.host) this.host.remove();
      this.host = null;
    }

    // -------------------------------------------------------------- drag

    _wireDrag() {
      const head = this.shadow.querySelector('.head');

      head.addEventListener('pointerdown', (e) => {
        // Ignore the minimise/close buttons.
        if (e.target.closest('button')) return;

        const rect = this.host.getBoundingClientRect();
        this._drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };

        // Switch from the right-anchored default to explicit left/top.
        this.host.style.left = rect.left + 'px';
        this.host.style.top = rect.top + 'px';
        this.host.style.right = 'auto';

        head.setPointerCapture(e.pointerId);
        e.preventDefault();
      });

      head.addEventListener('pointermove', (e) => {
        if (!this._drag) return;

        const width = this.host.offsetWidth;
        const height = this.host.offsetHeight;

        // Keep at least a sliver on screen so it can't be dragged into oblivion.
        const x = clamp(e.clientX - this._drag.dx, 8 - width + 60, window.innerWidth - 60);
        const y = clamp(e.clientY - this._drag.dy, 0, window.innerHeight - 30);

        this.host.style.left = x + 'px';
        this.host.style.top = y + 'px';
      });

      const end = (e) => {
        if (!this._drag) return;
        this._drag = null;
        try {
          head.releasePointerCapture(e.pointerId);
        } catch (err) {
          /* already released */
        }
        this._savePosition();
      };

      head.addEventListener('pointerup', end);
      head.addEventListener('pointercancel', end);
    }

    async _savePosition() {
      const rect = this.host.getBoundingClientRect();
      try {
        await chrome.storage.local.set({ [POS_KEY]: { x: rect.left, y: rect.top } });
      } catch (err) {
        /* position is a nicety, not worth surfacing */
      }
    }

    async _restorePosition() {
      try {
        const got = await chrome.storage.local.get(POS_KEY);
        const pos = got[POS_KEY];
        if (!pos) return;

        // Re-clamp in case the window is smaller than it was last time.
        const width = this.host.offsetWidth || 320;
        this.host.style.left = clamp(pos.x, 0, Math.max(0, window.innerWidth - width)) + 'px';
        this.host.style.top = clamp(pos.y, 0, Math.max(0, window.innerHeight - 60)) + 'px';
        this.host.style.right = 'auto';
      } catch (err) {
        /* fall back to the default top-right position */
      }
    }

    /**
     * The browser will not let us make a sound until the page has been
     * interacted with. Listen once for any interaction anywhere and use it to
     * unlock the AudioContext, so by the time T-60s arrives we're ready.
     */
    _wireUnlockOnInteraction() {
      const handler = async () => {
        await this.cues.unlock();
        this.renderAudio();
      };

      const opts = { once: true, capture: true, passive: true };
      document.addEventListener('pointerdown', handler, opts);
      document.addEventListener('keydown', handler, opts);
      this.shadow.addEventListener('pointerdown', handler, { once: true, passive: true });
    }
  }

  const DOT_COLOURS = {
    neutral: '#6b7688',
    amber: '#ffb020',
    red: '#ff5a52',
    green: '#2ee88a',
    past: '#4a5468'
  };

  /** Tiny element helper — avoids innerHTML entirely. */
  function el(tag, props) {
    const node = document.createElement(tag);
    if (!props) return node;
    for (const [key, value] of Object.entries(props)) {
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else node.setAttribute(key, value);
    }
    return node;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function hostnameOf(url) {
    try {
      return new URL(url).hostname;
    } catch (err) {
      return '';
    }
  }

  root.DT_Overlay = { Overlay: Overlay, HOST_ID: HOST_ID };
})(typeof globalThis !== 'undefined' ? globalThis : self);

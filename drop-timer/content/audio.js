/*
 * content/audio.js — audible cues.
 *
 * Tones are synthesised with WebAudio rather than shipped as audio files, so
 * there's nothing to decode, nothing to preload, no binary assets in the repo,
 * and you can retune any cue by editing a number below.
 *
 * Getting it loud enough for a 3am drop:
 *   - square waves, which are far louder per unit gain than sine waves
 *   - two slightly detuned oscillators per beep, which beat against each other
 *     and read as harsher/more attention-grabbing
 *   - a compressor on the master bus, so we can push the level up without the
 *     peaks clipping into crackle
 *   - frequencies in the 800–2000Hz band, where human hearing is most sensitive
 *
 * The real ceiling is your system volume. The README says so too.
 *
 * Autoplay policy: a page that has never been interacted with cannot start an
 * AudioContext. We detect that and the overlay shows an "enable sound" prompt,
 * because silently failing at T-60s is the worst possible outcome here.
 */
(function (root) {
  'use strict';

  // Each cue is a list of beeps: when to start (seconds from cue start), how
  // long, what pitch. Edit freely.
  const PATTERNS = {
    // T-60s — one clear note. "Heads up."
    t60: [{ at: 0.0, dur: 0.45, freq: 880, type: 'square', peak: 0.8 }],

    // T-10s — three rising notes. "Hands on."
    t10: [
      { at: 0.0, dur: 0.16, freq: 988, type: 'square', peak: 0.9 },
      { at: 0.24, dur: 0.16, freq: 1175, type: 'square', peak: 0.9 },
      { at: 0.48, dur: 0.3, freq: 1397, type: 'square', peak: 1.0 }
    ],

    // T-0 — deliberately unlike the others: a two-tone alarm that repeats.
    zero: [
      { at: 0.0, dur: 0.18, freq: 1568, type: 'square', peak: 1.0 },
      { at: 0.2, dur: 0.18, freq: 1047, type: 'square', peak: 1.0 },
      { at: 0.4, dur: 0.18, freq: 1568, type: 'square', peak: 1.0 },
      { at: 0.6, dur: 0.18, freq: 1047, type: 'square', peak: 1.0 },
      { at: 0.8, dur: 0.5, freq: 1568, type: 'square', peak: 1.0 }
    ],

    // Checklist not green at T-5min — low and buzzy, reads as "problem" rather
    // than "go".
    warning: [
      { at: 0.0, dur: 0.35, freq: 233, type: 'sawtooth', peak: 0.9 },
      { at: 0.45, dur: 0.35, freq: 233, type: 'sawtooth', peak: 0.9 },
      { at: 0.9, dur: 0.5, freq: 185, type: 'sawtooth', peak: 0.9 }
    ]
  };

  const DETUNE_CENTS = 11; // second oscillator, for a rougher/louder timbre

  class Cues {
    constructor(settings) {
      this.volume = clamp01(settings && settings.volume, 0.85);
      this.muted = !!(settings && settings.muted);

      this.ctx = null;
      this.master = null;
      this.blocked = false; // autoplay policy is holding us back
      this._listeners = [];
    }

    onChange(fn) {
      this._listeners.push(fn);
    }

    _emit() {
      for (const fn of this._listeners) {
        try {
          fn(this);
        } catch (err) {
          console.warn('[Drop Timer] audio listener failed', err);
        }
      }
    }

    /** Lazily build the audio graph: master gain -> compressor -> speakers. */
    _ensureContext() {
      if (this.ctx) return this.ctx;

      const Ctor = root.AudioContext || root.webkitAudioContext;
      if (!Ctor) {
        this.blocked = true;
        return null;
      }

      this.ctx = new Ctor();

      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;

      // Squashes peaks so we can run the master hot without clipping.
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 12;
      comp.ratio.value = 8;
      comp.attack.value = 0.002;
      comp.release.value = 0.15;

      this.master.connect(comp);
      comp.connect(this.ctx.destination);

      return this.ctx;
    }

    /**
     * True when the browser is refusing to make sound until the page gets a
     * user gesture. The overlay surfaces this rather than hiding it.
     */
    isBlocked() {
      return this.blocked || (this.ctx && this.ctx.state === 'suspended');
    }

    /**
     * Call from a click/keydown handler to satisfy the autoplay policy.
     * Safe to call repeatedly.
     */
    async unlock() {
      const ctx = this._ensureContext();
      if (!ctx) return false;

      if (ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch (err) {
          this.blocked = true;
          this._emit();
          return false;
        }
      }

      this.blocked = ctx.state !== 'running';
      this._emit();
      return !this.blocked;
    }

    setVolume(v) {
      this.volume = clamp01(v, this.volume);
      if (this.master) {
        this.master.gain.value = this.muted ? 0 : this.volume;
      }
      this._emit();
    }

    setMuted(m) {
      this.muted = !!m;
      if (this.master) {
        this.master.gain.value = this.muted ? 0 : this.volume;
      }
      this._emit();
    }

    /**
     * Play a named cue. Honours mute. Never throws — a broken speaker must not
     * take the countdown down with it.
     *
     * @param {'t60'|'t10'|'zero'|'warning'} name
     * @param {{repeat?: number, gap?: number}} [opts] repeat the whole pattern
     */
    play(name, opts) {
      if (this.muted) return;

      const pattern = PATTERNS[name];
      if (!pattern) return;

      const ctx = this._ensureContext();
      if (!ctx) return;

      if (ctx.state === 'suspended') {
        // Try to wake it, but don't wait — if the policy blocks us the overlay
        // is already showing the "enable sound" prompt.
        ctx.resume().catch(() => {});
        this.blocked = true;
        this._emit();
        return;
      }

      const repeat = (opts && opts.repeat) || 1;
      const gap = (opts && opts.gap) || 1.4;
      const base = ctx.currentTime + 0.02; // tiny lead-in avoids a click

      try {
        for (let r = 0; r < repeat; r++) {
          for (const beep of pattern) {
            this._beep(base + r * gap + beep.at, beep);
          }
        }
      } catch (err) {
        console.warn('[Drop Timer] could not play cue', name, err);
      }
    }

    /** One beep: two detuned oscillators through a short AD envelope. */
    _beep(startTime, spec) {
      const ctx = this.ctx;

      const env = ctx.createGain();
      env.connect(this.master);

      const peak = typeof spec.peak === 'number' ? spec.peak : 0.9;
      const attack = 0.006;
      const release = 0.05;
      const end = startTime + spec.dur;

      // Ramp rather than step, or you get an audible click at each edge.
      env.gain.setValueAtTime(0.0001, startTime);
      env.gain.exponentialRampToValueAtTime(peak, startTime + attack);
      env.gain.setValueAtTime(peak, Math.max(startTime + attack, end - release));
      env.gain.exponentialRampToValueAtTime(0.0001, end);

      for (const detune of [0, DETUNE_CENTS]) {
        const osc = ctx.createOscillator();
        osc.type = spec.type || 'square';
        osc.frequency.setValueAtTime(spec.freq, startTime);
        osc.detune.setValueAtTime(detune, startTime);
        osc.connect(env);
        osc.start(startTime);
        osc.stop(end + 0.02);
      }
    }

    /** Used by the overlay's Test button — plays T-0 so you can set volume. */
    test() {
      this.play('zero');
    }
  }

  function clamp01(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(1, Math.max(0, n));
  }

  root.DT_Audio = { Cues: Cues, PATTERNS: PATTERNS };
})(typeof globalThis !== 'undefined' ? globalThis : self);

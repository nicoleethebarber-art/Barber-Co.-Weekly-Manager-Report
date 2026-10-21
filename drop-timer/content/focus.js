/*
 * content/focus.js — T-0 focus assist.
 *
 * At T-0 this does exactly three things to the configured buy button:
 *   1. scrolls it into view
 *   2. draws a high-contrast outline around it
 *   3. calls .focus() so that pressing Enter or Space activates it
 *
 * What it deliberately does NOT do, and what you should keep it from doing if
 * you edit this file:
 *   - el.click()
 *   - el.dispatchEvent(...) of any kind
 *   - form.submit() / form.requestSubmit()
 *   - fetch / XMLHttpRequest / sendBeacon to the retailer
 *
 * The purchase is your keypress or your mouse click. This file only makes sure
 * the target is under your cursor and under keyboard focus at the right moment.
 */
(function (root) {
  'use strict';

  // Elements the browser will focus without help. Anything else gets a
  // temporary tabindex so .focus() actually takes.
  const NATIVELY_FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

  class FocusAssist {
    constructor(selector) {
      this.selector = selector;
      this._target = null;
      this._savedStyle = null;
      this._addedTabIndex = false;
      this._animation = null;
    }

    /**
     * Resolve the buy button.
     * @returns {{el:Element|null, error:string|null, count:number}}
     */
    find() {
      if (!this.selector) {
        return { el: null, error: 'No buy-button selector configured', count: 0 };
      }

      let nodes;
      try {
        nodes = document.querySelectorAll(this.selector);
      } catch (err) {
        return { el: null, error: 'Invalid selector: ' + err.message, count: 0 };
      }

      if (nodes.length === 0) {
        return { el: null, error: 'Nothing matches ' + this.selector, count: 0 };
      }

      // If the selector is ambiguous, prefer the first one that is actually
      // rendered — hidden duplicates (mobile/desktop variants of the same
      // button) are extremely common on retail pages.
      let chosen = null;
      for (const node of nodes) {
        if (isRendered(node)) {
          chosen = node;
          break;
        }
      }

      if (!chosen) {
        return {
          el: nodes[0],
          error: nodes.length + ' matched but none are visible',
          count: nodes.length
        };
      }

      return { el: chosen, error: null, count: nodes.length };
    }

    /**
     * Fire the assist. Idempotent-ish: calling twice just re-highlights.
     * @returns {{ok:boolean, error:string|null}}
     */
    engage() {
      const found = this.find();
      if (!found.el) {
        return { ok: false, error: found.error };
      }

      const el = found.el;
      this._target = el;

      // --- 1. scroll into view -------------------------------------------
      try {
        // 'instant', not 'smooth': at T-0 a half-second scroll animation is a
        // half-second you cannot click.
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      } catch (err) {
        // Older signature fallback.
        try {
          el.scrollIntoView(true);
        } catch (err2) {
          /* not fatal — the outline still tells you where it is */
        }
      }

      // --- 2. high-contrast outline --------------------------------------
      this._applyHighlight(el);

      // --- 3. keyboard focus ---------------------------------------------
      try {
        if (!el.matches(NATIVELY_FOCUSABLE)) {
          // Some "buy buttons" are divs. Give it a programmatic focus target.
          // This is a DOM attribute change, not an activation.
          el.setAttribute('tabindex', '-1');
          this._addedTabIndex = true;
        }
        // preventScroll: we already positioned it exactly where we want it.
        el.focus({ preventScroll: true });
      } catch (err) {
        return { ok: false, error: 'Could not focus the button: ' + err.message };
      }

      const focused = document.activeElement === el;
      return {
        ok: true,
        error: focused ? null : 'Outlined and scrolled, but the page moved focus elsewhere'
      };
    }

    /**
     * Briefly outline the button without focusing it — used by the "Test
     * selector" button so you can confirm you picked the right element well
     * before the drop.
     */
    preview(durationMs) {
      const found = this.find();
      if (!found.el) return { ok: false, error: found.error };

      this._target = found.el;
      try {
        found.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (err) {
        /* ignore */
      }
      this._applyHighlight(found.el);

      setTimeout(() => this.release(), durationMs || 2500);
      return { ok: true, error: null, count: found.count };
    }

    _applyHighlight(el) {
      if (this._savedStyle === null) {
        // Remember the inline values so release() puts the page back exactly
        // as we found it.
        this._savedStyle = {
          outline: el.style.outline,
          outlineOffset: el.style.outlineOffset,
          boxShadow: el.style.boxShadow,
          position: el.style.position,
          zIndex: el.style.zIndex
        };
      }

      el.style.outline = '4px solid #00e5ff';
      el.style.outlineOffset = '3px';
      el.style.boxShadow = '0 0 0 8px rgba(0, 229, 255, 0.35), 0 0 26px 8px rgba(0, 229, 255, 0.6)';

      // Lift it above any sticky header that might be covering it.
      if (getComputedStyle(el).position === 'static') {
        el.style.position = 'relative';
      }
      el.style.zIndex = '2147483000';

      // Pulse via the Web Animations API rather than injecting a @keyframes
      // stylesheet into the page.
      try {
        if (this._animation) this._animation.cancel();
        this._animation = el.animate(
          [
            { boxShadow: '0 0 0 8px rgba(0,229,255,0.35), 0 0 26px 8px rgba(0,229,255,0.60)' },
            { boxShadow: '0 0 0 14px rgba(0,229,255,0.10), 0 0 40px 14px rgba(0,229,255,0.85)' },
            { boxShadow: '0 0 0 8px rgba(0,229,255,0.35), 0 0 26px 8px rgba(0,229,255,0.60)' }
          ],
          { duration: 900, iterations: Infinity }
        );
      } catch (err) {
        /* the static outline is enough */
      }
    }

    /** Put the button back the way we found it. */
    release() {
      const el = this._target;
      if (!el) return;

      if (this._animation) {
        try {
          this._animation.cancel();
        } catch (err) {
          /* ignore */
        }
        this._animation = null;
      }

      if (this._savedStyle) {
        el.style.outline = this._savedStyle.outline;
        el.style.outlineOffset = this._savedStyle.outlineOffset;
        el.style.boxShadow = this._savedStyle.boxShadow;
        el.style.position = this._savedStyle.position;
        el.style.zIndex = this._savedStyle.zIndex;
        this._savedStyle = null;
      }

      if (this._addedTabIndex) {
        el.removeAttribute('tabindex');
        this._addedTabIndex = false;
      }

      this._target = null;
    }
  }

  /** Rendered = has layout. Cheaper and more reliable than reading styles. */
  function isRendered(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  root.DT_Focus = { FocusAssist: FocusAssist };
})(typeof globalThis !== 'undefined' ? globalThis : self);

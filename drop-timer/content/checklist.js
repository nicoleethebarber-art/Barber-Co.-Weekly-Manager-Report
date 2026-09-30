/*
 * content/checklist.js — the pre-flight checklist.
 *
 * Five items. Three are auto-detected from the DOM/URL, two are things no
 * extension can honestly verify (whether your card and address are actually
 * saved on the retailer's account) so they're manual ticks.
 *
 * Auto items re-evaluate on every DOM mutation (debounced) plus a slow poll,
 * because single-page-app product pages swap the variant control out from
 * under you constantly.
 *
 * Note on the "Logged in" check: we test for *existence*, not visibility. A
 * logout link living inside a collapsed account menu is display:none but you
 * are very much logged in, and a visibility test would flap red for no reason.
 */
(function (root) {
  'use strict';

  const POLL_MS = 1000;
  const DEBOUNCE_MS = 200;

  // Class/attribute conventions that retailers use to mark a chosen size.
  // Extend this list if your site does something unusual.
  const SELECTED_MARKERS = [
    '.selected',
    '.is-selected',
    '.active',
    '.is-active',
    '.checked',
    '[aria-checked="true"]',
    '[aria-selected="true"]',
    '[aria-pressed="true"]',
    '[data-selected="true"]',
    '[selected]'
  ].join(',');

  class Checklist {
    /**
     * @param {object} drop the configured drop
     * @param {{payment:boolean, shipping:boolean}} manual persisted manual ticks
     */
    constructor(drop, manual) {
      this.drop = drop;
      this.manual = Object.assign({ payment: false, shipping: false }, manual || {});
      this.items = [];
      this._listeners = [];
      this._observer = null;
      this._pollTimer = null;
      this._debounce = null;

      this.evaluate();
    }

    onChange(fn) {
      this._listeners.push(fn);
    }

    _emit() {
      for (const fn of this._listeners) {
        try {
          fn(this);
        } catch (err) {
          console.warn('[Drop Timer] checklist listener failed', err);
        }
      }
    }

    /** Start watching the page. */
    start() {
      this.stop();

      this._observer = new MutationObserver(() => {
        clearTimeout(this._debounce);
        this._debounce = setTimeout(() => this.evaluate(), DEBOUNCE_MS);
      });

      this._observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'aria-checked', 'aria-selected', 'aria-pressed', 'selected', 'checked', 'data-selected']
      });

      // Belt and braces: some frameworks mutate inside shadow roots or via
      // property assignment, which the observer above won't see.
      this._pollTimer = setInterval(() => this.evaluate(), POLL_MS);
    }

    stop() {
      if (this._observer) {
        this._observer.disconnect();
        this._observer = null;
      }
      if (this._pollTimer) {
        clearInterval(this._pollTimer);
        this._pollTimer = null;
      }
      clearTimeout(this._debounce);
    }

    setManual(id, value) {
      if (id !== 'payment' && id !== 'shipping') return;
      this.manual[id] = !!value;
      this.evaluate();
    }

    /** @returns {boolean} every item green */
    allGreen() {
      return this.items.length > 0 && this.items.every((i) => i.ok);
    }

    /** @returns {Array} the items that are not green */
    gaps() {
      return this.items.filter((i) => !i.ok);
    }

    /**
     * Recompute every item. Emits only when something actually changed, so the
     * 1s poll doesn't cause a redraw every second.
     */
    evaluate() {
      const next = [];

      // 1. Correct product page open.
      const onRightPage = DT_Store.isSamePage(location.href, this.drop.url);
      next.push({
        id: 'page',
        kind: 'auto',
        label: 'Correct product page open',
        ok: onRightPage,
        detail: onRightPage
          ? 'URL matches the configured target'
          : 'This is not the configured URL — open ' + shortUrl(this.drop.url)
      });

      // 2. Logged in. Skipped entirely if you didn't configure a selector.
      if (this.drop.loggedInSelector) {
        const found = safeQuery(this.drop.loggedInSelector);
        next.push({
          id: 'login',
          kind: 'auto',
          label: 'Logged in',
          ok: found.ok && found.elements.length > 0,
          detail: !found.ok
            ? 'Invalid selector: ' + found.error
            : found.elements.length > 0
              ? 'Account element found'
              : 'No element matches ' + this.drop.loggedInSelector
        });
      }

      // 3. Size / variant selected. Also skipped if unconfigured — plenty of
      //    products have no variant to pick.
      if (this.drop.variantSelector) {
        const variant = detectVariantSelected(this.drop.variantSelector);
        next.push({
          id: 'variant',
          kind: 'auto',
          label: 'Size / variant selected',
          ok: variant.ok,
          detail: variant.detail
        });
      }

      // 4 & 5. Things only you can know.
      next.push({
        id: 'payment',
        kind: 'manual',
        label: 'Payment method saved to account',
        ok: !!this.manual.payment,
        detail: this.manual.payment ? 'Confirmed by you' : 'Tick once you have checked'
      });

      next.push({
        id: 'shipping',
        kind: 'manual',
        label: 'Shipping address confirmed',
        ok: !!this.manual.shipping,
        detail: this.manual.shipping ? 'Confirmed by you' : 'Tick once you have checked'
      });

      const changed = JSON.stringify(next) !== JSON.stringify(this.items);
      this.items = next;
      if (changed) this._emit();
    }
  }

  /**
   * querySelectorAll that reports a bad selector instead of throwing. A typo in
   * the options page should show up as a red checklist row explaining itself,
   * not as an exception that kills the countdown.
   */
  function safeQuery(selector) {
    try {
      return { ok: true, elements: Array.from(document.querySelectorAll(selector)), error: null };
    } catch (err) {
      return { ok: false, elements: [], error: err.message };
    }
  }

  /**
   * Decide whether a variant control has a selection.
   *
   * There is no standard for this, so we try the common encodings in order of
   * how trustworthy they are:
   *   1. a <select> with a real (non-placeholder) value
   *   2. a checked radio/checkbox — either the element itself or one inside it
   *   3. an ARIA selected/checked/pressed state
   *   4. a "selected"-ish class name
   *
   * @returns {{ok:boolean, detail:string}}
   */
  function detectVariantSelected(selector) {
    const found = safeQuery(selector);

    if (!found.ok) {
      return { ok: false, detail: 'Invalid selector: ' + found.error };
    }
    if (found.elements.length === 0) {
      return { ok: false, detail: 'No element matches ' + selector };
    }

    for (const el of found.elements) {
      // 1. Native select.
      if (el.tagName === 'SELECT') {
        const opt = el.selectedOptions && el.selectedOptions[0];
        const value = el.value;
        const looksLikePlaceholder =
          !value ||
          value === '0' ||
          (opt && (opt.disabled || /^\s*(select|choose|pick|size)\b/i.test(opt.textContent || '')));

        if (!looksLikePlaceholder) {
          return { ok: true, detail: 'Selected: ' + (opt ? opt.textContent.trim() : value) };
        }
        continue;
      }

      // 2. The element is itself a checked input.
      if (el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox')) {
        if (el.checked) {
          return { ok: true, detail: 'Selected: ' + (labelFor(el) || el.value || 'checked') };
        }
        continue;
      }

      // 2b. …or contains one.
      const checkedInside = el.querySelector('input:checked');
      if (checkedInside) {
        return {
          ok: true,
          detail: 'Selected: ' + (labelFor(checkedInside) || checkedInside.value || 'checked')
        };
      }

      // 3 & 4. ARIA state or a selected-ish class, on the element or inside it.
      if (el.matches(SELECTED_MARKERS)) {
        return { ok: true, detail: 'Selected: ' + (text(el) || 'marked selected') };
      }

      const markedInside = el.querySelector(SELECTED_MARKERS);
      if (markedInside) {
        return { ok: true, detail: 'Selected: ' + (text(markedInside) || 'marked selected') };
      }
    }

    return {
      ok: false,
      detail:
        found.elements.length +
        (found.elements.length === 1 ? ' element matched' : ' elements matched') +
        ', none selected'
    };
  }

  /** Best-effort human label for a variant input, for the detail line. */
  function labelFor(input) {
    if (input.id) {
      const lbl = document.querySelector('label[for="' + cssEscape(input.id) + '"]');
      if (lbl) return text(lbl);
    }
    const wrapping = input.closest('label');
    if (wrapping) return text(wrapping);
    return input.getAttribute('aria-label') || '';
  }

  function text(el) {
    return (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  }

  function cssEscape(value) {
    if (root.CSS && typeof root.CSS.escape === 'function') return root.CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function shortUrl(url) {
    try {
      const u = new URL(url);
      return u.hostname + u.pathname;
    } catch (err) {
      return url;
    }
  }

  root.DT_Checklist = { Checklist: Checklist, detectVariantSelected: detectVariantSelected };
})(typeof globalThis !== 'undefined' ? globalThis : self);

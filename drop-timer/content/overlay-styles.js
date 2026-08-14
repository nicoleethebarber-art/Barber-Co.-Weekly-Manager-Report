/*
 * content/overlay-styles.js — the overlay's CSS.
 *
 * Kept as a JS string rather than a .css file for one specific reason: the
 * overlay lives inside a shadow root so the retailer's stylesheet can't reach
 * in and break it, and a shadow root can't load a CSS file that isn't listed
 * in web_accessible_resources — which would mean declaring a broad match
 * pattern in the manifest. A string avoids that entirely.
 *
 * Edit it like normal CSS. The `:host` rules style the overlay container
 * itself; everything else is scoped to the shadow tree and cannot leak out.
 */
(function (root) {
  'use strict';

  root.DT_STYLES = `
:host {
  all: initial;
  position: fixed;
  z-index: 2147483647;
  top: 16px;
  right: 16px;
  width: 320px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  color: #e8ecf2;
  -webkit-font-smoothing: antialiased;
}

* { box-sizing: border-box; }

.panel {
  background: #14181f;
  border: 1px solid #2b3240;
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}

/* ---------------------------------------------------------------- header */

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: #1b212b;
  border-bottom: 1px solid #2b3240;
  cursor: grab;
  user-select: none;
}
.head:active { cursor: grabbing; }

.dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: #6b7688;
  flex: 0 0 auto;
}

.title {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.head button {
  all: unset;
  cursor: pointer;
  width: 20px; height: 20px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  color: #98a2b3;
  font-size: 13px;
  line-height: 1;
  flex: 0 0 auto;
}
.head button:hover { background: #2b3240; color: #e8ecf2; }
.head button:focus-visible { outline: 2px solid #4c8dff; outline-offset: 1px; }

/* ------------------------------------------------------------- countdown */

.body { padding: 12px; }

.clock {
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
  font-weight: 700;
  font-size: 40px;
  line-height: 1.05;
  letter-spacing: -0.02em;
  text-align: center;
  padding: 6px 0 2px;
  transition: color 180ms ease;
  color: #e8ecf2;
}

.clock.neutral { color: #e8ecf2; }
.clock.amber   { color: #ffb020; }
.clock.red     { color: #ff5a52; }
.clock.green   { color: #2ee88a; }
.clock.past    { color: #7d8798; font-size: 30px; }

/* Green flash at T-0. */
@keyframes dt-flash {
  0%, 100% { background: transparent; }
  50%      { background: rgba(46, 232, 138, 0.28); }
}
.panel.flash { animation: dt-flash 380ms ease-in-out 4; }

.when {
  text-align: center;
  font-size: 11px;
  color: #98a2b3;
  margin-bottom: 8px;
}

.sync {
  text-align: center;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: #78839a;
  padding-bottom: 10px;
  border-bottom: 1px solid #242b36;
  margin-bottom: 10px;
  word-break: break-word;
}
.sync.bad { color: #ff8a80; }

/* ------------------------------------------------------------- checklist */

.section-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #78839a;
  margin: 0 0 6px;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.ready { color: #2ee88a; font-weight: 700; }
.notready { color: #ff5a52; font-weight: 700; }

ul.checks { list-style: none; margin: 0; padding: 0; }

li.check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 7px;
  margin-bottom: 2px;
}

li.check.manual { cursor: pointer; }
li.check.manual:hover { background: #1e242f; }

/* Highlight the gaps when we warn at T-5min. */
li.check.gap-flag {
  background: rgba(255, 90, 82, 0.14);
  box-shadow: inset 0 0 0 1px rgba(255, 90, 82, 0.45);
}

.mark {
  flex: 0 0 auto;
  width: 15px; height: 15px;
  margin-top: 1px;
  border-radius: 4px;
  display: grid;
  place-items: center;
  font-size: 10px;
  font-weight: 700;
  border: 1.5px solid #4a5468;
  color: transparent;
}
li.check.ok .mark {
  background: #1f8f52;
  border-color: #2ee88a;
  color: #ffffff;
}

.check-text { flex: 1 1 auto; min-width: 0; }
.check-label { font-size: 12px; color: #cfd6e2; }
li.check.ok .check-label { color: #8fa0b6; }
.check-detail {
  font-size: 10.5px;
  color: #6f7b90;
  word-break: break-word;
}
li.check:not(.ok) .check-detail { color: #d8a3a0; }

.tag {
  flex: 0 0 auto;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #6f7b90;
  border: 1px solid #333c4c;
  border-radius: 4px;
  padding: 1px 4px;
  margin-top: 2px;
}

/* ----------------------------------------------------------------- audio */

.audio {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #242b36;
  display: flex;
  align-items: center;
  gap: 8px;
}

.audio button {
  all: unset;
  cursor: pointer;
  padding: 3px 7px;
  border-radius: 6px;
  border: 1px solid #333c4c;
  font-size: 11px;
  color: #cfd6e2;
  flex: 0 0 auto;
}
.audio button:hover { background: #2b3240; }
.audio button:focus-visible { outline: 2px solid #4c8dff; outline-offset: 1px; }
.audio button.on { background: #33261f; border-color: #7a4a2e; color: #ffb020; }

input[type="range"] {
  flex: 1 1 auto;
  min-width: 0;
  accent-color: #4c8dff;
  height: 16px;
}

.vol-label {
  flex: 0 0 auto;
  font-size: 10.5px;
  color: #78839a;
  font-variant-numeric: tabular-nums;
  width: 30px;
  text-align: right;
}

/* --------------------------------------------------------------- banners */

.banner {
  margin-top: 10px;
  padding: 7px 9px;
  border-radius: 7px;
  font-size: 11.5px;
  display: none;
}
.banner.show { display: block; }

.banner.warn {
  background: rgba(255, 176, 32, 0.14);
  border: 1px solid rgba(255, 176, 32, 0.45);
  color: #ffcf7a;
}
.banner.danger {
  background: rgba(255, 90, 82, 0.14);
  border: 1px solid rgba(255, 90, 82, 0.5);
  color: #ffb0ab;
}

.banner button {
  all: unset;
  cursor: pointer;
  text-decoration: underline;
  font-weight: 600;
}
.banner button:focus-visible { outline: 2px solid #4c8dff; outline-offset: 2px; }

.foot {
  margin-top: 9px;
  font-size: 9.5px;
  color: #5c6779;
  text-align: center;
}

/* --------------------------------------------------------------- minimised */

.panel.min .body,
.panel.min .audio { display: none; }

.panel.min .mini {
  display: block;
  padding: 6px 10px 8px;
  text-align: center;
  font-weight: 700;
  font-size: 20px;
  font-variant-numeric: tabular-nums;
}
.mini { display: none; }
.mini.amber { color: #ffb020; }
.mini.red   { color: #ff5a52; }
.mini.green { color: #2ee88a; }

@media (prefers-reduced-motion: reduce) {
  .panel.flash { animation: none; outline: 3px solid #2ee88a; }
}
`;
})(typeof globalThis !== 'undefined' ? globalThis : self);

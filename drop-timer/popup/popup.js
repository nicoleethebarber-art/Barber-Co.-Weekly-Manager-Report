/*
 * popup/popup.js — the toolbar popup.
 *
 * A glance at what's next plus the volume controls, nothing more. The
 * countdown here runs on the *local* clock: the popup isn't on the retailer's
 * page, so it can't do a same-origin HEAD request, and faking a server-synced
 * number here would be worse than being honest about it. The footer says so.
 */
(function () {
  'use strict';

  const els = {
    none: document.getElementById('none'),
    detail: document.getElementById('detail'),
    label: document.getElementById('label'),
    clock: document.getElementById('clock'),
    when: document.getElementById('when'),
    permWarn: document.getElementById('perm-warn'),
    openPage: document.getElementById('open-page'),
    mute: document.getElementById('mute'),
    volume: document.getElementById('volume'),
    volLabel: document.getElementById('vol-label'),
    options: document.getElementById('options')
  };

  let next = null;
  let settings = null;

  async function init() {
    settings = await DT_Store.getSettings();
    renderSettings();
    wire();

    next = await askForNextDrop();

    if (!next) {
      els.none.hidden = false;
      els.detail.hidden = true;
      return;
    }

    els.none.hidden = true;
    els.detail.hidden = false;
    els.label.textContent = next.drop.label || next.drop.url;
    els.when.textContent = DT_TZ.formatInZone(next.epoch, next.drop.timeZone);
    els.openPage.href = next.drop.url;

    // A configured drop with no host permission silently does nothing, which is
    // the single most confusing failure mode. Call it out here.
    const pattern = DT_Store.originPattern(next.drop.url);
    if (pattern) {
      let granted = false;
      try {
        granted = await chrome.permissions.contains({ origins: [pattern] });
      } catch (err) {
        granted = false;
      }
      els.permWarn.hidden = granted;
    }

    tick();
    setInterval(tick, 250);
  }

  /** The service worker owns "what's next" so there's one source of truth. */
  function askForNextDrop() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'dt:next-drop' }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response || null);
      });
    });
  }

  function tick() {
    if (!next) return;

    const remaining = next.epoch - Date.now();
    els.clock.textContent = remaining > 0 ? DT_TZ.formatRemaining(remaining) : 'now';

    els.clock.className =
      'clock' + (remaining <= 60 * 1000 ? ' red' : remaining <= 5 * 60 * 1000 ? ' amber' : '');
  }

  function renderSettings() {
    els.mute.textContent = settings.muted ? '🔇 Muted' : '🔊 On';
    els.mute.classList.toggle('on', settings.muted);
    els.volume.value = String(Math.round(settings.volume * 100));
    els.volLabel.textContent = Math.round(settings.volume * 100) + '%';
  }

  function wire() {
    els.mute.addEventListener('click', async () => {
      settings = await DT_Store.setSettings({ muted: !settings.muted });
      renderSettings();
    });

    els.volume.addEventListener('input', () => {
      els.volLabel.textContent = els.volume.value + '%';
    });

    els.volume.addEventListener('change', async () => {
      settings = await DT_Store.setSettings({ volume: Number(els.volume.value) / 100 });
      renderSettings();
    });

    els.options.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
      window.close();
    });
  }

  init();
})();

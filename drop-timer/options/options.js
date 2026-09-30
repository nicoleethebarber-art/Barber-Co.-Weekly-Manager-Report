/*
 * options/options.js — the config screen.
 *
 * Design notes:
 *  - Cards are built once per drop and then updated in place. A full re-render
 *    on every keystroke would steal focus out of whatever you're typing in.
 *  - Saves are debounced; there is no Save button to forget to press.
 *  - chrome.permissions.request() must be called synchronously from a click
 *    handler or Chrome rejects it as "not a user gesture", so the grant button
 *    reads the pattern from the in-memory model and calls it immediately —
 *    never after an await.
 */
(function () {
  'use strict';

  const SAVE_DEBOUNCE_MS = 400;

  /** @type {Array} in-memory copy of the drop list; storage is written from here */
  let drops = [];
  let settings = null;
  let saveTimer = null;

  const listEl = document.getElementById('drop-list');
  const emptyEl = document.getElementById('empty-state');
  const toastEl = document.getElementById('toast');

  // ------------------------------------------------------------------ init

  async function init() {
    drops = await DT_Store.getDrops();
    settings = await DT_Store.getSettings();

    buildTimeZoneList();
    renderList();
    renderSettings();
    wireGlobalControls();

    // Keep the permission pills honest if you grant/revoke from chrome://extensions.
    chrome.permissions.onAdded.addListener(refreshAllPermissionStates);
    chrome.permissions.onRemoved.addListener(refreshAllPermissionStates);

    // Live countdown in the "drop time" preview.
    setInterval(updateAllPreviews, 1000);
  }

  /** One shared datalist of IANA zones, referenced by every timezone input. */
  function buildTimeZoneList() {
    const zones = DT_TZ.allZones();
    if (!zones.length) return; // older browser — the field stays a plain text input

    const list = document.createElement('datalist');
    list.id = 'tz-list';
    for (const zone of zones) {
      const opt = document.createElement('option');
      opt.value = zone;
      list.appendChild(opt);
    }
    document.body.appendChild(list);
  }

  // ------------------------------------------------------------- rendering

  function renderList() {
    listEl.textContent = '';
    emptyEl.hidden = drops.length > 0;

    for (const drop of drops) {
      listEl.appendChild(buildCard(drop));
    }
    refreshAllPermissionStates();
  }

  function buildCard(drop) {
    const card = el('div', { class: 'card drop-card' });
    card.dataset.dropId = drop.id;

    // ---- header ------------------------------------------------------
    const head = el('div', { class: 'drop-head' });
    const name = el('div', { class: 'name', text: drop.label || 'Untitled drop' });
    const permPill = el('span', { class: 'pill', text: 'checking…' });
    const timePill = el('span', { class: 'pill', text: '—' });
    head.append(name, timePill, permPill);

    // ---- fields ------------------------------------------------------
    const grid = el('div', { class: 'grid' });

    const labelField = textField('Label', drop.label, 'text', 'e.g. Dunk Low Panda');
    const urlField = textField('Product URL', drop.url, 'url', 'https://shop.example.com/products/…', true);
    const timeField = textField('Drop time (wall clock at the site)', drop.dropDateTime, 'datetime-local');
    const zoneField = textField('Timezone', drop.timeZone, 'text', 'America/New_York');
    const buyField = textField('Buy button selector', drop.buySelector, 'text', 'button[name="add"]', true);
    const loginField = textField('Logged-in indicator selector', drop.loggedInSelector, 'text', 'a[href*="/account/logout"]', true);
    const variantField = textField('Size / variant selector', drop.variantSelector, 'text', 'fieldset[name="size"] input', true);

    if (document.getElementById('tz-list')) {
      zoneField.input.setAttribute('list', 'tz-list');
    }

    labelField.wrap.classList.add('full');
    urlField.wrap.classList.add('full');
    buyField.wrap.classList.add('full');
    loginField.wrap.classList.add('full');
    variantField.wrap.classList.add('full');

    setHint(loginField, 'Optional. Leave blank to skip the "Logged in" check.');
    setHint(variantField, 'Optional. Leave blank if the product has no size/variant to pick.');
    setHint(buyField, 'Required for the T-0 focus assist. Must match exactly one visible element.');
    setHint(zoneField, 'IANA name. The drop time above is interpreted in this zone.');

    grid.append(
      labelField.wrap,
      urlField.wrap,
      timeField.wrap,
      zoneField.wrap,
      buyField.wrap,
      loginField.wrap,
      variantField.wrap
    );

    // ---- footer ------------------------------------------------------
    const foot = el('div', { class: 'drop-foot' });

    const enabledLabel = el('label', { class: 'inline' });
    const enabledBox = el('input', { type: 'checkbox' });
    enabledBox.checked = drop.enabled;
    enabledLabel.append(enabledBox, el('span', { text: 'Enabled' }));

    const preview = el('span', { class: 'when-preview' });
    const grantBtn = el('button', { type: 'button', class: 'grant', text: 'Grant site access' });
    const revokeBtn = el('button', { type: 'button', text: 'Revoke access' });
    const deleteBtn = el('button', { type: 'button', class: 'danger', text: 'Delete' });

    foot.append(enabledLabel, preview, el('span', { class: 'spacer' }), grantBtn, revokeBtn, deleteBtn);

    card.append(head, grid, foot);

    // Everything the update helpers need, in one place.
    const refs = {
      drop: drop,
      card: card,
      name: name,
      permPill: permPill,
      timePill: timePill,
      preview: preview,
      grantBtn: grantBtn,
      revokeBtn: revokeBtn,
      urlField: urlField,
      timeField: timeField,
      zoneField: zoneField
    };
    cardRefs.set(drop.id, refs);

    // ---- wiring ------------------------------------------------------

    bindText(labelField.input, drop, 'label', () => {
      name.textContent = drop.label || 'Untitled drop';
    });

    bindText(urlField.input, drop, 'url', () => {
      const pattern = DT_Store.originPattern(drop.url);
      urlField.input.classList.toggle('invalid', !!drop.url && !pattern);
      setHint(
        urlField,
        pattern
          ? 'Site access will be requested for ' + pattern
          : drop.url
            ? 'Not a valid http(s) URL'
            : '',
        pattern ? 'good' : 'bad'
      );
      refreshPermissionState(drop.id);
    });

    bindText(timeField.input, drop, 'dropDateTime', () => updatePreview(drop.id));
    bindText(zoneField.input, drop, 'timeZone', () => {
      const valid = DT_TZ.isValidZone(drop.timeZone);
      zoneField.input.classList.toggle('invalid', !valid);
      setHint(
        zoneField,
        valid ? 'IANA name. The drop time above is interpreted in this zone.' : 'Unknown timezone name',
        valid ? '' : 'bad'
      );
      updatePreview(drop.id);
    });

    bindText(buyField.input, drop, 'buySelector', () => validateSelector(buyField, drop.buySelector, true));
    bindText(loginField.input, drop, 'loggedInSelector', () =>
      validateSelector(loginField, drop.loggedInSelector, false, 'Optional. Leave blank to skip the "Logged in" check.')
    );
    bindText(variantField.input, drop, 'variantSelector', () =>
      validateSelector(variantField, drop.variantSelector, false, 'Optional. Leave blank if the product has no size/variant to pick.')
    );

    enabledBox.addEventListener('change', () => {
      drop.enabled = enabledBox.checked;
      card.classList.toggle('disabled', !drop.enabled);
      scheduleSave();
    });

    // NOTE: no await before permissions.request(), or Chrome drops the gesture.
    grantBtn.addEventListener('click', () => {
      const pattern = DT_Store.originPattern(drop.url);
      if (!pattern) {
        toast('Enter a valid product URL first.', 'bad');
        return;
      }
      chrome.permissions.request({ origins: [pattern] }, (granted) => {
        if (chrome.runtime.lastError) {
          toast(chrome.runtime.lastError.message, 'bad');
        } else {
          toast(granted ? 'Access granted for ' + pattern : 'Access was not granted.', granted ? 'good' : 'bad');
        }
        refreshPermissionState(drop.id);
      });
    });

    revokeBtn.addEventListener('click', () => {
      const pattern = DT_Store.originPattern(drop.url);
      if (!pattern) return;
      chrome.permissions.remove({ origins: [pattern] }, () => {
        toast('Access revoked for ' + pattern);
        refreshPermissionState(drop.id);
      });
    });

    deleteBtn.addEventListener('click', () => {
      if (!confirm('Delete "' + (drop.label || 'this drop') + '"?')) return;
      drops = drops.filter((d) => d.id !== drop.id);
      cardRefs.delete(drop.id);
      renderList();
      scheduleSave();
      toast('Drop deleted.');
    });

    card.classList.toggle('disabled', !drop.enabled);

    // Initial derived state.
    validateSelector(buyField, drop.buySelector, true);
    updatePreview(drop.id);

    return card;
  }

  const cardRefs = new Map();

  /** Live "when is this" line plus the header countdown pill. */
  function updatePreview(dropId) {
    const refs = cardRefs.get(dropId);
    if (!refs) return;

    const epoch = DT_Store.dropEpoch(refs.drop);

    if (epoch === null) {
      refs.preview.textContent = 'Set a drop time to arm this.';
      refs.timePill.textContent = 'not scheduled';
      refs.timePill.className = 'pill';
      return;
    }

    const remaining = epoch - Date.now();
    const local = new Date(epoch).toLocaleString();

    refs.preview.textContent = '';
    refs.preview.append(
      document.createTextNode('Fires at '),
      el('b', { text: DT_TZ.formatInZone(epoch, refs.drop.timeZone) }),
      document.createTextNode(' — your local time: ' + local)
    );

    if (remaining <= 0) {
      refs.timePill.textContent = 'passed';
      refs.timePill.className = 'pill';
    } else {
      refs.timePill.textContent = 'in ' + DT_TZ.formatRemaining(remaining);
      refs.timePill.className = 'pill' + (remaining < 60 * 60 * 1000 ? ' warn' : '');
    }
  }

  function updateAllPreviews() {
    for (const id of cardRefs.keys()) updatePreview(id);
  }

  /** Ask Chrome whether we hold the host permission this drop needs. */
  async function refreshPermissionState(dropId) {
    const refs = cardRefs.get(dropId);
    if (!refs) return;

    const pattern = DT_Store.originPattern(refs.drop.url);

    if (!pattern) {
      refs.permPill.textContent = 'no url';
      refs.permPill.className = 'pill';
      refs.grantBtn.disabled = true;
      refs.revokeBtn.disabled = true;
      return;
    }

    let granted = false;
    try {
      granted = await chrome.permissions.contains({ origins: [pattern] });
    } catch (err) {
      granted = false;
    }

    refs.permPill.textContent = granted ? 'site access ✓' : 'access needed';
    refs.permPill.className = 'pill ' + (granted ? 'ok' : 'danger');
    refs.grantBtn.disabled = granted;
    refs.revokeBtn.disabled = !granted;
  }

  function refreshAllPermissionStates() {
    for (const id of cardRefs.keys()) refreshPermissionState(id);
  }

  /**
   * Selectors can only be *syntax*-checked here — this page isn't the product
   * page, so we can't tell you whether the selector matches anything. The
   * overlay's checklist does that part on the real page.
   */
  function validateSelector(field, value, required, optionalHint) {
    if (!value) {
      field.input.classList.remove('invalid');
      setHint(field, required ? 'Required for the T-0 focus assist.' : optionalHint || '', required ? 'bad' : '');
      return;
    }

    try {
      document.querySelector(value);
      field.input.classList.remove('invalid');
      setHint(field, 'Valid CSS syntax. The overlay checks it against the real page.', 'good');
    } catch (err) {
      field.input.classList.add('invalid');
      setHint(field, 'Not valid CSS: ' + err.message, 'bad');
    }
  }

  // ---------------------------------------------------------- global controls

  function renderSettings() {
    const muted = document.getElementById('muted');
    const volume = document.getElementById('volume');
    const volumeLabel = document.getElementById('volume-label');
    const keepAwake = document.getElementById('keep-awake');

    muted.checked = settings.muted;
    volume.value = String(Math.round(settings.volume * 100));
    volumeLabel.textContent = Math.round(settings.volume * 100) + '%';
    keepAwake.checked = settings.keepAwake;
  }

  function wireGlobalControls() {
    document.getElementById('add-drop').addEventListener('click', () => {
      const drop = DT_Store.newDrop();
      drops.push(drop);
      listEl.appendChild(buildCard(drop));
      emptyEl.hidden = true;
      refreshPermissionState(drop.id);
      scheduleSave();
    });

    const muted = document.getElementById('muted');
    const volume = document.getElementById('volume');
    const volumeLabel = document.getElementById('volume-label');
    const keepAwake = document.getElementById('keep-awake');

    muted.addEventListener('change', () => saveSettings({ muted: muted.checked }));
    keepAwake.addEventListener('change', () => saveSettings({ keepAwake: keepAwake.checked }));

    volume.addEventListener('input', () => {
      volumeLabel.textContent = volume.value + '%';
    });
    volume.addEventListener('change', () => saveSettings({ volume: Number(volume.value) / 100 }));

    document.getElementById('test-tone').addEventListener('click', playTestTone);

    document.getElementById('export').addEventListener('click', exportFile);
    document.getElementById('copy-json').addEventListener('click', copyJSON);

    // Note: the two programmatic .click() calls on this page (here, and on the
    // download anchor in exportFile) act on elements of the extension's OWN
    // options page. No content script ever calls .click() on anything.
    const fileInput = document.getElementById('file-input');
    document.getElementById('import-file').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => applyImport(String(reader.result));
      reader.onerror = () => toast('Could not read that file.', 'bad');
      reader.readAsText(file);
      fileInput.value = '';
    });

    document.getElementById('import-paste').addEventListener('click', () => {
      const text = document.getElementById('import-text').value.trim();
      if (!text) {
        toast('Paste some JSON first.', 'bad');
        return;
      }
      applyImport(text);
    });
  }

  /**
   * Same synthesis as the content script's T-0 cue, so what you hear here is
   * what will wake you. Kept small and self-contained rather than importing
   * the content-script module, which expects a page context.
   */
  function playTestTone() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const master = ctx.createGain();
      master.gain.value = settings.muted ? 0 : settings.volume;

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 8;
      master.connect(comp);
      comp.connect(ctx.destination);

      const beeps = [
        [0.0, 0.18, 1568],
        [0.2, 0.18, 1047],
        [0.4, 0.18, 1568],
        [0.6, 0.18, 1047],
        [0.8, 0.5, 1568]
      ];

      const base = ctx.currentTime + 0.02;
      for (const [at, dur, freq] of beeps) {
        const start = base + at;
        const end = start + dur;

        const env = ctx.createGain();
        env.connect(master);
        env.gain.setValueAtTime(0.0001, start);
        env.gain.exponentialRampToValueAtTime(1, start + 0.006);
        env.gain.setValueAtTime(1, Math.max(start + 0.006, end - 0.05));
        env.gain.exponentialRampToValueAtTime(0.0001, end);

        for (const detune of [0, 11]) {
          const osc = ctx.createOscillator();
          osc.type = 'square';
          osc.frequency.setValueAtTime(freq, start);
          osc.detune.setValueAtTime(detune, start);
          osc.connect(env);
          osc.start(start);
          osc.stop(end + 0.02);
        }
      }

      setTimeout(() => ctx.close().catch(() => {}), 2500);

      if (settings.muted) toast('Cues are muted — untick "Mute all cues" to hear it.', 'bad');
    } catch (err) {
      toast('Could not play the tone: ' + err.message, 'bad');
    }
  }

  // -------------------------------------------------------- import / export

  function exportFile() {
    const json = DT_Store.exportJSON(drops, settings);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = 'drop-timer-config.json';
    a.click();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Exported.', 'good');
  }

  async function copyJSON() {
    try {
      await navigator.clipboard.writeText(DT_Store.exportJSON(drops, settings));
      toast('Config copied to clipboard.', 'good');
    } catch (err) {
      toast('Clipboard blocked — use the export button instead.', 'bad');
    }
  }

  async function applyImport(text) {
    let parsed;
    try {
      parsed = DT_Store.parseImport(text);
    } catch (err) {
      toast(err.message, 'bad');
      return;
    }

    if (!confirm('Replace your current ' + drops.length + ' drop(s) with ' + parsed.drops.length + ' imported drop(s)?')) {
      return;
    }

    drops = parsed.drops;
    if (parsed.settings) {
      settings = await DT_Store.setSettings(parsed.settings);
      renderSettings();
    }

    cardRefs.clear();
    renderList();
    await save();

    document.getElementById('import-text').value = '';
    toast(
      'Imported ' + parsed.drops.length + ' drop(s). Grant site access for each one.',
      'good'
    );
  }

  // ------------------------------------------------------------------ saving

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
  }

  async function save() {
    try {
      await DT_Store.setDrops(drops);
    } catch (err) {
      // The most likely cause by far is the sync storage quota.
      toast('Could not save: ' + err.message, 'bad');
    }
  }

  async function saveSettings(patch) {
    try {
      settings = await DT_Store.setSettings(patch);
    } catch (err) {
      toast('Could not save settings: ' + err.message, 'bad');
    }
  }

  // ------------------------------------------------------------------ utils

  /** Wire an input to a model field, with a debounced save and a side effect. */
  function bindText(input, drop, key, onChange) {
    input.addEventListener('input', () => {
      drop[key] = input.value.trim();
      if (onChange) onChange();
      scheduleSave();
    });
    if (onChange) onChange();
  }

  function textField(labelText, value, type, placeholder, mono) {
    const wrap = el('div');
    const id = 'f_' + Math.random().toString(36).slice(2, 9);

    const label = el('label', { text: labelText, for: id });
    const input = el('input', { type: type || 'text', id: id });
    if (placeholder) input.placeholder = placeholder;
    if (mono) input.className = 'mono';
    input.value = value || '';

    const hint = el('div', { class: 'field-hint' });

    wrap.append(label, input, hint);
    return { wrap: wrap, input: input, hint: hint };
  }

  function setHint(field, text, tone) {
    field.hint.textContent = text || '';
    field.hint.className = 'field-hint' + (tone ? ' ' + tone : '');
  }

  let toastTimer = null;
  function toast(message, tone) {
    toastEl.textContent = message;
    toastEl.className = 'toast show' + (tone ? ' ' + tone : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.className = 'toast';
    }, 3600);
  }

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

  init();
})();

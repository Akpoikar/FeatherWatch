/* theme feature: presets, accent color, layout options, persisted via theme_get/theme_set + localStorage */
(function () {
  'use strict';
  const root = document.documentElement;
  const LS_CFG = 'lw_appearance', LS_BOOT = 'lw_theme_boot';

  const PRESETS = {
    midnight: { name: 'Midnight', scheme: 'dark', a1: '#8b5cf6', a2: '#ec4899',
      v: { bg: '#0e0e12', bg2: '#16161c', bg3: '#1f1f27', bg4: '#2a2a35', line: '#2c2c38', fg: '#efeff4', fg2: '#a8a8b8', fg3: '#70707f', live: '#ef4444', shadow: '0 10px 30px rgba(0,0,0,.45)' } },
    light: { name: 'Light', scheme: 'light', a1: '#8b5cf6', a2: '#ec4899',
      v: { bg: '#f6f6f9', bg2: '#ffffff', bg3: '#efeff4', bg4: '#e2e2ea', line: '#dddde6', fg: '#16161c', fg2: '#4d4d5c', fg3: '#8a8a99', live: '#ef4444', shadow: '0 10px 30px rgba(20,20,40,.15)' } },
    oled: { name: 'OLED black', scheme: 'dark', a1: '#8b5cf6', a2: '#ec4899',
      v: { bg: '#000000', bg2: '#060607', bg3: '#111114', bg4: '#1c1c21', line: '#1d1d22', fg: '#f2f2f5', fg2: '#a3a3ad', fg3: '#67676f', live: '#ef4444', shadow: '0 10px 30px rgba(0,0,0,.7)' } },
    nord: { name: 'Nord', scheme: 'dark', a1: '#88c0d0', a2: '#b48ead',
      v: { bg: '#242933', bg2: '#2e3440', bg3: '#3b4252', bg4: '#434c5e', line: '#3b4252', fg: '#eceff4', fg2: '#c4ccd9', fg3: '#8790a2', live: '#bf616a', shadow: '0 10px 30px rgba(10,14,22,.5)' } },
    sepia: { name: 'Warm sepia', scheme: 'dark', a1: '#e0913b', a2: '#d9534f',
      v: { bg: '#17130f', bg2: '#201b15', bg3: '#2a231c', bg4: '#382f25', line: '#3a3027', fg: '#f1e7d8', fg2: '#c2b29c', fg3: '#8a7a66', live: '#e5533d', shadow: '0 10px 30px rgba(0,0,0,.5)' } },
    contrast: { name: 'High contrast', scheme: 'dark', a1: '#ffd400', a2: '#ff8a00',
      v: { bg: '#000000', bg2: '#000000', bg3: '#141414', bg4: '#2e2e2e', line: '#8a8a8a', fg: '#ffffff', fg2: '#f0f0f0', fg3: '#c8c8c8', live: '#ff3b3b', shadow: '0 0 0 1px #fff' } }
  };
  const SWATCHES = ['#8b5cf6', '#6366f1', '#3b82f6', '#06b6d4', '#10b981', '#84cc16', '#f59e0b', '#f97316', '#ef4444', '#ec4899'];
  const CARD = { small: 190, medium: 260, large: 340 };
  const DEF = { preset: 'midnight', accent: '', compact: false, side_width: 240, card: 'medium', font_scale: 100, radius: 10, reduce_motion: false, hide_offline: false };

  // ---------- color helpers ----------
  function hexToRgb(h) { h = String(h).replace('#', ''); if (h.length === 3) h = h.replace(/./g, c => c + c); const n = parseInt(h, 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function rgbToHsl(r, g, b) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0; const l = (mx + mn) / 2; if (mx !== mn) { const d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; } return [h, s, l]; }
  function hslToHex(h, s, l) { h = ((h % 360) + 360) % 360; const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l); const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join(''); }
  function shiftHue(hex, deg) { const [h, s, l] = rgbToHsl(...hexToRgb(hex)); return hslToHex(h + deg, Math.min(1, s * 1.05), l); }
  function lum(hex) { const c = hexToRgb(hex).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; }
  const validHex = h => /^#[0-9a-f]{6}$/i.test(h || '');

  // ---------- compute + apply ----------
  function compute(cfg) {
    const p = PRESETS[cfg.preset] || PRESETS.midnight;
    const a1 = validHex(cfg.accent) ? cfg.accent : p.a1;
    const a2 = validHex(cfg.accent) ? shiftHue(cfg.accent, 45) : p.a2;
    const vars = {};
    Object.keys(p.v).forEach(k => { vars['--' + k] = p.v[k]; });
    Object.assign(vars, {
      '--a1': a1, '--a2': a2, '--grad': 'linear-gradient(135deg,' + a1 + ',' + a2 + ')',
      '--lw-on-accent': lum(a1) > .45 ? '#111' : '#fff',
      '--side': cfg.side_width + 'px', '--r': cfg.radius + 'px',
      '--lw-card': (CARD[cfg.card] || 260) + 'px', '--lw-zoom': String(cfg.font_scale / 100),
      'color-scheme': p.scheme
    });
    const cls = ['lw-themed'];
    if (cfg.compact) cls.push('lw-compact');
    if (cfg.reduce_motion) cls.push('lw-reduce');
    if (cfg.hide_offline) cls.push('lw-hide-offline');
    return { vars, cls, scheme: p.scheme };
  }
  let cfg = Object.assign({}, DEF), schemeNow = 'dark';
  const ALL_CLS = ['lw-themed', 'lw-compact', 'lw-reduce', 'lw-hide-offline'];
  function apply(fade) {
    const c = compute(cfg);
    const reduce = cfg.reduce_motion || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (fade && !reduce) { root.classList.add('lw-fade'); clearTimeout(apply._t); apply._t = setTimeout(() => root.classList.remove('lw-fade'), 300); }
    Object.keys(c.vars).forEach(k => root.style.setProperty(k, c.vars[k]));
    ALL_CLS.forEach(k => root.classList.toggle(k, c.cls.includes(k)));
    root.setAttribute('data-lw-preset', cfg.preset);
    schemeNow = c.scheme;
    if (root.getAttribute('data-theme') !== c.scheme) root.setAttribute('data-theme', c.scheme);
    try { localStorage.setItem(LS_BOOT, JSON.stringify(c)); localStorage.setItem(LS_CFG, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }
  // Apply cached config immediately (inline head script in index.html already applied the vars before first paint).
  try { const s = JSON.parse(localStorage.getItem(LS_CFG) || 'null'); if (s && typeof s === 'object') cfg = Object.assign({}, DEF, s); } catch (e) { /* ignore */ }
  apply(false);
  // app.js applyTheme() writes data-theme from settings.theme; keep it consistent with the preset.
  new MutationObserver(() => { if (root.getAttribute('data-theme') !== schemeNow) root.setAttribute('data-theme', schemeNow); })
    .observe(root, { attributes: true, attributeFilter: ['data-theme'] });

  let saveT = null;
  function set(patch, fade) {
    Object.assign(cfg, patch); apply(fade !== false);
    clearTimeout(saveT); saveT = setTimeout(save, 400);
    if (pane) syncUI();
  }
  async function save() {
    const LW = window.LW; if (!LW || !LW.call) return;
    const r = await LW.call('theme_set', cfg);
    if (r && r.ok === false && window.pywebview) LW.toast && LW.toast('Could not save appearance: ' + r.error, 'error');
    // keep legacy settings.theme in sync (dark/light) so older code paths agree
    if (LW.S && LW.S.settings && LW.S.settings.theme !== schemeNow) { LW.S.settings.theme = schemeNow; const f = document.getElementById('settingsForm'); if (f && f.theme) f.theme.value = schemeNow; }
  }

  // ---------- settings UI ----------
  let pane = null, tabs = null;
  function h(tag, attrs, html) { const e = document.createElement(tag); if (attrs) Object.keys(attrs).forEach(k => e.setAttribute(k, attrs[k])); if (html != null) e.innerHTML = html; return e; }
  function buildUI() {
    const modal = document.getElementById('settingsModal'); const form = document.getElementById('settingsForm');
    if (!modal || !form || pane) return;
    const card = modal.querySelector('.modal-card');
    // the old dark/light select is superseded by the Appearance tab
    if (form.theme && form.theme.closest('label')) form.theme.closest('label').hidden = true;
    tabs = h('div', { class: 'th-tabs' }, '<button type="button" data-t="general" class="on">General</button><button type="button" data-t="appearance">Appearance</button>');
    form.parentNode.insertBefore(tabs, form);
    pane = h('div', { class: 'th-pane', hidden: '' });
    const presets = Object.keys(PRESETS).map(k => { const p = PRESETS[k].v; return `<button type="button" class="th-preset" data-p="${k}"><div class="th-prev" style="background:${p.bg}"><i style="background:${p.bg2}"></i><i style="background:${p.bg3};box-shadow:inset 0 -6px 0 ${PRESETS[k].a1}"></i></div><span>${PRESETS[k].name}</span></button>`; }).join('');
    const sw = '<button type="button" class="th-sw auto" data-a="" title="Theme default"></button>' + SWATCHES.map(c => `<button type="button" class="th-sw" data-a="${c}" style="background:${c}" title="${c}"></button>`).join('') + '<input type="color" class="th-custom" title="Custom color">';
    const range = (k, label, min, max, step, unit) => `<div class="th-row"><span>${label}</span><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}"><output data-o="${k}" data-u="${unit}"></output></div>`;
    pane.innerHTML = `<h4>Theme</h4><div class="th-presets">${presets}</div>
      <h4>Accent color</h4><div class="th-swatches">${sw}</div>
      <h4>Layout</h4>
      ${range('font_scale', 'Font scale', 90, 120, 5, '%')}
      ${range('side_width', 'Sidebar width', 180, 360, 10, 'px')}
      ${range('radius', 'Corner roundness', 0, 20, 1, 'px')}
      <div class="th-row"><span>Card size</span><div class="th-seg">${['small', 'medium', 'large'].map(s => `<button type="button" data-card="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div><span></span></div>
      <h4>Options</h4><div class="th-checks">
        <label class="row"><input type="checkbox" data-c="compact"> Compact sidebar</label>
        <label class="row"><input type="checkbox" data-c="hide_offline"> Hide offline follows in sidebar</label>
        <label class="row"><input type="checkbox" data-c="reduce_motion"> Reduce animations</label></div>
      <div class="th-foot"><button type="button" class="btn ghost" data-reset>Reset to defaults</button><button type="button" class="btn grad" data-close>Done</button></div>`;
    form.parentNode.insertBefore(pane, form.nextSibling);

    tabs.onclick = e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.t); };
    pane.addEventListener('click', e => {
      const p = e.target.closest('[data-p]'); if (p) return set({ preset: p.dataset.p });
      const a = e.target.closest('[data-a]'); if (a) return set({ accent: a.dataset.a });
      const c = e.target.closest('[data-card]'); if (c) return set({ card: c.dataset.card }, false);
      if (e.target.closest('[data-reset]')) return set(Object.assign({}, DEF));
      if (e.target.closest('[data-close]')) { window.LW && LW.closeModals(); }
    });
    pane.querySelector('.th-custom').addEventListener('input', e => set({ accent: e.target.value }, false));
    pane.querySelectorAll('input[type=range]').forEach(r => r.addEventListener('input', () => set({ [r.dataset.k]: +r.value }, false)));
    pane.querySelectorAll('input[data-c]').forEach(c => c.addEventListener('change', () => set({ [c.dataset.c]: c.checked }, false)));
    // reset to General tab whenever the modal is opened
    new MutationObserver(() => { if (!modal.hidden) { showTab(modal.dataset.thTab || 'general'); delete modal.dataset.thTab; } }).observe(modal, { attributes: true, attributeFilter: ['hidden'] });
    syncUI();
  }
  function showTab(t) {
    const form = document.getElementById('settingsForm'), card = pane.closest('.modal-card');
    tabs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
    form.hidden = t !== 'general'; pane.hidden = t !== 'appearance';
    card.classList.toggle('th-wide', t === 'appearance');
    const h3 = card.querySelector('h3'); if (h3) h3.textContent = t === 'appearance' ? 'Appearance' : 'Settings';
    if (t === 'appearance') syncUI();
  }
  function syncUI() {
    pane.querySelectorAll('[data-p]').forEach(b => b.classList.toggle('on', b.dataset.p === cfg.preset));
    pane.querySelectorAll('[data-a]').forEach(b => b.classList.toggle('on', b.dataset.a === (cfg.accent || '')));
    pane.querySelectorAll('[data-card]').forEach(b => b.classList.toggle('on', b.dataset.card === cfg.card));
    pane.querySelectorAll('input[type=range]').forEach(r => { r.value = cfg[r.dataset.k]; });
    pane.querySelectorAll('output[data-o]').forEach(o => { o.textContent = cfg[o.dataset.o] + o.dataset.u; });
    pane.querySelectorAll('input[data-c]').forEach(c => { c.checked = !!cfg[c.dataset.c]; });
    const cc = pane.querySelector('.th-custom'); cc.value = validHex(cfg.accent) ? cfg.accent : (PRESETS[cfg.preset] || PRESETS.midnight).a1;
  }
  function openAppearance() { const m = document.getElementById('settingsModal'); if (!m || !window.LW) return; buildUI(); m.dataset.thTab = 'appearance'; LW.openModal('settingsModal'); }

  // ---------- command palette entries ----------
  function hookPalette() {
    const input = document.getElementById('paletteInput'), list = document.getElementById('paletteList');
    if (!input || !list) return;
    const entries = q => {
      q = q.toLowerCase().trim(); if (!q) return [];
      const out = [];
      if ('theme toggle dark light'.includes(q) || q.startsWith('theme')) out.push({ label: 'Theme: toggle dark / light', run: () => set({ preset: schemeNow === 'light' ? 'midnight' : 'light' }) });
      Object.keys(PRESETS).forEach(k => { const n = 'theme ' + PRESETS[k].name.toLowerCase(); if (n.includes(q) || (q.startsWith('theme') && n.startsWith(q))) out.push({ label: 'Theme: ' + PRESETS[k].name, run: () => set({ preset: k }) }); });
      if ('appearance settings'.includes(q) || q.startsWith('appear')) out.push({ label: 'Open appearance settings', run: openAppearance });
      return q.length < 3 ? [] : out.slice(0, 7);
    };
    let cur = [];
    const draw = () => {
      list.querySelectorAll('.th-pal').forEach(x => x.remove());
      cur = entries(input.value);
      cur.slice().reverse().forEach((it, i) => {
        const li = document.createElement('li'); li.className = 'th-pal';
        li.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 3v18M12 3a9 9 0 0 1 0 18" fill="currentColor"/></svg><span></span><span class="k">Appearance</span>';
        li.children[1].textContent = it.label;
        li.onclick = () => { window.LW && LW.closeModals(); it.run(); };
        list.insertBefore(li, list.firstChild);
      });
      // if only our entries are meaningful, mark first selected
      if (cur.length && !list.querySelector('li.sel:not(.th-pal)')) { const f = list.querySelector('.th-pal'); f && f.classList.add('sel'); }
    };
    input.addEventListener('input', () => setTimeout(draw, 0));
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || !cur.length) return;
      const sel = list.querySelector('li.sel');
      if (!sel || sel.classList.contains('th-pal') || /no matches/i.test(sel.textContent)) {
        e.stopImmediatePropagation(); e.preventDefault(); window.LW && LW.closeModals(); cur[0].run();
      }
    }, true);
  }

  function boot(LW) {
    buildUI(); hookPalette();
    LW.openAppearance = openAppearance;
    LW.call('theme_get').then(r => {
      if (r && r.ok && r.appearance) {
        const next = Object.assign({}, DEF, r.appearance);
        if (JSON.stringify(next) !== JSON.stringify(cfg)) { cfg = next; apply(true); if (pane) syncUI(); }
      } else if (!window.pywebview) { /* mock mode: localStorage only */ }
    });
  }
  if (window.LW && window.LW.ready) window.LW.ready(boot);
  else { window.LW = window.LW || {}; (window.LW._ready = window.LW._ready || []).push(boot); }
})();

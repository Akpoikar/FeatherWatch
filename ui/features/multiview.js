/* multiview feature – watch 2–4 streams at once (see CONTRACT.md 'Features') */
(function () {
  'use strict';
  const MAX = 4, LS_KEY = 'lw.mv.set', DRAG_MIME = 'application/x-lw-item';
  const PREF_Q = ['720p60', '720p', '480p', '540p', '360p', 'best', 'source'];
  const TILE_MIME = 'application/x-featherwatch-tile';
  const ICON = {
    grid: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>',
    star: '<svg viewBox="0 0 24 24"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/></svg>',
    full: '<svg viewBox="0 0 24 24"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>',
    open: '<svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    vol: '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>'
  };
  const reduced = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // state
  let tiles = [];          // {id, item, qualities, quality, el, video, hls, token}
  let audioIdx = 0, layout = 'auto', section = null, gridEl = null, wasActive = false;

  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ ids: tiles.map(t => ({ input: t.item.url || t.id, q: t.quality })), layout })); } catch (e) { /* ignore */ }
  }
  function load() { try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { return null; } }

  const isActive = () => !!(section && section.classList.contains('active'));
  const nameOf = it => (window.LW && LW.nameOf) ? LW.nameOf(it) : (it.author || it.title || it.id);
  function pickQuality(qs, want) {
    qs = qs || [];
    if (want && qs.includes(want)) return want;
    for (const q of PREF_Q) if (qs.includes(q)) return q;
    const p = qs.find(q => /^\d+p/.test(q) && parseInt(q, 10) <= 720);
    return p || (qs.includes('best') ? 'best' : (qs[0] || 'best'));
  }

  // ---------- DOM ----------
  function build() {
    const vp = document.getElementById('viewPlayer');
    if (!vp || section) return;
    section = LW.el('section', 'view mv-view');
    section.id = 'viewMultiview';
    section.innerHTML = `
      <div class="mv-bar">
        <h2 class="mv-title">${ICON.grid}<span>Multi-view</span><span class="mv-count"></span></h2>
        <div class="mv-layouts" role="group" aria-label="Layout">
          <button data-l="auto" title="Auto layout">Auto</button>
          <button data-l="1" title="Single">1</button>
          <button data-l="2" title="Side by side">2</button>
          <button data-l="3" title="One big + two">1+2</button>
          <button data-l="4" title="2×2 grid">2×2</button>
        </div>
        <span class="mv-hint">1–4 audio · f fullscreen · drag tiles to swap</span>
        <div class="mv-addwrap">
          <button class="btn mv-addbtn" title="Add a stream">${ICON.plus}<span>Add stream</span></button>
          <div class="mv-pop" hidden></div>
        </div>
        <button class="btn ghost mv-clear" title="Remove all streams">Clear</button>
      </div>
      <div class="mv-grid"></div>`;
    vp.parentNode.insertBefore(section, vp.nextSibling);
    gridEl = section.querySelector('.mv-grid');
    section.querySelectorAll('.mv-layouts button').forEach(b => { b.onclick = () => { layout = b.dataset.l; applyLayout(); save(); }; });
    const addBtn = section.querySelector('.mv-addbtn'), pop = section.querySelector('.mv-pop');
    addBtn.onclick = e => { e.stopPropagation(); togglePop(); };
    pop.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', () => togglePop(false));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) { togglePop(false); e.stopPropagation(); } }, true);
    section.querySelector('.mv-clear').onclick = () => { tiles.slice().forEach(t => removeTile(t, true)); render(); save(); };

    // drag & drop of sidebar channels onto grid
    section.addEventListener('dragover', e => { if (hasDrag(e)) { e.preventDefault(); e.stopPropagation(); section.classList.add('mv-dragover'); } });
    section.addEventListener('dragleave', e => { if (!section.contains(e.relatedTarget)) section.classList.remove('mv-dragover'); });
    section.addEventListener('drop', e => {
      section.classList.remove('mv-dragover');
      const dt = e.dataTransfer; if (!dt) return;
      if (Array.from(dt.types || []).includes(TILE_MIME)) return;  // tile swap, handled by the tile
      const id = dt.getData(DRAG_MIME);
      const t = id || (dt.getData('text/uri-list') || dt.getData('text/plain') || '').split(/\s/).find(x => x && !x.startsWith('#'));
      if (!t) return;
      e.preventDefault(); e.stopPropagation();
      const ov = document.getElementById('dropOverlay'); if (ov) ov.classList.remove('show');
      add(id ? (findItem(id) || id) : t);
    });

    // tear down when another view takes over
    new MutationObserver(() => {
      const a = isActive();
      if (a && !wasActive) onEnter(); else if (!a && wasActive) onLeave();
      wasActive = a;
    }).observe(section, { attributes: true, attributeFilter: ['class'] });

    // top bar entry button
    const actions = document.getElementById('btnBrowse');
    if (actions && !document.getElementById('btnMultiview')) {
      const b = LW.el('button', 'btn ghost', ICON.grid + '<span>Multi-view</span>');
      b.id = 'btnMultiview'; b.title = 'Watch several streams at once';
      b.onclick = () => open();
      actions.parentNode.insertBefore(b, actions.nextSibling);
    }
    // player info action
    const ia = document.querySelector('#viewPlayer .info-actions');
    if (ia && !document.getElementById('btnAddMv')) {
      const b = LW.el('button', 'btn ghost', ICON.plus + '<span>Multi-view</span>');
      b.id = 'btnAddMv'; b.title = 'Add this stream to multi-view';
      b.onclick = () => { const it = LW.S.item; if (it) open(it); };
      ia.appendChild(b);
    }
    // sidebar: right-click entry + drag source
    const sb = document.getElementById('sidebar');
    if (sb) {
      sb.addEventListener('contextmenu', e => {   // bubbles after app.js filled #ctxMenu
        const li = e.target.closest && e.target.closest('.side-item[data-id]');
        const m = document.getElementById('ctxMenu');
        if (!li || !m || m.hidden) return;
        const it = findItem(li.dataset.id); if (!it) return;
        const b = LW.el('button', null, tiles.some(t => t.id === it.id) ? 'In multi-view' : 'Add to multi-view');
        b.onclick = () => { m.hidden = true; open(it); };
        m.insertBefore(b, m.children[1] || null);
      });
      sb.addEventListener('dragstart', e => {
        const li = e.target.closest && e.target.closest('.side-item[data-id]');
        if (!li) return;
        const it = findItem(li.dataset.id);
        e.dataTransfer.setData(DRAG_MIME, li.dataset.id);
        e.dataTransfer.setData('text/plain', (it && it.url) || li.dataset.id);
        e.dataTransfer.effectAllowed = 'copy';
      });
    }
    LW.on('sidebarRendered', markDraggable);
    markDraggable();
  }
  function hasDrag(e) { const t = e.dataTransfer && e.dataTransfer.types; return !!t && (Array.from(t).includes(DRAG_MIME) || Array.from(t).includes('text/plain') || Array.from(t).includes('text/uri-list')); }
  function markDraggable() { document.querySelectorAll('#sidebar .side-item[data-id]').forEach(li => { li.draggable = true; }); }
  function findItem(id) { const S = LW.S; return (S.follows || []).concat(S.history || []).find(i => i.id === id) || (S.item && S.item.id === id ? S.item : null); }

  // ---------- open / enter / leave ----------
  function open(itemOrInput) {
    if (!section) build();
    LW.showView('Multiview');
    if (itemOrInput) add(itemOrInput);
  }
  function onEnter() {
    LW.stopPlayback();
    if (!tiles.length) {
      const saved = load();
      if (saved) { layout = saved.layout || 'auto'; (saved.ids || []).slice(0, MAX).forEach(s => add(s.input, s.q, true)); }
    } else tiles.forEach(t => startTile(t));
    render();
  }
  function onLeave() {
    if (LW.fsEl && section.contains(LW.fsEl)) LW.exitFs();
    tiles.forEach(stopTile);
  }

  // ---------- tiles ----------
  async function add(input, quality, silent) {
    if (tiles.length >= MAX) { if (!silent) LW.toast('Multi-view holds up to 4 streams', 'error'); return; }
    let item = typeof input === 'object' ? input : null;
    const key = item ? item.id : String(input);
    if (tiles.some(t => t.id === key || (t.item.url && t.item.url === key))) { if (!silent) LW.toast('Already in multi-view'); return; }
    const t = { id: key, item: item || { id: key, author: key, title: '' }, qualities: [], quality: null, el: null, video: null, hls: null, token: 0, state: 'loading', err: '' };
    tiles.push(t); render(); save();
    const r = await LW.call('resolve', item ? (item.url || item.id) : input);
    if (!tiles.includes(t)) return;
    if (!r.ok) { t.state = 'error'; t.err = r.error || 'Could not resolve'; renderTile(t); return; }
    if (tiles.some(o => o !== t && o.id === r.item.id)) { removeTile(t); if (!silent) LW.toast('Already in multi-view'); return; }
    t.id = r.item.id; t.item = r.item; t.qualities = r.qualities || [];
    t.quality = pickQuality(t.qualities, quality);
    save();
    if (isActive()) startTile(t); else renderTile(t);
  }
  async function startTile(t) {
    stopTile(t);
    if (!t.quality) return;   // still resolving
    const tok = ++t.token;
    t.state = 'loading'; renderTile(t);
    const r = await LW.call('play', t.item.id, t.quality);
    if (tok !== t.token || !tiles.includes(t) || !isActive()) return;
    if (!r.ok) {
      t.state = (t.item.kind === 'channel' && /offline|no (playable )?streams|not live/i.test(r.error || '')) ? 'offline' : 'error';
      t.err = r.error || 'Playback failed'; renderTile(t); return;
    }
    t.isLive = r.is_live;
    const v = t.video;
    const ok = () => { if (tok === t.token) { t.state = 'playing'; renderTile(t); } };
    v.addEventListener('playing', ok, { once: true });
    if (r.kind === 'hls' && window.Hls && Hls.isSupported()) {
      const h = t.hls = new Hls({ lowLatencyMode: !!(LW.S.settings && LW.S.settings.low_latency), backBufferLength: 10, maxBufferLength: 20, capLevelToPlayerSize: true });
      h.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal || tok !== t.token) return;
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !t._mr) { t._mr = 1; h.recoverMediaError(); return; }
        t.state = 'error'; t.err = 'Stream error (' + (d.details || d.type) + ')'; stopTile(t); renderTile(t);
      });
      h.loadSource(r.src); h.attachMedia(v);
    } else v.src = r.src;
    applyAudio();
    v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
  }
  function stopTile(t) {
    t.token++;
    if (t.hls) { try { t.hls.destroy(); } catch (e) { /* ignore */ } t.hls = null; }
    if (t.video) { t.video.pause(); t.video.removeAttribute('src'); try { t.video.load(); } catch (e) { /* ignore */ } }
    t._mr = 0;
  }
  function removeTile(t, noRender) {
    const finish = () => {
      stopTile(t);
      const i = tiles.indexOf(t); if (i < 0) return;
      tiles.splice(i, 1);
      if (audioIdx >= tiles.length) audioIdx = Math.max(0, tiles.length - 1); else if (i < audioIdx) audioIdx--;
      if (t.el) t.el.remove();
      if (!noRender) { render(); save(); }
    };
    if (t.el && !reduced() && !noRender) { t.el.classList.add('mv-out'); setTimeout(finish, 200); } else finish();
  }
  function makePrimary(t) {
    const i = tiles.indexOf(t); if (i <= 0) return;
    const audioTile = tiles[audioIdx];
    tiles.splice(i, 1); tiles.unshift(t);
    audioIdx = tiles.indexOf(audioTile);
    render(); save();
  }
  function swapTiles(a, b) {
    if (a === b || !tiles[a] || !tiles[b]) return;
    const audioTile = tiles[audioIdx];
    [tiles[a], tiles[b]] = [tiles[b], tiles[a]];
    audioIdx = Math.max(0, tiles.indexOf(audioTile));
    render(); save();
  }
  function togglePop(force) {
    const pop = section && section.querySelector('.mv-pop'); if (!pop) return;
    const show = force != null ? force : pop.hidden;
    if (show && tiles.length >= MAX) return;
    pop.hidden = !show;
    if (show) { pop.innerHTML = ''; pop.appendChild(addTileEl(true)); const i = pop.querySelector('input'); if (i) i.focus(); }
  }
  function setAudio(i) { if (i < 0 || i >= tiles.length) return; audioIdx = i; applyAudio(); }
  function applyAudio() {
    tiles.forEach((t, i) => {
      if (t.video) t.video.muted = i !== audioIdx;
      if (t.el) t.el.classList.toggle('mv-audio', i === audioIdx);
    });
  }
  function fullscreen(t) {
    if (!t || !t.el) return;
    LW.toggleFs(t.el);
  }

  // ---------- render ----------
  function tileEl(t) {
    const d = LW.el('div', 'mv-tile' + (reduced() ? '' : ' mv-in'));
    d.innerHTML = `<video playsinline muted></video>
      <div class="mv-state"></div>
      <div class="mv-ov">
        <div class="mv-top"><div class="mv-av"></div><div class="mv-meta"><div class="mv-name"></div><div class="mv-sub"></div></div><span class="mv-badge"></span></div>
        <div class="mv-acts">
          <select class="mv-q" title="Quality"></select>
          <button class="mv-b" data-a="audio" title="Listen to this tile">${ICON.vol}</button>
          <button class="mv-b" data-a="primary" title="Make primary">${ICON.star}</button>
          <button class="mv-b" data-a="full" title="Fullscreen (f)">${ICON.full}</button>
          <button class="mv-b" data-a="open" title="Open in main player">${ICON.open}</button>
          <button class="mv-b" data-a="remove" title="Remove">${ICON.x}</button>
        </div>
      </div>`;
    t.el = d; t.video = d.querySelector('video');
    d.tabIndex = 0;
    d.addEventListener('animationend', () => d.classList.remove('mv-in'), { once: true });
    d.onclick = e => {
      const b = e.target.closest('[data-a]');
      if (e.target.closest('select')) return;
      if (!b) { setAudio(tiles.indexOf(t)); return; }
      e.stopPropagation();
      const a = b.dataset.a;
      if (a === 'audio') setAudio(tiles.indexOf(t));
      else if (a === 'primary') makePrimary(t);
      else if (a === 'full') fullscreen(t);
      else if (a === 'open') { const it = t.item; LW.openInput(it.url || it.id, it); }
      else if (a === 'remove') removeTile(t);
      else if (a === 'retry') startTile(t);
    };
    // drag a tile onto another to swap them
    d.draggable = true;
    d.addEventListener('dragstart', e => {
      if (e.target.closest && e.target.closest('select,input')) return;
      e.dataTransfer.setData(TILE_MIME, String(tiles.indexOf(t)));
      e.dataTransfer.effectAllowed = 'move';
      d.classList.add('mv-dragging');
    });
    d.addEventListener('dragend', () => { d.classList.remove('mv-dragging'); gridEl.querySelectorAll('.mv-swap').forEach(x => x.classList.remove('mv-swap')); });
    d.addEventListener('dragover', e => {
      if (!Array.from(e.dataTransfer.types || []).includes(TILE_MIME)) return;
      e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move';
      if (!d.classList.contains('mv-dragging')) d.classList.add('mv-swap');
    });
    d.addEventListener('dragleave', e => { if (!d.contains(e.relatedTarget)) d.classList.remove('mv-swap'); });
    d.addEventListener('drop', e => {
      if (!Array.from(e.dataTransfer.types || []).includes(TILE_MIME)) return;
      e.preventDefault(); e.stopPropagation();
      d.classList.remove('mv-swap');
      const from = +e.dataTransfer.getData(TILE_MIME), to = tiles.indexOf(t);
      swapTiles(from, to);
    });
    d.ondblclick = e => { if (!e.target.closest('.mv-acts')) fullscreen(t); };
    d.querySelector('.mv-q').onchange = e => { t.quality = e.target.value; save(); if (isActive()) startTile(t); };
    return d;
  }
  function renderTile(t) {
    if (!t.el) return;
    const it = t.item, d = t.el;
    d.dataset.state = t.state;
    const av = d.querySelector('.mv-av');
    av.textContent = it.avatar ? '' : LW.initial(it);
    av.style.background = it.avatar ? `center/cover url("${it.avatar}")` : LW.avBg(it.author || it.id);
    d.querySelector('.mv-name').textContent = nameOf(it);
    d.querySelector('.mv-sub').textContent = it.title || it.category || '';
    const live = t.isLive != null ? t.isLive : it.is_live;
    const bd = d.querySelector('.mv-badge'); bd.textContent = live ? 'LIVE' : (t.state === 'offline' ? 'OFFLINE' : ''); bd.classList.toggle('on', !!live);
    const sel = d.querySelector('.mv-q');
    sel.innerHTML = (t.qualities.length ? t.qualities : [t.quality || '…']).map(q => `<option${q === t.quality ? ' selected' : ''}>${LW.esc(q)}</option>`).join('');
    sel.disabled = !t.qualities.length;
    const st = d.querySelector('.mv-state');
    if (t.state === 'loading') st.innerHTML = '<div class="spinner"></div>';
    else if (t.state === 'offline') st.innerHTML = `<div class="mv-msg"><b>${LW.esc(nameOf(it))} is offline</b><button class="btn ghost" data-a="retry">Retry</button></div>`;
    else if (t.state === 'error') st.innerHTML = `<div class="mv-msg"><b>Couldn't play</b><span>${LW.esc(t.err)}</span><button class="btn ghost" data-a="retry">Retry</button></div>`;
    else st.innerHTML = '';
  }
  function addTileEl(inPop) {
    const d = LW.el('div', inPop ? 'mv-add mv-add-pop' : 'mv-tile mv-add');
    const live = (LW.S.follows || []).filter(f => f.is_live && !tiles.some(t => t.id === f.id)).sort((a, b) => (b.viewers || 0) - (a.viewers || 0)).slice(0, 8);
    d.innerHTML = `<form class="mv-form" autocomplete="off"><input type="text" spellcheck="false" placeholder="Channel name or URL"><button class="btn" type="submit">${ICON.plus}<span>Add</span></button></form>
      <div class="mv-picks-h">${live.length ? 'Live now' : (tiles.length ? '' : 'Add up to 4 streams — or drag channels from the sidebar')}</div>
      <div class="mv-picks"></div>`;
    const picks = d.querySelector('.mv-picks');
    live.forEach(f => {
      const b = LW.el('button', 'mv-pick');
      b.title = (f.author || '') + (f.title ? ' — ' + f.title : '');
      const av = LW.el('span', 'mv-av', f.avatar ? '' : LW.esc(LW.initial(f)));
      av.style.background = f.avatar ? `center/cover url("${f.avatar}")` : LW.avBg(f.author || f.id);
      b.appendChild(av); b.appendChild(LW.el('span', 'mv-pick-n', LW.esc(nameOf(f))));
      b.onclick = () => { togglePop(false); add(f); };
      picks.appendChild(b);
    });
    d.querySelector('form').onsubmit = e => { e.preventDefault(); const i = d.querySelector('input'); const v = i.value.trim(); if (v) { i.value = ''; togglePop(false); add(v); } };
    return d;
  }
  function render() {
    if (!gridEl) return;
    tiles.forEach(t => { if (!t.el) { tileEl(t); if (isActive() && t.quality) setTimeout(() => startTile(t)); } renderTile(t); });
    // reorder in place (moving <video> keeps hls attached)
    const old = gridEl.querySelector('.mv-add'); if (old) old.remove();
    tiles.forEach(t => gridEl.appendChild(t.el));
    if (!tiles.length) gridEl.appendChild(addTileEl());  // empty grid: big add panel; otherwise use the header button
    const ab = section.querySelector('.mv-addbtn');
    if (ab) { ab.hidden = !tiles.length || tiles.length >= MAX; }
    if (tiles.length >= MAX || !tiles.length) togglePop(false);
    section.querySelector('.mv-count').textContent = tiles.length ? tiles.length + '/' + MAX : '';
    applyLayout(); applyAudio();
  }
  function applyLayout() {
    if (!gridEl) return;
    const n = Math.max(1, tiles.length);
    let l = layout === 'auto' ? String(Math.min(4, Math.max(1, n))) : layout;
    if (+l < n) l = String(Math.min(4, n));    // never hide tiles
    gridEl.dataset.layout = l;
    section.querySelectorAll('.mv-layouts button').forEach(b => b.classList.toggle('on', b.dataset.l === layout));
  }

  // ---------- keyboard (capture phase, before app.js's global handler) ----------
  document.addEventListener('keydown', e => {
    if (!isActive() || e.metaKey || e.ctrlKey || e.altKey) return;
    const tg = e.target;
    if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT' || tg.isContentEditable)) return;
    if (document.querySelector('.modal:not([hidden])')) return;
    if (/^[1-4]$/.test(e.key)) { setAudio(+e.key - 1); const t = tiles[+e.key - 1]; if (t && t.el) t.el.focus({ preventScroll: true }); }
    else if (e.key.toLowerCase() === 'f') fullscreen(tiles[audioIdx]);
    else if (e.key === 'Escape' && LW.fsEl) LW.exitFs();
    else return;
    e.preventDefault(); e.stopPropagation();
  }, true);

  // ---------- boot ----------
  function init() { build(); window.LW.multiview = { open, add, tiles: () => tiles.slice() }; }
  if (window.LW && window.LW.ready) LW.ready(init);
  else { window.LW = window.LW || {}; (window.LW._ready = window.LW._ready || []).push(init); }
})();

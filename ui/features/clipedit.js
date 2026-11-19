/* clipedit feature – clip library + trim/convert editor (backend/features/clipedit.py) */
(function () {
  'use strict';
  let LW = null, modal = null, ffmpeg = true, cur = null, hlsInst = null, job = null, rafId = 0;
  const st = { start: 0, end: 0, dur: 0, loop: true, fmt: 'mp4', precise: false };
  const ICON_EDIT = '<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';

  function fmtT(s) {
    s = Math.max(0, s || 0);
    const m = Math.floor(s / 60), r = s - m * 60;
    return m + ':' + (r < 10 ? '0' : '') + r.toFixed(2);
  }
  function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
  function fmtDate(t) { try { return new Date(t * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return ''; } }
  function stem(name) { return String(name || '').replace(/\.[^.]+$/, ''); }
  function reveal(p) { LW.call('clip_reveal', p).then(x => { if (!x.ok) LW.toast(x.error, 'error'); }); }

  // ---------- DOM ----------
  function build() {
    modal = LW.el('div', 'modal ce-modal'); modal.id = 'ceModal'; modal.hidden = true;
    modal.innerHTML = `
<div class="modal-card ce-card" role="dialog" aria-label="Clips">
  <div class="ce-head">
    <button class="ce-back" type="button" title="Back to clips" hidden>‹</button>
    <h3 class="ce-title">Clips</h3>
    <span class="ce-spacer"></span>
    <button class="ce-folder btn ghost" type="button">Open folder</button>
    <button class="ce-x" type="button" title="Close (Esc)">✕</button>
  </div>
  <div class="ce-warn" hidden>ffmpeg was not found on your PATH – previewing works, but trimming/exporting is disabled. Install ffmpeg and restart FeatherWatch.</div>
  <div class="ce-lib"><div class="ce-grid"></div></div>
  <div class="ce-ed" hidden>
    <div class="ce-stage"><video class="ce-video" playsinline preload="auto"></video></div>
    <div class="ce-tl" tabindex="0" aria-label="Timeline">
      <div class="ce-strip"></div>
      <div class="ce-dim ce-dim-l"></div><div class="ce-dim ce-dim-r"></div>
      <div class="ce-sel"></div>
      <div class="ce-h ce-h-in" title="In (i)"></div><div class="ce-h ce-h-out" title="Out (o)"></div>
      <div class="ce-ph"></div>
    </div>
    <div class="ce-bar">
      <button class="ce-play btn ghost" type="button" title="Play / pause (space)">▶</button>
      <label class="ce-chk"><input type="checkbox" class="ce-loop" checked> Loop selection</label>
      <span class="ce-times"></span>
      <span class="ce-spacer"></span>
      <span class="ce-keys"><kbd>i</kbd>/<kbd>o</kbd> in/out · <kbd>space</kbd> play · <kbd>←</kbd>/<kbd>→</kbd> step</span>
    </div>
    <div class="ce-opts">
      <label class="ce-name">File name<input type="text" class="ce-fname" spellcheck="false" maxlength="120"></label>
      <div class="ce-fmt" role="radiogroup" aria-label="Format">
        <button type="button" data-f="mp4" class="sel">MP4</button><button type="button" data-f="gif">GIF</button><button type="button" data-f="m4a">Audio (m4a)</button>
      </div>
      <div class="ce-mode" role="radiogroup" aria-label="Mode">
        <button type="button" data-p="0" class="sel" title="Stream copy – instant, but cuts snap to keyframes">Fast</button><button type="button" data-p="1" title="Re-encode – frame-accurate, slower">Precise</button>
      </div>
    </div>
    <div class="ce-foot">
      <button class="ce-del btn ghost" type="button">Delete clip</button>
      <span class="ce-spacer"></span>
      <div class="ce-prog" hidden><div class="ce-prog-bar"></div><span class="ce-prog-t">0%</span></div>
      <button class="ce-cancel btn ghost" type="button" hidden>Cancel</button>
      <button class="ce-export btn grad" type="button">Export</button>
    </div>
  </div>
</div>`;
    document.body.appendChild(modal);
    const q = s => modal.querySelector(s);
    modal.addEventListener('mousedown', e => { if (e.target === modal) close(); });
    q('.ce-x').onclick = close;
    q('.ce-back').onclick = () => showLib();
    q('.ce-folder').onclick = () => reveal(cur ? cur.path : null);
    // stop playback whenever the modal gets hidden (also via LW.closeModals)
    new MutationObserver(() => { if (modal.hidden) unload(); }).observe(modal, { attributes: true, attributeFilter: ['hidden'] });

    const v = q('.ce-video');
    v.addEventListener('loadedmetadata', () => {
      if (isFinite(v.duration) && v.duration > 0 && (!st.dur || Math.abs(v.duration - st.dur) > 0.5)) {
        const wasFull = st.end >= st.dur - 0.01; st.dur = v.duration; if (wasFull || st.end > st.dur) st.end = st.dur; draw();
      }
    });
    v.addEventListener('play', () => { q('.ce-play').textContent = '❚❚'; tick(); });
    v.addEventListener('pause', () => { q('.ce-play').textContent = '▶'; draw(); });
    v.addEventListener('seeked', draw);
    v.addEventListener('error', () => { if (!hlsInst) LW.toast('This clip cannot be previewed here', 'error'); });
    q('.ce-play').onclick = togglePlay;
    q('.ce-loop').onchange = e => { st.loop = e.target.checked; };

    q('.ce-fmt').onclick = e => { const b = e.target.closest('button'); if (b) { st.fmt = b.dataset.f; syncOpts(); } };
    q('.ce-mode').onclick = e => { const b = e.target.closest('button'); if (b && !b.disabled) { st.precise = b.dataset.p === '1'; syncOpts(); } };
    q('.ce-export').onclick = doExport;
    q('.ce-cancel').onclick = () => { if (job) LW.call('ce_cancel', job.id); };
    const del = q('.ce-del'); let armT = 0;
    del.onclick = async () => {
      if (!del.classList.contains('armed')) {
        del.classList.add('armed'); del.textContent = 'Click again to delete';
        clearTimeout(armT); armT = setTimeout(() => { del.classList.remove('armed'); del.textContent = 'Delete clip'; }, 3000);
        return;
      }
      clearTimeout(armT); del.classList.remove('armed'); del.textContent = 'Delete clip';
      const r = await LW.call('ce_delete', cur.path);
      if (!r.ok) return LW.toast(r.error, 'error');
      LW.toast('Clip deleted'); showLib();
    };
    initTimeline(q('.ce-tl'));
    document.addEventListener('keydown', onKey, true);
  }
  const q = s => modal.querySelector(s);

  function open() {
    if (!modal) build();
    LW.openModal('ceModal');
    requestAnimationFrame(() => modal.classList.add('ce-in'));
  }
  function close() { modal.hidden = true; }
  function unload() {
    modal.classList.remove('ce-in');
    cancelAnimationFrame(rafId);
    const v = q('.ce-video'); v.pause();
    if (hlsInst) { try { hlsInst.destroy(); } catch (e) {} hlsInst = null; }
    v.removeAttribute('src'); try { v.load(); } catch (e) {}
  }

  // ---------- library ----------
  async function showLib() {
    open(); unload(); modal.classList.add('ce-in');
    cur = null;
    q('.ce-lib').hidden = false; q('.ce-ed').hidden = true; q('.ce-back').hidden = true;
    q('.ce-title').textContent = 'Clips';
    const g = q('.ce-grid');
    g.innerHTML = '<div class="ce-skel"></div><div class="ce-skel"></div><div class="ce-skel"></div>';
    const r = await LW.call('ce_list');
    g.innerHTML = '';
    if (!r.ok) {
      g.appendChild(LW.el('div', 'empty', /unavailable/.test(r.error || '') ? 'The clip library needs the desktop app.' : LW.esc(r.error)));
      return;
    }
    ffmpeg = r.ffmpeg; q('.ce-warn').hidden = ffmpeg;
    if (!r.items.length) { g.appendChild(LW.el('div', 'empty', 'No clips yet. Press <kbd>x</kbd> while watching to clip the last seconds.')); return; }
    r.items.forEach(it => {
      const c = LW.el('button', 'ce-item');
      c.type = 'button';
      c.innerHTML = `<div class="ce-thumb">${it.thumb ? `<img loading="lazy" alt="" src="${LW.esc(it.thumb)}">` : `<span>${LW.esc(it.ext.toUpperCase())}</span>`}` +
        `${it.duration ? `<span class="ce-dur">${fmtT(it.duration).replace(/\.\d+$/, '')}</span>` : ''}</div>` +
        `<div class="ce-meta"><b title="${LW.esc(it.name)}">${LW.esc(stem(it.name))}</b><span>${fmtDate(it.mtime)} · ${fmtSize(it.size)} · ${LW.esc(it.ext)}</span></div>`;
      c.onclick = () => openEditor(it.path);
      g.appendChild(c);
    });
  }

  // ---------- editor ----------
  async function openEditor(path) {
    open();
    const r = await LW.call('ce_open', path);
    if (!r.ok) { LW.toast(r.error, 'error'); return; }
    unload(); modal.classList.add('ce-in');
    cur = r; ffmpeg = r.ffmpeg;
    q('.ce-warn').hidden = ffmpeg;
    q('.ce-lib').hidden = true; q('.ce-ed').hidden = false; q('.ce-back').hidden = false;
    q('.ce-title').textContent = stem(r.name);
    q('.ce-fname').value = stem(r.name) + ' edit';
    st.dur = r.duration || 0; st.start = 0; st.end = st.dur;
    st.fmt = r.has_video === false ? 'm4a' : 'mp4';
    q('.ce-fmt [data-f="mp4"]').disabled = q('.ce-fmt [data-f="gif"]').disabled = r.has_video === false;
    q('.ce-fmt [data-f="m4a"]').disabled = r.has_audio === false;
    syncOpts(); setBusy(false);
    q('.ce-stage').classList.toggle('ce-audio', r.has_video === false);
    const v = q('.ce-video');
    if (/\.ts$/i.test(r.path) && window.Hls && window.Hls.isSupported()) {
      // MPEG-TS is not natively playable in most webviews: wrap it in a 1-segment VOD playlist for hls.js
      const pl = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${Math.ceil(st.dur || 600)}\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:${(st.dur || 600).toFixed(3)},\n${r.url}\n#EXT-X-ENDLIST\n`;
      hlsInst = new window.Hls({ maxBufferLength: 600 });
      hlsInst.loadSource(URL.createObjectURL(new Blob([pl], { type: 'application/vnd.apple.mpegurl' })));
      hlsInst.attachMedia(v);
    } else v.src = r.url;
    const strip = q('.ce-strip'); strip.style.backgroundImage = '';
    draw();
    if (ffmpeg && r.has_video) {
      const want = cur.path;
      LW.call('ce_filmstrip', r.path, 12).then(f => { if (f.ok && cur && cur.path === want) strip.style.backgroundImage = `url("${f.url}")`; });
    }
    setTimeout(() => q('.ce-tl').focus({ preventScroll: true }), 50);
  }

  function syncOpts() {
    q('.ce-fmt').querySelectorAll('button').forEach(b => { b.classList.toggle('sel', b.dataset.f === st.fmt); b.setAttribute('aria-checked', b.dataset.f === st.fmt); });
    const gif = st.fmt === 'gif';
    q('.ce-mode').querySelectorAll('button').forEach(b => {
      b.disabled = gif;
      const on = gif ? b.dataset.p === '1' : (b.dataset.p === '1') === st.precise;
      b.classList.toggle('sel', on); b.setAttribute('aria-checked', on);
    });
    q('.ce-mode').title = gif ? 'GIFs are always re-encoded (480px, 15 fps)' : '';
    q('.ce-export').disabled = !ffmpeg || !!job;
    q('.ce-export').title = ffmpeg ? '' : 'ffmpeg is required to export';
  }

  function togglePlay() {
    const v = q('.ce-video');
    if (v.paused) {
      if (v.currentTime < st.start - 0.05 || v.currentTime >= st.end - 0.05) v.currentTime = st.start;
      const p = v.play(); if (p && p.catch) p.catch(() => {});
    } else v.pause();
  }
  function tick() {
    cancelAnimationFrame(rafId);
    const v = q('.ce-video');
    if (v.paused) return;
    if (v.currentTime >= st.end - 0.02) {
      if (st.loop) v.currentTime = st.start; else { v.pause(); v.currentTime = st.end; }
    }
    draw();
    rafId = requestAnimationFrame(tick);
  }

  function draw() {
    if (!modal || !cur) return;
    const d = st.dur || 1, v = q('.ce-video');
    const pa = st.start / d * 100, pb = st.end / d * 100, pt = Math.min(1, (v.currentTime || 0) / d) * 100;
    q('.ce-sel').style.left = pa + '%'; q('.ce-sel').style.width = (pb - pa) + '%';
    q('.ce-dim-l').style.width = pa + '%'; q('.ce-dim-r').style.left = pb + '%';
    q('.ce-h-in').style.left = pa + '%'; q('.ce-h-out').style.left = pb + '%';
    q('.ce-ph').style.left = pt + '%';
    q('.ce-times').innerHTML = `<b>${fmtT(v.currentTime)}</b> · in ${fmtT(st.start)} · out ${fmtT(st.end)} · <b>${fmtT(st.end - st.start)}</b>`;
  }

  function setIn(t) { st.start = Math.max(0, Math.min(t, st.end - 0.1)); draw(); }
  function setOut(t) { st.end = Math.min(st.dur, Math.max(t, st.start + 0.1)); draw(); }

  function initTimeline(tl) {
    let drag = null;
    const tAt = e => { const r = tl.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * st.dur; };
    tl.addEventListener('pointerdown', e => {
      if (!st.dur) return;
      drag = e.target.classList.contains('ce-h-in') ? 'in' : e.target.classList.contains('ce-h-out') ? 'out' : 'seek';
      tl.setPointerCapture(e.pointerId); tl.classList.add('dragging');
      move(e); e.preventDefault(); tl.focus({ preventScroll: true });
    });
    const move = e => {
      if (!drag) return;
      const t = tAt(e), v = q('.ce-video');
      if (drag === 'in') { setIn(t); v.currentTime = st.start; }
      else if (drag === 'out') { setOut(t); v.currentTime = st.end; }
      else { v.currentTime = t; draw(); }
    };
    tl.addEventListener('pointermove', move);
    const up = () => { drag = null; tl.classList.remove('dragging'); };
    tl.addEventListener('pointerup', up); tl.addEventListener('pointercancel', up);
  }

  function onKey(e) {
    if (!modal || modal.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (cur && !q('.ce-ed').hidden) showLib(); else close(); return; }
    if (q('.ce-ed').hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    const a = document.activeElement;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'checkbox')) return;
    const v = q('.ce-video'), step = e.shiftKey ? 1 : 1 / 30;
    let hit = true;
    switch (e.key) {
      case ' ': case 'k': togglePlay(); break;
      case 'i': case 'I': setIn(v.currentTime); break;
      case 'o': case 'O': setOut(v.currentTime); break;
      case 'ArrowLeft': v.pause(); v.currentTime = Math.max(0, v.currentTime - step); break;
      case 'ArrowRight': v.pause(); v.currentTime = Math.min(st.dur, v.currentTime + step); break;
      case 'Home': v.currentTime = st.start; break;
      case 'End': v.currentTime = st.end; break;
      default: hit = false;
    }
    if (hit) { e.preventDefault(); e.stopPropagation(); draw(); }
  }

  // ---------- export ----------
  function setBusy(on, frac) {
    q('.ce-prog').hidden = !on; q('.ce-cancel').hidden = !on;
    if (on) { const p = Math.round((frac || 0) * 100); q('.ce-prog-bar').style.width = p + '%'; q('.ce-prog-t').textContent = p + '%'; }
    syncOpts();
  }
  async function doExport() {
    if (!cur || job || !ffmpeg) return;
    const opts = { format: st.fmt, precise: st.fmt === 'gif' ? true : st.precise, title: q('.ce-fname').value.trim() };
    const r = await LW.call('ce_export', cur.path, st.start, st.end, opts);
    if (!r.ok) return LW.toast('Export failed: ' + r.error, 'error');
    job = { id: r.job, out: r.out }; setBusy(true, 0);
  }
  function onEvent(ev) {
    if (!ev || ev.type !== 'ce_progress' || !job || ev.job !== job.id) return;
    if (ev.state === 'running') { setBusy(true, ev.progress); return; }
    job = null; if (modal) setBusy(false);
    if (ev.state === 'done') doneToast(ev.path, ev.size);
    else if (ev.state === 'cancelled') LW.toast('Export cancelled');
    else LW.toast('Export failed: ' + (ev.error || 'unknown error'), 'error');
  }
  function doneToast(path, size) {
    const host = document.getElementById('toasts'); if (!host) { LW.toast('Exported → ' + path); return; }
    const t = LW.el('div', 'toast clip-toast ce-toast');
    t.innerHTML = `<div><b>Exported</b>${size ? ' (' + fmtSize(size) + ')' : ''} → <span class="clip-path">${LW.esc(path)}</span></div>`;
    const b = LW.el('button', 'clip-reveal', 'Show in folder'); b.onclick = () => reveal(path);
    t.appendChild(b); host.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 7000);
  }

  // ---------- entry points ----------
  function addEntryPoints() {
    const menu = document.querySelector('.clip-menu');
    if (menu && !menu.querySelector('.ce-libbtn')) {
      const b = LW.el('button', 'ce-libbtn', 'Clips library…'); b.type = 'button';
      b.onclick = e => { e.stopPropagation(); menu.classList.remove('open'); showLib(); };
      menu.appendChild(b);
    }
    const rl = document.getElementById('recList');
    const h = rl && rl.previousElementSibling;
    if (h && !document.getElementById('ceHomeBtn')) {
      const b = LW.el('button', 'chip ce-homebtn', ICON_EDIT + 'Clips'); b.id = 'ceHomeBtn'; b.type = 'button';
      b.title = 'Open the clip library / editor';
      b.onclick = showLib;
      h.appendChild(b);
    }
  }

  function go(lw) {
    LW = lw;
    addEntryPoints(); setTimeout(addEntryPoints, 500);
    LW.on('event', onEvent);
    LW.on('itemOpened', addEntryPoints);
    LW.on('clipSaved', (r, toastEl) => {
      if (!r || !r.path) return;
      const b = LW.el('button', 'clip-reveal ce-editbtn', 'Edit'); b.type = 'button';
      b.onclick = () => openEditor(r.path);
      const rev = toastEl && toastEl.querySelector('.clip-reveal');
      if (rev) { const row = LW.el('div', 'ce-toast-row'); rev.replaceWith(row); row.appendChild(rev); row.appendChild(b); }
      else if (toastEl) toastEl.appendChild(b);
    });
    LW.ceOpen = openEditor; LW.ceLibrary = showLib;
  }
  if (window.LW && window.LW.ready) window.LW.ready(go);
  else (window.LW = window.LW || {}, (window.LW._ready = window.LW._ready || []).push(go));
})();

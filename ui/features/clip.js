/* clip feature – "clip the last N seconds" (backend/features/clip.py) */
(function () {
  'use strict';
  const LENS = [15, 30, 60, 120];
  const KEY = 'lw.clipLen';
  let len = 30, avail = 0, busy = false, btn = null, menu = null, pollT = null, mockMode = false;
  try { const v = parseInt(localStorage.getItem(KEY), 10); if (LENS.includes(v)) len = v; } catch (e) {}

  const SCISSORS = '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/></svg>';

  function behind(LW) {
    const v = LW.video; if (!v) return 0;
    const t = v.currentTime, b = v.buffered;
    for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.5 && t <= b.end(i) + 0.5) return Math.max(0, b.end(i) - t);
    return 0;
  }

  function setAvail(s) {
    avail = s || 0;
    if (!btn) return;
    const off = mockMode || avail < 1;
    btn.classList.toggle('clip-off', off);
    btn.title = mockMode ? 'Clipping needs the desktop app' :
      off ? 'Clip (x) – nothing buffered yet' : `Clip last ${len}s (x) · ${Math.floor(avail)}s buffered`;
    if (menu) menu.querySelectorAll('button[data-s]').forEach(b => {
      const s = +b.dataset.s; b.classList.toggle('sel', s === len); b.classList.toggle('clip-short', !off && s > avail + 2);
    });
  }

  async function poll(LW) {
    if (!LW.S.item) { setAvail(0); return; }
    const r = await LW.call('clip_status', LW.S.item.id);
    if (!r.ok) { mockMode = /unavailable/.test(r.error || ''); setAvail(0); return; }
    setAvail(r.seconds);
  }
  function startPoll(LW) { stopPoll(); poll(LW); pollT = setInterval(() => poll(LW), 3000); }
  function stopPoll() { if (pollT) clearInterval(pollT); pollT = null; }

  function flash(LW) {
    const p = document.getElementById('player'); if (!p) return;
    const f = LW.el('div', 'clip-flash'); p.appendChild(f);
    setTimeout(() => f.remove(), 700);
  }

  function savedToast(LW, r) {
    const host = document.getElementById('toasts'); if (!host) { LW.toast('Clip saved → ' + r.path); return; }
    const t = LW.el('div', 'toast clip-toast');
    t.innerHTML = `<div><b>Clip saved</b> (${Math.round(r.seconds)}s) → <span class="clip-path">${LW.esc(r.path)}</span></div>`;
    const b = LW.el('button', 'clip-reveal', 'Show in folder');
    b.onclick = () => LW.call('clip_reveal', r.path).then(x => { if (!x.ok) LW.toast(x.error, 'error'); });
    t.appendChild(b); host.appendChild(t);
    LW.emit('clipSaved', { path: r.path, seconds: r.seconds }, t); // used by clipedit (adds "Edit")
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 7000);
  }

  async function doClip(LW, secs) {
    if (busy || !LW.S.item) return;
    if (mockMode) { LW.toast('Clipping needs the desktop app', 'error'); return; }
    if (avail < 1) { LW.toast('Nothing buffered yet – wait a few seconds', 'error'); return; }
    busy = true; btn && btn.classList.add('busy'); flash(LW);
    const r = await LW.call('clip_save', LW.S.item.id, secs || len, behind(LW));
    busy = false; btn && btn.classList.remove('busy');
    if (r.ok) savedToast(LW, r); else LW.toast('Clip failed: ' + r.error, 'error');
  }

  function closeMenu() { menu && menu.classList.remove('open'); }

  LW_ready();
  function LW_ready() {
    const go = LW => {
      const rec = document.getElementById('cRecord');
      if (!rec || document.getElementById('cClip')) return;
      const wrap = LW.el('div', 'menu-wrap clip-wrap');
      btn = LW.el('button', 'cbtn clip-btn clip-off', SCISSORS); btn.id = 'cClip';
      menu = LW.el('div', 'menu clip-menu');
      menu.innerHTML = '<div class="clip-head">Clip the last…</div>' +
        LENS.map(s => `<button data-s="${s}">${s < 60 ? s + ' s' : s / 60 + ' min'}</button>`).join('') +
        '<div class="clip-hint">Press <kbd>x</kbd> to clip</div>';
      wrap.appendChild(btn); wrap.appendChild(menu);
      rec.parentNode.insertBefore(wrap, rec);
      btn.onclick = e => {
        e.stopPropagation();
        const open = !menu.classList.contains('open');
        document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open'));
        if (open) { menu.classList.add('open'); poll(LW); }
      };
      menu.onclick = e => {
        e.stopPropagation();
        const b = e.target.closest('button[data-s]'); if (!b) return;
        len = +b.dataset.s; try { localStorage.setItem(KEY, String(len)); } catch (er) {}
        closeMenu(); setAvail(avail); doClip(LW, len);
      };
      document.addEventListener('click', closeMenu);
      document.addEventListener('keydown', e => {
        if (e.key !== 'x' && e.key !== 'X') return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const a = document.activeElement;
        if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
        const vp = document.getElementById('viewPlayer');
        if (!vp || !vp.classList.contains('active') || document.querySelector('.modal:not([hidden])')) return;
        e.preventDefault(); doClip(LW, len);
      });
      LW.on('itemOpened', () => { setAvail(0); startPoll(LW); });
      LW.on('playing', () => startPoll(LW));
      LW.on('stopped', () => { stopPoll(); setAvail(0); });
      if (!window.pywebview) mockMode = true;
      setAvail(0);
    };
    if (window.LW && window.LW.ready) window.LW.ready(go);
    else (window.LW = window.LW || {}, (window.LW._ready = window.LW._ready || []).push(go));
  }
})();

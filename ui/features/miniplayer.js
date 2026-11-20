(function () {
  'use strict';
  const LW = window.LW;
  if (!LW) return;
  let mini = false, busy = false;
  const ICON = '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><rect x="11" y="11" width="9" height="7" rx="1" fill="currentColor"/></svg>';

  function isTyping(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  function syncUi() {
    const v = LW.video;
    const bar = document.getElementById('mini_bar');
    if (!bar || !v) return;
    bar.querySelector('#mini_play').textContent = v.paused ? '▶' : '❚❚';
    bar.querySelector('#mini_mute').textContent = (v.muted || v.volume === 0) ? '🔇' : '🔊';
    bar.querySelector('#mini_vol').value = v.muted ? 0 : v.volume;
  }

  // Move #player to <body> while mini: position:fixed is otherwise relative to ancestors that
  // have zoom/transform (font scale, view animations), so the rest of the app showed through.
  let home = null;
  function detachPlayer() {
    const p = document.getElementById('player');
    if (!p || p.parentNode === document.body) return;
    home = { parent: p.parentNode, next: p.nextSibling };
    document.body.appendChild(p);
  }
  function restorePlayer() {
    const p = document.getElementById('player');
    if (p && home && home.parent) home.parent.insertBefore(p, home.next && home.next.parentNode === home.parent ? home.next : null);
    home = null;
  }

  async function enter() {
    if (mini || busy) return;
    if (!document.getElementById('viewPlayer').classList.contains('active')) { LW.toast('Open a stream first', 'warn'); return; }
    busy = true;
    try {
      if (LW.fsEl) LW.exitFs();
      detachPlayer();
      document.body.classList.add('mini-mode');
      mini = true; syncUi();
      if (window.pywebview) {
        const r = await LW.call('mini_enter');
        if (r && !r.ok && r.error) console.warn('mini_enter:', r.error);
      }
    } finally { busy = false; }
  }

  async function exit() {
    if (!mini || busy) return;
    busy = true;
    try {
      if (window.pywebview) { try { await LW.call('mini_exit'); } catch (_) {} }
      document.body.classList.remove('mini-mode');
      restorePlayer();
      mini = false;
    } finally { busy = false; }
  }

  function toggle() { return mini ? exit() : enter(); }

  function build() {
    const player = document.getElementById('player');
    if (!player || document.getElementById('mini_bar')) return;
    // drag region covering the video (pywebview native drag)
    const drag = LW.el('div', 'mini_drag pywebview-drag-region');
    drag.id = 'mini_drag';
    drag.addEventListener('dblclick', e => { e.preventDefault(); exit(); });
    player.appendChild(drag);

    const bar = LW.el('div', 'mini_bar');
    bar.id = 'mini_bar';
    bar.innerHTML =
      '<button class="mini_btn" id="mini_play" title="Play/Pause"></button>' +
      '<button class="mini_btn" id="mini_mute" title="Mute"></button>' +
      '<input type="range" id="mini_vol" min="0" max="1" step="0.01">' +
      '<span class="mini_sp"></span>' +
      '<button class="mini_btn" id="mini_restore" title="Restore (I / double-click)">⤢</button>';
    player.appendChild(bar);
    bar.addEventListener('dblclick', e => e.stopPropagation());
    const v = LW.video;
    bar.querySelector('#mini_play').onclick = () => { if (v.paused) v.play().catch(() => {}); else v.pause(); };
    bar.querySelector('#mini_mute').onclick = () => { v.muted = !v.muted; };
    bar.querySelector('#mini_vol').oninput = e => { v.volume = +e.target.value; v.muted = v.volume === 0; };
    bar.querySelector('#mini_restore').onclick = exit;
    ['play', 'pause', 'volumechange'].forEach(ev => v.addEventListener(ev, syncUi));

    const row = document.querySelector('#controls .ctrl-row');
    if (row && !document.getElementById('mini_btn')) {
      const b = LW.el('button', 'cbtn', ICON);
      b.id = 'mini_btn'; b.title = 'Mini player (i)';
      b.onclick = toggle;
      const full = document.getElementById('cFull');
      row.insertBefore(b, full && full.parentNode === row ? full : null);
    }
  }

  document.addEventListener('keydown', e => {
    if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'i' || e.key === 'I') { e.preventDefault(); toggle(); }
    else if (e.key === 'Escape' && mini) { exit(); }
  });

  LW.on('stopped', () => { if (mini) exit(); });
  LW.ready(build);
  if (document.readyState !== 'loading') build(); else document.addEventListener('DOMContentLoaded', build);
  LW.mini = { enter, exit, toggle, active: () => mini };
})();

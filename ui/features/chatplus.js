/* chatplus feature – live chat extras on top of ui/features/chat.js:
   - highlight messages mentioning settings.chat_mention_name
   - per-user mute (click a username -> menu), stored in settings.chat_muted
   - emote picker (7TV/BTTV/FFZ from LW.chat.emotes + Twitch emotes seen in chat); click copies code.
   (VOD chat replay is not possible without Twitch's private GQL client id – see backend/features/chatplus.py.) */
(function () {
  'use strict';
  const LW = window.LW;
  if (!LW) return;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = d => `<svg viewBox="0 0 24 24">${d}</svg>`;
  const P = { name: '', re: null, muted: new Set(), seen: new Map() };
  let body, head, picker, menu, extras, obs;

  // ---------- settings ----------
  function apply(r) {
    if (!r || !r.ok) return;
    P.name = r.mention_name || '';
    P.muted = new Set((r.muted || []).map(s => s.toLowerCase()));
    const n = P.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    P.re = n ? new RegExp('(^|[^\\w])@?' + n + '(?![\\w])', 'i') : null;
    if (body) body.querySelectorAll('.msg[data-user]').forEach(decorate);
    if (extras && !extras.hidden) fillExtras();
  }
  function load() {
    LW.call('cp_get').then(r => {
      if (r && r.ok) return apply(r);
      if (!window.pywebview) { // mock mode: keep in localStorage
        let d = {}; try { d = JSON.parse(localStorage.getItem('cp_mock') || '{}'); } catch (e) { /* ignore */ }
        apply({ ok: true, mention_name: d.n || '', muted: d.m || [] });
      }
    });
  }
  function saveMock() { try { localStorage.setItem('cp_mock', JSON.stringify({ n: P.name, m: [...P.muted] })); } catch (e) { /* ignore */ } }
  async function setMute(login, on) {
    const r = await LW.call('cp_mute', login, on);
    if (r && r.ok) apply(r);
    else { if (on) P.muted.add(login); else P.muted.delete(login); saveMock(); apply({ ok: true, mention_name: P.name, muted: [...P.muted] }); }
    LW.toast((on ? 'Muted ' : 'Unmuted ') + login);
  }
  async function setName(n) {
    const r = await LW.call('cp_set_mention', n);
    if (r && r.ok) apply(r); else { P.name = n; saveMock(); apply({ ok: true, mention_name: n, muted: [...P.muted] }); }
  }

  // ---------- message decoration ----------
  function decorate(m) {
    const u = m.dataset.user;
    m.classList.toggle('cp-muted', P.muted.has(u));
    const t = m.querySelector('.lwc-text');
    m.classList.toggle('cp-mention', !!(P.re && t && P.re.test(t.textContent + ' ' + [...t.querySelectorAll('img')].map(i => i.alt).join(' '))));
    if (t) t.querySelectorAll('img.lwc-emote[src*="jtvnw.net"]').forEach(i => { if (!P.seen.has(i.alt)) P.seen.set(i.alt, i.src); });
  }

  // ---------- user menu ----------
  function closeMenu() { if (menu) { menu.remove(); menu = null; } }
  function openMenu(login, x, y) {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'cp-menu';
    const muted = P.muted.has(login);
    menu.innerHTML = `<div class="cp-menu-h">${esc(login)}</div>
      <button data-a="mute">${muted ? 'Unmute user' : 'Mute user'}</button>
      <button data-a="copy">Copy username</button>`;
    menu.onclick = e => {
      e.stopPropagation();
      const a = e.target.dataset.a; if (!a) return;
      if (a === 'mute') setMute(login, !muted);
      else copy(login, 'Copied ' + login);
      closeMenu();
    };
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  }
  function onUserClick(e) {
    const b = e.target.closest('.msg[data-user] > b');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    openMenu(b.parentElement.dataset.user, e.clientX, e.clientY);
  }

  function copy(text, msg) {
    const done = () => LW.toast(msg || ('Copied ' + text));
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallback());
    else fallback();
    function fallback() {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { LW.toast('Copy failed', 'error'); }
      ta.remove();
    }
  }

  // ---------- emote picker ----------
  function allEmotes() {
    const out = [];
    const em = (LW.chat && LW.chat.emotes) || {};
    for (const k in em) out.push([k, em[k][0], em[k][1]]);
    P.seen.forEach((u, k) => out.push([k, u, 'Twitch']));
    return out;
  }
  function renderPicker() {
    const q = picker.querySelector('input').value.trim().toLowerCase();
    const prov = picker.querySelector('.cp-tabs .on').dataset.p;
    let list = allEmotes().filter(e => (prov === 'all' || e[2] === prov) && (!q || e[0].toLowerCase().includes(q)));
    list.sort((a, b) => a[0].localeCompare(b[0]));
    const total = list.length;
    list = list.slice(0, 600);
    const grid = picker.querySelector('.cp-grid');
    grid.innerHTML = list.length ? list.map(e => `<button class="cp-emo" data-c="${esc(e[0])}" title="${esc(e[0])} (${esc(e[2])}) – click to copy"><img src="${esc(e[1])}" alt="${esc(e[0])}" loading="lazy" decoding="async"></button>`).join('')
      : `<div class="cp-empty">${prov === 'Twitch' ? 'Twitch emotes appear here once seen in chat' : 'No emotes'}</div>`;
    picker.querySelector('.cp-count').textContent = total > list.length ? `${list.length} of ${total}` : `${total}`;
  }
  function buildPicker() {
    picker = document.createElement('div');
    picker.className = 'cp-picker'; picker.hidden = true;
    picker.innerHTML = `<div class="cp-row"><input type="search" placeholder="Search emotes…" spellcheck="false"><span class="cp-count"></span></div>
      <div class="cp-tabs">${['all', '7TV', 'BTTV', 'FFZ', 'Twitch'].map((p, i) => `<button data-p="${p}"${i ? '' : ' class="on"'}>${p === 'all' ? 'All' : p}</button>`).join('')}</div>
      <div class="cp-grid"></div>
      <div class="cp-hint">Chat is read-only – clicking an emote copies its code to the clipboard.</div>`;
    picker.addEventListener('click', e => {
      e.stopPropagation();
      const t = e.target.closest('.cp-tabs button');
      if (t) { picker.querySelectorAll('.cp-tabs button').forEach(b => b.classList.toggle('on', b === t)); renderPicker(); return; }
      const em = e.target.closest('.cp-emo');
      if (em) copy(em.dataset.c, 'Copied ' + em.dataset.c + ' to clipboard');
    });
    picker.querySelector('input').addEventListener('input', renderPicker);
    return picker;
  }

  // ---------- extras panel (mention name + muted list) ----------
  function fillExtras() {
    extras.querySelector('input').value = P.name;
    const ul = extras.querySelector('.cp-mlist');
    ul.innerHTML = P.muted.size ? [...P.muted].sort().map(u => `<li><span>${esc(u)}</span><button data-u="${esc(u)}" title="Unmute">Unmute</button></li>`).join('') : '<li class="cp-empty">No muted users. Click a username in chat to mute.</li>';
  }
  function buildExtras() {
    extras = document.createElement('div');
    extras.className = 'cp-picker cp-extras'; extras.hidden = true;
    extras.innerHTML = `<label class="cp-l">Highlight mentions of <input type="text" placeholder="your username" spellcheck="false" maxlength="40"></label>
      <div class="cp-l">Muted users</div><ul class="cp-mlist"></ul>`;
    let t;
    extras.querySelector('input').addEventListener('input', e => { clearTimeout(t); const v = e.target.value; t = setTimeout(() => setName(v), 500); });
    extras.addEventListener('click', e => { e.stopPropagation(); const b = e.target.closest('button[data-u]'); if (b) setMute(b.dataset.u, false); });
    return extras;
  }

  function toggle(p, btn, force) {
    const show = force === undefined ? p.hidden : force;
    [picker, extras].forEach(x => { if (x && x !== p) x.hidden = true; });
    head.querySelectorAll('.cp-hbtn').forEach(b => b.classList.remove('on'));
    p.hidden = !show; if (show) btn.classList.add('on');
    if (show && p === picker) { renderPicker(); p.querySelector('input').focus(); }
    if (show && p === extras) fillExtras();
  }

  // ---------- mount (chat.js mounts lazily on first connect) ----------
  function mount() {
    const root = document.getElementById('chat');
    if (!root || !root.classList.contains('lwc') || root.dataset.cp) return !!(root && root.dataset.cp);
    root.dataset.cp = '1';
    body = document.getElementById('chatBody');
    head = root.querySelector('.chat-head');
    const ref = document.getElementById('lwcGear') || document.getElementById('btnChatClose');
    const mk = (title, icon) => { const b = document.createElement('button'); b.className = 'icon-btn sm lwc-hbtn cp-hbtn'; b.title = title; b.innerHTML = svg(icon); head.insertBefore(b, ref || null); return b; };
    const eb = mk('Emote picker (click an emote to copy its code)', '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01"/>');
    const xb = mk('Mentions & muted users', '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9"/>');
    root.insertBefore(buildPicker(), body);
    root.insertBefore(buildExtras(), body);
    eb.onclick = e => { e.stopPropagation(); toggle(picker, eb); };
    xb.onclick = e => { e.stopPropagation(); toggle(extras, xb); };
    document.addEventListener('click', () => { closeMenu(); if (!picker.hidden) toggle(picker, eb, false); if (!extras.hidden) toggle(extras, xb, false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
    body.addEventListener('click', onUserClick, true);
    body.addEventListener('contextmenu', e => { const m = e.target.closest('.msg[data-user]'); if (!m) return; e.preventDefault(); openMenu(m.dataset.user, e.clientX, e.clientY); });
    obs = new MutationObserver(recs => { for (const r of recs) r.addedNodes.forEach(n => { if (n.nodeType === 1 && n.dataset && n.dataset.user) decorate(n); }); });
    obs.observe(body, { childList: true });
    body.querySelectorAll('.msg[data-user]').forEach(decorate);
    return true;
  }
  function tryMount(n) { if (!mount() && n > 0) setTimeout(() => tryMount(n - 1), 300); }

  LW.ready(() => { load(); tryMount(10); });
  LW.on('itemOpened', () => tryMount(20));
})();

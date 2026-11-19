/* channel feature – channel profile page, past broadcasts/clips, sidebar search. See CONTRACT.md 'Features' */
(function () {
  'use strict';
  const NAME_RE = /^[A-Za-z0-9_]{2,25}$/;
  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>',
    heart: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-4.4-9.3-9C1 8.5 3 5 6.5 5c2 0 3.4 1.1 4.2 2.4h2.6C14.1 6.1 15.5 5 17.5 5 21 5 23 8.5 21.3 12 19 16.6 12 21 12 21z"/></svg>',
    ext: '<svg viewBox="0 0 24 24"><path d="M7 17 17 7M8 7h9v9"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>'
  };
  const fmtNum = n => n == null ? '' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
  const ago = t => { if (!t) return ''; const d = Date.now() / 1000 - t; if (d < 3600) return Math.max(1, Math.floor(d / 60)) + 'm ago'; if (d < 86400) return Math.floor(d / 3600) + 'h ago'; if (d < 86400 * 30) return Math.floor(d / 86400) + 'd ago'; if (d < 86400 * 365) return Math.floor(d / 86400 / 30) + 'mo ago'; return Math.floor(d / 86400 / 365) + 'y ago'; };

  // login for an item, or null if it's not a twitch channel/VOD we can map
  function loginOf(it) {
    if (!it) return null;
    if (it.platform === 'twitch' && it.kind === 'channel' && String(it.id).startsWith('twitch:')) return it.id.split(':')[1];
    if (it.platform === 'twitch' && it.author && NAME_RE.test(it.author)) return it.author.toLowerCase();
    return null;
  }

  LW.ready(function (LW) {
    const { $, el, esc, call, toast, S } = LW;
    const mock = !window.pywebview;
    const C = { login: null, info: null, tab: 'home', kind: 'archive', cursor: null, busy: false, token: 0, count: 0 };

    // ---------------- view ----------------
    const vp = $('#viewPlayer');
    const view = el('section', 'view ch-view'); view.id = 'viewChannel';
    vp.parentElement.appendChild(view);

    function skeletonPage() {
      return `<div class="ch-banner skel"></div><div class="ch-head"><div class="ch-av skel"></div><div class="ch-hmeta"><div class="skel skel-line" style="width:220px;height:22px"></div><div class="skel skel-line" style="width:140px"></div></div></div>
        <div class="ch-body"><div class="ch-grid">${'<div class="card skel-card"><div class="thumb skel"></div><div class="skel skel-line" style="width:80%"></div><div class="skel skel-line" style="width:50%"></div></div>'.repeat(4)}</div></div>`;
    }

    async function openChannel(login, hint) {
      if (!login) return;
      login = String(login).toLowerCase();
      const tok = ++C.token;
      if (LW.S.item) LW.stopPlayback();
      Object.assign(C, { login, info: null, tab: 'home', kind: 'archive', cursor: null, busy: false, count: 0 });
      view.innerHTML = skeletonPage();
      view.scrollTop = 0;
      LW.showView('Channel');
      view.classList.remove('ch-in'); void view.offsetWidth; view.classList.add('ch-in');
      document.title = login + ' · Lightweight';
      let r = await call('channel_info', login);
      if (tok !== C.token) return;
      if (!r.ok) {
        if (mock || /channel_info|not a function|undefined/i.test(r.error || '')) r = mockInfo(login, hint);
        else { view.innerHTML = `<div class="ch-body"><div class="empty">${esc(r.error || 'Could not load channel')}</div></div>`; return; }
      }
      C.info = r;
      render();
    }

    function mockInfo(login, hint) {
      const it = [...S.follows, ...S.history].find(x => loginOf(x) === login) || hint ||
        { id: 'twitch:' + login, platform: 'twitch', kind: 'channel', url: 'https://www.twitch.tv/' + login, author: login, title: login, is_live: false };
      return { ok: true, login, display_name: it.author || login, avatar: it.avatar || null, banner: null, bio: 'Mock bio for ' + login + '.', links: [{ label: 'Channel', url: 'https://www.twitch.tv/' + login }], item: it, mock: true };
    }

    function isFollowed(id) { return S.follows.some(f => f.id === id); }

    function render() {
      const i = C.info, it = i.item || {}, name = i.display_name || C.login;
      const live = !!it.is_live;
      const bg = i.banner ? `center/cover url("${i.banner}")` : i.avatar ? '' : LW.avBg(name);
      view.innerHTML = `
        <div class="ch-banner${i.banner ? '' : ' gen'}" style="${bg ? 'background:' + esc(bg) : ''}">${!i.banner && i.avatar ? `<div class="ch-blur" style="background-image:url('${esc(i.avatar)}')"></div>` : ''}<div class="ch-fade"></div></div>
        <div class="ch-head">
          <div class="ch-av${live ? ' live' : ''}" style="background:${i.avatar ? `center/cover url('${esc(i.avatar)}')` : LW.avBg(name)}">${i.avatar ? '' : esc(name[0].toUpperCase())}${live ? '<span class="ch-livetag">LIVE</span>' : ''}</div>
          <div class="ch-hmeta">
            <h1 class="ch-name">${esc(name)}</h1>
            <div class="ch-sub">${live ? `<span class="live-dot"></span><b>Live</b>${it.viewers != null ? ' · ' + esc(fmtNum(it.viewers)) + ' viewers' : ''}${it.category ? ' · ' + esc(it.category) : ''}` : '<span class="muted">Offline</span>'}</div>
          </div>
          <div class="ch-actions">
            ${live ? `<button class="btn grad" data-act="watch">${ICON.play}Watch live</button>` : `<button class="btn ghost" data-act="watch" title="Open channel in player">${ICON.play}Open</button>`}
            <button class="btn ${isFollowed(it.id) ? 'on' : 'ghost'}" data-act="follow">${ICON.heart}<span>${isFollowed(it.id) ? 'Following' : 'Follow'}</span></button>
          </div>
        </div>
        <div class="ch-tabs" role="tablist">
          ${['home', 'videos', 'clips', 'about'].map(t => `<button class="ch-tab${C.tab === t ? ' on' : ''}" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
          <span class="ch-ink"></span>
        </div>
        <div class="ch-body" id="chBody"></div>`;
      view.querySelector('[data-act="watch"]').onclick = () => LW.openInput(it.url || C.login, it);
      view.querySelector('[data-act="follow"]').onclick = toggleFollow;
      view.querySelectorAll('.ch-tab').forEach(b => b.onclick = () => setTab(b.dataset.tab));
      setTab(C.tab, true);
    }

    async function toggleFollow(e) {
      const it = C.info.item, b = e.currentTarget, on = isFollowed(it.id);
      b.disabled = true;
      const r = await call(on ? 'unfollow' : 'follow', it.id);
      b.disabled = false;
      if (!r.ok) return toast(r.error || 'Failed', 'error');
      if (on) S.follows = S.follows.filter(f => f.id !== it.id); else S.follows.push(Object.assign({}, it, { avatar: C.info.avatar || it.avatar }));
      b.classList.toggle('on', !on); b.classList.toggle('ghost', on); b.querySelector('span').textContent = on ? 'Follow' : 'Following';
      LW.renderSidebar();
      toast(on ? 'Unfollowed ' + (C.info.display_name || C.login) : 'Following ' + (C.info.display_name || C.login));
    }

    function moveInk() {
      const on = view.querySelector('.ch-tab.on'), ink = view.querySelector('.ch-ink');
      if (on && ink) { ink.style.width = on.offsetWidth + 'px'; ink.style.transform = `translateX(${on.offsetLeft}px)`; }
    }

    function setTab(tab, first) {
      C.tab = tab; C.cursor = null; C.count = 0; C.busy = false; C.gen = (C.gen || 0) + 1;
      view.querySelectorAll('.ch-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
      requestAnimationFrame(moveInk);
      const body = $('#chBody'); body.innerHTML = ''; body.classList.remove('ch-fadein'); void body.offsetWidth; body.classList.add('ch-fadein');
      const i = C.info, it = i.item || {};
      if (tab === 'home') {
        if (it.is_live) {
          const lv = el('div', 'ch-live');
          lv.innerHTML = `<div class="ch-live-thumb" style="background-image:url('${esc(it.thumbnail || '')}')"><span class="tag">LIVE</span><div class="ch-live-play">${ICON.play}</div></div>
            <div class="ch-live-meta"><div class="ch-live-title">${esc(it.title || '')}</div><div class="card-cat">${esc(it.category || '')}</div>${it.viewers != null ? `<div class="muted">${esc(fmtNum(it.viewers))} watching now</div>` : ''}<button class="btn grad">${ICON.play}Watch live</button></div>`;
          lv.onclick = () => LW.openInput(it.url || C.login, it);
          body.appendChild(lv);
        }
        body.appendChild(aboutBox(true));
        body.appendChild(el('h3', 'ch-h', 'Recent broadcasts'));
        loadVideos(body, 'archive', 8, true);
      } else if (tab === 'videos') {
        const f = el('div', 'ch-filter');
        [['archive', 'Past broadcasts'], ['highlight', 'Highlights'], ['upload', 'Uploads']].forEach(([k, l]) => {
          const b = el('button', 'chip' + (C.kind === k ? ' on' : ''), esc(l));
          b.onclick = () => { C.kind = k; setTab('videos'); };
          f.appendChild(b);
        });
        body.appendChild(f);
        loadVideos(body, C.kind);
      } else if (tab === 'clips') {
        loadVideos(body, 'clips');
      } else {
        body.appendChild(aboutBox(false));
      }
      if (first) return;
    }

    function aboutBox(compact) {
      const i = C.info, box = el('div', 'ch-about' + (compact ? ' compact' : ''));
      const bio = i.bio ? esc(i.bio).replace(/(https?:\/\/[^\s<]+[^\s<.,)!?])/g, '<a href="#" data-url="$1">$1</a>') : '<span class="muted">' + (i.item && i.item.is_live ? 'Bio shows when the channel is offline.' : 'No bio yet.') + '</span>';
      box.innerHTML = `<div class="ch-about-h">About ${esc(i.display_name || C.login)}</div><div class="ch-bio">${bio}</div>
        <div class="ch-links">${(i.links || []).map(l => `<button class="chip" data-url="${esc(l.url)}">${esc(l.label)}${ICON.ext}</button>`).join('')}</div>`;
      box.addEventListener('click', e => { const a = e.target.closest('[data-url]'); if (!a) return; e.preventDefault(); e.stopPropagation(); call('open_url', a.dataset.url); });
      return box;
    }

    function vodCard(v) {
      const c = el('div', 'card ch-vod');
      const h = S.history.find(x => x.id === v.id);
      const prog = h && h.progress && (h.duration || v.duration) ? Math.min(100, h.progress / (h.duration || v.duration) * 100) : 0;
      const th = el('div', 'thumb');
      const img = el('div', 'thumb-img');
      if (v.thumbnail) img.style.backgroundImage = `url("${v.thumbnail}")`; else img.style.background = LW.avBg(v.title || v.id);
      th.appendChild(img);
      if (v.duration) th.appendChild(el('span', 'tag r', esc(LW.fmtTime(v.duration))));
      if (v.views != null) th.appendChild(el('span', 'viewers', esc(fmtNum(v.views)) + ' views'));
      if (v.created_at) th.appendChild(el('span', 'tag', esc(ago(v.created_at))));
      if (prog) th.appendChild(el('div', 'prog', `<i style="width:${prog}%"></i>`));
      th.appendChild(el('div', 'ch-play', ICON.play));
      c.appendChild(th);
      c.appendChild(el('div', 'card-meta', `<div class="card-text"><div class="card-title" title="${esc(v.title)}">${esc(v.title || 'Untitled')}</div><div class="card-sub">${esc(v.author || '')}${h && prog ? ' · <span class="ch-resume">Resume ' + esc(LW.fmtTime(h.progress)) + '</span>' : ''}</div></div>`));
      c.onclick = () => LW.openInput(v.url, { title: v.title, author: v.author, platform: 'twitch', kind: v.kind, thumbnail: v.thumbnail, id: v.id });
      return c;
    }

    function mockVideos(kind) {
      const out = [];
      for (let k = 0; k < 6; k++) out.push({ id: (kind === 'clips' ? 'clip:' : 'twitch-vod:') + (1000 + k), title: (kind === 'clips' ? 'Mock clip ' : 'Mock broadcast ') + (k + 1), url: 'https://www.twitch.tv/videos/' + (1000 + k), thumbnail: null, duration: kind === 'clips' ? 30 : 3600 * (k + 1), created_at: Date.now() / 1000 - 86400 * (k + 1), views: 1234 * (k + 1), author: C.login, kind: kind === 'clips' ? 'clip' : 'vod' });
      return out;
    }

    async function loadVideos(body, kind, limit, compact) {
      const gen = C.gen;
      let grid = body.querySelector('.ch-grid');
      if (!grid) { grid = el('div', 'ch-grid'); body.appendChild(grid); }
      let more = body.querySelector('.ch-more');
      const skel = el('div', 'ch-skels', '<div class="card skel-card"><div class="thumb skel"></div><div class="skel skel-line" style="width:80%"></div><div class="skel skel-line" style="width:50%"></div></div>'.repeat(compact ? 4 : 8));
      skel.style.display = 'contents';
      grid.appendChild(skel);
      C.busy = true;
      let r = await call('channel_videos', C.login, kind, C.cursor);
      if (gen !== C.gen) return;
      if (!r.ok && (mock || C.info.mock)) r = { ok: true, items: C.cursor ? [] : mockVideos(kind), cursor: null };
      C.busy = false; skel.remove();
      if (!r.ok) { if (!C.count) grid.appendChild(el('div', 'empty', esc(r.error || 'Could not load videos'))); else toast(r.error, 'error'); return; }
      let items = r.items || [];
      if (limit) items = items.slice(0, limit);
      items.forEach((v, n) => { const c = vodCard(v); c.style.animationDelay = Math.min(n, 12) * 25 + 'ms'; grid.appendChild(c); });
      C.count += items.length;
      if (!C.count) {
        const label = kind === 'clips' ? 'clips' : kind === 'archive' ? 'past broadcasts' : kind + 's';
        grid.appendChild(el('div', 'empty', `No ${label} found.` + (r.source === 'ytdlp' ? ' (Without Twitch API credentials, listings use yt-dlp, which may not return results. Add TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET to .env for reliable results.)' : '')));
      }
      C.cursor = r.cursor || null;
      if (compact) {
        if (C.count && (r.cursor || (r.items || []).length > items.length)) {
          const b = el('button', 'btn ghost ch-more-link', 'View all videos'); b.onclick = () => setTab('videos'); body.appendChild(b);
        }
        return;
      }
      if (!more) { more = el('button', 'btn ghost ch-more', 'Load more'); more.onclick = () => !C.busy && loadVideos(body, kind); body.appendChild(more); }
      more.hidden = !C.cursor;
    }

    // infinite scroll
    view.addEventListener('scroll', () => {
      if (C.busy || !C.cursor || C.tab === 'home' || C.tab === 'about') return;
      if (view.scrollTop + view.clientHeight > view.scrollHeight - 400) { const b = view.querySelector('.ch-more'); if (b && !b.hidden) b.click(); }
    }, { passive: true });
    window.addEventListener('resize', moveInk);

    // ---------------- entry points ----------------
    function bindAv(node, it) {
      const login = loginOf(it); if (!login || !node || node.dataset.chBound) return;
      node.dataset.chBound = '1'; node.classList.add('ch-link'); node.title = 'View channel';
      node.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); openChannel(login, it); });
    }

    // sidebar: avatar click opens the profile (row click still plays). Order mirrors app.js renderSidebar.
    function bindSidebar() {
      const f = S.follows.slice().sort((a, b) => (b.is_live ? 1 : 0) - (a.is_live ? 1 : 0) || (b.viewers || 0) - (a.viewers || 0));
      const fl = [...document.querySelectorAll('#followList > .side-item')];
      if (fl.length === f.length) fl.forEach((li, n) => { li._lwItem = f[n]; bindAv(li.querySelector('.side-av'), f[n]); });
      const h = S.history.slice(0, 30), hl = [...document.querySelectorAll('#historyList > .side-item')];
      if (hl.length === h.length) hl.forEach((li, n) => { li._lwItem = h[n]; if (h[n].kind === 'channel') bindAv(li.querySelector('.side-av'), h[n]); });
    }

    // player info avatar + author
    ['#infoAvatar', '#infoAuthor'].forEach(sel => {
      const n = $(sel); if (!n) return;
      n.addEventListener('click', e => { const login = loginOf(S.item); if (!login) return; e.stopPropagation(); openChannel(login, S.item); });
    });
    LW.on('itemOpened', it => ['#infoAvatar', '#infoAuthor'].forEach(sel => { const n = $(sel); if (n) { const ok = !!loginOf(it); n.classList.toggle('ch-link', ok); n.title = ok ? 'View channel' : ''; } }));

    // cards anywhere (home, browse): click on avatar / author line
    document.addEventListener('click', e => {
      const t = e.target.closest('.card .card-av, .card .card-sub');
      if (!t || t.closest('#viewChannel')) return;
      const name = (t.classList.contains('card-sub') ? t.textContent : (t.closest('.card').querySelector('.card-sub') || {}).textContent || '').trim();
      if (!name) return;
      const it = [...S.follows, ...S.history].find(x => (x.author || '').toLowerCase() === name.toLowerCase() && loginOf(x));
      const inBrowse = t.closest('#viewBrowse');
      const login = it ? loginOf(it) : (inBrowse && NAME_RE.test(name) ? name.toLowerCase() : null);
      if (!login) return;
      e.stopPropagation(); e.preventDefault();
      openChannel(login, it);
    }, true);

    // fill VOD metadata (duration/thumbnail) so history progress bars and resume work
    LW.on('playing', it => {
      if (!it || (it.kind !== 'vod' && it.kind !== 'clip')) return;
      call('channel_annotate', it.id).then(r => { if (r.ok && r.item && S.item && S.item.id === it.id) { ['duration', 'thumbnail', 'title', 'author'].forEach(k => { if (r.item[k] && !S.item[k]) S.item[k] = r.item[k]; }); } });
    });

    // ---------------- sidebar search ----------------
    const sb = $('#sidebar');
    const wrap = el('div', 'ch-search');
    wrap.innerHTML = `<span class="ch-s-ic">${ICON.search}</span><input type="text" id="sideSearch" placeholder="Search channels" autocomplete="off" spellcheck="false"><kbd class="ch-s-kbd">/</kbd><button class="ch-s-x" title="Clear (Esc)">${ICON.x}</button>`;
    sb.insertBefore(wrap, sb.firstElementChild);
    const inp = wrap.querySelector('input');
    const nores = el('div', 'ch-nores'); nores.hidden = true;
    const hsec = $('#historyList').closest('.side-section');
    hsec.parentElement.insertBefore(nores, hsec.nextSibling);

    function applyFilter() {
      const q = inp.value.trim().toLowerCase();
      wrap.classList.toggle('has', !!q);
      sb.classList.toggle('ch-filtering', !!q);
      let first = null, shown = 0;
      ['#followList', '#historyList'].forEach(sel => {
        document.querySelectorAll(sel + ' > .side-item').forEach(li => {
          const it = li._lwItem;
          const hay = it ? [it.author, it.title, it.category, loginOf(it)].join(' ').toLowerCase() : li.textContent.toLowerCase();
          const ok = !q || hay.includes(q);
          li.classList.toggle('ch-hide', !ok);
          li.classList.toggle('ch-first', false);
          if (ok && q) { shown++; if (!first) first = li; }
        });
        document.querySelectorAll(sel + ' > .side-empty').forEach(x => x.classList.toggle('ch-hide', !!q));
      });
      if (first) first.classList.add('ch-first');
      nores.hidden = !q || !!shown;
      if (q && !shown) nores.innerHTML = `<div>No matches</div><button class="btn ghost">Open “${esc(inp.value.trim())}” as a channel</button>`;
      if (q && !shown) nores.querySelector('button').onclick = () => { const v = inp.value.trim(); clear(); LW.openInput(v); };
      return first;
    }
    function clear() { inp.value = ''; applyFilter(); }
    inp.addEventListener('input', applyFilter);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); if (inp.value) clear(); else inp.blur(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const f = applyFilter();
        const v = inp.value.trim();
        if (f) { f.click(); clear(); inp.blur(); } else if (v) { clear(); inp.blur(); LW.openInput(v); }
      }
    });
    wrap.querySelector('.ch-s-x').onclick = () => { clear(); inp.focus(); };
    document.addEventListener('keydown', e => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('.modal:not([hidden])')) return;
      e.preventDefault();
      const app = document.querySelector('.app');
      if (app && app.classList.contains('side-collapsed')) { const b = $('#btnSidebar'); if (b) b.click(); }
      inp.focus(); inp.select();
    });

    LW.on('sidebarRendered', () => { bindSidebar(); applyFilter(); });
    bindSidebar(); applyFilter();

    LW.openChannel = openChannel;
    LW.channelLoginOf = loginOf;
  });
})();

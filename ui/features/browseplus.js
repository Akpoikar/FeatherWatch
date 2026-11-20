/* browseplus feature: search, language/sort filters, avatars + uptime on stream cards */
(function () {
  'use strict';
  const MOCK = !window.pywebview;
  const LANGS = [['all', 'All languages'], ['en', 'English'], ['de', 'Deutsch'], ['es', 'Español'], ['fr', 'Français'], ['pt', 'Português'], ['ru', 'Русский'], ['it', 'Italiano'], ['ja', '日本語'], ['ko', '한국어'], ['zh', '中文'], ['pl', 'Polski'], ['tr', 'Türkçe'], ['nl', 'Nederlands'], ['sv', 'Svenska'], ['ar', 'العربية'], ['uk', 'Українська'], ['other', 'Other']];
  const SORTS = [['viewers', 'Most viewers'], ['recent', 'Recently started'], ['gems', 'Hidden gems (fewest viewers)']];
  const bp_meta = new Map(); // item id -> {started_at, avatar}
  const bp_asked = new Set();
  function bp_get(k, d) { try { return localStorage.getItem('bp.' + k) || d; } catch (e) { return d; } }
  function bp_set(k, v) { try { localStorage.setItem('bp.' + k, v); } catch (e) { /* ignore */ } }
  const bp_state = { lang: bp_get('lang', 'all'), sort: bp_get('sort', 'viewers') };

  function bp_uptime(iso) {
    const t = Date.parse(iso); if (!t) return '';
    const m = Math.max(0, Math.floor((Date.now() - t) / 60000));
    return m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + 'm';
  }
  function bp_num(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n); }
  function bp_sort(items) {
    if (bp_state.sort === 'recent') items.sort((a, b) => (Date.parse(b.started_at) || 0) - (Date.parse(a.started_at) || 0));
    else if (bp_state.sort === 'gems') items.sort((a, b) => (a.viewers || 0) - (b.viewers || 0));
    else items.sort((a, b) => (b.viewers || 0) - (a.viewers || 0));
    return items;
  }
  function bp_open(login) { if (LW.openChannel) LW.openChannel(login); else LW.openInput(login); }

  // ---- mock data for plain-browser dev ----
  function bp_mockSearch(q) {
    return { ok: true, channels: Array.from({ length: 6 }, (_, i) => ({ login: q.toLowerCase().replace(/\W/g, '') + i, name: q + ' ' + i, avatar: null, is_live: i < 2, viewers: i < 2 ? 1200 - i * 500 : null, title: 'Mock stream', category: 'Just Chatting', started_at: new Date(Date.now() - 8040000).toISOString() })),
      categories: Array.from({ length: 4 }, (_, i) => ({ id: 'g' + i, name: q + ' Game ' + (i + 1), box_art: null })) };
  }

  // ---- stream fetch override (used by app.js browseLoad) ----
  async function bp_streams(gameId, cursor) {
    let r = await LW.call('bp_streams', gameId, cursor, bp_state.lang, 40);
    if (!r.ok && /unavailable/.test(r.error || '')) {
      r = await LW.call('browse_streams', gameId, cursor);
      if (r.ok && MOCK) (r.items || []).forEach((x, i) => { x.started_at = new Date(Date.now() - (i + 1) * 1900000).toISOString(); });
    }
    if (r.ok) {
      bp_sort(r.items || []);
      (r.items || []).forEach(x => bp_meta.set(x.id, { started_at: x.started_at, avatar: x.avatar }));
    }
    return r;
  }

  // ---- decorate cards: uptime + avatar ----
  function bp_decorate(card) {
    const m = bp_meta.get(card.dataset.id); if (!m) return;
    const th = card.querySelector('.thumb');
    if (m.started_at && th && !th.querySelector('.bp-up') && th.querySelector('.tag')) {
      const u = LW.el('span', 'bp-up', LW.esc(bp_uptime(m.started_at))); u.dataset.t = m.started_at; th.appendChild(u);
    }
    const av = card.querySelector('.card-av');
    if (m.avatar && av && !av.classList.contains('bp-pic') && av.textContent) {
      av.textContent = ''; av.style.background = `center/cover url("${m.avatar}")`; av.classList.add('bp-pic');
    }
  }
  function bp_observe(node) {
    if (!node) return;
    new MutationObserver(ms => ms.forEach(mu => mu.addedNodes.forEach(n => { if (n.nodeType === 1 && n.classList.contains('card')) bp_decorate(n); }))).observe(node, { childList: true });
  }

  // ---- home/sidebar avatars for follows that lack one ----
  let bp_avBusy = false;
  async function bp_fillAvatars() {
    if (bp_avBusy || MOCK) return;
    const S = LW.S; const all = (S.follows || []).concat(S.history || []);
    const logins = [...new Set(all.filter(i => i.platform === 'twitch' && i.kind === 'channel' && !i.avatar).map(i => i.id.split(':')[1]).filter(l => l && !bp_asked.has(l)))];
    if (!logins.length) return;
    logins.forEach(l => bp_asked.add(l));
    bp_avBusy = true;
    const r = await LW.call('bp_avatars', logins);
    bp_avBusy = false;
    if (!r.ok) return;
    let changed = false;
    all.forEach(i => { const a = r.avatars && r.avatars[(i.id.split(':')[1] || '').toLowerCase()]; if (a && !i.avatar && i.kind === 'channel') { i.avatar = a; changed = true; } });
    if (changed) { try { LW.renderSidebar(); if (LW.$('#viewHome') && LW.$('#viewHome').classList.contains('active')) LW.renderHome(); } catch (e) { console.error(e); } }
  }

  // ---- UI ----
  function bp_build() {
    const view = LW.$('#viewBrowse'), head = view && view.querySelector('.browse-head');
    if (!head) return;
    const bar = LW.el('div', 'bp-bar');
    bar.innerHTML = `<div class="bp-search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="bp_q" type="search" placeholder="Search channels and categories…" autocomplete="off" spellcheck="false"><div class="bp-results" id="bp_res" hidden></div></div>
      <div class="bp-filters" id="bp_filters" hidden><select id="bp_lang" title="Language">${LANGS.map(l => `<option value="${l[0]}">${LW.esc(l[1])}</option>`).join('')}</select><select id="bp_sort" title="Sort">${SORTS.map(s => `<option value="${s[0]}">${LW.esc(s[1])}</option>`).join('')}</select></div>`;
    head.parentNode.insertBefore(bar, head.nextSibling);
    const q = bar.querySelector('#bp_q'), res = bar.querySelector('#bp_res'), lang = bar.querySelector('#bp_lang'), sort = bar.querySelector('#bp_sort');
    lang.value = bp_state.lang; sort.value = bp_state.sort;
    if (lang.value !== bp_state.lang) { lang.value = 'all'; bp_state.lang = 'all'; }
    const reload = () => { const B = LW.browseState; if (B && B.mode === 'streams' && LW.browseOpen) LW.browseOpen('streams', B.game); };
    lang.onchange = () => { bp_state.lang = lang.value; bp_set('lang', lang.value); reload(); };
    sort.onchange = () => { bp_state.sort = sort.value; bp_set('sort', sort.value); reload(); };

    const grid = LW.$('#browseGrid');
    const gamesMode = () => grid.classList.contains('games') && !(LW.browseState && LW.browseState.game);
    let lastMode = null;
    const syncFilters = () => {
      const g = grid.classList.contains('games');
      bar.querySelector('#bp_filters').hidden = g;
      const gm = gamesMode();
      q.placeholder = gm ? 'Search categories…' : 'Search channels and categories…';
      if (lastMode !== null && gm !== lastMode) { q.value = ''; res.hidden = true; }
      lastMode = gm;
    };
    new MutationObserver(syncFilters).observe(grid, { attributes: true, attributeFilter: ['class'] });
    syncFilters();

    let timer = 0, seq = 0;
    const close = () => { res.hidden = true; };
    // On the Top games tab, the search filters the category grid itself.
    let catSearching = false;
    async function runCats(text, my) {
      const more = LW.$('#browseMore');
      if (!text) { if (catSearching) { catSearching = false; LW.browseOpen('games'); } return; }
      const lower = text.toLowerCase();
      // instant local filter of already-loaded tiles
      grid.querySelectorAll('.card').forEach(c => { c.hidden = !c.textContent.toLowerCase().includes(lower); });
      if (text.length < 2) return;
      let r = await LW.call('bp_search', text, 'categories');
      if (!r.ok && MOCK) r = bp_mockSearch(text);
      if (my !== seq || !gamesMode()) return;
      if (!r.ok) { if (/not configured|credentials/i.test(r.error || '')) return; LW.toast(r.error || 'Search failed', 'error'); return; }
      catSearching = true; more.hidden = true;
      const cats = r.categories || [];
      grid.innerHTML = cats.length ? '' : '<div class="empty">No categories match.</div>';
      cats.forEach(g => grid.appendChild(LW.gameCard(g)));
    }
    async function run() {
      const text = q.value.trim(); const my = ++seq;
      if (gamesMode() && LW.gameCard) { close(); return runCats(text, my); }
      if (text.length < 2) { close(); return; }
      res.hidden = false;
      res.innerHTML = '<div class="bp-sk"></div><div class="bp-sk"></div><div class="bp-sk"></div>';
      let r = await LW.call('bp_search', text);
      if (!r.ok && MOCK) r = bp_mockSearch(text);
      if (my !== seq) return;
      if (!r.ok) {
        res.innerHTML = /not configured|credentials/i.test(r.error || '')
          ? '<div class="bp-empty">Search needs the Twitch API: put <code>TWITCH_CLIENT_ID</code> and <code>TWITCH_CLIENT_SECRET</code> in a <code>.env</code> file next to app.py and restart.</div>'
          : `<div class="bp-empty">${LW.esc(r.error || 'Search failed')}</div>`;
        return;
      }
      res.innerHTML = '';
      const ch = r.channels || [], cats = r.categories || [];
      if (!ch.length && !cats.length) { res.innerHTML = '<div class="bp-empty">No results.</div>'; return; }
      if (ch.length) res.appendChild(LW.el('div', 'bp-h', 'Channels'));
      ch.forEach(c => {
        const row = LW.el('button', 'bp-row');
        const av = LW.el('span', 'bp-av' + (c.is_live ? ' live' : ''), c.avatar ? '' : LW.esc((c.name || '?')[0].toUpperCase()));
        av.style.background = c.avatar ? `center/cover url("${c.avatar}")` : LW.avBg(c.login);
        row.appendChild(av);
        const sub = c.is_live ? `<span class="bp-live">● ${c.viewers != null ? LW.esc(bp_num(c.viewers)) + ' viewers' : 'Live'}</span>${c.category ? ' · ' + LW.esc(c.category) : ''}${c.started_at ? ' · ' + LW.esc(bp_uptime(c.started_at)) : ''}` : '<span class="bp-off">Offline</span>';
        row.appendChild(LW.el('span', 'bp-tx', `<b>${LW.esc(c.name)}</b><small>${sub}</small>`));
        row.onclick = () => { close(); bp_open(c.login); };
        res.appendChild(row);
      });
      if (cats.length) res.appendChild(LW.el('div', 'bp-h', 'Categories'));
      cats.forEach(g => {
        const row = LW.el('button', 'bp-row');
        const art = LW.el('span', 'bp-art'); art.style.background = g.box_art ? `center/cover url("${g.box_art}")` : LW.avBg(g.name);
        row.appendChild(art); row.appendChild(LW.el('span', 'bp-tx', `<b>${LW.esc(g.name)}</b><small>Category</small>`));
        row.onclick = () => { close(); q.value = ''; if (LW.browseOpen) { LW.showView('Browse'); LW.browseOpen('streams', { id: g.id, name: g.name, box_art: g.box_art }); } };
        res.appendChild(row);
      });
    }
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, gamesMode() ? 200 : 300); });
    q.addEventListener('focus', () => { if (res.childElementCount && q.value.trim().length >= 2) res.hidden = false; });
    q.addEventListener('keydown', e => {
      if (e.key === 'Escape') { if (gamesMode() && q.value) { q.value = ''; run(); } close(); q.blur(); }
      else if (e.key === 'Enter') { clearTimeout(timer); const first = res.querySelector('.bp-row'); if (!res.hidden && first) first.click(); else run(); }
    });
    document.addEventListener('mousedown', e => { if (!bar.querySelector('.bp-search').contains(e.target)) close(); });
  }

  function bp_init() {
    LW.browseStreams = bp_streams;
    bp_build();
    bp_observe(LW.$('#browseGrid'));
    bp_observe(LW.$('#gridLive'));
    setInterval(() => document.querySelectorAll('.bp-up').forEach(u => { u.textContent = bp_uptime(u.dataset.t); }), 60000);
    LW.on('sidebarRendered', () => setTimeout(bp_fillAvatars, 0));
    LW.on('event', e => { if (e && e.type === 'live') setTimeout(bp_fillAvatars, 500); });
    // follows' live info (started_at) for home cards is unknown here; avatars come via bp_fillAvatars
  }
  if (window.LW && LW.ready) LW.ready(bp_init);
  else (window.LW = window.LW || {}, (LW._ready = LW._ready || []).push(bp_init));
})();

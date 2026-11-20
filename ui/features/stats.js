/* stats feature: watch-time tracking + Stats view */
(function () {
  'use strict';
  const RANGES = { '7d': 7, '30d': 30, '1y': 365, all: 0 };
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const ICON = '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>';
  let section = null, range = '30d', data = null;
  try { range = localStorage.getItem('lw.stats.range') || range; } catch (e) { /* ignore */ }

  // ---------- tracking ----------
  const T = { item: null, acc: 0, last: 0, newSession: false, sinceFlush: 0 };
  function loginOf(it) {
    if (!it) return '';
    const m = /^twitch:(.+)$/.exec(it.id || '');
    if (m) return m[1];
    const u = /twitch\.tv\/([A-Za-z0-9_]+)/.exec(it.url || '');
    return (u && u[1] !== 'videos') ? u[1] : (it.author || '');
  }
  function metaOf(it) {
    return { title: it.title, author: it.author, login: loginOf(it), platform: it.platform, kind: it.kind,
      category: it.category, avatar: it.avatar, thumbnail: it.thumbnail, url: it.url };
  }
  function flush() {
    const it = T.item, sec = Math.round(T.acc);
    if (!it || sec < 1) return;
    const meta = metaOf(it); meta.new_session = T.newSession;
    T.acc = 0; T.newSession = false; T.sinceFlush = 0;
    if (window.pywebview) LW.call('stats_add', it.id, sec, meta).then(r => { if (r && !r.ok) console.warn('[stats]', r.error); });
    else mockAdd(it, sec, meta);
  }
  // what is being watched right now: the main player, or the multi-view tile that has audio
  function source() {
    const mv = document.getElementById('viewMultiview');
    if (mv && mv.classList.contains('active') && LW.multiview) {
      const t = LW.multiview.tiles().find(x => x.video && !x.video.muted && x.item && x.item.id);
      return t ? { item: t.item, video: t.video, mv: true } : null;
    }
    return LW.S && LW.S.item ? { item: LW.S.item, video: LW.video, mv: false } : null;
  }
  function watching(src) {
    const v = src && src.video;
    if (!v || v.paused || v.ended || v.seeking || v.readyState < 3) return false;
    const pip = document.pictureInPictureElement === v;
    if (!pip && document.visibilityState !== 'visible') return false;
    if (src.mv) return true;
    const vp = document.getElementById('viewPlayer');
    return pip || !vp || vp.classList.contains('active');
  }
  function tick() {
    const now = Date.now(), dt = Math.min(5, (now - (T.last || now)) / 1000);
    T.last = now;
    const src = source(), cur = src && src.item;
    if (cur && (!T.item || T.item.id !== cur.id)) { flush(); T.item = cur; T.newSession = true; }
    if (cur && T.item) T.item = cur; // keep metadata fresh (category may update)
    if (watching(src)) { T.acc += dt; T.sinceFlush += dt; }
    if (T.sinceFlush >= 30 || T.acc >= 30) flush();
  }
  function hookTracking() {
    LW.on('itemOpened', it => { flush(); T.item = it || LW.S.item; T.newSession = true; });
    LW.on('stopped', () => flush());
    LW.on('playing', () => { T.last = Date.now(); });
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') flush(); });
    T.last = Date.now();
    setInterval(tick, 1000);
  }

  // ---------- mock data ----------
  let mock = null;
  function mockData() {
    if (mock) return mock;
    const chans = [['xqc', 'Just Chatting'], ['shroud', 'Valorant'], ['pokimane', 'Just Chatting'], ['lirik', 'Elden Ring'],
      ['summit1g', 'Counter-Strike'], ['hasanabi', 'Just Chatting'], ['sodapoppin', 'World of Warcraft'], ['moistcr1tikal', 'Minecraft']];
    const days = {}, items = {}, names = {};
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const now = new Date();
    for (let i = 0; i < 400; i++) {
      if (rnd() < 0.25 && i > 2) continue;
      const d = new Date(now); d.setDate(d.getDate() - i);
      const key = ymd(d), rec = { total: 0, ch: {}, cat: {}, pf: {}, hours: {} };
      const n = 1 + Math.floor(rnd() * 3);
      for (let j = 0; j < n; j++) {
        const [c, cat] = chans[Math.floor(Math.pow(rnd(), 1.6) * chans.length)];
        const s = Math.round(600 + rnd() * 7200), h = Math.floor(17 + rnd() * 8) % 24, wd = (d.getDay() + 6) % 7;
        rec.total += s; rec.ch[c] = (rec.ch[c] || 0) + s; rec.cat[cat] = (rec.cat[cat] || 0) + s;
        const pf = rnd() < 0.85 ? 'twitch' : 'youtube'; rec.pf[pf] = (rec.pf[pf] || 0) + s;
        rec.hours[wd + '-' + h] = (rec.hours[wd + '-' + h] || 0) + s;
        names[c] = { name: c };
      }
      days[key] = rec;
    }
    for (let k = 0; k < 8; k++) {
      const [c, cat] = chans[k];
      items['twitch-vod:' + (1000 + k)] = { title: `${c} VOD — ${cat} marathon`, author: c, login: c, platform: 'twitch', kind: 'vod',
        category: cat, seconds: Math.round(3000 + rnd() * 20000), sessions: 1 + Math.floor(rnd() * 6), last: Date.now() / 1000 - k * 86400 };
    }
    return (mock = { items, days, names });
  }
  function mockAdd(it, sec, meta) {
    const m = mockData(), d = new Date(), key = ymd(d), c = (meta.login || 'unknown').toLowerCase();
    const r = m.days[key] = m.days[key] || { total: 0, ch: {}, cat: {}, pf: {}, hours: {} };
    const cat = meta.category || 'Uncategorized', hk = ((d.getDay() + 6) % 7) + '-' + d.getHours();
    r.total += sec; r.ch[c] = (r.ch[c] || 0) + sec; r.cat[cat] = (r.cat[cat] || 0) + sec;
    r.pf[meta.platform || 'other'] = (r.pf[meta.platform || 'other'] || 0) + sec; r.hours[hk] = (r.hours[hk] || 0) + sec;
    const i = m.items[it.id] = m.items[it.id] || { seconds: 0, sessions: 0 };
    Object.assign(i, { title: meta.title, author: meta.author, login: meta.login, platform: meta.platform, kind: meta.kind, category: meta.category });
    i.seconds += sec; if (meta.new_session) i.sessions++; i.last = Date.now() / 1000;
  }

  // ---------- helpers ----------
  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function hrs(s) {
    if (s < 60) return Math.round(s) + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    const h = s / 3600; return (h < 10 ? h.toFixed(1) : Math.round(h).toLocaleString()) + 'h';
  }
  function addTo(o, src) { for (const k in src || {}) o[k] = (o[k] || 0) + src[k]; }
  function top(o, n) { return Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n); }
  const reduced = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function aggregate(d, rk) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const keys = Object.keys(d.days || {}).sort();
    let n = RANGES[rk];
    if (!n) { n = keys.length ? Math.round((today - new Date(keys[0] + 'T00:00:00')) / 864e5) + 1 : 1; }
    const series = [], ch = {}, cat = {}, pf = {}, hours = {};
    let total = 0;
    for (let i = n - 1; i >= 0; i--) {
      const x = new Date(today); x.setDate(x.getDate() - i);
      const k = ymd(x), r = d.days[k];
      const s = r ? r.total || 0 : 0;
      series.push({ k, d: x, s }); total += s;
      if (r) { addTo(ch, r.ch); addTo(cat, r.cat); addTo(pf, r.pf); addTo(hours, r.hours); }
    }
    let streak = 0;
    for (let i = 0; ; i++) {
      const x = new Date(today); x.setDate(x.getDate() - i);
      const r = d.days[ymd(x)];
      if (r && r.total > 0) streak++; else if (i > 0) break; // today may be empty without breaking
      if (i > 3650) break;
    }
    const active = series.filter(p => p.s > 0).length;
    return { series, total, ch, cat, pf, hours, streak, n, active, avg: total / Math.max(1, n) };
  }

  function avatarFor(login, d) {
    const S = LW.S || {}, l = login.toLowerCase();
    const it = (S.follows || []).concat(S.history || []).find(x => x.avatar && (loginOfSafe(x) === l || (x.author || '').toLowerCase() === l));
    if (it) return it.avatar;
    const n = d.names && d.names[l]; if (n && n.avatar) return n.avatar;
    const vi = Object.values(d.items || {}).find(x => (x.login || '').toLowerCase() === l && x.avatar);
    return vi ? vi.avatar : null;
  }
  function loginOfSafe(x) { return loginOf(x).toLowerCase(); }
  function displayName(login, d) { const n = d.names && d.names[login]; return (n && n.name) || login; }

  // ---------- view ----------
  function build() {
    const vp = document.getElementById('viewPlayer');
    if (!vp || document.getElementById('viewStats')) return;
    section = LW.el('section', 'view stats-view');
    section.id = 'viewStats';
    section.innerHTML = `
      <div class="stats-head">
        <h2 class="stats-title">${ICON}<span>Watch stats</span></h2>
        <div class="stats-range" role="tablist">${Object.keys(RANGES).map(k => `<button data-r="${k}" role="tab">${k === 'all' ? 'All' : k}</button>`).join('')}</div>
        <button class="btn ghost stats-export" title="Export CSV to Downloads"><svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg><span>Export CSV</span></button>
      </div>
      <div class="stats-body"></div>`;
    vp.parentNode.insertBefore(section, vp.nextSibling);
    section.querySelectorAll('.stats-range button').forEach(b => b.onclick = () => {
      range = b.dataset.r; try { localStorage.setItem('lw.stats.range', range); } catch (e) { /* ignore */ }
      render();
    });
    section.querySelector('.stats-export').onclick = async () => {
      if (!window.pywebview) { LW.toast('CSV export needs the desktop app'); return; }
      const r = await LW.call('stats_export');
      if (r.ok) LW.toast('Saved ' + r.path.split(/[\\/]/).pop() + ' to Downloads'); else LW.toast(r.error, 'error');
    };
    // top bar button
    const ref = document.getElementById('btnMultiview') || document.getElementById('btnBrowse');
    if (ref && !document.getElementById('btnStats')) {
      const b = LW.el('button', 'btn ghost', ICON + '<span>Stats</span>');
      b.id = 'btnStats'; b.title = 'Watch-time stats';
      b.onclick = open;
      ref.parentNode.insertBefore(b, ref.nextSibling);
    }
    // command palette: add "Stats" entry when query matches
    const pin = document.getElementById('paletteInput'), pl = document.getElementById('paletteList');
    if (pin && pl) {
      const inject = () => {
        const q = pin.value.toLowerCase().trim();
        if (pl.querySelector('.stats-pal') || (q && !'stats watch time statistics'.includes(q) && !q.startsWith('stat'))) return;
        const li = LW.el('li', 'stats-pal', ICON + '<span><b>Watch stats</b></span><span class="k">view</span>');
        li.onclick = () => { LW.closeModals(); open(); };
        pl.appendChild(li);
      };
      new MutationObserver(inject).observe(pl, { childList: true });
    }
  }

  async function open() {
    flush();
    if (LW.S && LW.S.item) LW.stopPlayback();
    LW.showView('Stats');
    await load();
  }
  async function load() {
    if (!window.pywebview) data = mockData();
    else {
      const r = await LW.call('stats_get');
      data = r.ok ? r.stats : { items: {}, days: {} };
      if (!r.ok) LW.toast(r.error || 'Stats unavailable', 'error');
    }
    render();
  }

  function tile(label, value, sub) { return `<div class="stats-tile"><div class="stats-tl">${label}</div><div class="stats-tv">${value}</div><div class="stats-ts">${sub || ''}</div></div>`; }

  function render() {
    if (!section || !data) return;
    section.querySelectorAll('.stats-range button').forEach(b => b.classList.toggle('on', b.dataset.r === range));
    const body = section.querySelector('.stats-body'), A = aggregate(data, range);
    const anim = !reduced();
    if (!Object.keys(data.days || {}).length) {
      body.innerHTML = `<div class="stats-empty">${ICON}<h3>No watch time yet</h3><p>Start watching something — time is counted while video actually plays.</p></div>`;
      return;
    }
    const tc = top(A.ch, 10), tg = top(A.cat, 8);
    const topCh = tc[0] ? LW.esc(displayName(tc[0][0], data)) : '—';
    body.innerHTML = `
      <div class="stats-tiles">
        ${tile('Total watched', hrs(A.total), A.active + ' active day' + (A.active === 1 ? '' : 's'))}
        ${tile('Day streak', A.streak + (A.streak === 1 ? ' day' : ' days'), 'consecutive days')}
        ${tile('Avg per day', hrs(A.avg), 'over ' + A.n + ' days')}
        ${tile('Top channel', topCh, tc[0] ? hrs(tc[0][1]) : '')}
      </div>
      <div class="stats-card stats-chart-card"><h3>Daily watch time</h3><div class="stats-chart"></div><div class="stats-tip" hidden></div></div>
      <div class="stats-grid">
        <div class="stats-card"><h3>Top channels</h3><ul class="stats-list stats-ch"></ul></div>
        <div class="stats-card"><h3>Top categories</h3><ul class="stats-list stats-cat"></ul></div>
      </div>
      <div class="stats-grid">
        <div class="stats-card"><h3>When you watch</h3><div class="stats-heat"></div></div>
        <div class="stats-card"><h3>Most rewatched VODs</h3><ul class="stats-list stats-vods"></ul></div>
      </div>`;
    if (!anim) body.classList.add('stats-noanim'); else body.classList.remove('stats-noanim');
    drawChart(body.querySelector('.stats-chart'), body.querySelector('.stats-tip'), A.series);
    const chMax = tc.length ? tc[0][1] : 1, chUl = body.querySelector('.stats-ch');
    if (!tc.length) chUl.innerHTML = '<li class="stats-none">Nothing in this range</li>';
    tc.forEach(([login, s], i) => {
      const av = avatarFor(login, data), name = displayName(login, data);
      const li = LW.el('li', 'stats-row' + (LW.openChannel ? ' click' : ''));
      li.style.setProperty('--i', i);
      li.innerHTML = `<div class="stats-av"${av ? ` style="background:center/cover url('${LW.esc(av)}')"` : ` style="background:${LW.avBg(login)}"`}>${av ? '' : LW.esc(name.charAt(0).toUpperCase())}</div>
        <div class="stats-rm"><div class="stats-rn"><span>${LW.esc(name)}</span><b>${hrs(s)}</b></div><div class="stats-bar"><i style="--w:${(s / chMax * 100).toFixed(1)}%"></i></div></div>`;
      if (LW.openChannel && login !== 'unknown') li.onclick = () => LW.openChannel(login);
      chUl.appendChild(li);
    });
    const cMax = tg.length ? tg[0][1] : 1, cUl = body.querySelector('.stats-cat');
    if (!tg.length) cUl.innerHTML = '<li class="stats-none">Nothing in this range</li>';
    tg.forEach(([c, s], i) => {
      const li = LW.el('li', 'stats-row'); li.style.setProperty('--i', i);
      li.innerHTML = `<div class="stats-rm"><div class="stats-rn"><span>${LW.esc(c)}</span><b>${hrs(s)} · ${Math.round(s / Math.max(1, A.total) * 100)}%</b></div><div class="stats-bar alt"><i style="--w:${(s / cMax * 100).toFixed(1)}%"></i></div></div>`;
      cUl.appendChild(li);
    });
    drawHeat(body.querySelector('.stats-heat'), A.hours);
    const vods = Object.entries(data.items || {}).filter(([, v]) => v.kind === 'vod' || v.kind === 'video' || v.kind === 'clip')
      .sort((a, b) => (b[1].sessions || 0) - (a[1].sessions || 0) || b[1].seconds - a[1].seconds).slice(0, 6);
    const vUl = body.querySelector('.stats-vods');
    if (!vods.length) vUl.innerHTML = '<li class="stats-none">No VODs watched yet</li>';
    vods.forEach(([id, v], i) => {
      const li = LW.el('li', 'stats-row click'); li.style.setProperty('--i', i);
      li.innerHTML = `<div class="stats-thumb"${v.thumbnail ? ` style="background:center/cover url('${LW.esc(v.thumbnail)}')"` : ''}></div>
        <div class="stats-rm"><div class="stats-rn"><span>${LW.esc(v.title || id)}</span><b>${v.sessions || 1}×</b></div><div class="stats-sub">${LW.esc(v.author || '')} · ${hrs(v.seconds || 0)}</div></div>`;
      li.onclick = () => LW.openInput(v.url || id);
      vUl.appendChild(li);
    });
  }

  function drawChart(host, tip, series) {
    const W = 800, H = 200, P = { l: 36, r: 6, t: 10, b: 22 };
    const max = Math.max(3600, ...series.map(p => p.s));
    const stepH = max > 6 * 3600 ? Math.ceil(max / 3600 / 4) * 3600 : 3600;
    const n = series.length, bw = (W - P.l - P.r) / n, gap = n > 120 ? 0 : Math.min(4, bw * 0.25);
    const y = s => H - P.b - s / max * (H - P.t - P.b);
    let g = '';
    for (let v = 0; v <= max; v += stepH) g += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" class="gl"/><text x="${P.l - 6}" y="${y(v) + 3}" text-anchor="end">${v / 3600}h</text>`;
    let bars = '', labels = '';
    const every = Math.ceil(n / 8);
    series.forEach((p, i) => {
      const x = P.l + i * bw + gap / 2, h = Math.max(p.s > 0 ? 2 : 0, H - P.b - y(p.s));
      bars += `<rect class="bar" data-i="${i}" x="${x.toFixed(2)}" y="${(H - P.b - h).toFixed(2)}" width="${Math.max(0.5, bw - gap).toFixed(2)}" height="${h.toFixed(2)}" rx="${Math.min(3, bw / 3).toFixed(1)}" style="--d:${Math.min(i * 12, 600)}ms"/>`;
      bars += `<rect class="hit" data-i="${i}" x="${(P.l + i * bw).toFixed(2)}" y="${P.t}" width="${bw.toFixed(2)}" height="${H - P.t - P.b}"/>`;
      if (i % every === 0) labels += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${p.d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</text>`;
    });
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Daily watch time">
      <defs><linearGradient id="statsGrad" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="var(--a1)"/><stop offset="1" stop-color="var(--a2)"/></linearGradient></defs>
      <g class="axis">${g}${labels}</g><g>${bars}</g></svg>`;
    const svg = host.querySelector('svg');
    svg.addEventListener('mousemove', e => {
      const t = e.target.closest('.hit'); if (!t) { tip.hidden = true; return; }
      const p = series[+t.dataset.i];
      svg.querySelectorAll('.bar.hov').forEach(b => b.classList.remove('hov'));
      const b = svg.querySelector(`.bar[data-i="${t.dataset.i}"]`); if (b) b.classList.add('hov');
      tip.innerHTML = `<b>${hrs(p.s)}</b><span>${p.d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>`;
      tip.hidden = false;
      const hr = host.getBoundingClientRect(), cr = host.parentNode.getBoundingClientRect();
      const tr = t.getBoundingClientRect();
      tip.style.left = Math.min(hr.width - 70, Math.max(0, tr.left + tr.width / 2 - cr.left)) + 'px';
      tip.style.top = (hr.top - cr.top) + 'px';
    });
    svg.addEventListener('mouseleave', () => { tip.hidden = true; svg.querySelectorAll('.bar.hov').forEach(b => b.classList.remove('hov')); });
  }

  function drawHeat(host, hours) {
    const max = Math.max(1, ...Object.values(hours));
    let h = '<div class="stats-hgrid"><span></span>';
    for (let c = 0; c < 24; c++) h += `<span class="hh">${c % 6 === 0 ? c : ''}</span>`;
    for (let d = 0; d < 7; d++) {
      h += `<span class="hd">${DAYS[d]}</span>`;
      for (let c = 0; c < 24; c++) {
        const s = hours[d + '-' + c] || 0, o = s ? 0.15 + 0.85 * s / max : 0;
        h += `<i title="${DAYS[d]} ${String(c).padStart(2, '0')}:00 · ${hrs(s)}" style="--o:${o.toFixed(2)}"></i>`;
      }
    }
    host.innerHTML = h + '</div>';
  }

  function init() {
    build(); hookTracking();
    if (section) new MutationObserver(() => { if (section.classList.contains('active') && !data) load(); }).observe(section, { attributes: true, attributeFilter: ['class'] });
    LW.stats = { open, flush };
  }
  if (window.LW && window.LW.ready) window.LW.ready(init);
  else (window.LW = window.LW || {}, (window.LW._ready = window.LW._ready || []).push(init));
})();

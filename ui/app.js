/* Lightweight – frontend (vanilla JS, no build step) */
(function () {
  'use strict';

  // ---------- helpers ----------
  const $ = (s, r) => (r || document).querySelector(s);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = s => {
    if (!isFinite(s) || s < 0) s = 0; s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  };
  const fmtNum = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
  const ago = t => { if (!t) return ''; const d = Date.now() / 1000 - t; if (d < 60) return 'just now'; if (d < 3600) return Math.floor(d / 60) + 'm ago'; if (d < 86400) return Math.floor(d / 3600) + 'h ago'; return Math.floor(d / 86400) + 'd ago'; };
  const hue = s => { let h = 0; for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const avBg = s => `linear-gradient(135deg,hsl(${hue(s)} 70% 55%),hsl(${(hue(s) + 50) % 360} 70% 45%))`;
  const initial = it => ((it.author || it.title || '?').trim()[0] || '?').toUpperCase();
  const nameOf = it => it.author || it.title || it.url || it.id;
  const looksLikeLink = s => /^(https?:\/\/|www\.)\S+$/i.test(s) || /^[a-z0-9_]{3,25}$/i.test(s);
  const isTyping = e => { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); };

  // ---------- mock API (plain browser dev) ----------
  function makeMock() {
    const now = Math.floor(Date.now() / 1000);
    const TEST_HLS = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
    const mk = (id, o) => Object.assign({ id, platform: 'twitch', kind: 'channel', url: '', title: '', author: '', category: '', thumbnail: null, is_live: false, last_watched: null, progress: 0, duration: null }, o);
    const items = {
      'twitch:aurora_plays': mk('twitch:aurora_plays', { url: 'https://twitch.tv/aurora_plays', title: 'Ranked grind to Diamond — !socials', author: 'aurora_plays', category: 'Valorant', is_live: true, viewers: 12840 }),
      'twitch:pixelchef': mk('twitch:pixelchef', { url: 'https://twitch.tv/pixelchef', title: 'Cozy cooking + chat hangout', author: 'pixelchef', category: 'Just Chatting', is_live: true, viewers: 3120 }),
      'twitch:speedrunsam': mk('twitch:speedrunsam', { url: 'https://twitch.tv/speedrunsam', title: 'Any% WR attempts', author: 'speedrunsam', category: 'Celeste', is_live: true, viewers: 870 }),
      'twitch:nightowl': mk('twitch:nightowl', { url: 'https://twitch.tv/nightowl', title: 'Offline', author: 'nightowl', category: 'Minecraft', is_live: false }),
      'twitch-vod:2001': mk('twitch-vod:2001', { kind: 'vod', url: 'https://twitch.tv/videos/2001', title: 'Marathon stream highlights', author: 'aurora_plays', category: 'Valorant', last_watched: now - 3600, progress: 1800, duration: 5400 }),
      'youtube:abc123': mk('youtube:abc123', { platform: 'youtube', kind: 'video', url: 'https://youtube.com/watch?v=abc123', title: 'How streaming protocols work', author: 'TechTalks', category: 'Education', last_watched: now - 86400 * 2, progress: 300, duration: 1200 })
    };
    let follows = ['twitch:aurora_plays', 'twitch:pixelchef', 'twitch:speedrunsam', 'twitch:nightowl'];
    let history = ['twitch-vod:2001', 'youtube:abc123', 'twitch:pixelchef'];
    items['twitch:pixelchef'].last_watched = now - 600;
    let settings = { player_path: '', default_quality: 'best', record_dir: '~/Movies/Lightweight', live_poll_minutes: 3, low_latency: true, theme: 'dark' };
    const recs = [{ item_id: 'twitch:aurora_plays', path: '~/Movies/Lightweight/aurora_plays-2026-11-18.ts', started: now - 90000, active: false }];
    const delay = (v, ms) => new Promise(r => setTimeout(() => r(v), ms || 250));
    const list = ids => ids.map(i => items[i]).filter(Boolean);
    return {
      resolve(input) {
        input = String(input).trim();
        let id, o;
        const m = input.match(/twitch\.tv\/videos\/(\d+)/);
        if (m) { id = 'twitch-vod:' + m[1]; o = { kind: 'vod', title: 'VOD ' + m[1], author: 'someone', duration: 3600 }; }
        else if (/youtu/.test(input)) { id = 'youtube:' + (input.match(/v=([\w-]+)/) || [, 'x'])[1]; o = { platform: 'youtube', kind: 'video', title: 'YouTube video', author: 'YouTuber', duration: 600 }; }
        else { const n = (input.match(/twitch\.tv\/([\w]+)/) || [, input])[1].toLowerCase(); id = 'twitch:' + n; o = { author: n, title: n + ' live', category: 'Just Chatting', is_live: true, viewers: 420 }; }
        if (!items[id]) items[id] = mk(id, Object.assign({ url: input }, o));
        return delay({ ok: true, item: items[id], qualities: ['source', '1080p60', '720p60', '480p', '360p', 'audio_only'], default_quality: settings.default_quality }, 700);
      },
      play(id) {
        const it = items[id]; it.last_watched = Math.floor(Date.now() / 1000);
        history = [id].concat(history.filter(x => x !== id));
        return delay({ ok: true, src: TEST_HLS, kind: 'hls', is_live: !!it.is_live }, 500);
      },
      open_external: () => delay({ ok: true }),
      record_start(id) { const r = { item_id: id, path: '~/Movies/Lightweight/' + id.replace(/\W/g, '_') + '.ts', started: Date.now() / 1000, active: true }; recs.unshift(r); setTimeout(() => window.lw.onEvent({ type: 'record', item_id: id, state: 'started', path: r.path })); return delay({ ok: true, path: r.path }); },
      record_stop(id) { recs.forEach(r => { if (r.item_id === id) r.active = false; }); setTimeout(() => window.lw.onEvent({ type: 'record', item_id: id, state: 'stopped' })); return delay({ ok: true }); },
      recordings: () => delay({ ok: true, items: recs.slice() }),
      history: () => delay({ ok: true, items: list(history) }),
      remove_history(id) { history = history.filter(x => x !== id); return delay({ ok: true }); },
      clear_history() { history = []; return delay({ ok: true }); },
      follows: () => delay({ ok: true, items: list(follows) }),
      follow(id) { if (!follows.includes(id)) follows.push(id); return delay({ ok: true }); },
      unfollow(id) { follows = follows.filter(x => x !== id); return delay({ ok: true }); },
      profile: () => delay({ ok: true, avatar: null, bio: 'Variety streamer. Business: hello@example.com — schedule on https://example.com', links: [{ label: 'Channel', url: 'https://example.com' }, { label: 'Past broadcasts', url: 'https://example.com/videos' }] }, 500),
      open_url: () => delay({ ok: true }),
      refresh_live() { return delay({ ok: true, items: list(follows) }, 900); },
      save_progress(id, s) { if (items[id]) items[id].progress = s; return delay({ ok: true }, 10); },
      get_settings: () => delay({ ok: true, settings: Object.assign({}, settings) }, 50),
      set_settings(d) { Object.assign(settings, d); return delay({ ok: true, settings: Object.assign({}, settings) }); },
      browse_status: () => delay({ ok: true, configured: true }, 50),
      browse_games(c) { const p = +(c || 0); return delay({ ok: true, cursor: p < 3 ? String(p + 1) : null, items: Array.from({ length: 20 }, (_, i) => ({ id: 'g' + (p * 20 + i), name: 'Game ' + (p * 20 + i + 1), box_art: null, viewers: 90000 - (p * 20 + i) * 1500 })) }); },
      browse_streams(g, c) { const p = +(c || 0); return delay({ ok: true, cursor: p < 2 ? String(p + 1) : null, items: Array.from({ length: 12 }, (_, i) => mk('twitch:s' + p + i, { url: 'https://twitch.tv/s' + p + i, title: 'Stream ' + (p * 12 + i + 1), author: 's' + p + i, category: g || 'Mixed', is_live: true, viewers: 5000 - p * 1000 - i * 50 })) }); },
      stream_stats: id => delay({ ok: true, viewers: items[id] && items[id].is_live ? (items[id].viewers || 1234) : null }, 200),
      chat_info(id) { const it = items[id]; return delay(it && it.platform === 'twitch' && it.kind === 'channel' ? { ok: true, channel: it.author } : { ok: false, error: 'no chat' }, 50); }
    };
  }

  let API = null;
  async function call(name, ...args) {
    try {
      const fn = API && API[name];
      if (!fn) return { ok: false, error: 'API ' + name + ' unavailable' };
      const r = await fn.apply(API, args);
      return r || { ok: false, error: 'empty response' };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }

  // ---------- state ----------
  const S = {
    follows: [], history: [], recordings: [], settings: {},
    item: null, qualities: [], quality: null, isLive: false, kind: 'hls',
    recording: new Set(), hls: null, chatWs: null, lastSave: 0, loadToken: 0
  };
  const app = $('#app'), video = $('#video'), player = $('#player');

  // ---------- toasts ----------
  function toast(text, level) {
    const t = el('div', 'toast' + (level === 'error' ? ' error' : ''), esc(text));
    $('#toasts').appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, level === 'error' ? 6000 : 3500);
  }

  // ---------- views ----------
  function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view' + name));
    if (name === 'Home') { stopPlayback(); renderHome(); }
    if (name === 'Browse') stopPlayback();
  }

  // ---------- sidebar ----------
  function sideItem(it, opts) {
    const li = el('li', 'side-item' + (S.item && S.item.id === it.id ? ' active' : ''));
    li.dataset.id = it.id;
    li.title = (it.author || '') + (it.title ? ' — ' + it.title : '');
    const pic = opts.history ? (it.thumbnail || it.avatar) : it.avatar;
    const av = el('div', 'side-av' + (opts.follow && !it.is_live ? ' off' : ''), pic ? '' : esc(initial(it)));
    av.style.background = pic ? `center/cover url("${pic}")` : avBg(it.author || it.id);
    if (opts.follow && it.is_live) av.appendChild(el('span', 'ldot'));
    li.appendChild(av);
    const meta = el('div', 'side-meta');
    meta.innerHTML = `<div class="side-name">${esc(opts.history ? (it.title || nameOf(it)) : nameOf(it))}</div><div class="side-sub">${esc(opts.history ? (it.author || it.platform) + (it.last_watched ? ' · ' + ago(it.last_watched) : '') : (it.is_live ? it.category || 'Live' : 'Offline'))}</div>`;
    li.appendChild(meta);
    if (opts.follow && it.is_live) li.appendChild(el('div', 'side-right', '<span class="pulse"></span>' + (it.viewers != null ? esc(fmtNum(it.viewers)) : '')));
    if (opts.history) {
      const x = el('button', 'side-x', '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>');
      x.title = 'Remove from history';
      x.onclick = e => { e.stopPropagation(); removeHistory(it.id); };
      li.appendChild(x);
      if (it.duration && it.progress) { const p = el('div', 'side-prog', `<i style="width:${Math.min(100, it.progress / it.duration * 100)}%"></i>`); li.appendChild(p); }
    }
    li.onclick = () => openInput(it.url || it.id, it);
    li.oncontextmenu = e => { e.preventDefault(); ctxMenu(e, it, opts); };
    return li;
  }
  function renderSidebar() {
    const fl = $('#followList'); fl.innerHTML = '';
    const f = S.follows.slice().sort((a, b) => (b.is_live ? 1 : 0) - (a.is_live ? 1 : 0) || (b.viewers || 0) - (a.viewers || 0));
    if (!f.length) fl.appendChild(el('div', 'side-empty', 'Follow channels to see them here.'));
    f.forEach(it => fl.appendChild(sideItem(it, { follow: true })));
    const live = f.filter(i => i.is_live).length;
    $('#followCount').textContent = live ? live + ' live' : '';
    const hl = $('#historyList'); hl.innerHTML = '';
    if (!S.history.length) hl.appendChild(el('div', 'side-empty', 'Nothing watched yet.'));
    S.history.slice(0, 30).forEach(it => hl.appendChild(sideItem(it, { history: true })));
    window.LW && LW.emit && LW.emit('sidebarRendered');
  }
  function ctxMenu(e, it, opts) {
    const m = $('#ctxMenu'); m.innerHTML = '';
    const add = (label, fn) => { const b = el('button', null, esc(label)); b.onclick = () => { m.hidden = true; fn(); }; m.appendChild(b); };
    add('Watch', () => openInput(it.url || it.id, it));
    if (opts.history) add('Remove from history', () => removeHistory(it.id));
    const followed = S.follows.some(f => f.id === it.id);
    if (it.kind === 'channel') add(followed ? 'Unfollow' : 'Follow', () => toggleFollow(it));
    add('Copy link', () => navigator.clipboard && navigator.clipboard.writeText(it.url || ''));
    m.hidden = false;
    m.style.left = Math.min(e.clientX, innerWidth - 200) + 'px';
    m.style.top = Math.min(e.clientY, innerHeight - 160) + 'px';
  }
  document.addEventListener('click', () => { $('#ctxMenu').hidden = true; });

  async function removeHistory(id) {
    const r = await call('remove_history', id);
    if (!r.ok) return toast(r.error, 'error');
    S.history = S.history.filter(i => i.id !== id); renderSidebar(); renderHome();
  }

  // ---------- home ----------
  function card(it, opts) {
    const c = el('div', 'card');
    const thumb = el('div', 'thumb');
    if (it.thumbnail) { const i = el('div', 'thumb-img'); i.style.backgroundImage = `url("${it.thumbnail}")`; thumb.appendChild(i); }
    else { const i = el('div', 'thumb-img'); i.style.background = avBg(it.author || it.id); thumb.appendChild(i); thumb.appendChild(el('div', 'thumb-ph', esc(initial(it)))); }
    if (it.is_live) thumb.appendChild(el('span', 'tag', 'LIVE'));
    if (it.is_live && it.viewers != null) thumb.appendChild(el('span', 'viewers', esc(fmtNum(it.viewers)) + ' viewers'));
    if (!it.is_live && it.duration) thumb.appendChild(el('span', 'tag r', fmtTime(it.duration)));
    if (opts && opts.progress && it.duration) thumb.appendChild(el('div', 'prog', `<i style="width:${Math.min(100, (it.progress || 0) / it.duration * 100)}%"></i>`));
    c.appendChild(thumb);
    const av = el('div', 'card-av', esc(initial(it))); av.style.background = avBg(it.author || it.id);
    const meta = el('div', 'card-meta'); meta.appendChild(av);
    meta.appendChild(el('div', 'card-text', `<div class="card-title">${esc(it.title || nameOf(it))}</div><div class="card-sub">${esc(it.author || it.platform)}</div><div class="card-cat">${esc(it.category || (it.last_watched ? ago(it.last_watched) : ''))}</div>`));
    c.appendChild(meta);
    c.onclick = () => openInput(it.url || it.id, it);
    c.oncontextmenu = e => { e.preventDefault(); ctxMenu(e, it, { history: opts && opts.progress }); };
    return c;
  }
  function skeletons(n) { let s = ''; for (let i = 0; i < n; i++) s += '<div class="card skel-card"><div class="thumb skel"></div><div class="skel skel-line" style="width:80%"></div><div class="skel skel-line" style="width:50%"></div></div>'; return s; }
  let homeLoaded = false;
  function renderHome() {
    const gl = $('#gridLive'), gc = $('#gridContinue'), rl = $('#recList');
    if (!homeLoaded) { gl.innerHTML = skeletons(4); gc.innerHTML = skeletons(4); return; }
    gl.innerHTML = ''; gc.innerHTML = ''; rl.innerHTML = '';
    const live = S.follows.filter(i => i.is_live).sort((a, b) => (b.viewers || 0) - (a.viewers || 0));
    if (!live.length) gl.appendChild(el('div', 'empty', 'None of your follows are live right now.'));
    live.forEach(it => gl.appendChild(card(it)));
    const cont = S.history.filter(i => i.kind !== 'channel').slice(0, 12);
    if (!cont.length) gc.appendChild(el('div', 'empty', 'VODs and videos you watch will show up here.'));
    cont.forEach(it => gc.appendChild(card(it, { progress: true })));
    if (!S.recordings.length) rl.appendChild(el('div', 'empty', 'No recordings yet. Hit the record button while watching.'));
    S.recordings.forEach(r => rl.appendChild(el('div', 'rec', `${r.active ? '<span class="pulse"></span>' : '<svg viewBox="0 0 24 24"><path d="M15 10l5-3v10l-5-3zM3 6h12v12H3z"/></svg>'}<span class="path" title="${esc(r.path)}">${esc(r.path)}</span><span class="when">${r.active ? 'recording…' : esc(ago(r.started))}</span>`)));
  }

  async function loadData() {
    const [f, h, r] = await Promise.all([call('follows'), call('history'), call('recordings')]);
    if (f.ok) S.follows = f.items || [];
    if (h.ok) S.history = h.items || [];
    if (r.ok) { S.recordings = r.items || []; S.recordings.forEach(x => x.active && S.recording.add(x.item_id)); }
    homeLoaded = true; renderSidebar(); renderHome(); updateFollowBtn(); updateRecBtn();
  }

  // ---------- settings / theme ----------
  function applyTheme(t) { document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : 'dark'); }
  async function loadSettings() {
    const r = await call('get_settings');
    if (r.ok) { S.settings = r.settings || {}; applyTheme(S.settings.theme); }
  }
  function openSettings() {
    const f = $('#settingsForm');
    for (const k of ['player_path', 'default_quality', 'record_dir', 'live_poll_minutes', 'theme']) if (f[k]) f[k].value = S.settings[k] != null ? S.settings[k] : '';
    f.low_latency.checked = !!S.settings.low_latency;
    openModal('settingsModal');
  }
  $('#settingsForm').onsubmit = async e => {
    e.preventDefault(); const f = e.target;
    const d = { player_path: f.player_path.value.trim(), default_quality: f.default_quality.value, record_dir: f.record_dir.value.trim(), live_poll_minutes: Math.max(1, parseInt(f.live_poll_minutes.value, 10) || 3), low_latency: f.low_latency.checked, theme: f.theme.value };
    const r = await call('set_settings', d);
    if (!r.ok) return toast(r.error, 'error');
    S.settings = r.settings || d; applyTheme(S.settings.theme); closeModals(); toast('Settings saved');
  };

  // ---------- modals ----------
  function openModal(id) { closeModals(); $('#' + id).hidden = false; }
  function closeModals() { document.querySelectorAll('.modal').forEach(m => { m.hidden = true; }); }
  document.querySelectorAll('.modal').forEach(m => m.addEventListener('mousedown', e => { if (e.target === m || e.target.hasAttribute('data-close')) closeModals(); }));
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModals));

  // ---------- open / play ----------
  async function openInput(input, hint) {
    input = String(input || '').trim();
    if (!input) return;
    const token = ++S.loadToken;
    showView('Player');
    teardownVideo();
    player.classList.add('loading'); player.classList.remove('is-live', 'at-live');
    $('#playerError').hidden = true; $('#skelText').textContent = 'Resolving ' + (hint ? nameOf(hint) : input) + '…';
    setInfo(hint || { title: input, author: '', category: '' });
    const r = await call('resolve', input);
    if (token !== S.loadToken) return;
    if (!r.ok) return showError(r.error || 'Could not resolve link');
    S.item = r.item; S.qualities = r.qualities || []; S.quality = r.default_quality || S.settings.default_quality || S.qualities[0] || 'best';
    if (!S.qualities.includes(S.quality) && S.qualities.length) S.quality = S.qualities.includes('best') ? 'best' : S.qualities[0];
    setInfo(S.item); renderSidebar(); updateFollowBtn(); updateRecBtn(); buildQualityMenu();
    connectChat(S.item);
    pollViewers();
    await startPlay(token);
  }
  async function startPlay(token, keepTime) {
    $('#skelText').textContent = 'Starting ' + S.quality + '…';
    player.classList.add('loading');
    const r = await call('play', S.item.id, S.quality);
    if (token !== S.loadToken) return;
    if (!r.ok) return showError(r.error || 'Playback failed');
    S.isLive = !!r.is_live; S.kind = r.kind || 'hls';
    player.classList.toggle('is-live', S.isLive);
    $('#cSpeed').parentElement.style.display = S.isLive ? 'none' : '';
    $('#infoLive').classList.toggle('on', S.isLive);
    loadSource(r.src, keepTime);
    LW.emit('playing', S.item, r);
    refreshLists();
  }
  function loadSource(src, keepTime) {
    teardownVideo();
    const resumeAt = keepTime != null ? keepTime : (!S.isLive && S.item.progress > 5 && (!S.item.duration || S.item.progress < S.item.duration - 15) ? S.item.progress : 0);
    const onReady = () => {
      player.classList.remove('loading');
      if (resumeAt && !S.isLive) { video.currentTime = resumeAt; if (keepTime == null) osd('Resumed at ' + fmtTime(resumeAt)); }
      video.play().catch(() => { video.muted = true; syncVol(); video.play().catch(() => {}); });
    };
    if (S.kind === 'hls' && window.Hls && Hls.isSupported()) {
      const hls = new Hls({
        lowLatencyMode: !!S.settings.low_latency,
        liveBackBufferLength: 60 * 60 * 2, backBufferLength: 90,
        liveSyncDurationCount: S.settings.low_latency ? 2 : 3,
        maxLiveSyncPlaybackRate: S.settings.low_latency ? 1.15 : 1,
        enableWorker: true
      });
      S.hls = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, onReady);
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) { osd('Network error, retrying…'); hls.startLoad(); }
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else showError('Playback error: ' + d.details);
      });
      hls.loadSource(src); hls.attachMedia(video);
    } else {
      video.src = src;
      video.addEventListener('loadedmetadata', onReady, { once: true });
    }
  }
  function teardownVideo() {
    if (S.hls) { try { S.hls.destroy(); } catch (e) { /* ignore */ } S.hls = null; }
    video.removeAttribute('src'); try { video.load(); } catch (e) { /* ignore */ }
    video.playbackRate = 1; $('#cSpeed').textContent = '1×';
  }
  function stopPlayback() {
    saveProgress(true);
    S.loadToken++; teardownVideo(); disconnectChat(); clearTimeout(viewersT); setViewers(null); S.item = null;
    LW.emit('stopped');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    renderSidebar();
  }
  function showError(msg) {
    player.classList.remove('loading');
    const e = $('#playerError'); e.hidden = false; e.innerHTML = '<div><b>Couldn\'t play this.</b><br>' + esc(msg) + '</div>';
    toast(msg, 'error');
  }
  let viewersT;
  function setViewers(v) {
    const b = $('#infoViewers');
    b.hidden = v == null; if (v != null) { b.querySelector('span').textContent = Number(v).toLocaleString(); b.title = v.toLocaleString() + ' viewers'; }
  }
  async function pollViewers() {
    clearTimeout(viewersT);
    const it = S.item; if (!it || it.kind !== 'channel' || it.platform !== 'twitch') { setViewers(null); return; }
    const r = await call('stream_stats', it.id);
    if (!S.item || S.item.id !== it.id) return;
    const v = r.ok ? r.viewers : null; setViewers(v);
    if (v != null) { it.viewers = v; S.follows.forEach(f => { if (f.id === it.id) f.viewers = v; }); renderSidebar(); }
    viewersT = setTimeout(pollViewers, 60000);
  }
  function setInfo(it) {
    $('#infoTitle').textContent = it.title || nameOf(it);
    $('#infoAuthor').textContent = it.author || it.platform || '';
    $('#infoCategory').textContent = it.category || it.kind || '';
    setAvatar(it);
    loadAbout(it);
    LW.emit('itemOpened', it);
    $('#infoLive').classList.toggle('on', !!it.is_live);
    setViewers(it.is_live && it.viewers != null ? it.viewers : null);
    document.title = (it.author || it.title || 'Lightweight') + ' · Lightweight';
  }
  function setAvatar(it) {
    const a = $('#infoAvatar');
    if (it.avatar) { a.textContent = ''; a.style.background = `center/cover url("${it.avatar}")`; a.classList.add('pic'); }
    else { a.textContent = initial(it); a.style.background = avBg(it.author || it.id); a.classList.remove('pic'); }
  }
  const linkify = t => esc(t).replace(/(https?:\/\/[^\s<]+[^\s<.,)!?])/g, '<a href="#" data-url="$1">$1</a>')
    .replace(/([\w.+-]+@[\w-]+\.[\w.]+)/g, '<a href="#" data-url="mailto:$1">$1</a>');
  async function loadAbout(it) {
    const box = $('#about'), id = it.id;
    box.classList.remove('ready'); box.classList.add('loading');
    $('#aboutName').textContent = 'About ' + nameOf(it);
    $('#aboutBio').innerHTML = '<span class="skel-line"></span><span class="skel-line short"></span>';
    $('#aboutLinks').innerHTML = '';
    const r = await call('profile', id);
    if (!S.item || S.item.id !== id) return;  // user switched channels meanwhile
    box.classList.remove('loading');
    if (!r.ok) { box.classList.remove('ready'); box.hidden = true; return; }
    box.hidden = false;
    if (r.avatar) { it.avatar = r.avatar; S.item.avatar = r.avatar; setAvatar(it); [S.follows, S.history].forEach(l => l.forEach(x => { if (x.id === id) x.avatar = r.avatar; })); renderSidebar(); }
    $('#aboutBio').innerHTML = r.bio ? linkify(r.bio) : '<span class="muted">' + (it.is_live ? 'Bio shows when the channel is offline.' : 'No bio yet.') + '</span>';
    $('#aboutLinks').innerHTML = (r.links || []).map(l => `<button class="chip" data-url="${esc(l.url)}">${esc(l.label)}<svg viewBox="0 0 24 24"><path d="M7 17 17 7M8 7h9v9"/></svg></button>`).join('');
    requestAnimationFrame(() => box.classList.add('ready'));
  }
  document.addEventListener('click', e => {
    const a = e.target.closest('#about [data-url]'); if (!a) return;
    e.preventDefault(); const u = a.dataset.url;
    if (u.startsWith('mailto:')) { navigator.clipboard && navigator.clipboard.writeText(u.slice(7)); toast('Email copied: ' + u.slice(7)); }
    else call('open_url', u);
  });
  async function refreshLists() {
    const h = await call('history'); if (h.ok) { S.history = h.items || []; renderSidebar(); }
  }

  // ---------- progress ----------
  function saveProgress(force) {
    if (!S.item || S.isLive || !isFinite(video.currentTime) || video.currentTime < 1) return;
    const now = Date.now();
    if (!force && now - S.lastSave < 10000) return;
    S.lastSave = now; S.item.progress = video.currentTime;
    call('save_progress', S.item.id, video.currentTime);
  }
  window.addEventListener('beforeunload', () => saveProgress(true));

  // ---------- follow / record / external ----------
  function updateFollowBtn() {
    const b = $('#btnFollow');
    const can = S.item && S.item.kind === 'channel';
    b.style.display = can ? '' : 'none';
    const on = can && S.follows.some(f => f.id === S.item.id);
    b.classList.toggle('on', !!on); b.querySelector('span').textContent = on ? 'Following' : 'Follow';
  }
  async function toggleFollow(it) {
    it = it || S.item; if (!it) return;
    const on = S.follows.some(f => f.id === it.id);
    const r = await call(on ? 'unfollow' : 'follow', it.id);
    if (!r.ok) return toast(r.error, 'error');
    if (on) S.follows = S.follows.filter(f => f.id !== it.id); else S.follows.push(it);
    toast(on ? 'Unfollowed ' + nameOf(it) : 'Following ' + nameOf(it));
    renderSidebar(); updateFollowBtn(); if ($('#viewHome').classList.contains('active')) renderHome();
  }
  function updateRecBtn() { const on = S.item && S.recording.has(S.item.id); $('#cRecord').classList.toggle('on', !!on); $('#cRecord').title = on ? 'Stop recording' : 'Record'; }
  let recBusy = false;
  async function toggleRecord() {
    if (!S.item || recBusy) return;
    recBusy = true;
    const btn = $('#cRecord'); btn.disabled = true; btn.classList.add('busy');
    const id = S.item.id, on = S.recording.has(id);
    try {
      const r = await call(on ? 'record_stop' : 'record_start', id, S.quality);
      if (!r.ok && !(on && /not recording/i.test(r.error || ''))) return toast(r.error, 'error');
      if (on) S.recording.delete(id); else S.recording.add(id);
    } finally {
      recBusy = false; btn.disabled = false; btn.classList.remove('busy'); updateRecBtn();
    }
  }
  async function openExternal() {
    if (!S.item) return;
    video.pause();
    const r = await call('open_external', S.item.id, S.quality);
    toast(r.ok ? 'Opening in external player…' : r.error, r.ok ? 'info' : 'error');
  }

  // ---------- quality / speed menus ----------
  function buildQualityMenu() {
    const m = $('#qualityMenu'); m.innerHTML = '';
    S.qualities.forEach(q => {
      const b = el('button', q === S.quality ? 'sel' : '', esc(q));
      b.onclick = e => { e.stopPropagation(); closeMenus(); if (q === S.quality) return; S.quality = q; buildQualityMenu(); osd('Quality: ' + q); startPlay(S.loadToken, S.isLive ? null : video.currentTime); };
      m.appendChild(b);
    });
  }
  function buildSpeedMenu() {
    const m = $('#speedMenu'); m.innerHTML = '';
    [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].forEach(r => {
      const b = el('button', r === video.playbackRate ? 'sel' : '', r + '×');
      b.onclick = e => { e.stopPropagation(); video.playbackRate = r; $('#cSpeed').textContent = r + '×'; closeMenus(); osd('Speed ' + r + '×'); };
      m.appendChild(b);
    });
  }
  function closeMenus() { document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open')); }
  $('#cQuality').onclick = e => { e.stopPropagation(); const m = $('#qualityMenu'); const o = m.classList.contains('open'); closeMenus(); if (!o) m.classList.add('open'); };
  $('#cSpeed').onclick = e => { e.stopPropagation(); buildSpeedMenu(); const m = $('#speedMenu'); const o = m.classList.contains('open'); closeMenus(); if (!o) m.classList.add('open'); };
  document.addEventListener('click', closeMenus);

  // ---------- player controls ----------
  let osdT;
  function osd(t) { const o = $('#osd'); o.textContent = t; o.classList.add('show'); clearTimeout(osdT); osdT = setTimeout(() => o.classList.remove('show'), 1200); }
  function togglePlay() { if (video.paused) video.play().catch(() => {}); else video.pause(); }
  function range() {
    // returns [start, end] of seekable window
    if (S.isLive) {
      const s = video.seekable; if (!s.length) return [0, 0];
      const end = (S.hls && S.hls.liveSyncPosition) || s.end(s.length - 1);
      return [s.start(0), Math.max(end, s.start(0))];
    }
    return [0, isFinite(video.duration) ? video.duration : (S.item && S.item.duration) || 0];
  }
  function seekBy(d) {
    const [a, b] = range(); if (b <= a) return;
    video.currentTime = Math.max(a, Math.min(b, video.currentTime + d)); osd((d > 0 ? '+' : '') + d + 's'); poke();
  }
  function goLive() { const [, b] = range(); if (b) video.currentTime = b; video.play().catch(() => {}); osd('Live'); }
  function syncVol() { player.classList.toggle('muted', video.muted || video.volume === 0); $('#cVol').value = video.muted ? 0 : video.volume; }
  function toggleMute() { video.muted = !video.muted; if (!video.muted && video.volume === 0) video.volume = .5; syncVol(); osd(video.muted ? 'Muted' : 'Volume ' + Math.round(video.volume * 100) + '%'); }
  function toggleFull() { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else (player.requestFullscreen ? player.requestFullscreen() : (video.webkitEnterFullscreen && video.webkitEnterFullscreen())); }
  function toggleTheatre() { app.classList.toggle('theatre'); try { localStorage.setItem('lw.theatre', app.classList.contains('theatre') ? '1' : ''); } catch (e) { /* ignore */ } }
  async function togglePip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (video.requestPictureInPicture) await video.requestPictureInPicture();
      else if (video.webkitSetPresentationMode) video.webkitSetPresentationMode(video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
      else toast('Picture-in-picture is not supported here', 'error');
    } catch (e) { toast('PiP failed: ' + e.message, 'error'); }
  }
  function toggleChat() { app.classList.toggle('chat-hidden'); try { localStorage.setItem('lw.chat', app.classList.contains('chat-hidden') ? '0' : '1'); } catch (e) { /* ignore */ } }

  $('#cPlay').onclick = togglePlay; $('#bigPlay').onclick = togglePlay;
  video.addEventListener('click', togglePlay); video.addEventListener('dblclick', toggleFull);
  $('#cBack').onclick = () => seekBy(-10); $('#cFwd').onclick = () => seekBy(10);
  $('#cMute').onclick = toggleMute;
  $('#cVol').oninput = e => { video.volume = +e.target.value; video.muted = video.volume === 0; syncVol(); try { localStorage.setItem('lw.vol', video.volume); } catch (x) { /* ignore */ } };
  $('#cLive').onclick = goLive; $('#cFull').onclick = toggleFull; $('#cTheatre').onclick = toggleTheatre; $('#cPip').onclick = togglePip; $('#cRecord').onclick = toggleRecord;
  $('#btnFollow').onclick = () => toggleFollow(); $('#btnVlc').onclick = openExternal; $('#btnChat').onclick = toggleChat; $('#btnChatClose').onclick = toggleChat;

  ['play', 'pause', 'playing'].forEach(ev => video.addEventListener(ev, () => player.classList.toggle('paused', video.paused)));
  video.addEventListener('waiting', () => $('#skelText').textContent = 'Buffering…');
  video.addEventListener('volumechange', syncVol);
  video.addEventListener('timeupdate', () => { updateBar(); saveProgress(false); });
  video.addEventListener('progress', updateBar);
  video.addEventListener('pause', () => saveProgress(true));
  player.classList.add('paused');

  function updateBar() {
    const [a, b] = range(), span = b - a, t = video.currentTime;
    const pct = span > 0 ? Math.max(0, Math.min(1, (t - a) / span)) * 100 : (S.isLive ? 100 : 0);
    $('#seekFill').style.width = pct + '%'; $('#seekThumb').style.left = pct + '%';
    let buf = 0; const br = video.buffered; if (br.length && span > 0) buf = Math.min(1, (br.end(br.length - 1) - a) / span) * 100;
    $('#seekBuf').style.width = buf + '%';
    if (S.isLive) {
      const behind = Math.max(0, b - t);
      player.classList.toggle('at-live', behind < 6);
      $('#cTime').textContent = behind < 6 ? '' : '-' + fmtTime(behind);
      const lat = S.hls && isFinite(S.hls.latency) ? S.hls.latency : null;
      $('#cLatency').textContent = lat != null ? 'Latency ' + lat.toFixed(1) + 's' : '';
    } else {
      $('#cTime').textContent = fmtTime(t) + ' / ' + fmtTime(b); $('#cLatency').textContent = '';
    }
  }
  // seek bar
  const seek = $('#seek');
  const seekPos = e => { const r = seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  let dragging = false;
  seek.addEventListener('mousemove', e => {
    const p = seekPos(e), [a, b] = range(), t = a + p * (b - a);
    const tip = $('#seekTip'); tip.style.left = p * 100 + '%';
    tip.textContent = S.isLive ? (b - t < 3 ? 'Live' : '-' + fmtTime(b - t)) : fmtTime(t);
  });
  seek.addEventListener('mousedown', e => { dragging = true; doSeek(e); });
  window.addEventListener('mousemove', e => { if (dragging) doSeek(e); });
  window.addEventListener('mouseup', () => { dragging = false; });
  function doSeek(e) { const [a, b] = range(); if (b > a) { video.currentTime = a + seekPos(e) * (b - a); updateBar(); } }

  // auto-hide controls
  let idleT;
  function poke() { player.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => { if (!video.paused && !document.querySelector('.menu.open') && !dragging) player.classList.add('idle'); }, 2500); }
  player.addEventListener('mousemove', poke); player.addEventListener('mouseleave', () => { if (!video.paused) player.classList.add('idle'); });
  video.addEventListener('play', poke);

  // ---------- chat ----------
  function chatSys(t) { addMsg(el('div', 'msg sys', esc(t))); }
  function addMsg(node) {
    const body = $('#chatBody');
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    body.appendChild(node);
    while (body.childElementCount > 300) body.firstChild.remove();
    if (atBottom) body.scrollTop = body.scrollHeight;
  }
  function disconnectChat() {
    if (LW.chat) return LW.chat.disconnect(); // features/chat.js takes over
    if (S.chatWs) { S.chatWs.onclose = null; try { S.chatWs.close(); } catch (e) { /* ignore */ } S.chatWs = null; }
    clearTimeout(S.chatRetry);
  }
  function parseTags(raw) { const o = {}; raw.split(';').forEach(kv => { const i = kv.indexOf('='); o[kv.slice(0, i)] = kv.slice(i + 1).replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\'); }); return o; }
  async function connectChat(it) {
    if (LW.chat) return LW.chat.connect(it); // features/chat.js takes over
    disconnectChat();
    $('#chatBody').innerHTML = ''; $('#chatStatus').textContent = '';
    const r = await call('chat_info', it.id);
    if (!S.item || S.item.id !== it.id) return;
    if (!r.ok || !r.channel) { $('#chat').style.display = 'none'; return; }
    $('#chat').style.display = '';
    const channel = String(r.channel).toLowerCase().replace(/^#/, '');
    let tries = 0;
    const open = () => {
      $('#chatStatus').textContent = 'connecting…';
      let ws;
      try { ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443'); } catch (e) { $('#chatStatus').textContent = 'offline'; return; }
      S.chatWs = ws;
      ws.onopen = () => {
        tries = 0;
        ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
        ws.send('PASS SCHMOOPIIE');
        ws.send('NICK justinfan' + (10000 + Math.floor(Math.random() * 89999)));
        ws.send('JOIN #' + channel);
      };
      ws.onmessage = ev => String(ev.data).split('\r\n').forEach(line => {
        if (!line) return;
        if (line.startsWith('PING')) { ws.send('PONG' + line.slice(4)); return; }
        let tags = {}, rest = line;
        if (rest[0] === '@') { const sp = rest.indexOf(' '); tags = parseTags(rest.slice(1, sp)); rest = rest.slice(sp + 1); }
        const m = rest.match(/^:([^!\s]+)(?:![^\s]+)? (\w+) (#\S+)?(?: :(.*))?/);
        if (!m) return;
        const cmd = m[2];
        if (cmd === '366' || (cmd === 'ROOMSTATE' && $('#chatStatus').textContent !== 'connected')) { $('#chatStatus').textContent = 'connected'; chatSys('Welcome to #' + channel + ' chat'); }
        else if (cmd === 'PRIVMSG') {
          let text = m[4] || '';
          const action = /^\u0001ACTION (.*)\u0001$/.exec(text); if (action) text = action[1];
          const name = tags['display-name'] || m[1];
          const color = tags.color || `hsl(${hue(m[1])} 75% 65%)`;
          addMsg(el('div', 'msg', `<b style="color:${esc(color)}">${esc(name)}</b>${action ? ' ' : ': '}<span${action ? ` style="color:${esc(color)}"` : ''}>${esc(text)}</span>`));
        } else if (cmd === 'CLEARCHAT' && !m[4]) chatSys('Chat was cleared by a moderator');
        else if (cmd === 'NOTICE') chatSys(m[4] || '');
      });
      ws.onclose = () => {
        if (S.chatWs !== ws) return;
        $('#chatStatus').textContent = 'reconnecting…';
        S.chatRetry = setTimeout(open, Math.min(30000, 1000 * Math.pow(2, tries++)));
      };
      ws.onerror = () => {};
    };
    open();
  }

  // ---------- command palette ----------
  let palSel = 0, palItems = [];
  function openPalette() { openModal('palette'); const i = $('#paletteInput'); i.value = ''; renderPalette(''); setTimeout(() => i.focus(), 10); }
  function renderPalette(q) {
    q = q.toLowerCase().trim();
    const seen = new Set(), all = [];
    S.follows.concat(S.history).forEach(it => { if (!seen.has(it.id)) { seen.add(it.id); all.push(it); } });
    palItems = all.filter(it => !q || [it.title, it.author, it.category, it.url].join(' ').toLowerCase().includes(q)).slice(0, 30);
    if (q && looksLikeLink(q)) palItems.unshift({ _open: q, title: 'Open "' + q + '"' });
    palSel = 0; drawPalette();
  }
  function drawPalette() {
    const ul = $('#paletteList'); ul.innerHTML = '';
    if (!palItems.length) ul.appendChild(el('li', null, '<span style="color:var(--fg3)">No matches</span>'));
    palItems.forEach((it, i) => {
      const li = el('li', i === palSel ? 'sel' : '');
      if (it._open) li.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 5l7 7-7 7"/></svg><span>' + esc(it.title) + '</span><span class="k">Enter</span>';
      else li.innerHTML = (it.is_live ? '<span class="pulse"></span>' : '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>') + `<span><b>${esc(nameOf(it))}</b> <span style="color:var(--fg3)">${esc(it.title && it.title !== nameOf(it) ? it.title : '')}</span></span><span class="k">${esc(it.platform || '')}</span>`;
      li.onmouseenter = () => { palSel = i; ul.querySelectorAll('li').forEach((x, j) => x.classList.toggle('sel', j === i)); };
      li.onclick = () => pickPalette(i);
      ul.appendChild(li);
    });
  }
  function pickPalette(i) { const it = palItems[i]; if (!it) return; closeModals(); if (it._open) openInput(it._open); else openInput(it.url || it.id, it); }
  $('#paletteInput').addEventListener('input', e => renderPalette(e.target.value));
  $('#paletteInput').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { palSel = Math.min(palItems.length - 1, palSel + 1); drawPalette(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { palSel = Math.max(0, palSel - 1); drawPalette(); e.preventDefault(); }
    else if (e.key === 'Enter') { pickPalette(palSel); e.preventDefault(); }
  });

  // ---------- top bar / global input ----------
  $('#pasteForm').onsubmit = e => { e.preventDefault(); const v = $('#pasteInput').value.trim(); if (v) { $('#pasteInput').value = ''; $('#pasteInput').blur(); openInput(v); } };
  $('#brand').onclick = e => { e.preventDefault(); showView('Home'); };
  $('#btnSidebar').onclick = () => { app.classList.toggle('side-collapsed'); try { localStorage.setItem('lw.side', app.classList.contains('side-collapsed') ? '1' : ''); } catch (x) { /* ignore */ } };
  $('#btnSettings').onclick = openSettings;
  $('#btnHelp').onclick = () => openModal('helpModal');
  $('#btnClearHistory').onclick = async () => { if (!confirm('Clear all watch history?')) return; const r = await call('clear_history'); if (r.ok) { S.history = []; renderSidebar(); renderHome(); } else toast(r.error, 'error'); };
  $('#btnRefresh').onclick = async () => {
    const b = $('#btnRefresh'); b.classList.add('spin');
    const r = await call('refresh_live'); b.classList.remove('spin');
    if (!r.ok) return toast(r.error, 'error');
    mergeLive(r.items || []); toast('Live status updated');
  };
  function mergeLive(items) {
    const byId = {}; items.forEach(i => { byId[i.id] = i; });
    S.follows = S.follows.map(f => byId[f.id] ? Object.assign({}, f, byId[f.id]) : f);
    S.history = S.history.map(h => byId[h.id] ? Object.assign({}, h, byId[h.id]) : h);
    renderSidebar(); if ($('#viewHome').classList.contains('active')) renderHome();
  }

  document.addEventListener('paste', e => {
    if (isTyping(e)) return;
    const t = (e.clipboardData && e.clipboardData.getData('text') || '').trim();
    if (t && looksLikeLink(t.split(/\s/)[0])) { e.preventDefault(); openInput(t.split(/\s/)[0]); }
  });
  // drag & drop
  let dragDepth = 0;
  const dropOv = $('#dropOverlay');
  window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; dropOv.classList.add('show'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropOv.classList.remove('show'); } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0; dropOv.classList.remove('show');
    const dt = e.dataTransfer; const t = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').split(/\s/).find(x => x && !x.startsWith('#'));
    if (t) openInput(t); else toast('Drop a link to watch it', 'error');
  });

  // keyboard
  document.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); if ($('#palette').hidden) openPalette(); else closeModals(); return; }
    if (e.key === 'Escape') { if (document.querySelector('.modal:not([hidden])')) { closeModals(); return; } closeMenus(); if (app.classList.contains('theatre') && !document.fullscreenElement) toggleTheatre(); return; }
    if (isTyping(e) || mod || e.altKey) return;
    if (e.key === '?') { openModal('helpModal'); return; }
    if (!$('#viewPlayer').classList.contains('active') || document.querySelector('.modal:not([hidden])')) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const map = {
      ' ': togglePlay, k: togglePlay, ArrowLeft: () => seekBy(-10), ArrowRight: () => seekBy(10), j: () => seekBy(-10), l: () => seekBy(10),
      f: toggleFull, m: toggleMute, t: toggleTheatre, c: toggleChat, p: togglePip,
      ArrowUp: () => { video.muted = false; video.volume = Math.min(1, video.volume + .05); osd('Volume ' + Math.round(video.volume * 100) + '%'); },
      ArrowDown: () => { video.volume = Math.max(0, video.volume - .05); osd('Volume ' + Math.round(video.volume * 100) + '%'); }
    };
    if (map[k]) { e.preventDefault(); map[k](); poke(); }
  });

  // ---------- browse (Twitch Helix) ----------
  const B = { mode: 'games', game: null, cursor: null, busy: false, items: 0 };
  function gameCard(g) {
    const c = el('div', 'card game');
    const th = el('div', 'thumb'); const i = el('div', 'thumb-img');
    if (g.box_art) i.style.backgroundImage = `url("${g.box_art}")`; else i.style.background = avBg(g.name);
    th.appendChild(i); c.appendChild(th);
    c.appendChild(el('div', 'card-meta', `<div class="card-text"><div class="card-title">${esc(g.name)}</div>${g.viewers != null ? `<div class="card-sub">~${esc(fmtNum(g.viewers))} viewers</div>` : ''}</div>`));
    c.title = g.name;
    c.onclick = () => browseOpen('streams', g);
    return c;
  }
  async function browseLoad(reset) {
    if (B.busy) return;
    const grid = $('#browseGrid'), more = $('#browseMore');
    if (reset) {
      B.cursor = null; B.items = 0; grid.innerHTML = skeletons(8); more.hidden = true;
      const st = await call('browse_status');
      if (st.ok && !st.configured) {
        grid.innerHTML = '<div class="empty">Twitch API not configured. Create an app at dev.twitch.tv/console, then put <code>TWITCH_CLIENT_ID</code> and <code>TWITCH_CLIENT_SECRET</code> in a <code>.env</code> file next to app.py (or ~/.lightweight/.env) and restart.</div>';
        return;
      }
    }
    B.busy = true; more.disabled = true; more.textContent = 'Loading…';
    const r = B.mode === 'games' ? await call('browse_games', B.cursor) : await call('browse_streams', B.game ? B.game.id : null, B.cursor);
    B.busy = false; more.disabled = false; more.textContent = 'Load more';
    if (reset) grid.innerHTML = '';
    if (!r.ok) { if (!B.items) grid.innerHTML = `<div class="empty">${esc(r.error)}</div>`; else toast(r.error, 'error'); return; }
    const items = r.items || [];
    items.forEach(x => grid.appendChild(B.mode === 'games' ? gameCard(x) : card(x)));
    B.items += items.length;
    if (!B.items) grid.innerHTML = '<div class="empty">Nothing live here right now.</div>';
    B.cursor = r.cursor || null;
    more.hidden = !B.cursor || !items.length;
  }
  function browseOpen(mode, game) {
    B.mode = mode; B.game = game || null;
    $('#browseGrid').classList.toggle('games', mode === 'games');
    $('#browseBack').hidden = !B.game;
    $('#browseTabs').hidden = !!B.game;
    $('#browseTitle').textContent = B.game ? B.game.name : 'Browse';
    document.querySelectorAll('#browseTabs .chip').forEach(b => b.classList.toggle('on', b.dataset.tab === mode));
    $('#main').scrollTop = 0;
    browseLoad(true);
  }
  $('#btnBrowse').onclick = () => { showView('Browse'); if (!$('#browseGrid').childElementCount || B.game) browseOpen(B.game ? 'streams' : B.mode, B.game); };
  $('#browseBack').onclick = () => browseOpen('games');
  $('#browseMore').onclick = () => browseLoad(false);
  document.querySelectorAll('#browseTabs .chip').forEach(b => b.onclick = () => browseOpen(b.dataset.tab));
  // infinite scroll: auto-load when the "Load more" button comes into view
  if (window.IntersectionObserver) new IntersectionObserver(es => { if (es[0].isIntersecting && !$('#browseMore').hidden && $('#viewBrowse').classList.contains('active')) browseLoad(false); }, { root: $('#main'), rootMargin: '400px' }).observe($('#browseMore'));

  // ---------- events from Python ----------
  window.lw = {
    onEvent(evt) {
      LW.emit('event', evt);
      if (!evt || !evt.type) return;
      if (evt.type === 'live') {
        const before = new Set(S.follows.filter(f => f.is_live).map(f => f.id));
        mergeLive(evt.items || []);
        (evt.items || []).forEach(i => { if (i.is_live && !before.has(i.id) && S.follows.some(f => f.id === i.id)) toast(nameOf(i) + ' is live' + (i.category ? ' · ' + i.category : '')); });
      } else if (evt.type === 'record') {
        if (evt.state === 'started') { S.recording.add(evt.item_id); toast('Recording started → ' + (evt.path || '')); }
        else { S.recording.delete(evt.item_id); toast(evt.state === 'error' ? 'Recording failed' + (evt.path ? ': ' + evt.path : '') : 'Recording saved' + (evt.path ? ' → ' + evt.path : ''), evt.state === 'error' ? 'error' : 'info'); }
        updateRecBtn();
        call('recordings').then(r => { if (r.ok) { S.recordings = r.items || []; if ($('#viewHome').classList.contains('active')) renderHome(); } });
      } else if (evt.type === 'toast') toast(evt.text, evt.level);
    }
  };

  // ---------- boot ----------
  function restorePrefs() {
    try {
      if (localStorage.getItem('lw.side')) app.classList.add('side-collapsed');
      if (localStorage.getItem('lw.theatre')) app.classList.add('theatre');
      if (localStorage.getItem('lw.chat') === '0') app.classList.add('chat-hidden');
      const v = localStorage.getItem('lw.vol'); if (v != null) video.volume = +v;
    } catch (e) { /* ignore */ }
    syncVol();
  }
  // ---------- feature plug-in surface (ui/features/*.js use window.LW) ----------
  const LW = window.LW = window.LW || {};
  const readyCbs = LW._ready || [];
  Object.assign(LW, {
    $, el, esc, fmtTime, call, toast, showView, openInput, renderSidebar, renderHome, setInfo, nameOf, initial, avBg,
    openModal, closeModals, stopPlayback, loadData,
    get S() { return S; }, get video() { return video; }, get hls() { return S.hls; },
    hooks: { itemOpened: [], playing: [], stopped: [], event: [], sidebarRendered: [] },
    on(name, fn) { (LW.hooks[name] = LW.hooks[name] || []).push(fn); },
    emit(name, ...a) { (LW.hooks[name] || []).forEach(f => { try { f(...a); } catch (e) { console.error(e); } }); },
    ready(fn) { booted ? fn(LW) : readyCbs.push(fn); }
  });
  let booted = false;
  async function boot(api) {
    if (booted) return; booted = true; API = api;
    readyCbs.splice(0).forEach(f => { try { f(LW); } catch (e) { console.error(e); } });
    restorePrefs(); renderHome();
    await loadSettings();
    await loadData();
  }
  if (window.pywebview && window.pywebview.api && window.pywebview.api.resolve) boot(window.pywebview.api);
  else {
    window.addEventListener('pywebviewready', () => boot(window.pywebview.api));
    // plain browser: fall back to mock if pywebview doesn't show up quickly
    setTimeout(() => { if (!booted && !window.pywebview) { console.info('[lightweight] pywebview not found – using mock API'); boot(makeMock()); } }, 600);
  }
})();

/* chat feature – see CONTRACT.md 'Features'.
   Anonymous read-only Twitch IRC chat with native + 7TV/BTTV/FFZ emotes, badges,
   keyword highlights, bot filter, pop-out window. Works in two modes:
   - main window: takes over #chat (app.js connectChat/disconnectChat delegate to LW.chat)
   - standalone: ui/features/chat_popout.html (?channel=name), no LW present. */
(function () {
  'use strict';
  const STANDALONE = !!window.LW_CHAT_STANDALONE;
  const MAX = 250, MAX_PAUSED = 800;
  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hue = s => { let h = 0; for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const svg = d => `<svg viewBox="0 0 24 24">${d}</svg>`;

  function api() { return window.pywebview && window.pywebview.api; }
  async function call(name, ...a) {
    if (window.LW && LW.call) return LW.call(name, ...a);
    const p = api();
    if (!p || !p[name]) return { ok: false, error: 'unavailable' };
    try { return await p[name](...a); } catch (e) { return { ok: false, error: String(e) }; }
  }

  const DEFAULTS = { highlights: [], sound: false, hide_bots: true, bots: ['nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot'], font_size: 13, timestamps: false, third_party: true };
  const C = {
    prefs: Object.assign({}, DEFAULTS), ws: null, retry: null, channel: null, gen: 0,
    emotes: {}, badges: {}, roomId: null, paused: false, hover: false, queue: [], raf: 0, hlRe: null, botSet: new Set(), lastBeep: 0
  };
  let root, body, statusEl, moreBtn, panel;

  // ---------- DOM ----------
  function mount() {
    root = document.getElementById('chat');
    if (!root) return false;
    root.classList.add('lwc');
    body = document.getElementById('chatBody');
    statusEl = document.getElementById('chatStatus');
    const head = root.querySelector('.chat-head');
    const close = document.getElementById('btnChatClose');
    const mkBtn = (id, title, icon) => { const b = document.createElement('button'); b.className = 'icon-btn sm lwc-hbtn'; b.id = id; b.title = title; b.innerHTML = svg(icon); return b; };
    const gear = mkBtn('lwcGear', 'Chat settings', '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>');
    gear.onclick = e => { e.stopPropagation(); togglePanel(); };
    if (!STANDALONE) {
      const pop = mkBtn('lwcPop', 'Pop out chat', '<path d="M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>');
      pop.onclick = popout;
      head.insertBefore(pop, close || null);
    }
    head.insertBefore(gear, close || null);

    panel = document.createElement('div');
    panel.className = 'lwc-panel'; panel.hidden = true;
    panel.innerHTML = `
      <label class="lwc-l">Highlight keywords <small>(comma or new line; your username…)</small>
        <textarea data-k="highlights" rows="2" spellcheck="false"></textarea></label>
      <label class="lwc-c"><input type="checkbox" data-k="sound"> Soft sound on highlight</label>
      <label class="lwc-c"><input type="checkbox" data-k="hide_bots"> Hide bots</label>
      <label class="lwc-l">Bot names<textarea data-k="bots" rows="2" spellcheck="false"></textarea></label>
      <label class="lwc-c"><input type="checkbox" data-k="timestamps"> Show timestamps</label>
      <label class="lwc-c"><input type="checkbox" data-k="third_party"> 7TV / BTTV / FFZ emotes</label>
      <label class="lwc-l">Font size <span data-v="font_size"></span><input type="range" min="10" max="22" step="1" data-k="font_size"></label>`;
    panel.addEventListener('input', onPanelInput);
    panel.addEventListener('click', e => e.stopPropagation());
    root.insertBefore(panel, body);
    document.addEventListener('click', () => { if (!panel.hidden) togglePanel(false); });

    moreBtn = document.createElement('button');
    moreBtn.className = 'lwc-more'; moreBtn.hidden = true; moreBtn.textContent = 'More messages below';
    moreBtn.onclick = () => { C.hover = false; resume(); };
    root.insertBefore(moreBtn, body.nextSibling);

    body.addEventListener('scroll', onScroll, { passive: true });
    body.addEventListener('mouseenter', () => { C.hover = true; });
    body.addEventListener('mouseleave', () => { C.hover = false; if (!C.paused) stick(); });
    body.addEventListener('click', e => {
      const a = e.target.closest('a[data-url]');
      if (!a) return;
      e.preventDefault();
      call('open_url', a.dataset.url).then(r => { if (!r || !r.ok) window.open(a.dataset.url, '_blank'); });
    });
    loadPrefs();
    return true;
  }

  function togglePanel(force) {
    panel.hidden = force === undefined ? !panel.hidden : !force;
    document.getElementById('lwcGear').classList.toggle('on', !panel.hidden);
    if (!panel.hidden) fillPanel();
  }
  function fillPanel() {
    panel.querySelectorAll('[data-k]').forEach(i => {
      const v = C.prefs[i.dataset.k];
      if (i.type === 'checkbox') i.checked = !!v;
      else if (Array.isArray(v)) i.value = v.join(', ');
      else i.value = v;
    });
    panel.querySelector('[data-v=font_size]').textContent = C.prefs.font_size + 'px';
  }
  let saveT;
  function onPanelInput(e) {
    const i = e.target, k = i.dataset.k;
    if (!k) return;
    let v = i.type === 'checkbox' ? i.checked : i.value;
    if (k === 'highlights' || k === 'bots') v = String(v).split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    if (k === 'font_size') { v = +v; panel.querySelector('[data-v=font_size]').textContent = v + 'px'; }
    C.prefs[k] = v; applyPrefs();
    if (k === 'third_party' && v && C.roomId) loadEmotes(C.roomId);
    clearTimeout(saveT);
    saveT = setTimeout(() => call('chat_set_prefs', C.prefs).then(r => { if (r && r.ok && r.prefs) C.prefs = r.prefs; }), 500);
  }
  async function loadPrefs() {
    const r = await call('chat_get_prefs');
    if (r && r.ok && r.prefs) C.prefs = Object.assign({}, DEFAULTS, r.prefs);
    applyPrefs();
  }
  function applyPrefs() {
    const p = C.prefs;
    root.style.setProperty('--lwc-fs', (p.font_size || 13) + 'px');
    root.classList.toggle('lwc-ts', !!p.timestamps);
    const words = (p.highlights || []).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean);
    C.hlRe = words.length ? new RegExp('(^|[^\\w])(' + words.join('|') + ')(?![\\w])', 'i') : null;
    C.botSet = new Set((p.bots || []).map(b => b.toLowerCase()));
  }

  // ---------- scrolling / pause ----------
  const atBottom = () => body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  function onScroll() {
    if (C.autoScrolling) return;
    const was = C.paused;
    C.paused = !atBottom();
    if (was !== C.paused) moreBtn.hidden = !C.paused;
  }
  function stick() { C.autoScrolling = true; body.scrollTop = body.scrollHeight; requestAnimationFrame(() => { C.autoScrolling = false; }); }
  function resume() { C.paused = false; moreBtn.hidden = true; trim(MAX); stick(); }
  function trim(n) { while (body.childElementCount > n) body.firstElementChild.remove(); }

  function push(node) {
    C.queue.push(node);
    if (!C.raf) C.raf = requestAnimationFrame(flush);
  }
  function flush() {
    C.raf = 0;
    const q = C.queue.splice(0);
    if (!q.length) return;
    const frag = document.createDocumentFragment();
    const animate = !reduceMotion && q.length < 4 && !C.paused && !C.hover;
    for (const n of q.slice(-MAX)) { if (animate) n.classList.add('lwc-in'); frag.appendChild(n); }
    body.appendChild(frag);
    const holding = C.paused || C.hover;
    trim(holding ? MAX_PAUSED : MAX);
    if (!holding) stick();
    else if (C.paused) moreBtn.hidden = false;
  }

  // ---------- message rendering ----------
  function sys(t) { const d = document.createElement('div'); d.className = 'msg sys'; d.textContent = t; push(d); }
  function parseTags(raw) { const o = {}; raw.split(';').forEach(kv => { const i = kv.indexOf('='); o[kv.slice(0, i)] = kv.slice(i + 1).replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\'); }); return o; }
  const URL_RE = /^(https?:\/\/[^\s<>"]+|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|tv|gg|io|me|co|be|ly|app|dev)(?:\/[^\s<>"]*)?)$/i;
  const emoteImg = (url, name, cls) => `<img class="lwc-emote${cls ? ' ' + cls : ''}" src="${esc(url)}" alt="${esc(name)}" title="${esc(name)}" loading="lazy" decoding="async">`;

  function renderWords(text) {
    let out = '';
    const parts = text.split(/(\s+)/);
    for (const w of parts) {
      if (!w) continue;
      if (/^\s+$/.test(w)) { out += ' '; continue; }
      const e = C.prefs.third_party !== false && C.emotes[w];
      if (e) { out += emoteImg(e[0], w + ' (' + e[1] + ')'); continue; }
      if (URL_RE.test(w)) { const u = /^https?:/i.test(w) ? w : 'https://' + w; out += `<a href="#" data-url="${esc(u)}" title="${esc(u)}">${esc(w)}</a>`; continue; }
      if (w[0] === '@' && w.length > 1) { out += `<span class="lwc-at">${esc(w)}</span>`; continue; }
      out += esc(w);
    }
    return out;
  }
  function renderText(text, emotesTag) {
    if (!emotesTag) return renderWords(text);
    const chars = Array.from(text), ranges = [];
    emotesTag.split('/').forEach(p => {
      const [id, pos] = p.split(':');
      (pos || '').split(',').forEach(r => { const [a, b] = r.split('-').map(Number); if (!isNaN(a) && !isNaN(b)) ranges.push([a, b, id]); });
    });
    ranges.sort((x, y) => x[0] - y[0]);
    let out = '', i = 0;
    for (const [a, b, id] of ranges) {
      if (a < i) continue;
      out += renderWords(chars.slice(i, a).join(''));
      const name = chars.slice(a, b + 1).join('');
      out += emoteImg(`https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/dark/1.0`, name);
      i = b + 1;
    }
    return out + renderWords(chars.slice(i).join(''));
  }
  const TEXT_BADGE = { broadcaster: ['LIVE', '#e91916'], moderator: ['MOD', '#00ad03'], vip: ['VIP', '#e005b9'], subscriber: ['SUB', '#8b5cf6'], founder: ['SUB', '#8b5cf6'], staff: ['STAFF', '#666'] };
  function renderBadges(raw) {
    if (!raw) return '';
    let out = '';
    raw.split(',').forEach(b => {
      if (!b) return;
      const set = b.split('/')[0];
      let img = C.badges[b];
      if (!img && set === 'subscriber') img = C.badges['subscriber/0'] || C.badges['subscriber/1'];
      if (img) out += `<img class="lwc-badge" src="${esc(img[0])}" alt="" title="${esc(img[1])}" loading="lazy">`;
      else if (TEXT_BADGE[set]) out += `<span class="lwc-tbadge" style="background:${TEXT_BADGE[set][1]}">${TEXT_BADGE[set][0]}</span>`;
    });
    return out;
  }
  function onPrivmsg(tags, login, text) {
    if (C.prefs.hide_bots && C.botSet.has(login)) return;
    const action = /^\u0001ACTION (.*)\u0001$/.exec(text); if (action) text = action[1];
    const name = tags['display-name'] || login;
    const color = /^#[0-9a-f]{6}$/i.test(tags.color || '') ? tags.color : `hsl(${hue(login)} 75% 65%)`;
    const hl = C.hlRe && C.hlRe.test(text);
    const d = document.createElement('div');
    d.className = 'msg' + (hl ? ' lwc-hl' : '') + (action ? ' lwc-action' : '');
    if (tags.id) d.dataset.id = tags.id;
    d.dataset.user = login;
    const ts = C.prefs.timestamps ? `<span class="lwc-time">${new Date(+tags['tmi-sent-ts'] || Date.now()).toTimeString().slice(0, 5)}</span>` : '';
    d.innerHTML = `${ts}${renderBadges(tags.badges)}<b style="color:${esc(color)}">${esc(name)}</b>${action ? ' ' : '<span class="lwc-colon">: </span>'}<span class="lwc-text"${action ? ` style="color:${esc(color)}"` : ''}>${renderText(text, tags.emotes)}</span>`;
    push(d);
    if (hl && C.prefs.sound) beep();
  }
  let actx;
  function beep() {
    const now = Date.now(); if (now - C.lastBeep < 2500) return; C.lastBeep = now;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.08, actx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.35);
      o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.4);
    } catch (e) { /* ignore */ }
  }

  // ---------- emotes ----------
  async function loadEmotes(roomId) {
    const gen = C.gen;
    const r = await call('chat_emotes', roomId || null);
    if (gen !== C.gen || !r || !r.ok) return;
    C.emotes = r.emotes || {}; C.badges = r.badges || {};
  }

  // ---------- IRC ----------
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
  function disconnect() {
    C.gen++;
    if (C.ws) { C.ws.onclose = null; try { C.ws.close(); } catch (e) { /* ignore */ } C.ws = null; }
    clearTimeout(C.retry);
    C.channel = null; C.roomId = null;
  }
  function connectChannel(channel) {
    disconnect();
    if (!root && !mount()) return;
    channel = String(channel).toLowerCase().replace(/^#/, '');
    C.channel = channel; C.queue = []; body.innerHTML = ''; resume(); setStatus('');
    const gen = C.gen;
    loadEmotes(null);
    let tries = 0, welcomed = false;
    const open = () => {
      if (gen !== C.gen) return;
      setStatus('connecting…');
      let ws;
      try { ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443'); } catch (e) { setStatus('offline'); return; }
      C.ws = ws;
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
        if (cmd === 'PRIVMSG') onPrivmsg(tags, m[1].toLowerCase(), m[4] || '');
        else if (cmd === 'ROOMSTATE') {
          setStatus('connected');
          if (!welcomed) { welcomed = true; sys('Welcome to #' + channel + ' chat'); }
          if (tags['room-id'] && tags['room-id'] !== C.roomId) { C.roomId = tags['room-id']; loadEmotes(C.roomId); }
        } else if (cmd === 'CLEARCHAT') {
          if (!m[4]) sys('Chat was cleared by a moderator');
          else body.querySelectorAll(`.msg[data-user="${CSS.escape(m[4].toLowerCase())}"]`).forEach(n => n.classList.add('lwc-deleted'));
        } else if (cmd === 'CLEARMSG' && tags['target-msg-id']) {
          const n = body.querySelector(`.msg[data-id="${CSS.escape(tags['target-msg-id'])}"]`); if (n) n.classList.add('lwc-deleted');
        } else if (cmd === 'USERNOTICE' && tags['system-msg']) {
          sys(tags['system-msg']);
          if (m[4]) onPrivmsg(tags, (tags.login || m[1]).toLowerCase(), m[4]);
        } else if (cmd === 'NOTICE') sys(m[4] || '');
      });
      ws.onclose = () => {
        if (C.ws !== ws || gen !== C.gen) return;
        setStatus('reconnecting…');
        C.retry = setTimeout(open, Math.min(30000, 1000 * Math.pow(2, tries++)));
      };
      ws.onerror = () => {};
    };
    open();
  }

  async function connect(item) {
    disconnect();
    if (!root && !mount()) return;
    body.innerHTML = ''; setStatus('');
    const gen = C.gen;
    const r = await call('chat_info', item.id);
    if (gen !== C.gen || (window.LW && LW.S && LW.S.item && LW.S.item.id !== item.id)) return;
    if (!r.ok || !r.channel) { root.style.display = 'none'; return; }
    root.style.display = '';
    connectChannel(r.channel);
  }

  async function popout() {
    if (!C.channel) return;
    const r = await call('chat_popout', C.channel);
    if (!r || !r.ok) {
      const w = window.open('features/chat_popout.html?channel=' + encodeURIComponent(C.channel), 'lwchat_' + C.channel, 'width=380,height=680');
      if (!w && window.LW) LW.toast(r && r.error ? r.error : 'Pop-out unavailable', 'error');
    }
  }

  const chat = { connect, connectChannel, disconnect, popout, get channel() { return C.channel; } };
  if (STANDALONE) {
    window.LWChat = chat;
    const start = () => {
      const ch = new URLSearchParams(location.search).get('channel');
      if (!mount()) return;
      if (ch) { document.title = '#' + ch + ' chat'; const t = document.getElementById('lwcTitle'); if (t) t.textContent = '#' + ch; connectChannel(ch); }
    };
    let started = false;
    const once = () => { if (!started) { started = true; start(); } };
    window.addEventListener('pywebviewready', () => { if (!started) return once(); loadPrefs(); loadEmotes(C.roomId); });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(() => { if (api()) once(); else setTimeout(once, 800); }, 0));
    else setTimeout(once, api() ? 0 : 800);
  } else {
    const LW = window.LW = window.LW || {};
    LW.chat = chat;
  }
})();

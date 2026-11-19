/* updater feature: "Updates" tab in the settings modal (keeps streamlink / yt-dlp current) */
(function () {
  'use strict';
  let pane = null, btn = null, st = null;
  const MOCK = !window.pywebview;
  const mockSt = { current: { python: '3.14.0', streamlink: '8.6.3', 'yt-dlp': '2026.10.26' }, latest: {}, pending: {}, busy: false, frozen: false, settings: { auto: true, last_check: 0 }, overlay: { applied: {}, rolled_back: {} } };

  async function call(name, ...a) {
    try { const r = await LW.call(name, ...a); if (r && r.ok === false && MOCK) return Object.assign({ ok: true }, mockSt); return r; }
    catch (e) { return { ok: false, error: String(e) }; }
  }
  const esc = s => (window.LW && LW.esc ? LW.esc(String(s == null ? '' : s)) : String(s == null ? '' : s));

  function row(label, cur, latest, pending) {
    let badge = '';
    if (pending) badge = `<span class="upd-badge upd-pend">${esc(pending)} installed - restart</span>`;
    else if (latest && cur && latest !== cur) badge = `<span class="upd-badge upd-new">${esc(latest)} available</span>`;
    else if (latest && cur) badge = '<span class="upd-badge upd-ok">up to date</span>';
    return `<div class="upd-row"><span class="upd-name">${label}</span><span class="upd-ver">${esc(cur || 'not found')}</span><span class="upd-latest">${latest ? esc(latest) : '-'}</span>${badge}</div>`;
  }

  function render(extra) {
    if (!pane || !st) return;
    const c = st.current || {}, l = st.latest || {}, p = st.pending || {};
    const last = st.settings && st.settings.last_check ? new Date(st.settings.last_check * 1000).toLocaleString() : 'never';
    const rb = Object.keys((st.overlay && st.overlay.rolled_back) || {});
    const pend = Object.keys(p).length > 0;
    const errs = (extra && extra.errors) || [];
    pane.innerHTML = `
      <div class="upd-table">
        <div class="upd-row upd-head"><span>Component</span><span>Current</span><span>Latest</span><span></span></div>
        ${row('streamlink', c.streamlink, l.streamlink, p.streamlink)}
        ${row('yt-dlp', c['yt-dlp'], l['yt-dlp'], p['yt-dlp'])}
        <div class="upd-row"><span class="upd-name">Python</span><span class="upd-ver">${esc(c.python)}</span><span class="upd-latest"></span><span class="upd-dim">${st.frozen ? 'bundled' : 'venv'}</span></div>
      </div>
      <p class="upd-dim">Last check: ${esc(last)}. Twitch and YouTube change often; old streamlink / yt-dlp versions stop working.</p>
      ${rb.length ? `<p class="upd-err">Update for ${esc(rb.join(', '))} failed to load and was rolled back to the bundled version.</p>` : ''}
      ${errs.map(e => `<p class="upd-err">${esc(e)}</p>`).join('')}
      <label class="row"><input type="checkbox" data-upd-auto ${st.settings && st.settings.auto ? 'checked' : ''}> Install updates automatically (checked at most once a day)</label>
      <div class="upd-foot">
        <button type="button" class="btn ghost" data-upd="check" ${st.busy ? 'disabled' : ''}>${st.busy ? 'Working...' : 'Check now'}</button>
        <button type="button" class="btn ghost" data-upd="install" ${st.busy ? 'disabled' : ''}>Update now</button>
        <button type="button" class="btn ${pend ? 'grad' : 'ghost'}" data-upd="restart">Restart app</button>
      </div>`;
  }

  async function refresh() { const r = await call('upd_status'); if (r && r.ok !== false) { st = r; render(); } }

  async function act(kind) {
    if (kind === 'restart') {
      const r = await call('upd_restart');
      if (!r || r.ok === false) LW.toast('Restart failed: ' + ((r && r.error) || 'unavailable'), 'error');
      return;
    }
    st = Object.assign(st || {}, { busy: true }); render();
    const r = await call(kind === 'check' ? 'upd_check' : 'upd_install');
    if (!r || r.ok === false) { st.busy = false; render({ errors: [(r && r.error) || 'failed'] }); return; }
    st = r; render(r);
    const inst = Object.keys(r.installed || {});
    if (inst.length) LW.toast('Updated ' + inst.map(k => k + ' ' + r.installed[k]).join(', ') + ' - restart to apply', 'success');
    else if (kind === 'check') LW.toast((r.updates || []).length ? 'Updates available: ' + r.updates.join(', ') : 'Everything is up to date');
    else if (!(r.errors || []).length) LW.toast('Nothing to update');
  }

  function build() {
    const modal = document.getElementById('settingsModal'), form = document.getElementById('settingsForm');
    if (!modal || !form || pane) return;
    const card = modal.querySelector('.modal-card');
    let tabs = card.querySelector('.th-tabs');
    if (!tabs) { // theme feature absent: make a minimal tab bar of our own
      tabs = document.createElement('div'); tabs.className = 'th-tabs upd-tabs';
      tabs.innerHTML = '<button type="button" data-t="general" class="on">General</button>';
      form.parentNode.insertBefore(tabs, form);
      tabs.addEventListener('click', e => { const b = e.target.closest('button'); if (b && b.dataset.t === 'general') { form.hidden = false; tabs.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); } });
      new MutationObserver(() => { if (!modal.hidden) tabs.querySelector('[data-t=general]').click(); }).observe(modal, { attributes: true, attributeFilter: ['hidden'] });
    }
    btn = document.createElement('button'); btn.type = 'button'; btn.dataset.t = 'updates'; btn.textContent = 'Updates';
    tabs.appendChild(btn);
    pane = document.createElement('div'); pane.className = 'upd-pane'; pane.hidden = true;
    // insert after the last pane so theme's DOM order stays intact
    const last = card.querySelector('.th-pane') || form;
    last.parentNode.insertBefore(pane, last.nextSibling);
    // theme's tab handler sets .on and hides form/appearance for unknown tabs; we just mirror our button's state
    const sync = () => {
      const on = btn.classList.contains('on');
      if (pane.hidden === !on) return;
      pane.hidden = !on;
      if (on) { form.hidden = true; const tp = card.querySelector('.th-pane'); if (tp) tp.hidden = true; const h3 = card.querySelector('h3'); if (h3) h3.textContent = 'Updates'; refresh(); }
    };
    tabs.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (b === btn) { tabs.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === btn)); } setTimeout(sync); });
    new MutationObserver(sync).observe(tabs, { subtree: true, attributes: true, attributeFilter: ['class'] });
    pane.addEventListener('click', e => { const b = e.target.closest('[data-upd]'); if (b && !b.disabled) act(b.dataset.upd); });
    pane.addEventListener('change', e => { if (e.target.matches('[data-upd-auto]')) call('upd_set', { auto: e.target.checked }).then(r => { if (r && r.settings && st) st.settings = r.settings; }); });
  }

  function boot() {
    // theme.js builds its tab bar in its own LW.ready; run after it
    setTimeout(build, 0);
    LW.on('event', ev => {
      if (!ev || ev.type !== 'upd_status') return;
      if (ev.installed && Object.keys(ev.installed).length) {
        LW.toast('Updated ' + Object.keys(ev.installed).map(k => k + ' ' + ev.installed[k]).join(', ') + ' - restart to apply', 'success');
      } else if (ev.auto && ev.updates && ev.updates.length) {
        LW.toast('Updates available: ' + ev.updates.join(', ') + ' (Settings > Updates)');
      }
      if (pane && !pane.hidden) refresh();
    });
  }
  if (window.LW && window.LW.ready) window.LW.ready(boot);
})();

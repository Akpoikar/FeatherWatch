// follows_ext: platform badge for YouTube / Kick follows in the sidebar (live status comes from the backend poll).
(function () {
  const LW = window.LW;
  if (!LW) return;
  const ICONS = {
    youtube: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 8.2v7.6L16 12z"/></svg>',
    kick: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4v5h2V7h2V5h4v6h-2v2h2v6h-4v-2h-2v-2h-2v5H6z"/></svg>'
  };
  function fx_badge(it) {
    const b = document.createElement('span');
    b.className = 'fx-badge fx-' + it.platform;
    b.title = it.platform === 'youtube' ? 'YouTube' : 'Kick';
    b.innerHTML = ICONS[it.platform];
    return b;
  }
  function fx_decorate() {
    const byId = {};
    (LW.S.follows || []).concat(LW.S.history || []).forEach(i => { byId[i.id] = i; });
    document.querySelectorAll('.side-item[data-id]').forEach(li => {
      const it = byId[li.dataset.id];
      if (!it || !ICONS[it.platform] || li.querySelector('.fx-badge')) return;
      const av = li.querySelector('.side-av');
      if (av) { av.classList.add('fx-has'); av.appendChild(fx_badge(it)); }
    });
  }
  LW.on('sidebarRendered', fx_decorate);
  LW.ready && LW.ready(fx_decorate);
})();

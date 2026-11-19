// netproxy: proxy / region settings section in the settings modal.
(function () {
  var LW = window.LW; if (!LW) return;
  var SCHEMES = ['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h'];
  var np_state = { supported: false };

  function np_mask(u) { return String(u || '').replace(/^(\w+:\/\/[^:@\/]*):[^@\/]*@/, '$1:***@'); }
  function np_valid(u) {
    u = (u || '').trim(); if (!u) return '';
    if (u.indexOf('://') < 0) u = 'http://' + u;
    var m = /^(\w+):\/\/(?:[^@\/\s]+@)?([A-Za-z0-9.\-]+|\[[0-9a-fA-F:]+\]):(\d{1,5})\/?$/.exec(u);
    if (!m) return null;
    if (SCHEMES.indexOf(m[1].toLowerCase()) < 0) return null;
    var p = +m[3]; if (p < 1 || p > 65535) return null;
    return u;
  }

  function np_build() {
    var form = document.getElementById('settingsForm');
    if (!form || document.getElementById('npBox')) return;
    var box = document.createElement('fieldset');
    box.id = 'npBox'; box.className = 'np-box';
    box.innerHTML =
      '<legend>Network proxy / region</legend>' +
      '<label>Proxy URL<input id="npUrl" placeholder="off — e.g. http://host:8080 or socks5://user:pass@host:1080" spellcheck="false" autocomplete="off"></label>' +
      '<label>Scope<select id="npScope"><option value="all">All traffic</option>' +
      '<option value="playlist-only">Playlists only (segments direct)</option></select></label>' +
      '<label id="npPlRow" hidden>Twitch playlist proxies<input id="npPl" placeholder="https://proxy1, https://proxy2"></label>' +
      '<div class="np-row"><button type="button" class="btn ghost" id="npTest">Test</button>' +
      '<span class="np-out" id="npOut"></span></div>';
    var actions = form.querySelector('.modal-actions');
    form.insertBefore(box, actions || null);
    LW.$('#npTest').addEventListener('click', np_test);
    LW.$('#npUrl').addEventListener('input', function () {
      var v = np_valid(this.value); this.classList.toggle('np-bad', v === null);
    });
    form.addEventListener('submit', np_save);
  }

  function np_load() {
    LW.call('np_get').then(function (r) {
      if (!r || !r.ok) { var b = document.getElementById('npBox'); if (b && !window.pywebview) b.querySelector('#npOut').textContent = 'Proxy not available in browser mode'; return; }
      np_state.supported = !!r.playlist_supported;
      LW.$('#npUrl').value = r.settings.net_proxy || '';
      LW.$('#npScope').value = r.settings.net_proxy_scope || 'all';
      LW.$('#npPl').value = (r.settings.twitch_proxy_playlist || []).join(', ');
      LW.$('#npPlRow').hidden = !np_state.supported;
    });
  }

  function np_save() {
    var u = LW.$('#npUrl').value;
    if (np_valid(u) === null) { LW.toast('Invalid proxy URL — not saved', 'error'); return; }
    var d = { net_proxy: u.trim(), net_proxy_scope: LW.$('#npScope').value };
    if (np_state.supported) d.twitch_proxy_playlist = LW.$('#npPl').value;
    LW.call('np_set', d).then(function (r) {
      if (r && r.ok) LW.$('#npUrl').value = r.settings.net_proxy || '';
      else if (r && window.pywebview) LW.toast('Proxy: ' + r.error, 'error');
    });
  }

  function np_test() {
    var out = LW.$('#npOut'), u = LW.$('#npUrl').value;
    if (np_valid(u) === null) { out.textContent = 'Invalid URL (scheme://[user:pass@]host:port)'; out.className = 'np-out np-err'; return; }
    out.textContent = 'Testing ' + (np_mask(u.trim()) || 'direct') + '…'; out.className = 'np-out';
    LW.call('np_test', u.trim()).then(function (r) {
      if (r && r.ok) {
        out.textContent = (r.via === 'direct' ? 'Direct' : 'OK') + ': ' + r.ip + ' · ' +
          [r.city, r.country].filter(Boolean).join(', ') + ' · ' + r.latency_ms + ' ms';
        out.className = 'np-out np-ok';
      } else {
        out.textContent = np_mask((r && r.error) || 'Test unavailable'); out.className = 'np-out np-err';
      }
    });
  }

  LW.ready(function () {
    np_build();
    var modal = document.getElementById('settingsModal');
    if (modal) new MutationObserver(function () { if (!modal.hidden) np_load(); })
      .observe(modal, { attributes: true, attributeFilter: ['hidden'] });
    np_load();
  });
})();

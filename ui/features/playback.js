// Playback tuning: low-latency hls.js config, quality cap / battery saver, live latency readout.
(function () {
  const LW = window.LW = window.LW || {};
  const PB = { cfg: { quality_cap: 'off', battery_saver: false, show_latency: true }, discharging: false, hls: null, timer: null };
  const CAP_H = { off: Infinity, '720p': 720, '480p': 480, lowest: 0 };

  // ---- rewind window: how many seconds of watched video stay in memory ----
  function pb_rewindSec() { const w = Number(PB.cfg.rewind_window); return w > 0 ? w : Infinity; }
  function pb_applyRewind() {
    const hls = PB.hls; if (!hls || !hls.config) return;
    const w = pb_rewindSec();
    hls.config.backBufferLength = w;
    hls.config.liveBackBufferLength = w;
  }

  // ---- hls.js config hook (read by app.js loadSource) ----
  (LW.hlsConfigHooks = LW.hlsConfigHooks || []).push(function pb_hlsConfig(S) {
    const w = pb_rewindSec();
    const cfg = { backBufferLength: w, liveBackBufferLength: w };
    if (!S.settings || !S.settings.low_latency || !S.isLive) return cfg;
    return Object.assign(cfg, {
      lowLatencyMode: true,
      liveSyncDurationCount: 2,
      liveMaxLatencyDurationCount: 5,
      maxLiveSyncPlaybackRate: 1.1,
      maxBufferLength: 10,
      maxMaxBufferLength: 20
    });
  });

  function pb_capHeight() {
    let h = CAP_H[PB.cfg.quality_cap] != null ? CAP_H[PB.cfg.quality_cap] : Infinity;
    if (PB.cfg.battery_saver && PB.discharging) h = Math.min(h, 480);
    return h;
  }
  function pb_applyCap() {
    const hls = PB.hls;
    if (!hls || !hls.levels || !hls.levels.length) return;
    const h = pb_capHeight();
    if (h === Infinity) { hls.autoLevelCapping = -1; return; }
    let idx = -1, lowest = 0;
    hls.levels.forEach((l, i) => {
      if ((l.height || 0) < (hls.levels[lowest].height || 0)) lowest = i;
      if (h > 0 && (l.height || 0) <= h && (idx < 0 || (l.height || 0) >= (hls.levels[idx].height || 0))) idx = i;
    });
    if (idx < 0) idx = lowest;
    hls.autoLevelCapping = idx;
    if (hls.currentLevel > idx || hls.loadLevel > idx) hls.nextLevel = idx;
  }

  // ---- latency readout ----
  let badge = null;
  function pb_badge() {
    if (badge && document.body.contains(badge)) return badge;
    const p = document.getElementById('player'); if (!p) return null;
    badge = document.createElement('div'); badge.className = 'pb-latency'; badge.hidden = true;
    badge.title = 'Seconds behind live (click to jump to live)';
    badge.onclick = () => { const h = PB.hls, v = LW.video; if (h && h.liveSyncPosition && v) v.currentTime = h.liveSyncPosition; };
    p.appendChild(badge); return badge;
  }
  function pb_tick() {
    const b = pb_badge(); if (!b) return;
    const S = LW.S || {}, v = LW.video, h = PB.hls;
    let lat = null;
    if (S.isLive && h && v) {
      if (typeof h.latency === 'number' && h.latency > 0) lat = h.latency;
      else if (v.seekable && v.seekable.length) lat = v.seekable.end(v.seekable.length - 1) - v.currentTime;
    }
    if (!PB.cfg.show_latency || lat == null || !isFinite(lat)) { b.hidden = true; return; }
    b.hidden = false;
    b.textContent = lat.toFixed(1) + 's behind' + (pb_capHeight() !== Infinity ? ' · capped' : '');
    b.classList.toggle('far', lat > 8);
  }

  // ---- settings modal controls ----
  function pb_injectSettings() {
    const f = document.getElementById('settingsForm');
    if (!f || f.querySelector('.pb-settings')) return;
    const wrap = document.createElement('div'); wrap.className = 'pb-settings';
    wrap.innerHTML =
      '<label>Data saver (quality cap)<select name="pb_quality_cap">' +
      '<option value="off">Off</option><option value="720p">Max 720p</option><option value="480p">Max 480p</option><option value="lowest">Lowest (audio-ish)</option></select></label>' +
      '<label class="row"><input name="pb_battery_saver" type="checkbox"> Battery saver (cap to 480p on battery)</label>' +
      '<label class="row"><input name="pb_show_latency" type="checkbox"> Show live latency readout</label>' +
      '<label>Rewind window (memory use)<select name="pb_rewind_window">' +
      '<option value="30">30 seconds</option><option value="120">2 minutes</option><option value="300">5 minutes</option>' +
      '<option value="600">10 minutes</option><option value="1800">30 minutes</option><option value="3600">1 hour</option>' +
      '<option value="0">Unlimited (keeps whole stream in RAM)</option></select></label>';
    const actions = f.querySelector('.modal-actions');
    f.insertBefore(wrap, actions);
    // populate whenever the modal opens
    const modal = document.getElementById('settingsModal');
    if (modal) new MutationObserver(() => { if (!modal.hidden) pb_fill(); }).observe(modal, { attributes: true, attributeFilter: ['hidden'] });
    f.addEventListener('submit', () => {
      pb_save({ quality_cap: f.pb_quality_cap.value, battery_saver: f.pb_battery_saver.checked, show_latency: f.pb_show_latency.checked, rewind_window: parseInt(f.pb_rewind_window.value, 10) });
    });
  }
  function pb_fill() {
    const f = document.getElementById('settingsForm'); if (!f || !f.pb_quality_cap) return;
    f.pb_quality_cap.value = PB.cfg.quality_cap; f.pb_battery_saver.checked = !!PB.cfg.battery_saver; f.pb_show_latency.checked = !!PB.cfg.show_latency;
    f.pb_rewind_window.value = String(PB.cfg.rewind_window);
  }
  async function pb_save(d) {
    Object.assign(PB.cfg, d); pb_applyCap(); pb_applyRewind(); pb_tick();
    try {
      const r = await LW.call('pb_set', d);
      if (r && r.ok && r.playback) PB.cfg = r.playback;
    } catch (e) { /* mock mode */ }
    if (!window.pywebview) try { localStorage.setItem('pb_cfg', JSON.stringify(PB.cfg)); } catch (e) { /* ignore */ }
  }
  async function pb_load() {
    let r = null;
    try { r = await LW.call('pb_get'); } catch (e) { /* ignore */ }
    if (r && r.ok && r.playback) PB.cfg = r.playback;
    else try { Object.assign(PB.cfg, JSON.parse(localStorage.getItem('pb_cfg') || '{}')); } catch (e) { /* ignore */ }
  }

  // ---- battery ----
  function pb_battery() {
    if (!navigator.getBattery) return;
    navigator.getBattery().then(b => {
      const upd = () => { const d = !b.charging; if (d !== PB.discharging) { PB.discharging = d; pb_applyCap(); } };
      upd(); b.addEventListener('chargingchange', upd);
    }).catch(() => {});
  }

  LW.on && LW.on('hlsCreated', hls => {
    PB.hls = hls;
    if (window.Hls) {
      hls.on(Hls.Events.MANIFEST_PARSED, pb_applyCap);
      pb_applyRewind();
      hls.on(Hls.Events.LEVELS_UPDATED || 'hlsLevelsUpdated', pb_applyCap);
    }
  });
  LW.on && LW.on('stopped', () => { PB.hls = null; pb_tick(); });

  const boot = async () => {
    pb_injectSettings(); pb_badge(); pb_battery();
    await pb_load(); pb_applyCap();
    if (!PB.timer) PB.timer = setInterval(pb_tick, 1000);
  };
  if (LW.ready) LW.ready(boot); else (LW._ready = LW._ready || []).push(boot);
  LW.playback = { get config() { return PB.cfg; }, applyCap: pb_applyCap };
})();

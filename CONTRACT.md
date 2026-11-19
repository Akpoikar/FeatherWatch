# FeatherWatch – architecture contract (shared by all agents)

Desktop app: **Python 3.9+ + pywebview** (uses the OS webview: WebView2 on Windows, WKWebView on macOS → tiny, no Electron).
Video: **hls.js** in the webview, fed through a **local HLS proxy** in Python (avoids CORS, works for Twitch live, Twitch VODs, YouTube live/VOD HLS). External player (VLC/mpv) as a fallback button.
Deps: `pywebview`, `streamlink`, `yt-dlp` (optional, for YouTube VODs/search fallback). venv at `.venv` (Python 3.9 — no `match`, no `X | Y` types).
Do NOT call Twitch GQL with Twitch's private client ID. Live status/metadata come from streamlink (`session.streams(url)` non-empty == live; plugin `get_title()/get_author()/get_category()`) and yt-dlp.

## Files
- `app.py` – entry point, creates window loading `ui/index.html`, exposes `Api` as `js_api`. (backend agent)
- `backend/` – `resolver.py` (streamlink/yt-dlp resolve), `proxy.py` (local HLS proxy on 127.0.0.1 random port, rewrites m3u8 URIs to `/p?u=<urlencoded>`), `store.py` (JSON at `~/.featherwatch/data.json`), `recorder.py` (record stream to file via streamlink), `live.py` (background live checker). (backend agent)
- `ui/index.html`, `ui/style.css`, `ui/app.js`, `ui/vendor/hls.min.js` (vendored copy, hls.js 1.5.x). (frontend agent)
- `README.md`, `requirements.txt`, `build/` scripts (PyInstaller spec / build.bat / build.sh). (docs agent)
- Remove old `lightweight.py` (backend agent).

## JS → Python API (`window.pywebview.api.<name>(...)`, all return JSON-serializable, Promises in JS)
Every call returns `{ok: true, ...}` or `{ok: false, error: "msg"}`.

| method | args | returns |
|---|---|---|
| `resolve(input)` | channel name / any URL (twitch channel, twitch VOD `/videos/123`, clip, youtube watch/live/@channel, kick, etc.). Bare name → twitch channel. | `{ok, item: Item, qualities: [str], default_quality: str}` |
| `play(item_id, quality)` | | `{ok, src: "http://127.0.0.1:PORT/p?u=...m3u8", kind: "hls"|"mp4", is_live: bool}` |
| `open_external(item_id, quality)` | launches VLC/mpv via streamlink | `{ok}` |
| `record_start(item_id, quality)` / `record_stop(item_id)` | saves to `~/Videos/FeatherWatch/` (or `~/Movies` on mac) | `{ok, path}` |
| `recordings()` | | `{ok, items:[{item_id, path, started, active}]}` |
| `history()` | | `{ok, items:[Item]}` newest first (max 200) |
| `remove_history(item_id)` / `clear_history()` | | `{ok}` |
| `follows()` | | `{ok, items:[Item]}` |
| `follow(item_id)` / `unfollow(item_id)` | | `{ok}` |
| `refresh_live()` | checks all follows + recent channel history now | `{ok, items:[Item]}` |
| `save_progress(item_id, seconds)` | VOD resume position | `{ok}` |
| `get_settings()` / `set_settings(dict)` | keys: `player_path`, `default_quality`, `record_dir`, `live_poll_minutes` (default 3), `low_latency` (bool), `theme` ("dark"/"light") | `{ok, settings}` |
| `chat_info(item_id)` | | `{ok, channel: "name"}` for twitch channels else `{ok:false}` – UI then connects anonymously to `wss://irc-ws.chat.twitch.tv` (NICK justinfan12345) read-only |

### Item
```json
{"id": "twitch:elvemage59" | "twitch-vod:123" | "youtube:VIDEOID" | "url:<sha1>",
 "platform": "twitch"|"youtube"|"kick"|"other",
 "kind": "channel"|"vod"|"clip"|"video",
 "url": "...", "title": "...", "author": "...", "category": "...",
 "thumbnail": "url or null", "is_live": true|false|null,
 "last_watched": 1732000000, "progress": 123.4, "duration": null|seconds}
```

## Python → JS events
Backend calls `window.evaluate_js("window.lw && window.lw.onEvent(" + json + ")")`:
- `{"type":"live", "items":[Item]}` – after each background live check
- `{"type":"record", "item_id":..., "state":"started"|"stopped"|"error", "path":...}`
- `{"type":"toast", "level":"info"|"error", "text":...}`

## UI requirements
Twitch-like dark layout: collapsible left sidebar (Followed – live first with red dot + viewer/category; Recently watched with progress bars), top bar with big "paste any link" input (also accept Ctrl/Cmd+V anywhere and drag-and-drop of links), main player with custom controls (play/pause, seek bar incl. live DVR window + "Go live" button, volume, quality menu, theatre mode, fullscreen, PiP, speed for VODs, keyboard: space/k, ←/→ 10s, f, m, t), right collapsible chat panel for Twitch. Home view = grid of live follows + continue-watching cards. Smooth animations (CSS transitions, skeleton loaders, card hover lift, sidebar slide) respecting `prefers-reduced-motion`. No frameworks, no build step, vanilla JS. Must work in a plain browser too with a mock API when `window.pywebview` is absent (for dev).

## Features (plug-in layout — added in round 2)
Several agents work **at the same time**. To avoid clobbering each other:
- **Own files only.** Each feature `X` owns `backend/features/X.py`, `ui/features/X.js`, `ui/features/X.css` (already linked from index.html / loaded by app.py). Create extra files freely under your own name prefix.
- **Backend:** `backend/features/X.py` defines `setup(api) -> {"js_name": fn}`; each `fn(api, *args)` becomes `window.pywebview.api.js_name(...)`, auto-wrapped to return `{ok:true,...}` / `{ok:false,error}`. Raise `backend.resolver.ResolveError("msg")` for user-facing errors. Optional `shutdown(api)`. Useful internals: `api._store` (Store: get_item/put_item/update_item/settings/follows/history), `api._resolver` (Resolver; `.session` is the streamlink session, `.session.http` a requests session; `.get_stream(item, quality)`), `api._proxy` (HLSProxy), `api._browser` (TwitchBrowser — official Helix API, only if `api._browser.configured()`), `api._emit(event_dict)` → JS `LW.on('event', fn)`. Feature JS-name prefixes: `chat_*`, `mv_*`, `clip_*`, `channel_*`.
- **Frontend:** `ui/features/X.js` is a plain IIFE; use `window.LW` (exposed by app.js): `$, el, esc, fmtTime, call(name,...args)→Promise<{ok..}>, toast(text, level), showView(name), openInput(urlOrName), renderSidebar, renderHome, setInfo, nameOf, initial, avBg, openModal(id), closeModals, stopPlayback, loadData, S (state: S.item current Item, S.follows, S.history, S.settings, S.quality, S.isLive), video (the <video>), hls (current hls.js instance)`, hooks `LW.on('itemOpened'|'playing'|'stopped'|'event'|'sidebarRendered', fn)`, and `LW.ready(fn)` (runs after boot). Inject your DOM from JS (don't edit index.html unless unavoidable). Add views as `<section class="view" id="viewX">` inside the same parent as `#viewPlayer` so `LW.showView('X')` works.
- **Shared files (`ui/app.js`, `ui/index.html`, `ui/style.css`, `app.py`, `backend/*.py`):** only if truly necessary, with the Edit tool, small targeted edits, re-read right before editing, never rewrite whole files. Say in your report exactly what you changed there.
- Must still work in plain-browser mock mode: if your `call()` returns `{ok:false}` because the mock lacks your method, degrade gracefully (you may add mock data in your own JS when `!window.pywebview`).
- Item avatars: `item.avatar` (from backend/profile.py, may be null). Python 3.9 syntax. Verify with `node --check` and `py_compile`, plus real backend tests in the scratchpad dir (`/private/tmp/claude-501/-Users-karenakopian-Documents-projects-Lightweight/df740329-4a0b-4a61-b157-5f1eac6378bf/scratchpad/<feature>/`). Never write to the real `~/.featherwatch/data.json` in tests (instantiate Store with a scratch path) — the user has 100 real follows there. Don't read `.env` (secrets). Don't launch the GUI window.

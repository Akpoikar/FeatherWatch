"""FeatherWatch – tiny desktop player for Twitch / YouTube / anything streamlink or yt-dlp understands."""
import functools
import json
import os
import shutil
import subprocess
import sys
import threading
import traceback
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
os.environ.setdefault("PYTHONWARNINGS", "ignore")

from backend.store import Store  # noqa: E402
from backend.resolver import Resolver, ResolveError  # noqa: E402
from backend.proxy import HLSProxy  # noqa: E402
from backend.recorder import Recorder  # noqa: E402
from backend.live import LiveChecker  # noqa: E402
from backend import profile  # noqa: E402
from backend.browse import TwitchBrowser, BrowseError, load_dotenv  # noqa: E402

# One-time migration from the app's old name (Lightweight) so follows/settings carry over.
_old_dir, _new_dir = Path.home() / ".lightweight", Path.home() / ".featherwatch"
if _old_dir.is_dir() and not _new_dir.exists():
    try:
        _old_dir.rename(_new_dir)
    except OSError:
        pass

load_dotenv(Path(__file__).resolve().parent / ".env", Path.home() / ".featherwatch" / ".env")


def resource_dir():
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))


def find_player(override=""):
    if override and (os.path.isfile(override) or shutil.which(override)):
        return override
    for name in ("mpv", "vlc", "iina"):
        p = shutil.which(name)
        if p:
            return p
    cands = []
    if sys.platform == "win32":
        for env in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
            base = os.environ.get(env)
            if base:
                cands += [os.path.join(base, "VideoLAN", "VLC", "vlc.exe"),
                          os.path.join(base, "mpv", "mpv.exe"),
                          os.path.join(base, "Programs", "mpv", "mpv.exe")]
        cands.append(os.path.expanduser(r"~\scoop\apps\mpv\current\mpv.exe"))
    elif sys.platform == "darwin":
        for root in ("/Applications", os.path.expanduser("~/Applications")):
            cands += [root + "/IINA.app/Contents/MacOS/iina-cli", root + "/VLC.app/Contents/MacOS/VLC",
                      root + "/mpv.app/Contents/MacOS/mpv"]
        cands += ["/opt/homebrew/bin/mpv", "/usr/local/bin/mpv"]
    else:
        cands += ["/usr/bin/mpv", "/usr/bin/vlc", "/snap/bin/vlc", "/var/lib/flatpak/exports/bin/org.videolan.VLC"]
    for c in cands:
        if os.path.isfile(c):
            return c
    return None


def api_method(fn):
    @functools.wraps(fn)
    def wrapper(*a, **kw):
        try:
            res = fn(*a, **kw)
            if res is None:
                res = {}
            res.setdefault("ok", True)
            return res
        except (ResolveError, BrowseError) as e:
            return {"ok": False, "error": str(e)}
        except Exception as e:
            if "--debug" in sys.argv:
                traceback.print_exc()
            return {"ok": False, "error": str(e) or type(e).__name__}
    return wrapper


class Api:
    def __init__(self):
        self._window = None
        self._store = Store()
        self._resolver = Resolver()
        self._resolver.set_low_latency(self._store.settings().get("low_latency", True))
        self._proxy = HLSProxy(self._resolver.session.http, on_event=self._emit).start()
        self._recorder = Recorder(self._resolver, self._emit)
        self._browser = TwitchBrowser(self._resolver.session.http)
        self._live = LiveChecker(self._store, self._resolver, self._emit, self._browser)
        self._live.browser = self._browser
        from backend import features
        self._features = features.load(self, api_method)

    # pywebview exposes public attributes, so keep the window reference private
    def _set_window(self, w):
        self._window = w

    def _emit(self, ev):
        w = self._window
        if w is None:
            return
        try:
            w.evaluate_js("window.lw && window.lw.onEvent(%s)" % json.dumps(ev))
        except Exception:
            pass

    def _item(self, item_id):
        it = self._store.get_item(item_id)
        if not it:
            raise ResolveError("Unknown item: %s" % item_id)
        return it

    # ---------- resolve / play ----------
    @api_method
    def resolve(self, text):
        item, qualities, default = self._resolver.resolve(text)
        item = self._store.put_item(item)
        pref = self._store.settings().get("default_quality") or "best"
        if pref in qualities:
            default = pref
        return {"item": item, "qualities": qualities, "default_quality": default}

    def _src(self, item, quality):
        src_kind, s = self._resolver.get_stream(item, quality)
        if src_kind == "streamlink":
            url, kind = self._resolver.stream_url(s)
            hdrs = (getattr(s, "args", None) or {}).get("headers") or {}
            hid = self._proxy.register_headers(hdrs) if hdrs else "0"
            if hid == "0":
                hid = self._proxy.register_headers(dict(self._resolver.session.http.headers))
        else:
            url, kind = s["url"], s["kind"]
            hid = self._proxy.register_headers(s["headers"])
        return self._proxy.url_for(url, hid), kind

    @api_method
    def play(self, item_id, quality=None):
        item = self._item(item_id)
        src, kind = self._src(item, quality)
        self._store.touch_history(item_id)
        it = self._store.get_item(item_id)
        return {"src": src, "kind": kind, "is_live": bool(it.get("is_live")) if it.get("kind") == "channel"
                else bool(it.get("is_live"))}

    @api_method
    def open_external(self, item_id, quality=None):
        item = self._item(item_id)
        player = find_player(self._store.settings().get("player_path") or "")
        if not player:
            raise ResolveError("No external player found (install VLC or mpv, or set player_path)")
        src, _ = self._src(item, quality)
        title = item.get("title") or item.get("url")
        args = [player]
        low = os.path.basename(player).lower()
        if "mpv" in low:
            args += ["--force-media-title=" + title]
        elif "vlc" in low:
            args += ["--meta-title=" + title]
        args.append(src)
        kw = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "stdin": subprocess.DEVNULL}
        if sys.platform == "win32":
            kw["creationflags"] = 0x00000008  # DETACHED_PROCESS
        else:
            kw["start_new_session"] = True
        subprocess.Popen(args, **kw)
        self._store.touch_history(item_id)
        return {}

    # ---------- recording ----------
    @api_method
    def record_start(self, item_id, quality=None):
        item = self._item(item_id)
        path = self._recorder.start(item, quality, self._store.settings().get("record_dir"))
        return {"path": path}

    @api_method
    def record_stop(self, item_id):
        path = self._recorder.stop(item_id)
        if path is None:
            raise ResolveError("Not recording")
        return {"path": path}

    @api_method
    def recordings(self):
        return {"items": self._recorder.list()}

    # ---------- history / follows ----------
    @api_method
    def history(self):
        return {"items": self._store.history()}

    @api_method
    def remove_history(self, item_id):
        self._store.remove_history(item_id)

    @api_method
    def clear_history(self):
        self._store.clear_history()

    @api_method
    def follows(self):
        items = self._store.follows()
        items.sort(key=lambda i: (not i.get("is_live"), (i.get("author") or i.get("title") or "").lower()))
        return {"items": items}

    @api_method
    def follow(self, item_id):
        self._item(item_id)
        self._store.follow(item_id)

    @api_method
    def unfollow(self, item_id):
        self._store.unfollow(item_id)

    @api_method
    def refresh_live(self):
        return {"items": self._live.check_now()}

    @api_method
    def save_progress(self, item_id, seconds):
        self._item(item_id)
        self._store.update_item(item_id, progress=float(seconds or 0))

    # ---------- settings / chat ----------
    @api_method
    def get_settings(self):
        return {"settings": self._store.settings()}

    @api_method
    def set_settings(self, d):
        s = self._store.set_settings(d or {})
        self._resolver.set_low_latency(s.get("low_latency", True))
        self._live._wake.set()  # re-arm poll interval
        return {"settings": s}

    @api_method
    def chat_info(self, item_id):
        it = self._item(item_id)
        if it.get("platform") == "twitch" and it.get("kind") == "channel":
            return {"channel": it["id"].split(":", 1)[1]}
        return {"ok": False, "error": "No chat for this item"}

    @api_method
    def profile(self, item_id, force=False):
        """Avatar + bio for the channel behind an item (cached for a day)."""
        it = self._item(item_id)
        if force or profile.is_stale(it):
            fields = profile.fetch(self._resolver.session.http, it)
            if fields:
                it = self._store.update_item(item_id, **fields) or it
        url = profile.channel_url(it) or it.get("url")
        links = []
        if it.get("platform") == "twitch" and url:
            links = [{"label": "Channel", "url": url},
                     {"label": "Past broadcasts", "url": url + "/videos?filter=archives"},
                     {"label": "Clips", "url": url + "/clips"},
                     {"label": "Schedule", "url": url + "/schedule"}]
        elif url:
            links = [{"label": "Open page", "url": url}]
        return {"avatar": it.get("avatar"), "bio": it.get("bio"), "links": links}

    @api_method
    def open_url(self, url):
        """Open a link in the system browser (only http/https)."""
        import webbrowser
        if not str(url).startswith(("http://", "https://")):
            raise ResolveError("Unsupported link")
        webbrowser.open(url)

    # ---------- browse (Twitch Helix) ----------
    @api_method
    def browse_status(self):
        return {"configured": self._browser.configured()}

    @api_method
    def browse_games(self, cursor=None):
        items, nxt = self._browser.top_games(cursor)
        return {"items": items, "cursor": nxt}

    @api_method
    def browse_streams(self, game_id=None, cursor=None):
        items, nxt = self._browser.streams(game_id, cursor)
        return {"items": items, "cursor": nxt}

    @api_method
    def stream_stats(self, item_id):
        """Current viewer count for a live Twitch channel (needs Helix credentials)."""
        it = self._item(item_id)
        if it.get("platform") != "twitch" or it.get("kind") != "channel" or not self._browser.configured():
            return {"viewers": None}
        login = it["id"].split(":", 1)[1].lower()
        info = self._browser.live_by_login([login]).get(login)
        v = info["viewers"] if info else None
        self._store.update_item(item_id, viewers=v)
        return {"viewers": v, "started_at": info and info.get("started_at")}

    def _shutdown(self):
        from backend import features
        features.shutdown(self, self._features)
        self._live.stop()
        self._recorder.stop_all()
        self._proxy.stop()


def main():
    import webview

    debug = "--debug" in sys.argv
    api = Api()
    index = resource_dir() / "ui" / "index.html"
    state_file = Path.home() / ".featherwatch" / "window.json"
    try:
        st = json.loads(state_file.read_text())
    except Exception:
        st = {}
    geo = {"width": max(900, int(st.get("width", 1280))), "height": max(600, int(st.get("height", 800)))}
    if "x" in st and "y" in st:
        geo["x"], geo["y"] = int(st["x"]), int(st["y"])
    window = webview.create_window(
        "FeatherWatch", url=str(index), js_api=api, **geo,
        maximized=bool(st.get("maximized", True)),
        min_size=(900, 600), background_color="#0e0e10", text_select=True,
    )
    api._set_window(window)

    # Remember size / position / maximized state between launches.
    def _save():
        try:
            state_file.parent.mkdir(parents=True, exist_ok=True)
            state_file.write_text(json.dumps(st))
        except Exception:
            pass

    def _on_resized(width, height):
        if not st.get("maximized"):
            st["width"], st["height"] = width, height

    def _on_moved(x, y):
        if not st.get("maximized"):
            st["x"], st["y"] = x, y

    def _set_max(v):
        st["maximized"] = v

    for name, fn in (("resized", _on_resized), ("moved", _on_moved),
                     ("maximized", lambda: _set_max(True)), ("restored", lambda: _set_max(False)),
                     ("closing", _save)):
        try:
            getattr(window.events, name).__iadd__(fn)
        except Exception:
            pass
    try:
        window.events.closed += api._shutdown
    except Exception:
        pass
    api._live.start()
    webview.start(debug=debug)


if __name__ == "__main__":
    main()

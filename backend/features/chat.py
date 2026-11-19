"""Chat feature: third-party emotes (7TV/BTTV/FFZ), badges (ivr.fi), prefs, pop-out window.

No Twitch private client-id is used. All lists are cached in memory and in
~/.featherwatch/cache/chat_*.json (TTL), so fetching is cheap and CORS-free.
"""
import json
import threading
import time
from pathlib import Path

CACHE_DIR = Path.home() / ".featherwatch" / "cache"
TTL = 6 * 3600
UA = {"User-Agent": "FeatherWatch/1.0"}

DEFAULT_PREFS = {
    "highlights": [],
    "sound": False,
    "hide_bots": True,
    "bots": ["nightbot", "streamelements", "streamlabs", "moobot", "fossabot", "wizebot",
             "soundalerts", "sery_bot", "botrixoficial", "kofistreambot"],
    "font_size": 13,
    "timestamps": False,
    "third_party": True,
}

_mem = {}
_lock = threading.Lock()
_popouts = {}


def _http(api):
    try:
        return api._resolver.session.http
    except Exception:
        import requests
        return requests.Session()


def _get_json(http, url):
    r = http.get(url, headers=UA, timeout=8)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def _cached(key, fn):
    now = time.time()
    with _lock:
        hit = _mem.get(key)
    if hit and now - hit[0] < TTL:
        return hit[1]
    path = CACHE_DIR / ("chat_%s.json" % key)
    try:
        d = json.loads(path.read_text("utf-8"))
        if now - d["t"] < TTL:
            with _lock:
                _mem[key] = (d["t"], d["v"])
            return d["v"]
    except Exception:
        d = None
    try:
        v = fn()
    except Exception:
        if d is not None:  # stale is better than nothing
            return d["v"]
        return None
    with _lock:
        _mem[key] = (now, v)
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"t": now, "v": v}), "utf-8")
    except Exception:
        pass
    return v


# ---- emote providers -> {name: [url, provider]} ----
def _7tv_set(emotes):
    out = {}
    for e in emotes or []:
        try:
            out[e["name"]] = ["https://cdn.7tv.app/emote/%s/1x.webp" % e["id"], "7TV"]
        except Exception:
            pass
    return out


def _bttv_list(lst):
    return {e["code"]: ["https://cdn.betterttv.net/emote/%s/1x" % e["id"], "BTTV"] for e in lst or [] if "code" in e}


def _ffz_list(lst):
    # FFZ emotes via BTTV's cached FFZ mirror (api.frankerfacez.com is often slow/unreachable)
    out = {}
    for e in lst or []:
        u = (e.get("images") or {}).get("1x")
        if u and "code" in e:
            out[e["code"]] = [u, "FFZ"]
    return out


def _gather(http, jobs):
    """jobs: [(url, parser)] fetched in parallel; later jobs override earlier names."""
    res = [None] * len(jobs)

    def run(i, url, parse):
        try:
            res[i] = parse(_get_json(http, url))
        except Exception:
            res[i] = None
    ts = [threading.Thread(target=run, args=(i, u, f), daemon=True) for i, (u, f) in enumerate(jobs)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(10)
    out = {}
    for r in res:
        out.update(r or {})
    return out


def _global(http):
    return _gather(http, [
        ("https://api.betterttv.net/3/cached/frankerfacez/emotes/global", _ffz_list),
        ("https://api.betterttv.net/3/cached/emotes/global", _bttv_list),
        ("https://7tv.io/v3/emote-sets/global", lambda d: _7tv_set((d or {}).get("emotes"))),
    ])


def _channel(http, rid):
    def bttv(d):
        d = d or {}
        o = _bttv_list(d.get("sharedEmotes"))
        o.update(_bttv_list(d.get("channelEmotes")))
        return o
    return _gather(http, [
        ("https://api.betterttv.net/3/cached/frankerfacez/users/twitch/%s" % rid, _ffz_list),
        ("https://api.betterttv.net/3/cached/users/twitch/%s" % rid, bttv),
        ("https://7tv.io/v3/users/twitch/%s" % rid, lambda d: _7tv_set(((d or {}).get("emote_set") or {}).get("emotes"))),
    ])


def _badges(http, rid=None):
    """ivr.fi public mirror of Helix badges -> {"set/version": url}."""
    url = "https://api.ivr.fi/v2/twitch/badges/" + ("channel?id=%s" % rid if rid else "global")
    out = {}
    for s in _get_json(http, url) or []:
        for v in s.get("versions") or []:
            u = v.get("image_url_1x") or v.get("image_url_2x")
            if u:
                out["%s/%s" % (s.get("set_id"), v.get("id"))] = [u, v.get("title") or s.get("set_id")]
    return out


def chat_emotes(api, room_id=None):
    http = _http(api)
    rid = "".join(c for c in str(room_id or "") if c.isdigit())
    emotes = dict(_cached("global", lambda: _global(http)) or {})
    badges = dict(_cached("badges_global", lambda: _badges(http)) or {})
    if rid:
        emotes.update(_cached("ch_" + rid, lambda: _channel(http, rid)) or {})
        badges.update(_cached("badges_" + rid, lambda: _badges(http, rid)) or {})
    return {"emotes": emotes, "badges": badges}


# ---- prefs (store settings key "chat") ----
def _prefs(api):
    p = dict(DEFAULT_PREFS)
    try:
        with api._store.lock:
            cur = api._store.data["settings"].get("chat")
        if isinstance(cur, dict):
            p.update({k: v for k, v in cur.items() if k in DEFAULT_PREFS})
    except Exception:
        pass
    return p


def chat_get_prefs(api):
    return {"prefs": _prefs(api)}


def chat_set_prefs(api, d):
    p = _prefs(api)
    for k, v in (d or {}).items():
        if k not in DEFAULT_PREFS:
            continue
        if k in ("highlights", "bots"):
            v = [str(x).strip()[:60] for x in (v or []) if str(x).strip()][:100]
        elif k == "font_size":
            try:
                v = max(10, min(22, int(v)))
            except Exception:
                continue
        else:
            v = bool(v)
        p[k] = v
    with api._store.lock:
        api._store.data["settings"]["chat"] = p
        api._store.save()
    return {"prefs": p}


# ---- pop-out ----
class PopoutApi:
    """Minimal js_api for the pop-out window (only what chat.js needs)."""

    def __init__(self, api):
        self._api = api

    def _w(self, fn, *a):
        try:
            r = fn(self._api, *a) or {}
            r.setdefault("ok", True)
            return r
        except Exception as e:
            return {"ok": False, "error": str(e) or type(e).__name__}

    def chat_emotes(self, room_id=None):
        return self._w(chat_emotes, room_id)

    def chat_get_prefs(self):
        return self._w(chat_get_prefs)

    def chat_set_prefs(self, d):
        return self._w(chat_set_prefs, d)

    def open_url(self, url):
        return self._api.open_url(url)


def chat_popout(api, channel):
    import webview
    from backend.resolver import ResolveError
    ch = "".join(c for c in str(channel or "").lower() if c.isalnum() or c == "_")
    if not ch:
        raise ResolveError("No channel")
    old = _popouts.get(ch)
    if old is not None:
        try:
            old.show()
            return {"existing": True}
        except Exception:
            pass
    page = Path(__file__).resolve().parents[2] / "ui" / "features" / "chat_popout.html"
    w = webview.create_window(
        "#%s chat · FeatherWatch" % ch, url=page.as_uri() + "?channel=" + ch,
        js_api=PopoutApi(api), width=380, height=680, min_size=(260, 300),
        on_top=True, background_color="#16161c",
    )
    _popouts[ch] = w
    try:
        w.events.closed += lambda *a: _popouts.pop(ch, None)
    except Exception:
        pass
    return {}


def shutdown(api):
    for w in list(_popouts.values()):
        try:
            w.destroy()
        except Exception:
            pass
    _popouts.clear()


def setup(api):
    return {
        "chat_emotes": chat_emotes,
        "chat_get_prefs": chat_get_prefs,
        "chat_set_prefs": chat_set_prefs,
        "chat_popout": chat_popout,
    }

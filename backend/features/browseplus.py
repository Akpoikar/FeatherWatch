"""Browse-plus: avatars, search, filtered/sorted live streams — official Helix API only (api._browser)."""
import json
import os
import threading
import time
from pathlib import Path

from backend.resolver import ResolveError

AV_TTL = 7 * 24 * 3600
CACHE_FILE = Path(os.path.expanduser("~/.lightweight/cache/bp_avatars.json"))
_lock = threading.Lock()
_av = {}  # login(lower) -> (ts, url|None, user_id)
_loaded = [False]


def _size(url, w, h):
    return (url or "").replace("{width}", str(w)).replace("{height}", str(h)) or None


def _browser(api):
    b = getattr(api, "_browser", None)
    if b is None or not b.configured():
        raise ResolveError("Twitch API not configured – add TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET to .env")
    return b


def _load_cache():
    if _loaded[0]:
        return
    _loaded[0] = True
    try:
        d = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        for k, v in d.items():
            _av[k] = tuple(v)
    except Exception:
        pass


def _save_cache():
    try:
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        now = time.time()
        d = {k: list(v) for k, v in _av.items() if now - v[0] < AV_TTL}
        tmp = CACHE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(d), encoding="utf-8")
        os.replace(str(tmp), str(CACHE_FILE))
    except Exception:
        pass


def avatars_by_login(b, logins):
    """{login: avatar_url|None}, batched 100 per Helix /users call, cached in memory + disk."""
    logins = sorted({(l or "").strip().lower() for l in logins if l})
    now = time.time()
    out, miss = {}, []
    with _lock:
        _load_cache()
        for l in logins:
            c = _av.get(l)
            if c and now - c[0] < AV_TTL:
                out[l] = c[1]
            else:
                miss.append(l)
    if miss:
        got = {}
        for i in range(0, len(miss), 100):
            d = b._get("/users", [("login", l) for l in miss[i:i + 100]])
            for u in d.get("data", []):
                got[u["login"].lower()] = (now, u.get("profile_image_url") or None, u.get("id"))
        with _lock:
            for l in miss:
                v = got.get(l, (now, None, None))
                _av[l] = v
                out[l] = v[1]
            _save_cache()
    return out


def bp_avatars(api, logins):
    b = _browser(api)
    if isinstance(logins, str):
        logins = [logins]
    logins = [(l or "").split(":", 1)[-1] for l in (logins or [])][:500]
    return {"avatars": avatars_by_login(b, logins)}


def _stream_item(s):
    login = s["user_login"]
    return {
        "id": "twitch:" + login, "platform": "twitch", "kind": "channel",
        "url": "https://www.twitch.tv/" + login,
        "title": s.get("title") or login, "author": s.get("user_name") or login,
        "category": s.get("game_name") or "",
        "thumbnail": _size(s.get("thumbnail_url"), 440, 248),
        "is_live": True, "viewers": s.get("viewer_count", 0),
        "language": s.get("language"), "started_at": s.get("started_at"), "avatar": None,
    }


def bp_streams(api, game_id=None, cursor=None, language=None, first=40):
    b = _browser(api)
    params = {"first": max(1, min(100, int(first or 40)))}
    if game_id:
        params["game_id"] = game_id
    if cursor:
        params["after"] = cursor
    if language and language != "all":
        params["language"] = language
    d = b._get("/streams", params)
    items = [_stream_item(s) for s in d.get("data", [])]
    try:
        av = avatars_by_login(b, [i["id"][7:] for i in items])
        for i in items:
            i["avatar"] = av.get(i["id"][7:].lower())
    except Exception:
        pass
    return {"items": items, "cursor": (d.get("pagination") or {}).get("cursor")}


def bp_search(api, query):
    b = _browser(api)
    q = (query or "").strip()
    if not q:
        return {"channels": [], "categories": []}
    ch = b._get("/search/channels", {"query": q, "first": 20}).get("data", [])
    cats = b._get("/search/categories", {"query": q, "first": 12}).get("data", [])
    channels = []
    logins = [c.get("broadcaster_login") for c in ch if c.get("broadcaster_login")]
    live = {}
    try:
        live = b.live_by_login([l for l, c in zip(logins, ch) if c.get("is_live")]) if logins else {}
    except Exception:
        pass
    for c in ch:
        login = c.get("broadcaster_login")
        if not login:
            continue
        info = live.get(login.lower()) or {}
        channels.append({
            "login": login, "name": c.get("display_name") or login,
            "avatar": c.get("thumbnail_url") or None, "is_live": bool(c.get("is_live")),
            "title": c.get("title") or "", "category": c.get("game_name") or "",
            "viewers": info.get("viewers"), "started_at": c.get("started_at") or info.get("started_at") or None,
        })
    channels.sort(key=lambda x: (not x["is_live"], -(x["viewers"] or 0)))
    categories = [{"id": g["id"], "name": g["name"], "box_art": _size((g.get("box_art_url") or "").replace("52x72", "{width}x{height}"), 144, 192)}
                  for g in cats]
    return {"channels": channels, "categories": categories}


def setup(api):
    return {"bp_avatars": bp_avatars, "bp_streams": bp_streams, "bp_search": bp_search}

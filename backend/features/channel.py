"""Channel feature: profile page data + past broadcasts / highlights / uploads / clips.

Sources (no Twitch GQL with Twitch's client id from our own code):
  1. Official Helix API via api._browser (user's own app credentials) when configured.
  2. Fallback: yt-dlp's Twitch playlist extractors (flat extraction, used as a library).
Results are cached briefly in memory.
"""
import re
import threading
import time

from backend.resolver import ResolveError, NAME_RE, classify, TWITCH_THUMB

try:
    import yt_dlp
except Exception:  # pragma: no cover
    yt_dlp = None

PAGE = 24
TTL = 300
KINDS = ("archive", "highlight", "upload", "clips")
_cache = {}  # key -> (ts, value)
_lock = threading.Lock()


def _cached(key, fn, ttl=TTL):
    with _lock:
        c = _cache.get(key)
        if c and time.time() - c[0] < ttl:
            return c[1]
    v = fn()
    with _lock:
        _cache[key] = (time.time(), v)
    return v


def _login(s):
    s = (s or "").strip()
    if s.startswith("twitch:"):
        s = s.split(":", 1)[1]
    m = re.match(r"^(?:https?://)?(?:www\.|m\.)?twitch\.tv/([A-Za-z0-9_]+)", s)
    if m:
        s = m.group(1)
    if not NAME_RE.match(s):
        raise ResolveError("Not a Twitch channel: %s" % s)
    return s.lower()


def _helix_ok(api):
    b = getattr(api, "_browser", None)
    try:
        return bool(b and b.configured())
    except Exception:
        return False


def _hms(s):
    """Helix duration '1h2m3s' -> seconds."""
    if not s:
        return None
    t = 0
    for n, u in re.findall(r"(\d+)([hms])", s):
        t += int(n) * {"h": 3600, "m": 60, "s": 1}[u]
    return t or None


def _ts(iso):
    if not iso:
        return None
    try:
        import calendar
        return calendar.timegm(time.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S"))
    except Exception:
        return None


# ---------------- Helix ----------------
def _helix_user(api, login):
    def f():
        d = api._browser._get("/users", {"login": login})
        data = d.get("data") or []
        if not data:
            raise ResolveError("Channel not found: %s" % login)
        return data[0]
    return _cached(("user", login), f, ttl=3600)


def _helix_videos(api, login, kind, cursor):
    u = _helix_user(api, login)
    if kind == "clips":
        params = {"broadcaster_id": u["id"], "first": PAGE}
        if cursor:
            params["after"] = cursor
        d = api._browser._get("/clips", params)
        items = [{
            "id": "clip:" + c["id"], "title": c.get("title") or "", "url": c.get("url"),
            "thumbnail": c.get("thumbnail_url"), "duration": c.get("duration"),
            "created_at": _ts(c.get("created_at")), "views": c.get("view_count"),
            "author": u.get("display_name") or login, "kind": "clip",
        } for c in d.get("data", [])]
    else:
        params = {"user_id": u["id"], "type": kind, "first": PAGE}
        if cursor:
            params["after"] = cursor
        d = api._browser._get("/videos", params)
        items = []
        for v in d.get("data", []):
            th = v.get("thumbnail_url") or ""
            th = th.replace("%{width}", "440").replace("%{height}", "248") if th and "_404" not in th else None
            items.append({
                "id": "twitch-vod:" + v["id"], "title": v.get("title") or "",
                "url": "https://www.twitch.tv/videos/" + v["id"], "thumbnail": th,
                "duration": _hms(v.get("duration")), "created_at": _ts(v.get("created_at")),
                "views": v.get("view_count"), "author": v.get("user_name") or login, "kind": "vod",
            })
    nxt = (d.get("pagination") or {}).get("cursor")
    return items, (nxt if items else None)


# ---------------- yt-dlp fallback ----------------
class _Quiet:
    def debug(self, m):
        pass
    info = warning = error = debug


def _ytdlp_videos(login, kind, cursor):
    if yt_dlp is None:
        raise ResolveError("yt-dlp not installed")
    start = int(cursor or 0)
    if kind == "clips":
        url = "https://www.twitch.tv/%s/clips?filter=clips&range=all" % login
    else:
        filt = {"archive": "archives", "highlight": "highlights", "upload": "uploads"}[kind]
        url = "https://www.twitch.tv/%s/videos?filter=%s&sort=time" % (login, filt)
    opts = {"quiet": True, "no_warnings": True, "skip_download": True, "extract_flat": "in_playlist",
            "playliststart": start + 1, "playlistend": start + PAGE, "logger": _Quiet()}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    items = []
    for e in list(info.get("entries") or []):
        if not e:
            continue
        eurl = e.get("url") or ""
        thumb = e.get("thumbnail")
        if not thumb and e.get("thumbnails"):
            thumb = (e["thumbnails"][-1] or {}).get("url")
        if kind == "clips":
            iid, k = "clip:" + str(e.get("id")), "clip"
        else:
            m = re.search(r"/videos/(\d+)", eurl) or re.match(r"v?(\d+)$", str(e.get("id") or ""))
            if not m:
                continue
            iid, k = "twitch-vod:" + m.group(1), "vod"
            eurl = "https://www.twitch.tv/videos/" + m.group(1)
        items.append({
            "id": iid, "title": e.get("title") or "", "url": eurl, "thumbnail": thumb,
            "duration": e.get("duration"), "created_at": e.get("timestamp"),
            "views": e.get("view_count"), "author": e.get("uploader") or login, "kind": k,
        })
    return items, (str(start + len(items)) if len(items) >= PAGE else None)


# ---------------- API ----------------
def channel_videos(api, login, kind="archive", cursor=None):
    login = _login(login)
    if kind not in KINDS:
        raise ResolveError("Unknown video type: %s" % kind)
    helix = _helix_ok(api)
    src = "helix" if helix else "ytdlp"

    def f():
        if helix:
            try:
                return _helix_videos(api, login, kind, cursor)
            except ResolveError:
                raise
            except Exception:
                pass  # fall through to yt-dlp
        return _ytdlp_videos(login, kind, None if helix else cursor)
    items, nxt = _cached(("videos", login, kind, cursor, src), f)
    # remember VOD metadata so history / resume progress have duration + thumbnail later
    with _lock:
        for it in items:
            _meta[it["id"]] = it
    return {"items": items, "cursor": nxt, "source": src}


_meta = {}  # item id -> listing entry


def channel_annotate(api, item_id):
    """Fill duration/thumbnail/title/author on a stored VOD item from listing metadata."""
    with _lock:
        m = _meta.get(item_id)
    it = api._store.get_item(item_id)
    if not m or not it:
        return {"item": it}
    fields = {}
    for k in ("duration", "thumbnail", "author"):
        if m.get(k) and not it.get(k):
            fields[k] = m[k]
    if m.get("title") and (not it.get("title") or it.get("title") == it.get("url")):
        fields["title"] = m["title"]
    if fields:
        it = api._store.update_item(item_id, **fields) or it
    return {"item": it}


def channel_info(api, login, refresh=False):
    """Profile header data: item (stored), avatar, bio, banner, live status, links."""
    login = _login(login)
    iid = "twitch:" + login
    it = api._store.get_item(iid)
    if not it:
        it = api._store.put_item(classify("https://www.twitch.tv/" + login))
    out = {"login": login, "banner": None, "display_name": it.get("author") or login,
           "source": "helix" if _helix_ok(api) else "public"}
    fields = {}
    if _helix_ok(api):
        try:
            u = _helix_user(api, login)
            out["display_name"] = u.get("display_name") or login
            out["banner"] = u.get("offline_image_url") or None
            out["bio_helix"] = u.get("description") or None
            if u.get("profile_image_url"):
                fields["avatar"] = u["profile_image_url"].replace("-300x300.", "-150x150.")
            s = _cached(("stream", login), lambda: api._browser._get("/streams", {"user_login": login}), ttl=60)
            st = (s.get("data") or [None])[0]
            fields["is_live"] = bool(st)
            if st:
                fields.update(title=st.get("title") or it.get("title"), category=st.get("game_name") or "",
                              viewers=st.get("viewer_count"),
                              thumbnail=TWITCH_THUMB.format(login) + "?t=%d" % int(time.time() // 60))
            fields["author"] = out["display_name"]
        except ResolveError:
            raise
        except Exception:
            pass
    if "is_live" not in fields:
        try:
            fields.update(_cached(("live", login), lambda: api._resolver.check_live(it), ttl=60 if not refresh else 0))
        except Exception:
            pass
    if fields:
        it = api._store.update_item(iid, **fields) or it
    p = api.profile(iid)
    if p.get("ok"):
        out.update(avatar=p.get("avatar"), bio=p.get("bio"), links=p.get("links") or [])
    else:
        out.update(avatar=it.get("avatar"), bio=it.get("bio"), links=[])
    if not out.get("bio") and out.get("bio_helix"):
        out["bio"] = out["bio_helix"]
    out.pop("bio_helix", None)
    it = api._store.get_item(iid) or it
    out["item"] = it
    return out


def setup(api):
    return {"channel_videos": channel_videos, "channel_info": channel_info,
            "channel_annotate": channel_annotate}

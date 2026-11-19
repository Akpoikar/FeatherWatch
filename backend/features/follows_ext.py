"""follows_ext: make YouTube and Kick channel follows behave like Twitch follows.

What was broken for non-Twitch channels:
  * `youtube.com/@handle` got an `url:<sha1>` id (a different id per URL spelling) and streamlink
    finds no stream on the bare channel page, so it always looked offline.
  * Kick channels also got `url:<sha1>` ids.
  * The live check only knew the streamlink path (no viewers / avatar), and profile.fetch on a
    YouTube `/live` page would store the *video* thumbnail as the avatar.

Fix (no edits to shared files; we wrap a few module functions / resolver methods at setup):
  * classify(): YouTube channel URLs -> id `youtube-ch:<handle>`, url `https://www.youtube.com/<handle>/live`;
    Kick channel URLs -> id `kick:<slug>`, url `https://kick.com/<slug>`.
  * Resolver.check_live(): YouTube via one page fetch of `/<handle>/live` (isLiveNow, title, viewers,
    category, avatar); Kick via `https://kick.com/api/v2/channels/<slug>`; streamlink fallback.
    Concurrency capped by a semaphore + per-host spacing + per-item result cache.
  * profile.fetch(): YouTube/Kick channels get their real avatar from the same lookups.
  * Existing `url:` follows for YouTube/Kick channels are migrated to the new ids once.
"""
import html
import json
import re
import threading
import time
from urllib.parse import urlparse

from backend import profile as _profile
from backend import resolver as _resolver

UA = _profile.UA
YT_KEY_RE = re.compile(r"^/(@[\w.\-%]+|channel/UC[\w-]{22}|c/[\w.\-%]+|user/[\w.\-%]+)", re.I)
KICK_SLUG_RE = re.compile(r"^[A-Za-z0-9_\-]{2,40}$")
KICK_RESERVED = {"video", "videos", "categories", "category", "browse", "following", "search",
                 "dashboard", "api", "terms-of-service", "privacy-policy", "clips", "clip"}
CACHE_TTL = 60          # don't re-check the same channel more than once a minute
MAX_CONCURRENT = 3      # simultaneous YouTube/Kick requests
MIN_SPACING = 0.25      # seconds between request starts per host

_sem = threading.BoundedSemaphore(MAX_CONCURRENT)
_space_lock = threading.Lock()
_last_start = {}
_cache = {}             # item_id -> (ts, fields)
_cache_lock = threading.Lock()
_orig = {}


# ---------------------------------------------------------------- classification
def channel_key(url):
    """('youtube'|'kick', key, canonical_url) for a channel URL, else None."""
    p = urlparse(url)
    host = (p.hostname or "").lower()
    if host.endswith("youtube.com"):
        m = YT_KEY_RE.match(p.path or "")
        if not m:
            return None
        key = m.group(1)
        if key.lower().startswith("channel/"):
            key = "channel/" + key.split("/", 1)[1]  # UC ids are case-sensitive
        else:
            key = key.lower() if key.startswith("@") else key
        return "youtube", key, "https://www.youtube.com/%s/live" % key
    if host.endswith("kick.com"):
        parts = [x for x in (p.path or "").split("/") if x]
        if len(parts) == 1 and KICK_SLUG_RE.match(parts[0]) and parts[0].lower() not in KICK_RESERVED:
            slug = parts[0].lower()
            return "kick", slug, "https://kick.com/" + slug
    return None


def _id_for(platform, key):
    return ("youtube-ch:" if platform == "youtube" else "kick:") + key


def classify(url):
    item = _orig["classify"](url)
    if item.get("kind") == "channel" or item.get("platform") in ("youtube", "kick"):
        ck = channel_key(url)
        if ck and item.get("kind") in ("channel", "video") and not item["id"].startswith(("youtube:", "twitch")):
            platform, key, curl = ck
            name = key.split("/")[-1].lstrip("@")
            item.update(id=_id_for(platform, key), platform=platform, kind="channel", url=curl)
            if not item.get("author") or item.get("author") == item.get("title"):
                item["author"] = name
            if item.get("title") in (url, "", None) or platform == "kick":
                item["title"] = name
    return item


def is_ext_channel(item):
    return bool(item and item.get("kind") == "channel" and item.get("platform") in ("youtube", "kick")
                and str(item.get("id", "")).startswith(("youtube-ch:", "kick:")))


# ---------------------------------------------------------------- rate limiting
def _throttle(host):
    with _space_lock:
        now = time.time()
        wait = _last_start.get(host, 0) + MIN_SPACING - now
        _last_start[host] = max(now, _last_start.get(host, 0) + MIN_SPACING)
    if wait > 0:
        time.sleep(wait)


def _get(http, url, host, **kw):
    with _sem:
        _throttle(host)
        return http.get(url, timeout=15, **kw)


# ---------------------------------------------------------------- live checks
def _js_str(s):
    try:
        return json.loads('"%s"' % s)
    except Exception:
        return s


def _meta(page, key):
    v = _profile._meta(page, key)
    return html.unescape(v) if v else v


def youtube_live(http, key):
    """Live status for a YouTube channel (`@handle`, `channel/UC..`, `c/x`, `user/x`)."""
    url = "https://www.youtube.com/%s/live" % key
    r = _get(http, url, "youtube", headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.8"},
             cookies={"SOCS": "CAI", "CONSENT": "YES+"})
    r.encoding = "utf-8"
    page = r.text
    if r.status_code == 404:
        raise _resolver.ResolveError("YouTube channel not found")
    live = '"isLiveNow":true' in page
    out = {"is_live": live, "viewers": None}
    if live:
        m = re.search(r'"videoDetails":\{"videoId":"([\w-]{11})"', page)
        vid = m.group(1) if m else None
        m = re.search(r'"videoDetails":\{.*?"title":"((?:[^"\\]|\\.)*)"', page)
        if m:
            out["stream_title"] = out["title"] = _js_str(m.group(1))
        m = re.search(r'"videoDetails":\{.*?"author":"((?:[^"\\]|\\.)*)"', page)
        if m:
            out["author"] = _js_str(m.group(1))
        m = re.search(r'"originalViewCount":"(\d+)"', page) or re.search(r'"concurrentViewers":"(\d+)"', page)
        if m:
            out["viewers"] = int(m.group(1))
        m = re.search(r'"category":"((?:[^"\\]|\\.)*)"', page)
        if m:
            out["category"] = _js_str(m.group(1))
        if vid:
            out["video_id"] = vid
            out["thumbnail"] = "https://i.ytimg.com/vi/%s/hqdefault_live.jpg?t=%d" % (vid, int(time.time() // 60))
        m = re.search(r'"videoOwnerRenderer":\{"thumbnail":\{"thumbnails":\[\{"url":"([^"]+)"', page)
        if m:
            out["avatar"] = re.sub(r"=s\d+-", "=s88-", _js_str(m.group(1)))
    else:
        name = _meta(page, "og:title")
        img = _meta(page, "og:image")
        if name:
            out["author"] = name
            out["title"] = name
        if img and ("yt3." in img or "ggpht" in img):
            out["avatar"] = img
        out["thumbnail"] = None
        out["category"] = ""
    if out.get("avatar"):
        out["profile_ts"] = int(time.time())
    return out


def kick_live(http, slug):
    r = _get(http, "https://kick.com/api/v2/channels/" + slug, "kick",
             headers={"User-Agent": UA, "Accept": "application/json"})
    if r.status_code == 404:
        raise _resolver.ResolveError("Kick channel not found")
    r.raise_for_status()
    d = r.json()
    user = d.get("user") or {}
    ls = d.get("livestream") or None
    out = {"is_live": bool(ls and ls.get("is_live")), "viewers": None,
           "author": user.get("username") or slug}
    if user.get("profile_pic"):
        out["avatar"] = user["profile_pic"]
        out["profile_ts"] = int(time.time())
    if user.get("bio"):
        out["bio"] = user["bio"]
    if out["is_live"]:
        out["viewers"] = ls.get("viewer_count")
        out["stream_title"] = out["title"] = ls.get("session_title") or out["author"]
        cats = ls.get("categories") or []
        out["category"] = (cats[0].get("name") if cats else "") or ""
        out["thumbnail"] = (ls.get("thumbnail") or {}).get("url")
        out["started_at"] = ls.get("start_time")
    else:
        out["title"] = out["author"]
        out["thumbnail"] = None
        out["category"] = ""
    return out


def ext_check(resolver, item, use_cache=True):
    """Fields for a YouTube/Kick channel item (cached for CACHE_TTL seconds)."""
    iid = item["id"]
    if use_cache:
        with _cache_lock:
            c = _cache.get(iid)
        if c and time.time() - c[0] < CACHE_TTL:
            return dict(c[1])
    key = iid.split(":", 1)[1]
    http = resolver.session.http
    try:
        fields = youtube_live(http, key) if item["platform"] == "youtube" else kick_live(http, key)
    except _resolver.ResolveError:
        raise
    except Exception:
        with _sem:  # page/API blocked: fall back to streamlink
            fields = _orig["check_live"](item)
        fields.setdefault("viewers", None)
    with _cache_lock:
        _cache[iid] = (time.time(), dict(fields))
    return fields


# ---------------------------------------------------------------- wrappers
def _make_check_live(resolver):
    def check_live(item):
        if is_ext_channel(item):
            return ext_check(resolver, item)
        return _orig["check_live"](item)
    return check_live


def _make_resolve(resolver):
    def resolve(text):
        item, qualities, default = _orig["resolve"](text)
        if is_ext_channel(item):
            try:
                f = ext_check(resolver, item, use_cache=False)
                f.pop("video_id", None)
                # resolve() already decided playability; keep its is_live unless the page says live
                f["is_live"] = bool(item.get("is_live") or f.get("is_live"))
                item.update({k: v for k, v in f.items() if v is not None or k == "viewers"})
            except Exception:
                pass
        return item, qualities, default
    return resolve


def _profile_fetch(http, item):
    if is_ext_channel(item):
        with _cache_lock:
            c = _cache.get(item["id"])
        f = dict(c[1]) if c else {}
        if not f.get("avatar"):
            try:
                key = item["id"].split(":", 1)[1]
                f = youtube_live(http, key) if item["platform"] == "youtube" else kick_live(http, key)
            except Exception:
                return {}
        return {k: f[k] for k in ("avatar", "bio", "profile_ts") if f.get(k)}
    return _orig["profile_fetch"](http, item)


def migrate(store):
    """Re-key old `url:<sha1>` YouTube/Kick channel follows to stable channel ids."""
    changed = 0
    with store.lock:
        d = store.data
        for i, fid in enumerate(list(d["follows"])):
            it = d["items"].get(fid)
            if not it or not fid.startswith("url:") or it.get("platform") not in ("youtube", "kick"):
                continue
            ck = channel_key(it.get("url") or "")
            if not ck:
                continue
            nid = _id_for(ck[0], ck[1])
            new = dict(it)
            new.update(id=nid, kind="channel", url=ck[2], profile_ts=None)
            d["items"][nid] = dict(d["items"].get(nid) or {}, **new)
            if nid in d["follows"]:
                d["follows"][i] = None
            else:
                d["follows"][i] = nid
            d["history"] = [nid if h == fid else h for h in d["history"]]
            changed += 1
        if changed:
            d["follows"] = [f for f in d["follows"] if f]
            seen = set()
            d["history"] = [h for h in d["history"] if not (h in seen or seen.add(h))]
            store.save()
    return changed


# ---------------------------------------------------------------- feature API
def install(resolver):
    """Patch the module/resolver hooks (idempotent). Separate from setup() for testing."""
    if "classify" not in _orig:
        _orig["classify"] = _resolver.classify
        _resolver.classify = classify
        _orig["profile_fetch"] = _profile.fetch
        _profile.fetch = _profile_fetch
    if not getattr(resolver, "_fx_installed", False):
        _orig["check_live"] = resolver.check_live
        _orig["resolve"] = resolver.resolve
        resolver.check_live = _make_check_live(resolver)
        resolver.resolve = _make_resolve(resolver)
        resolver._fx_installed = True


def fx_check(api, item_id):
    """Force a live check of one YouTube/Kick follow now."""
    it = api._store.get_item(item_id)
    if not it:
        raise _resolver.ResolveError("Unknown item: %s" % item_id)
    if not is_ext_channel(it):
        raise _resolver.ResolveError("Not a YouTube/Kick channel")
    f = ext_check(api._resolver, it, use_cache=False)
    f.pop("video_id", None)
    return {"item": api._store.update_item(item_id, **f)}


def setup(api):
    install(api._resolver)
    try:
        migrate(api._store)
    except Exception:
        pass
    return {"fx_check": fx_check}

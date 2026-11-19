"""Resolve user input into Items and playable streams via streamlink / yt-dlp."""
import hashlib
import re
import threading
import time
from urllib.parse import urlparse, parse_qs

import streamlink
from streamlink.stream.hls import HLSStream
from streamlink.stream.http import HTTPStream

try:
    import yt_dlp  # optional
except Exception:  # pragma: no cover
    yt_dlp = None

NAME_RE = re.compile(r"^[A-Za-z0-9_]{2,25}$")
YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
ALIASES = ("best", "worst", "best-unfiltered", "worst-unfiltered")

TWITCH_THUMB = "https://static-cdn.jtvnw.net/previews-ttv/live_user_{}-440x248.jpg"
YT_THUMB = "https://i.ytimg.com/vi/{}/hqdefault.jpg"


class _QuietLogger:
    def debug(self, msg):
        pass

    warning = info = error = debug


class ResolveError(Exception):
    pass


def _sha1(s):
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:16]


def normalize_input(text):
    """Return a full URL for a channel name or URL-ish input."""
    t = (text or "").strip()
    if not t:
        raise ResolveError("Empty input")
    if NAME_RE.match(t):
        return "https://www.twitch.tv/" + t.lower()
    if not re.match(r"^[a-z][a-z0-9+.-]*://", t, re.I):
        t = "https://" + t
    return t


def _youtube_id(url):
    p = urlparse(url)
    host = (p.hostname or "").lower()
    if host.endswith("youtu.be"):
        vid = p.path.strip("/").split("/")[0]
        return vid if YT_ID_RE.match(vid) else None
    if "youtube.com" in host:
        q = parse_qs(p.query)
        if p.path == "/watch" and q.get("v"):
            v = q["v"][0]
            return v if YT_ID_RE.match(v) else None
        m = re.match(r"^/(?:live|shorts|embed|v)/([A-Za-z0-9_-]{11})", p.path)
        if m:
            return m.group(1)
    return None


def classify(url):
    """Build a skeleton Item from a URL (no network)."""
    p = urlparse(url)
    host = (p.hostname or "").lower()
    parts = [x for x in p.path.split("/") if x]
    item = {
        "id": "url:" + _sha1(url), "platform": "other", "kind": "video", "url": url,
        "title": url, "author": "", "category": "", "thumbnail": None, "is_live": None,
        "last_watched": None, "progress": 0, "duration": None,
    }
    if host.endswith("twitch.tv"):
        item["platform"] = "twitch"
        if host.startswith("clips.") or (len(parts) >= 3 and parts[1] == "clip"):
            item["kind"] = "clip"
        elif parts and parts[0] == "videos" and len(parts) > 1 and parts[1].isdigit():
            item.update(id="twitch-vod:" + parts[1], kind="vod",
                        url="https://www.twitch.tv/videos/" + parts[1])
        elif len(parts) >= 3 and parts[1] == "video" and parts[2].isdigit():
            item.update(id="twitch-vod:" + parts[2], kind="vod",
                        url="https://www.twitch.tv/videos/" + parts[2])
        elif parts and NAME_RE.match(parts[0]):
            login = parts[0].lower()
            item.update(id="twitch:" + login, kind="channel", url="https://www.twitch.tv/" + login,
                        title=login, author=login)
    elif "youtube.com" in host or host.endswith("youtu.be"):
        item["platform"] = "youtube"
        vid = _youtube_id(url)
        if vid:
            item.update(id="youtube:" + vid, kind="video",
                        url="https://www.youtube.com/watch?v=" + vid, thumbnail=YT_THUMB.format(vid))
        else:
            item["kind"] = "channel"
    elif host.endswith("kick.com"):
        item["platform"] = "kick"
        if parts and parts[0] != "video" and "videos" not in parts:
            item.update(kind="channel", title=parts[0], author=parts[0])
    return item


def _quality_key(name):
    m = re.match(r"^(\d+)p(\d+)?", name)
    if m:
        return (int(m.group(1)), int(m.group(2) or 30))
    if name == "auto":
        return (100000, 0)  # adaptive master playlist: always the best choice
    if name == "audio_only":
        return (-1, 0)
    return (0, 0)


class Resolver:
    """Wraps a single streamlink session; caches resolved streams briefly."""

    CACHE_TTL = 45

    def __init__(self):
        self.session = streamlink.Streamlink()
        self.session.set_option("http-timeout", 15)
        self._cache = {}  # item_id -> (ts, streams_dict, ytinfo)
        self._lock = threading.Lock()

    def set_low_latency(self, on):
        try:
            self.session.set_option("hls-live-edge", 2 if on else 3)
        except Exception:
            pass

    # ---------- streamlink ----------
    def _streamlink(self, url):
        """Return (streams, meta) or raise. streams may be {} when offline."""
        try:
            name, cls, resolved = self.session.resolve_url(url)
        except streamlink.NoPluginError:
            raise ResolveError("No plugin for this URL")
        plugin = cls(self.session, resolved)
        streams = plugin.streams() or {}
        meta = {}
        for k, fn in (("title", "get_title"), ("author", "get_author"), ("category", "get_category")):
            try:
                v = getattr(plugin, fn)()
                if v:
                    meta[k] = str(v)
            except Exception:
                pass
        return streams, meta

    # ---------- yt-dlp ----------
    def _ytdlp(self, url):
        if yt_dlp is None:
            raise ResolveError("yt-dlp not installed")
        opts = {"quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True,
                "logger": _QuietLogger()}
        if getattr(self, "ytdlp_proxy", None):  # set by features/netproxy
            opts["proxy"] = self.ytdlp_proxy
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        if info.get("_type") == "playlist" and info.get("entries"):
            info = next((e for e in info["entries"] if e), info)
        return info

    @staticmethod
    def _yt_formats(info):
        """Map quality name -> {url, kind, headers} from yt-dlp info (combined A+V only)."""
        out = {}
        for f in info.get("formats") or []:
            if not f.get("url") or f.get("vcodec") in (None, "none") or f.get("acodec") in (None, "none"):
                continue
            proto = f.get("protocol") or ""
            if proto.startswith("m3u8"):
                kind = "hls"
            elif proto in ("https", "http") and f.get("ext") == "mp4":
                kind = "mp4"
            else:
                continue
            h = f.get("height") or 0
            name = "%dp" % h if h else (f.get("format_id") or "source")
            prev = out.get(name)
            # prefer HLS over progressive, then higher bitrate
            score = (1 if kind == "hls" else 0, f.get("tbr") or 0)
            if prev is None or score > prev["score"]:
                out[name] = {"url": f["url"], "kind": kind, "score": score,
                             "headers": dict(f.get("http_headers") or {})}
        # YouTube now serves video and audio as separate HLS renditions; the master manifest
        # combines them and hls.js switches quality itself.
        master = next((f.get("manifest_url") for f in info.get("formats") or []
                       if (f.get("protocol") or "").startswith("m3u8") and f.get("manifest_url")), None)
        if master:
            hdrs = next((dict(f.get("http_headers") or {}) for f in info.get("formats") or []
                         if f.get("manifest_url") == master), {})
            out["auto"] = {"url": master, "kind": "hls", "score": (2, 0), "headers": hdrs}
        if not out and info.get("url"):
            kind = "hls" if (info.get("protocol") or "").startswith("m3u8") else "mp4"
            out["source"] = {"url": info["url"], "kind": kind, "score": (0, 0),
                             "headers": dict(info.get("http_headers") or {})}
        return out

    # ---------- public ----------
    def resolve(self, text):
        url = normalize_input(text)
        item = classify(url)
        streams, meta, yt = {}, {}, None
        err = None
        try:
            streams, meta = self._streamlink(item["url"])
        except Exception as e:
            err = e
        if not streams and (item["platform"] != "twitch") and not (item["kind"] == "channel" and err is None):
            try:
                info = self._ytdlp(item["url"])
                yt = self._yt_formats(info)
                vid = info.get("id")
                if item["platform"] == "youtube" and vid and YT_ID_RE.match(vid):
                    item.update(id="youtube:" + vid, url="https://www.youtube.com/watch?v=" + vid,
                                thumbnail=YT_THUMB.format(vid), kind="video")
                meta.setdefault("title", info.get("title") or "")
                meta.setdefault("author", info.get("uploader") or info.get("channel") or "")
                if info.get("thumbnail") and not item["thumbnail"]:
                    item["thumbnail"] = info["thumbnail"]
                if info.get("duration"):
                    item["duration"] = info["duration"]
                item["is_live"] = bool(info.get("is_live"))
                err = None
            except Exception as e:
                err = e  # prefer the yt-dlp error message (usually more specific)
        if err is not None and not streams and not yt:
            # an offline twitch channel is fine; everything else is an error
            if not (item["platform"] == "twitch" and item["kind"] == "channel"):
                msg = re.sub(r"^ERROR:\s*", "", str(err)) or "Could not resolve"
                raise ResolveError(msg)
        for k, v in meta.items():
            if v:
                item[k] = v
        if item["kind"] == "channel":
            item["is_live"] = bool(streams) or bool(yt and item.get("is_live"))
            if item["platform"] == "twitch" and item["is_live"]:
                item["thumbnail"] = TWITCH_THUMB.format(item["id"].split(":", 1)[1])
        elif item["is_live"] is None:
            item["is_live"] = False
        if streams:
            qualities = [q for q in streams if q not in ALIASES]
            qualities.sort(key=_quality_key, reverse=True)
        else:
            qualities = sorted((yt or {}).keys(), key=_quality_key, reverse=True)
        with self._lock:
            self._cache[item["id"]] = (time.time(), streams, yt, item["url"])
        default = "best" if qualities else ""
        return item, (["best"] + qualities if qualities else []), default

    def get_stream(self, item, quality):
        """Return ('streamlink', Stream) or ('ytdlp', fmtdict). Re-resolves if cache stale."""
        with self._lock:
            c = self._cache.get(item["id"])
        if not c or time.time() - c[0] > self.CACHE_TTL:
            self.resolve(item["url"])
            with self._lock:
                c = self._cache.get(item["id"])
        if not c:
            raise ResolveError("Stream not available")
        _, streams, yt, _ = c
        quality = quality or "best"
        if streams:
            s = streams.get(quality) or streams.get("best")
            if s is None:
                raise ResolveError("Quality not available")
            return "streamlink", s
        if yt:
            if quality in yt:
                return "ytdlp", yt[quality]
            best = sorted(yt.keys(), key=_quality_key, reverse=True)[0]
            return "ytdlp", yt[best]
        raise ResolveError("Offline or no playable streams")

    def check_live(self, item):
        """Cheap-ish live check for a channel Item via streamlink. Returns updated fields."""
        streams, meta = self._streamlink(item["url"])
        fields = {"is_live": bool(streams)}
        fields.update({k: v for k, v in meta.items() if v})
        if item.get("platform") == "twitch":
            login = item["id"].split(":", 1)[1]
            fields["thumbnail"] = TWITCH_THUMB.format(login) + "?t=%d" % int(time.time() // 60) if streams else None
        with self._lock:
            self._cache[item["id"]] = (time.time(), streams, None, item["url"])
        return fields

    def stream_url(self, stream):
        """Upstream URL for a streamlink stream (HLS variant/multivariant or HTTP)."""
        if isinstance(stream, HLSStream):
            return stream.url, "hls"
        if isinstance(stream, HTTPStream):
            return stream.url, "mp4"
        url = getattr(stream, "url", None)
        if not url:
            raise ResolveError("Unsupported stream type: %s" % type(stream).__name__)
        return url, ("hls" if ".m3u8" in url else "mp4")

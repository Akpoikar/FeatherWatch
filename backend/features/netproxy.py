"""Network proxy / region option (feature: netproxy).

Settings (kept in store settings, managed via np_get / np_set):
  net_proxy             "" (off) | "http://host:port" | "socks5://user:pass@host:port" ...
  net_proxy_scope       "all" | "playlist-only"
  twitch_proxy_playlist list of playlist-proxy URLs (streamlink twitch `proxy-playlist`,
                        only used if the installed streamlink supports it)

"all": streamlink session (shared requests session -> also Helix/profile/HLS proxy), yt-dlp.
"playlist-only": streamlink + yt-dlp resolution and .m3u8 fetches go through the proxy;
HLS-proxy segment fetches go direct.
"""
import re
import threading
import time
from urllib.parse import urlparse, unquote

import requests

from backend.resolver import ResolveError

SCHEMES = ("http", "https", "socks4", "socks4a", "socks5", "socks5h")
SCOPES = ("all", "playlist-only")
DEFAULTS = {"net_proxy": "", "net_proxy_scope": "all", "twitch_proxy_playlist": []}
TEST_URL = "https://ipinfo.io/json"
_DIRECT = {"http": None, "https": None}
_lock = threading.Lock()


def validate(url):
    """Return normalized proxy URL ('' = off) or raise ResolveError."""
    url = (url or "").strip()
    if not url:
        return ""
    if "://" not in url:
        url = "http://" + url
    try:
        p = urlparse(url)
        port = p.port
    except ValueError:
        raise ResolveError("Invalid proxy URL (bad port)")
    if p.scheme.lower() not in SCHEMES:
        raise ResolveError("Proxy scheme must be one of: " + ", ".join(SCHEMES))
    if not p.hostname or not re.match(r"^[A-Za-z0-9.\-\[\]:]+$", p.hostname):
        raise ResolveError("Invalid proxy host")
    if not port:
        raise ResolveError("Proxy URL needs a port, e.g. http://host:8080")
    if p.path not in ("", "/") or p.query:
        raise ResolveError("Proxy URL must not contain a path")
    if p.scheme.lower().startswith("socks"):
        try:
            import socks  # noqa: F401
        except ImportError:
            raise ResolveError("SOCKS proxies need PySocks (pip install PySocks)")
    return url.rstrip("/")


def mask(url):
    """Hide the password: socks5://user:***@host:port"""
    if not url:
        return ""
    try:
        p = urlparse(url)
    except ValueError:
        return url
    if p.password is None:
        return url
    user = unquote(p.username or "")
    host = p.hostname or ""
    if ":" in host:
        host = "[%s]" % host
    return "%s://%s:***@%s%s" % (p.scheme, user, host, (":%d" % p.port) if p.port else "")


def _cfg(api):
    s = api._store.settings()
    out = {}
    for k, v in DEFAULTS.items():
        out[k] = s.get(k, v if not isinstance(v, list) else list(v))
    if out["net_proxy_scope"] not in SCOPES:
        out["net_proxy_scope"] = "all"
    if not isinstance(out["twitch_proxy_playlist"], list):
        out["twitch_proxy_playlist"] = []
    return out


def _playlist_supported():
    try:
        from streamlink.plugins import twitch
        for a in twitch.__plugin__.arguments or []:
            if getattr(a, "name", "") == "proxy-playlist":
                return True
    except Exception:
        pass
    return False


def _is_playlist(url):
    path = urlparse(url).path.lower()
    return path.endswith((".m3u8", ".m3u")) or "/playlist" in path


def apply(api, cfg=None):
    """Push current proxy settings into streamlink / requests / HLS proxy / yt-dlp (live)."""
    cfg = cfg or _cfg(api)
    url = cfg["net_proxy"] or ""
    scope = cfg["net_proxy_scope"]
    res = getattr(api, "_resolver", None)
    with _lock:
        if res is not None:
            sess = res.session
            if url:
                sess.set_option("http-proxy", url)  # sets http.proxies http+https
            else:
                try:
                    sess.http.proxies.pop("http", None)
                    sess.http.proxies.pop("https", None)
                except Exception:
                    pass
            res.ytdlp_proxy = url or None
            # twitch `proxy-playlist`: streamlink removed it (absent in 8.x); value is stored and
            # passed only if _playlist_supported() (see np_get.playlist_supported).
            res.twitch_proxy_playlist = (cfg["twitch_proxy_playlist"] if _playlist_supported() else [])
            if hasattr(res, "_cache"):
                res._cache.clear()
        px = getattr(api, "_proxy", None)
        if px is not None:
            if url and scope == "playlist-only":
                px.proxy_selector = lambda u: None if _is_playlist(u) else _DIRECT
            else:
                px.proxy_selector = None  # session default (proxied when url set)


def _save(api, upd):
    st = api._store
    with st.lock:
        st.data["settings"].update(upd)
        st.save()


def np_get(api):
    cfg = _cfg(api)
    cfg["net_proxy"] = mask(cfg["net_proxy"])  # never send the password to the UI
    return {"settings": cfg,
            "playlist_supported": _playlist_supported(),
            "socks_available": _has_socks()}


def np_set(api, d):
    d = d or {}
    cfg = _cfg(api)
    if "net_proxy" in d:
        v = d["net_proxy"]
        # UI shows a masked URL; if it comes back unchanged keep the stored one
        if v and v == mask(cfg["net_proxy"]) and v != cfg["net_proxy"]:
            v = cfg["net_proxy"]
        cfg["net_proxy"] = validate(v)
    if "net_proxy_scope" in d:
        if d["net_proxy_scope"] not in SCOPES:
            raise ResolveError("Scope must be 'all' or 'playlist-only'")
        cfg["net_proxy_scope"] = d["net_proxy_scope"]
    if "twitch_proxy_playlist" in d:
        v = d["twitch_proxy_playlist"]
        if isinstance(v, str):
            v = [x.strip() for x in re.split(r"[,\s]+", v) if x.strip()]
        for x in v:
            if not str(x).startswith(("http://", "https://")):
                raise ResolveError("Playlist proxy must be http(s) URL: %s" % x)
        cfg["twitch_proxy_playlist"] = [str(x) for x in v]
    _save(api, cfg)
    apply(api, cfg)
    return np_get(api)


def _has_socks():
    try:
        import socks  # noqa: F401
        return True
    except ImportError:
        return False


def np_test(api, url=None):
    """Fetch TEST_URL through `url` (or saved proxy; '' = direct). -> ip/country/latency."""
    if url is None:
        url = _cfg(api)["net_proxy"]
    elif url and url == mask(_cfg(api)["net_proxy"]):
        url = _cfg(api)["net_proxy"]
    url = validate(url)
    s = requests.Session()
    s.trust_env = False
    proxies = {"http": url, "https": url} if url else {}
    t0 = time.time()
    try:
        r = s.get(TEST_URL, proxies=proxies, timeout=12, headers={"Accept": "application/json",
                                                               "User-Agent": "FeatherWatch"})
        r.raise_for_status()
        j = r.json()
    except requests.exceptions.ProxyError as e:
        raise ResolveError("Proxy error: %s" % _short(e))
    except requests.exceptions.ConnectTimeout:
        raise ResolveError("Proxy connection timed out")
    except Exception as e:
        raise ResolveError("Test failed: %s" % _short(e))
    finally:
        s.close()
    return {"ip": j.get("ip"), "country": j.get("country"), "region": j.get("region"),
            "city": j.get("city"), "org": j.get("org"),
            "latency_ms": int((time.time() - t0) * 1000),
            "via": mask(url) or "direct"}


def _short(e):
    m = str(e)
    m = re.sub(r"//[^/@\s]*:[^/@\s]*@", "//***@", m)  # never leak creds
    return m[:200]


def setup(api):
    try:
        apply(api)
    except Exception:
        import traceback
        traceback.print_exc()
    return {"np_get": np_get, "np_set": np_set, "np_test": np_test}

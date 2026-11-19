"""Local HLS / progressive proxy on 127.0.0.1:<random>.

GET /p?u=<urlencoded upstream>&h=<header-profile id>
 - m3u8 bodies are rewritten so every URI (segments, variants, EXT-X-KEY/MAP/MEDIA URIs) goes back through /p
 - Twitch media playlists are parsed with streamlink's TwitchM3U8Parser and ad segments are removed
 - other bodies are streamed, with Range passthrough (for mp4 seeking)
"""
import re
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, urljoin, urlparse, parse_qs

import requests

try:
    from streamlink.plugins.twitch import TwitchM3U8Parser
except Exception:  # pragma: no cover
    TwitchM3U8Parser = None

URI_ATTR_RE = re.compile(r'URI="([^"]*)"')
CHUNK = 64 * 1024
DEFAULT_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
PASS_HEADERS = ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag")


class _AdState:
    """Per-playlist state that keeps output media/discontinuity sequence numbers stable across reloads."""

    def __init__(self):
        self.ads = set()        # upstream sequence numbers known to be ads
        self.out = {}           # upstream seq -> (out_seq, cc)
        self.last_kept = None   # upstream seq of the newest kept segment
        self.last_ad = None     # upstream seq of newest ad segment (for break detection)
        self.lock = threading.Lock()


class HLSProxy:
    def __init__(self, http_session=None, on_event=None):
        self.http = http_session or requests.Session()
        self.on_event = on_event
        self.profiles = {"0": {"User-Agent": DEFAULT_UA}}
        self.adstate = {}
        self._lock = threading.Lock()
        self.server = None
        self.port = None
        # observers (e.g. backend/features/clip.py): objects with
        #   on_playlist(url, text), wants(url) -> bool, on_segment(url, data)
        self.observers = []

    def _notify(self, meth, *args):
        for o in list(self.observers):
            try:
                getattr(o, meth)(*args)
            except Exception:
                pass

    def _wants(self, url):
        for o in list(self.observers):
            try:
                if o.wants(url):
                    return True
            except Exception:
                pass
        return False

    # ---------- lifecycle ----------
    def start(self):
        proxy = self

        class Handler(_Handler):
            owner = proxy

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, name="hls-proxy", daemon=True).start()
        return self

    def stop(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()

    # ---------- urls ----------
    def register_headers(self, headers):
        """Register a header profile for upstream requests, return its id."""
        if not headers:
            return "0"
        hid = uuid.uuid4().hex[:10]
        with self._lock:
            self.profiles[hid] = dict(headers)
        return hid

    def url_for(self, upstream, hid="0"):
        return "http://127.0.0.1:%d/p?u=%s&h=%s" % (self.port, quote(upstream, safe=""), hid)

    def _headers(self, hid):
        with self._lock:
            return dict(self.profiles.get(hid) or self.profiles["0"])

    # ---------- playlist rewriting ----------
    def rewrite_m3u8(self, text, base, hid):
        is_twitch = "ttvnw.net" in (urlparse(base).hostname or "") or "twitch" in base
        if is_twitch and "#EXTINF" in text and TwitchM3U8Parser is not None:
            try:
                text = self._strip_twitch_ads(text, base)
            except Exception:
                pass  # fall back to plain rewrite
        out = []
        for line in text.splitlines():
            s = line.strip()
            if not s:
                continue
            if s.startswith("#"):
                if 'URI="' in s:
                    s = URI_ATTR_RE.sub(lambda m: 'URI="%s"' % self.url_for(urljoin(base, m.group(1)), hid), s)
                out.append(s)
            else:
                out.append(self.url_for(urljoin(base, s), hid))
        return "\n".join(out) + "\n"

    def _strip_twitch_ads(self, text, base):
        parsed = TwitchM3U8Parser(base).parse(text)
        segs = [sg for sg in parsed.segments if not sg.prefetch]
        if not any(sg.ad for sg in segs) and not self.adstate.get(base):
            # fast path: no ads ever seen for this playlist; just drop prefetch hints
            return "\n".join(l for l in text.splitlines() if not l.startswith("#EXT-X-TWITCH-PREFETCH"))
        with self._lock:
            st = self.adstate.setdefault(base, _AdState())
        new_break = False
        with st.lock:
            # assign stable output numbers
            for sg in segs:
                n = sg.num
                if sg.ad:
                    if n not in st.ads:
                        if st.last_ad is None or n != st.last_ad + 1:
                            new_break = True
                        st.ads.add(n)
                        st.last_ad = max(n, st.last_ad or n)
                    continue
                if n in st.out:
                    continue
                prev = st.out.get(st.last_kept) if st.last_kept is not None else None
                if prev is None:
                    st.out[n] = (n - sum(1 for a in st.ads if a < n), 0)
                else:
                    gap = n != st.last_kept + 1  # ads (or unknown) in between
                    st.out[n] = (prev[0] + 1, prev[1] + (1 if (gap or sg.discontinuity) else 0))
                if st.last_kept is None or n > st.last_kept:
                    st.last_kept = n
            # prune old state
            if segs:
                lo = segs[0].num - 50
                st.ads = {a for a in st.ads if a >= lo}
                st.out = {k: v for k, v in st.out.items() if k >= lo or k == st.last_kept}
            kept = [sg for sg in segs if not sg.ad and sg.num in st.out]
            mapping = {sg.num: st.out[sg.num] for sg in kept}
        if new_break and self.on_event:
            try:
                self.on_event({"type": "toast", "level": "info", "text": "Ad break skipped"})
            except Exception:
                pass

        # Rebuild playlist from original lines, dropping ad segment blocks.
        lines = [l.strip() for l in text.splitlines() if l.strip()]
        header, body, block = [], [], []
        seg_i = 0
        seen_first_seg = False
        prev_kept_num = None
        for l in lines:
            if l.startswith("#EXT-X-TWITCH-PREFETCH"):
                continue
            if l.startswith("#EXT-X-MEDIA-SEQUENCE") or l.startswith("#EXT-X-DISCONTINUITY-SEQUENCE"):
                continue
            if l.startswith("#EXT-X-ENDLIST"):
                body.append(l)
                continue
            if not l.startswith("#"):
                sg = segs[seg_i] if seg_i < len(segs) else None
                seg_i += 1
                seen_first_seg = True
                if sg is None or sg.ad or sg.num not in mapping:
                    block = []
                    continue
                block = [b for b in block if b != "#EXT-X-DISCONTINUITY"]
                if prev_kept_num is not None and mapping[sg.num][1] != mapping[prev_kept_num][1]:
                    block.insert(0, "#EXT-X-DISCONTINUITY")
                body.extend(block)
                body.append(l)
                block = []
                prev_kept_num = sg.num
                continue
            is_seg_tag = l.startswith(("#EXTINF", "#EXT-X-PROGRAM-DATE-TIME", "#EXT-X-DISCONTINUITY",
                                       "#EXT-X-BYTERANGE", "#EXT-X-DATERANGE", "#EXT-X-KEY", "#EXT-X-MAP"))
            if not seen_first_seg and not l.startswith(("#EXTINF", "#EXT-X-PROGRAM-DATE-TIME",
                                                        "#EXT-X-DISCONTINUITY", "#EXT-X-BYTERANGE")):
                header.append(l)
            elif is_seg_tag or seen_first_seg:
                if l.startswith(("#EXTINF", "#EXT-X-PROGRAM-DATE-TIME", "#EXT-X-DISCONTINUITY", "#EXT-X-BYTERANGE")):
                    block.append(l)
                else:
                    body.append(l)
            else:
                block.append(l)
        if kept:
            first = mapping[kept[0].num]
            ms, dseq = first
        else:
            ms, dseq = 0, 0
            # whole window is ad: keep previous numbering going so hls.js just waits
            with st.lock:
                if st.last_kept is not None and st.last_kept in st.out:
                    ms, dseq = st.out[st.last_kept][0] + 1, st.out[st.last_kept][1]
        if header and header[0] == "#EXTM3U":
            header = [header[0], "#EXT-X-MEDIA-SEQUENCE:%d" % ms,
                      "#EXT-X-DISCONTINUITY-SEQUENCE:%d" % dseq] + header[1:]
        else:
            header = ["#EXTM3U", "#EXT-X-MEDIA-SEQUENCE:%d" % ms,
                      "#EXT-X-DISCONTINUITY-SEQUENCE:%d" % dseq] + [h for h in header if h != "#EXTM3U"]
        return "\n".join(header + body)


def _is_m3u8(url, ctype, head):
    c = (ctype or "").lower()
    return ("mpegurl" in c or urlparse(url).path.endswith(".m3u8")
            or head.lstrip().startswith(b"#EXTM3U"))


class _Handler(BaseHTTPRequestHandler):
    owner = None  # type: HLSProxy
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self._handle(head=True)

    def do_GET(self):
        self._handle(head=False)

    def _err(self, code, msg):
        body = msg.encode("utf-8", "replace")
        try:
            self.send_response(code)
            self._cors()
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception:
            pass

    def _handle(self, head):
        p = urlparse(self.path)
        if p.path != "/p":
            return self._err(404, "not found")
        q = parse_qs(p.query)
        upstream = (q.get("u") or [""])[0]
        hid = (q.get("h") or ["0"])[0]
        if not upstream.startswith(("http://", "https://")):
            return self._err(400, "bad url")
        owner = self.owner
        headers = owner._headers(hid)
        rng = self.headers.get("Range")
        if rng:
            headers["Range"] = rng
        try:
            # bypass streamlink's raise-on-error wrapper so upstream status codes pass through
            r = requests.Session.request(owner.http, "GET", upstream, headers=headers, stream=True,
                                         timeout=20, allow_redirects=True)
        except Exception as e:
            return self._err(502, "upstream error: %s" % e)
        try:
            ctype = r.headers.get("Content-Type", "")
            first = b""
            it = r.iter_content(CHUNK)
            if r.status_code < 400:
                for first in it:
                    if first:
                        break
            if r.status_code < 400 and _is_m3u8(r.url, ctype, first[:64]):
                raw = first + b"".join(it)
                text = raw.decode(r.encoding or "utf-8", "replace")
                if owner.observers:
                    owner._notify("on_playlist", r.url, text)
                body = owner.rewrite_m3u8(text, r.url, hid).encode("utf-8")
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                if not head:
                    self.wfile.write(body)
                return
            self.send_response(r.status_code)
            self._cors()
            for h in PASS_HEADERS:
                if h in r.headers and not (h == "Content-Length" and r.headers.get("Content-Encoding")):
                    self.send_header(h, r.headers[h])
            chunked = "Content-Length" not in r.headers or r.headers.get("Content-Encoding")
            if chunked:
                self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            if head:
                return
            keep = [] if (r.status_code == 200 and not rng and owner.observers and owner._wants(upstream)) else None

            def write(b):
                if not b:
                    return
                if keep is not None:
                    keep.append(b)
                if chunked:
                    self.wfile.write(b"%x\r\n" % len(b) + b + b"\r\n")
                else:
                    self.wfile.write(b)
            write(first)
            for b in it:
                write(b)
            if chunked:
                self.wfile.write(b"0\r\n\r\n")
            if keep is not None:
                owner._notify("on_segment", upstream, b"".join(keep))
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            self.close_connection = True
        finally:
            r.close()

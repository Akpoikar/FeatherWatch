"""Clip feature: save the last N seconds of what is being watched.

Hooks into HLSProxy via `proxy.observers`: every media playlist passing through
the proxy is parsed (segment url -> duration/sequence), and segment bodies the
player fetches are kept in a rolling per-stream memory buffer.
"""
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from collections import OrderedDict
from pathlib import Path
from urllib.parse import urljoin, urlparse, parse_qs

from backend.resolver import ResolveError

KEEP_SECONDS = 180          # per stream
MAX_STREAMS = 2
MAX_BYTES = 300 * 1024 * 1024
MAX_CLIP = 180
INF_RE = re.compile(r"#EXTINF:\s*([\d.]+)")
MAP_RE = re.compile(r'#EXT-X-MAP:.*URI="([^"]*)"')
SEQ_RE = re.compile(r"#EXT-X-MEDIA-SEQUENCE:\s*(\d+)")
URI_RE = re.compile(r'URI="([^"]*)"')


class _Seg(object):
    __slots__ = ("seq", "dur", "start", "data", "init", "t")

    def __init__(self, seq, dur, start, init):
        self.seq, self.dur, self.start, self.init = seq, dur, start, init
        self.data = None
        self.t = 0.0


class _Stream(object):
    def __init__(self, url):
        self.url = url
        self.item_id = None
        self.segs = {}          # seq -> _Seg (known from playlist)
        self.inits = {}         # init url -> bytes
        self.last_used = time.time()
        self.last_data = 0.0

    def held(self):
        return [s for s in self.segs.values() if s.data is not None]

    def nbytes(self):
        return sum(len(s.data) for s in self.held()) + sum(len(b) for b in self.inits.values() if b)


class ClipBuffer(object):
    def __init__(self):
        self.lock = threading.Lock()
        self.streams = OrderedDict()   # media playlist url -> _Stream
        self.urlmap = {}               # segment / init url -> (playlist url, seq or None)
        self.master_items = {}         # master/variant upstream url -> item_id
        self.current_item = None

    # ---------- proxy observer API ----------
    def on_playlist(self, url, text):
        if "#EXTINF" not in text:
            # master playlist: map variants to the item that requested the master
            item = self.master_items.get(url)
            if item:
                for line in text.splitlines():
                    s = line.strip()
                    if s and not s.startswith("#"):
                        self.master_items[urljoin(url, s)] = item
                    for u in URI_RE.findall(s):
                        self.master_items[urljoin(url, u)] = item
            return
        with self.lock:
            st = self.streams.get(url)
            if st is None:
                st = _Stream(url)
                self.streams[url] = st
            st.last_used = time.time()
            self.streams.move_to_end(url)
            st.item_id = self.master_items.get(url) or st.item_id
            m = SEQ_RE.search(text)
            seq = int(m.group(1)) if m else 0
            dur, init = None, None
            vod_start = 0.0
            for line in text.splitlines():
                s = line.strip()
                if not s:
                    continue
                if s.startswith("#EXTINF"):
                    mm = INF_RE.match(s)
                    dur = float(mm.group(1)) if mm else 0.0
                elif s.startswith("#EXT-X-MAP"):
                    mm = MAP_RE.match(s)
                    if mm:
                        init = urljoin(url, mm.group(1))
                        st.inits.setdefault(init, None)
                        self.urlmap[init] = (url, None)
                elif not s.startswith("#"):
                    if dur is not None:
                        seg = st.segs.get(seq)
                        if seg is None:
                            prev = st.segs.get(seq - 1)
                            start = prev.start + prev.dur if prev else vod_start
                            seg = st.segs[seq] = _Seg(seq, dur, start, init)
                        self.urlmap[urljoin(url, s)] = (url, seq)
                        vod_start = seg.start + seg.dur
                    seq += 1
                    dur = None
            self._prune(st)
            self._evict()

    def wants(self, url):
        return url in self.urlmap

    def on_segment(self, url, data):
        with self.lock:
            ref = self.urlmap.get(url)
            if not ref:
                return
            st = self.streams.get(ref[0])
            if st is None:
                return
            if ref[1] is None:
                st.inits[url] = data
                return
            seg = st.segs.get(ref[1])
            if seg is None:
                return
            seg.data = data
            seg.t = time.time()
            st.last_data = seg.t
            st.last_used = seg.t
            if st.item_id:
                self.current_item = st.item_id
            self._prune(st)
            self._evict()

    # ---------- memory management ----------
    def _prune(self, st):
        held = sorted(st.held(), key=lambda s: s.t)
        total = sum(s.dur for s in held)
        while held and total > KEEP_SECONDS:
            s = held.pop(0)
            total -= s.dur
            s.data = None
        # drop metadata for segments far outside the window
        if len(st.segs) > 2000:
            keep = sorted(st.segs)[-1500:]
            dropped = set(st.segs) - set(keep)
            for k in dropped:
                if st.segs[k].data is None:
                    del st.segs[k]
        if len(self.urlmap) > 20000:
            self.urlmap = {u: r for u, r in self.urlmap.items()
                           if r[0] in self.streams and (r[1] is None or r[1] in self.streams[r[0]].segs)}

    def _evict(self):
        # keep at most MAX_STREAMS streams that hold data, and a global byte cap
        live = [u for u, s in self.streams.items() if s.held()]
        live.sort(key=lambda u: self.streams[u].last_data)
        while len(live) > MAX_STREAMS:
            self._drop(live.pop(0))
        while live and sum(self.streams[u].nbytes() for u in live) > MAX_BYTES:
            st = self.streams[live[0]]
            held = sorted(st.held(), key=lambda s: s.t)
            if held:
                held[0].data = None
            if not st.held():
                self._drop(live.pop(0))
        if len(self.streams) > 12:
            for u in list(self.streams)[:-12]:
                if not self.streams[u].held():
                    self._drop(u)

    def _drop(self, url):
        st = self.streams.pop(url, None)
        if st:
            self.urlmap = {u: r for u, r in self.urlmap.items() if r[0] != url}

    # ---------- queries ----------
    def _pick(self, item_id):
        cands = [s for s in self.streams.values() if s.held()]
        if item_id:
            mine = [s for s in cands if s.item_id == item_id]
            if mine:
                cands = mine
        if not cands:
            return None
        return max(cands, key=lambda s: s.last_data)

    @staticmethod
    def _run(st):
        """Contiguous run of held segments ending at the most recently fetched one."""
        newest = max(st.held(), key=lambda s: s.t)
        run = [newest]
        n = newest.seq
        # extend forward (fetched earlier but later in timeline is unusual; include anyway)
        while st.segs.get(n + 1) is not None and st.segs[n + 1].data is not None:
            n += 1
            run.append(st.segs[n])
        n = newest.seq
        while st.segs.get(n - 1) is not None and st.segs[n - 1].data is not None:
            n -= 1
            run.insert(0, st.segs[n])
        run.sort(key=lambda s: s.seq)
        return run

    def available(self, item_id=None):
        with self.lock:
            st = self._pick(item_id)
            if not st:
                return 0.0
            return sum(s.dur for s in self._run(st))

    def collect(self, item_id, seconds, before_end):
        with self.lock:
            st = self._pick(item_id)
            if not st:
                return None
            run = self._run(st)
            end = run[-1].start + run[-1].dur - max(0.0, before_end)
            start = end - seconds
            sel = [s for s in run if s.start + s.dur > start + 0.01 and s.start < end - 0.01]
            if not sel:  # requested position fell out of memory; take the oldest part we have
                sel = [s for s in run if s.start < run[0].start + seconds]
            parts, last_init = [], None
            for s in sel:
                if s.init and s.init != last_init:
                    b = st.inits.get(s.init)
                    if b:
                        parts.append(b)
                    last_init = s.init
                parts.append(s.data)
            fmp4 = any(s.init for s in sel)
            return (st.item_id or item_id, b"".join(parts), sum(s.dur for s in sel), fmp4)


_BUF = ClipBuffer()


def _record_dir(api):
    d = ""
    try:
        d = api._store.settings().get("record_dir") or ""
    except Exception:
        pass
    if not d:
        d = str(Path.home() / ("Movies" if sys.platform == "darwin" else "Videos") / "FeatherWatch")
    p = Path(os.path.expanduser(d))
    p.mkdir(parents=True, exist_ok=True)
    return p


def _name(api, item_id):
    it = {}
    try:
        it = api._store.get_item(item_id) or {}
    except Exception:
        pass
    n = it.get("author") or (item_id or "").split(":", 1)[-1] or "stream"
    if it.get("kind") != "channel" and it.get("title"):
        n = it.get("author") or it.get("title")
    n = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", str(n)).strip(" .") or "stream"
    return n[:60]


def clip_status(api, item_id=None):
    return {"seconds": round(_BUF.available(item_id), 1)}


def clip_save(api, item_id=None, seconds=30, before_end=0):
    try:
        seconds = max(1.0, min(float(seconds or 30), MAX_CLIP))
        before_end = max(0.0, float(before_end or 0))
    except (TypeError, ValueError):
        raise ResolveError("Bad clip length")
    got = _BUF.collect(item_id, seconds, before_end)
    if not got or not got[1]:
        raise ResolveError("Nothing buffered yet – play the stream for a few seconds first")
    iid, data, dur, fmp4 = got
    d = _record_dir(api)
    base = "%s clip %s" % (_name(api, item_id or iid), time.strftime("%Y-%m-%d %H-%M-%S"))
    ext = ".mp4" if fmp4 else ".ts"
    path = d / (base + ext)
    with open(str(path), "wb") as f:
        f.write(data)
    ff = shutil.which("ffmpeg")
    if ff and not fmp4:
        mp4 = d / (base + ".mp4")
        try:
            kw = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "stdin": subprocess.DEVNULL, "timeout": 60}
            if sys.platform == "win32":
                kw["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
            r = subprocess.run([ff, "-y", "-loglevel", "error", "-i", str(path), "-c", "copy",
                                "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", str(mp4)], **kw)
            if r.returncode == 0 and mp4.exists() and mp4.stat().st_size > 1024:
                path.unlink()
                path = mp4
            elif mp4.exists():
                mp4.unlink()
        except Exception:
            pass
    return {"path": str(path), "seconds": round(dur, 1)}


def clip_reveal(api, path=None):
    p = Path(path) if path else _record_dir(api)
    if not p.exists():
        raise ResolveError("File not found")
    if sys.platform == "darwin":
        args = ["open", "-R", str(p)] if p.is_file() else ["open", str(p)]
    elif sys.platform == "win32":
        args = ["explorer", "/select," + str(p)] if p.is_file() else ["explorer", str(p)]
    else:
        args = ["xdg-open", str(p.parent if p.is_file() else p)]
    subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {}


def _track_play(api):
    """Wrap api.play so master playlist urls map back to item ids."""
    orig = getattr(api, "play", None)
    if orig is None or getattr(orig, "_clip_wrapped", False):
        return

    def play(item_id, quality=None):
        r = orig(item_id, quality)
        try:
            if isinstance(r, dict) and r.get("ok") and r.get("src"):
                u = (parse_qs(urlparse(r["src"]).query).get("u") or [""])[0]
                if u:
                    _BUF.master_items[u] = item_id
                    _BUF.current_item = item_id
        except Exception:
            pass
        return r
    play._clip_wrapped = True
    try:
        play.__name__ = "play"
        play.__doc__ = getattr(orig, "__doc__", None)
    except Exception:
        pass
    api.play = play


def setup(api):
    proxy = getattr(api, "_proxy", None)
    if proxy is not None and hasattr(proxy, "observers") and _BUF not in proxy.observers:
        proxy.observers.append(_BUF)
    _track_play(api)
    return {"clip_status": clip_status, "clip_save": clip_save, "clip_reveal": clip_reveal}


def shutdown(api):
    with _BUF.lock:
        _BUF.streams.clear()
        _BUF.urlmap.clear()

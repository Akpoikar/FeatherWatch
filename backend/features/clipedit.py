"""Clip editor: list saved clips, trim/convert them with ffmpeg.

Media is served to the webview by a tiny private HTTP server bound to
127.0.0.1 on a random port (own module, so the shared HLS proxy stays
untouched). It never takes a path from the URL: ce_* calls hand out random
tokens that map to files already validated to live inside record_dir (or our
thumbnail cache), so traversal is impossible by construction. Range requests
are supported so <video> can seek.
"""
import hashlib
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from backend.resolver import ResolveError

EXTS = (".mp4", ".ts", ".mkv", ".mov", ".gif", ".m4a", ".webm")
CACHE = Path.home() / ".lightweight" / "cache" / "clipedit"
_NOWIN = {"creationflags": 0x08000000} if sys.platform == "win32" else {}
_SAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')


def _ff(name="ffmpeg"):
    return shutil.which(name)


def _record_dir(api):
    from backend.features.clip import _record_dir as rd
    return rd(api).resolve()


def _check(api, path):
    """Resolve `path` and ensure it is an existing file directly/inside record_dir."""
    if not path or not isinstance(path, str):
        raise ResolveError("No file given")
    root = _record_dir(api)
    try:
        p = Path(os.path.expanduser(path)).resolve()
    except Exception:
        raise ResolveError("Bad path")
    if p == root or root not in p.parents:
        raise ResolveError("File is outside the recordings folder")
    if not p.is_file() or p.suffix.lower() not in EXTS:
        raise ResolveError("File not found")
    return p


def _run(args, timeout=60):
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          stdin=subprocess.DEVNULL, timeout=timeout, **_NOWIN)


# ---------------- media server ----------------
class _Server(object):
    def __init__(self):
        self.tokens = {}        # token -> (path str, mime)
        self.by_path = {}
        self.lock = threading.Lock()
        self.httpd = None
        self.port = 0

    def start(self):
        if self.httpd:
            return
        srv = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def do_GET(self):
                self._serve(True)

            def do_HEAD(self):
                self._serve(False)

            def _serve(self, body):
                q = parse_qs(urlparse(self.path).query)
                tok = (q.get("t") or [""])[0]
                with srv.lock:
                    ent = srv.tokens.get(tok)
                if urlparse(self.path).path != "/f" or not ent or not os.path.isfile(ent[0]):
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                path, mime = ent
                size = os.path.getsize(path)
                start, end, code = 0, size - 1, 200
                rng = self.headers.get("Range")
                m = re.match(r"bytes=(\d*)-(\d*)$", rng or "")
                if m and size:
                    if m.group(1):
                        start = int(m.group(1))
                        end = int(m.group(2)) if m.group(2) else size - 1
                    elif m.group(2):
                        start = max(0, size - int(m.group(2)))
                    end = min(end, size - 1)
                    if start > end:
                        self.send_response(416)
                        self.send_header("Content-Range", "bytes */%d" % size)
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    code = 206
                n = end - start + 1 if size else 0
                self.send_response(code)
                self.send_header("Content-Type", mime)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(n))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                if code == 206:
                    self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
                self.end_headers()
                if not body:
                    return
                try:
                    with open(path, "rb") as f:
                        f.seek(start)
                        while n > 0:
                            b = f.read(min(n, 256 * 1024))
                            if not b:
                                break
                            self.wfile.write(b)
                            n -= len(b)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def url(self, path):
        """Path must already be validated."""
        self.start()
        path = str(path)
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if path.endswith(".ts"):
            mime = "video/mp2t"
        with self.lock:
            tok = self.by_path.get(path)
            if not tok:
                tok = secrets.token_urlsafe(16)
                self.tokens[tok] = (path, mime)
                self.by_path[path] = tok
        return "http://127.0.0.1:%d/f?t=%s" % (self.port, tok)

    def forget(self, path):
        with self.lock:
            tok = self.by_path.pop(str(path), None)
            self.tokens.pop(tok, None)

    def stop(self):
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
            self.httpd = None


_SRV = _Server()


# ---------------- probing / thumbs ----------------
_META = {}


def _key(p):
    st = p.stat()
    return hashlib.sha1(("%s|%d|%d" % (p, st.st_size, int(st.st_mtime))).encode("utf-8")).hexdigest()[:20]


def _probe(p):
    k = _key(p)
    if k in _META:
        return _META[k]
    info = {"duration": None, "width": None, "height": None, "has_video": False, "has_audio": False}
    fp = _ff("ffprobe")
    try:
        if fp:
            r = _run([fp, "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height",
                      "-of", "json", str(p)], 20)
            j = json.loads(r.stdout.decode("utf-8", "replace") or "{}")
            d = (j.get("format") or {}).get("duration")
            info["duration"] = float(d) if d not in (None, "N/A") else None
            for s in j.get("streams") or []:
                if s.get("codec_type") == "video" and not info["has_video"]:
                    info.update(has_video=True, width=s.get("width"), height=s.get("height"))
                elif s.get("codec_type") == "audio":
                    info["has_audio"] = True
        elif _ff():
            r = _run([_ff(), "-hide_banner", "-i", str(p)], 20)
            e = r.stderr.decode("utf-8", "replace")
            m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", e)
            if m:
                info["duration"] = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
            info["has_video"] = " Video:" in e
            info["has_audio"] = " Audio:" in e
    except Exception:
        pass
    _META[k] = info
    return info


def _thumb(p, at=None):
    ff = _ff()
    if not ff:
        return None
    CACHE.mkdir(parents=True, exist_ok=True)
    out = CACHE / (_key(p) + ".jpg")
    if not out.exists():
        dur = _probe(p).get("duration") or 0
        t = at if at is not None else min(2.0, dur / 3.0) if dur else 0
        try:
            _run([ff, "-y", "-loglevel", "error", "-ss", "%.2f" % t, "-i", str(p), "-frames:v", "1",
                  "-vf", "scale=320:-2", "-q:v", "5", str(out)], 30)
        except Exception:
            pass
    return out if out.exists() and out.stat().st_size else None


# ---------------- api ----------------
def ce_info(api):
    return {"ffmpeg": bool(_ff()), "ffprobe": bool(_ff("ffprobe")), "record_dir": str(_record_dir(api))}


def ce_list(api, thumbs=True):
    root = _record_dir(api)
    items = []
    for p in root.iterdir():
        try:
            if not p.is_file() or p.suffix.lower() not in EXTS or " clip " not in p.name:
                continue
            st = p.stat()
            if time.time() - st.st_mtime < 2 and st.st_size < 1024:
                continue  # being written
            info = _probe(p)
            t = _thumb(p) if thumbs and info.get("has_video") else None
            items.append({"path": str(p), "name": p.name, "size": st.st_size, "mtime": int(st.st_mtime),
                          "duration": info.get("duration"), "has_video": info.get("has_video"),
                          "has_audio": info.get("has_audio"), "ext": p.suffix.lower()[1:],
                          "thumb": _SRV.url(t) if t else None})
        except Exception:
            continue
    items.sort(key=lambda i: i["mtime"], reverse=True)
    return {"items": items, "ffmpeg": bool(_ff()), "record_dir": str(root)}


def ce_open(api, path):
    p = _check(api, path)
    info = _probe(p)
    return {"path": str(p), "name": p.name, "url": _SRV.url(p), "ffmpeg": bool(_ff()),
            "size": p.stat().st_size, **info}


def ce_filmstrip(api, path, count=10):
    p = _check(api, path)
    ff = _ff()
    if not ff:
        raise ResolveError("ffmpeg not found")
    count = max(2, min(int(count or 10), 24))
    dur = _probe(p).get("duration") or 0
    if not dur or not _probe(p).get("has_video"):
        raise ResolveError("No video")
    CACHE.mkdir(parents=True, exist_ok=True)
    out = CACHE / ("%s_strip%d.jpg" % (_key(p), count))
    if not out.exists():
        r = _run([ff, "-y", "-loglevel", "error", "-i", str(p), "-vf",
                  "fps=%.5f,scale=-2:54,tile=%dx1" % (count / dur, count), "-frames:v", "1",
                  "-q:v", "6", str(out)], 90)
        if r.returncode != 0 or not out.exists():
            raise ResolveError("Filmstrip failed")
    return {"url": _SRV.url(out), "count": count}


_JOBS = {}
_JLOCK = threading.Lock()


def _unique(d, base, ext):
    out = d / (base + ext)
    i = 2
    while out.exists():
        out = d / ("%s (%d)%s" % (base, i, ext))
        i += 1
    return out


def _build(ff, src, out, start, dur, fmt, precise, has_audio):
    a = [ff, "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1"]
    pos = ["-ss", "%.3f" % start, "-i", str(src), "-t", "%.3f" % dur]
    if fmt == "gif":
        # input-side -t: output-side drops trailing frames with the palette filter graph
        pos = ["-ss", "%.3f" % start, "-t", "%.3f" % dur, "-i", str(src)]
        return a + pos + ["-vf", "fps=15,scale=480:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];"
                          "[b][p]paletteuse=dither=bayer:bayer_scale=4", "-an", "-loop", "0", str(out)]
    if fmt == "m4a":
        if not has_audio:
            raise ResolveError("This clip has no audio")
        codec = ["-c:a", "aac", "-b:a", "160k"] if precise else ["-c:a", "copy"]
        return a + pos + ["-vn", "-sn", "-dn"] + codec + ["-movflags", "+faststart", str(out)]
    if precise:
        codec = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
                 "-c:a", "aac", "-b:a", "160k"]
    else:
        codec = ["-c", "copy", "-avoid_negative_ts", "make_zero"]
    return a + pos + ["-map", "0:v?", "-map", "0:a?", "-sn", "-dn"] + codec + ["-movflags", "+faststart", str(out)]


def ce_export(api, path, start, end, opts=None):
    p = _check(api, path)
    ff = _ff()
    if not ff:
        raise ResolveError("ffmpeg is not installed (or not on PATH) – export is unavailable")
    opts = opts or {}
    fmt = opts.get("format") or "mp4"
    if fmt not in ("mp4", "gif", "m4a"):
        raise ResolveError("Unknown format")
    precise = bool(opts.get("precise"))
    info = _probe(p)
    try:
        start = max(0.0, float(start or 0))
        end = float(end) if end is not None else (info.get("duration") or 0)
    except (TypeError, ValueError):
        raise ResolveError("Bad start/end")
    if info.get("duration"):
        end = min(end, info["duration"])
    dur = end - start
    if dur < 0.1:
        raise ResolveError("Selection is too short")
    if fmt == "gif" and dur > 60:
        raise ResolveError("GIFs are limited to 60 seconds")
    title = _SAFE.sub("_", str(opts.get("title") or "")).strip(" .")[:120] or (p.stem + " edit")
    out = _unique(p.parent, title, "." + fmt)
    args = _build(ff, p, out, start, dur, fmt, precise, info.get("has_audio"))
    job = secrets.token_hex(6)
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            stdin=subprocess.DEVNULL, **_NOWIN)
    with _JLOCK:
        _JOBS[job] = {"proc": proc, "cancel": False}
    threading.Thread(target=_watch, args=(api, job, proc, out, dur), daemon=True).start()
    return {"job": job, "out": str(out)}


def _watch(api, job, proc, out, dur):
    err = []
    t = threading.Thread(target=lambda: err.append(proc.stderr.read()), daemon=True)
    t.start()
    last = 0.0
    for raw in proc.stdout:
        line = raw.decode("utf-8", "replace").strip()
        k, _, v = line.partition("=")
        if k in ("out_time_us", "out_time_ms") and v.isdigit():
            frac = min(1.0, int(v) / 1e6 / dur) if dur else 0
            now = time.time()
            if now - last > 0.15:
                last = now
                _emit(api, {"type": "ce_progress", "job": job, "state": "running", "progress": round(frac, 3)})
    proc.wait()
    t.join(2)
    with _JLOCK:
        j = _JOBS.pop(job, {})
    if j.get("cancel"):
        try:
            out.unlink()
        except OSError:
            pass
        _emit(api, {"type": "ce_progress", "job": job, "state": "cancelled"})
    elif proc.returncode == 0 and out.exists() and out.stat().st_size > 0:
        _emit(api, {"type": "ce_progress", "job": job, "state": "done", "progress": 1, "path": str(out),
                    "size": out.stat().st_size})
    else:
        msg = (b"".join(e or b"" for e in err)).decode("utf-8", "replace").strip().splitlines()
        try:
            if out.exists():
                out.unlink()
        except OSError:
            pass
        _emit(api, {"type": "ce_progress", "job": job, "state": "error",
                    "error": (msg[-1] if msg else "ffmpeg exited with %s" % proc.returncode)[:300]})


def _emit(api, ev):
    try:
        api._emit(ev)
    except Exception:
        pass


def ce_cancel(api, job):
    with _JLOCK:
        j = _JOBS.get(job)
        if not j:
            raise ResolveError("No such export")
        j["cancel"] = True
        proc = j["proc"]
    try:
        proc.terminate()
    except Exception:
        pass
    return {}


def ce_delete(api, path):
    p = _check(api, path)
    _SRV.forget(p)
    p.unlink()
    return {}


def setup(api):
    return {"ce_info": ce_info, "ce_list": ce_list, "ce_open": ce_open, "ce_filmstrip": ce_filmstrip,
            "ce_export": ce_export, "ce_cancel": ce_cancel, "ce_delete": ce_delete}


def shutdown(api):
    with _JLOCK:
        for j in _JOBS.values():
            j["cancel"] = True
            try:
                j["proc"].terminate()
            except Exception:
                pass
    _SRV.stop()

"""Record streams to disk in background threads (streamlink stream.open(), or plain HTTP for yt-dlp mp4/HLS)."""
import os
import re
import threading
import time
from pathlib import Path

CHUNK = 256 * 1024


def safe_name(s, maxlen=80):
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", s or "stream").strip(" ._")
    return (s or "stream")[:maxlen]


class Recording:
    def __init__(self, item_id, path):
        self.item_id = item_id
        self.path = path
        self.started = int(time.time())
        self.stop_event = threading.Event()
        self.thread = None
        self.error = None
        self.handle = None  # open stream fd / http response, closed by stop() to unblock read()

    @property
    def active(self):
        return bool(self.thread and self.thread.is_alive())

    def to_dict(self):
        return {"item_id": self.item_id, "path": self.path, "started": self.started,
                "active": self.active, "error": self.error}


class Recorder:
    def __init__(self, resolver, emit):
        self.resolver = resolver
        self.emit = emit
        self.recs = {}
        self.lock = threading.Lock()

    def start(self, item, quality, record_dir):
        with self.lock:
            cur = self.recs.get(item["id"])
            if cur and cur.active:
                return cur.path
        src_kind, stream = self.resolver.get_stream(item, quality)
        d = Path(os.path.expanduser(record_dir))
        d.mkdir(parents=True, exist_ok=True)
        ext = ".ts"
        if src_kind == "ytdlp" and stream["kind"] == "mp4":
            ext = ".mp4"
        base = "%s - %s" % (safe_name(item.get("author") or item.get("title")),
                            time.strftime("%Y-%m-%d %H-%M-%S"))
        path = str(d / (safe_name(base, 120) + ext))
        rec = Recording(item["id"], path)
        rec.thread = threading.Thread(target=self._run, args=(rec, src_kind, stream), daemon=True,
                                      name="rec-" + item["id"])
        with self.lock:
            self.recs[item["id"]] = rec
        rec.thread.start()
        self.emit({"type": "record", "item_id": item["id"], "state": "started", "path": path})
        return path

    def _run(self, rec, src_kind, stream):
        state = "stopped"
        try:
            with open(rec.path, "wb") as f:
                if src_kind == "streamlink":
                    fd = rec.handle = stream.open()
                    try:
                        while not rec.stop_event.is_set():
                            b = fd.read(CHUNK)
                            if not b:
                                break
                            f.write(b)
                    finally:
                        fd.close()
                elif stream["kind"] == "mp4":
                    r = self.resolver.session.http.get(stream["url"], headers=stream["headers"],
                                                       stream=True, timeout=30)
                    rec.handle = r
                    try:
                        for b in r.iter_content(CHUNK):
                            if rec.stop_event.is_set():
                                break
                            f.write(b)
                    finally:
                        r.close()
                else:
                    from streamlink.stream import HLSStream
                    hs = HLSStream(self.resolver.session, stream["url"], headers=stream["headers"])
                    fd = rec.handle = hs.open()
                    try:
                        while not rec.stop_event.is_set():
                            b = fd.read(CHUNK)
                            if not b:
                                break
                            f.write(b)
                    finally:
                        fd.close()
        except Exception as e:
            if not rec.stop_event.is_set():  # errors caused by stop() closing the handle are normal
                rec.error = str(e)
                state = "error"
        self.emit({"type": "record", "item_id": rec.item_id, "state": state, "path": rec.path})

    def stop(self, item_id):
        with self.lock:
            rec = self.recs.get(item_id)
        if not rec:
            return None
        rec.stop_event.set()
        h = rec.handle
        if h is not None:
            try:
                h.close()  # unblocks a read() stuck waiting for data (e.g. during a skipped ad break)
            except Exception:
                pass
        if rec.thread:
            rec.thread.join(timeout=5)
        return rec.path

    def list(self):
        with self.lock:
            return [r.to_dict() for r in sorted(self.recs.values(), key=lambda r: -r.started)]

    def stop_all(self):
        for k in list(self.recs):
            try:
                self.stop(k)
            except Exception:
                pass

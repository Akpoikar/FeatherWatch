"""Stats feature: watch-time tracking stored in ~/.featherwatch/stats.json.

Schema: {"version":1, "items":{id:{seconds,title,author,login,platform,kind,category,avatar,thumbnail,url,sessions,last}},
         "days":{"YYYY-MM-DD":{"total":s,"ch":{login:s},"cat":{cat:s},"pf":{platform:s},"hours":{"wd-h":s}}}}
"""
import csv
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from backend.resolver import ResolveError

STATS_FILE = Path.home() / ".featherwatch" / "stats.json"
MAX_CHUNK = 600  # a single flush can never add more than this


class StatsStore(object):
    def __init__(self, path=STATS_FILE):
        self.path = Path(path)
        self.lock = threading.RLock()
        self.data = {"version": 1, "items": {}, "days": {}}
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                d = json.load(f)
            if isinstance(d, dict):
                self.data["items"] = d.get("items") or {}
                self.data["days"] = d.get("days") or {}
        except Exception:
            pass

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(self.path.parent), prefix=".stats-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self.data, f, ensure_ascii=False, separators=(",", ":"))
            os.replace(tmp, str(self.path))
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def add(self, item_id, seconds, meta=None, now=None):
        try:
            seconds = float(seconds)
        except (TypeError, ValueError):
            raise ResolveError("bad seconds")
        if not item_id or seconds <= 0:
            return 0
        seconds = min(seconds, MAX_CHUNK)
        meta = meta if isinstance(meta, dict) else {}
        now = time.time() if now is None else now
        lt = time.localtime(now)
        day = time.strftime("%Y-%m-%d", lt)
        login = str(meta.get("login") or meta.get("author") or "").strip()
        key_ch = login.lower() or "unknown"
        cat = str(meta.get("category") or "").strip() or "Uncategorized"
        pf = str(meta.get("platform") or "other")
        with self.lock:
            it = self.data["items"].setdefault(str(item_id), {"seconds": 0, "sessions": 0})
            for k in ("title", "author", "platform", "kind", "category", "avatar", "thumbnail", "url"):
                if meta.get(k):
                    it[k] = meta[k]
            if login:
                it["login"] = login
            it["seconds"] = round(it.get("seconds", 0) + seconds, 1)
            if meta.get("new_session"):
                it["sessions"] = it.get("sessions", 0) + 1
            it["last"] = int(now)
            d = self.data["days"].setdefault(day, {"total": 0, "ch": {}, "cat": {}, "pf": {}, "hours": {}})
            d["total"] = round(d.get("total", 0) + seconds, 1)
            for bucket, k in (("ch", key_ch), ("cat", cat), ("pf", pf), ("hours", "%d-%d" % (lt.tm_wday, lt.tm_hour))):
                b = d.setdefault(bucket, {})
                b[k] = round(b.get(k, 0) + seconds, 1)
            names = self.data.setdefault("names", {})
            if login:
                names[key_ch] = {"name": meta.get("author") or login, "avatar": meta.get("avatar") or (names.get(key_ch) or {}).get("avatar")}
            self._save()
        return seconds

    def snapshot(self):
        with self.lock:
            return json.loads(json.dumps(self.data))

    def export_csv(self, out_dir):
        snap = self.snapshot()
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / ("featherwatch-stats-%s.csv" % time.strftime("%Y%m%d-%H%M%S"))
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["date", "type", "key", "seconds", "hours"])
            for day in sorted(snap["days"]):
                d = snap["days"][day]
                w.writerow([day, "total", "", d.get("total", 0), round(d.get("total", 0) / 3600.0, 3)])
                for bucket, label in (("ch", "channel"), ("cat", "category"), ("pf", "platform")):
                    for k, v in sorted((d.get(bucket) or {}).items(), key=lambda kv: -kv[1]):
                        w.writerow([day, label, k, v, round(v / 3600.0, 3)])
            w.writerow([])
            w.writerow(["item_id", "title", "author", "platform", "category", "seconds", "sessions", "last_watched"])
            for iid, it in sorted(snap["items"].items(), key=lambda kv: -kv[1].get("seconds", 0)):
                w.writerow([iid, it.get("title", ""), it.get("author", ""), it.get("platform", ""), it.get("category", ""),
                            it.get("seconds", 0), it.get("sessions", 0),
                            time.strftime("%Y-%m-%d %H:%M", time.localtime(it.get("last", 0)))])
        return str(path)


def _reveal(path):
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", "-R", path])
        elif sys.platform.startswith("win"):
            subprocess.Popen(["explorer", "/select,", path])
        else:
            subprocess.Popen(["xdg-open", os.path.dirname(path)])
    except Exception:
        pass


def _store(api):
    st = getattr(api, "_stats", None)
    if st is None:
        st = api._stats = StatsStore()
    return st


def stats_add(api, item_id, seconds, meta=None):
    return {"added": _store(api).add(item_id, seconds, meta)}


def stats_get(api):
    return {"stats": _store(api).snapshot()}


def stats_export(api, reveal=True):
    path = _store(api).export_csv(Path.home() / "Downloads")
    if reveal:
        _reveal(path)
    return {"path": path}


def setup(api):
    return {"stats_add": stats_add, "stats_get": stats_get, "stats_export": stats_export}

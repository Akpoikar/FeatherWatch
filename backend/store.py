"""Thread-safe JSON store at ~/.featherwatch/data.json with atomic writes."""
import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

DATA_DIR = Path.home() / ".featherwatch"
DATA_FILE = DATA_DIR / "data.json"
MAX_HISTORY = 200


def default_record_dir():
    base = "Movies" if sys.platform == "darwin" else "Videos"
    return str(Path.home() / base / "FeatherWatch")


DEFAULT_SETTINGS = {
    "player_path": "",
    "default_quality": "best",
    "record_dir": default_record_dir(),
    "live_poll_minutes": 3,
    "low_latency": True,
    "theme": "dark",
}


class Store:
    def __init__(self, path=DATA_FILE):
        self.path = Path(path)
        self.lock = threading.RLock()
        self.data = {"settings": dict(DEFAULT_SETTINGS), "history": [], "follows": [], "items": {}}
        self._load()

    def _load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                d = json.load(f)
            if isinstance(d, dict):
                for k in ("history", "follows"):
                    if isinstance(d.get(k), list):
                        self.data[k] = d[k]
                if isinstance(d.get("items"), dict):
                    self.data["items"] = d["items"]
                if isinstance(d.get("settings"), dict):
                    self.data["settings"].update(d["settings"])
        except FileNotFoundError:
            pass
        except Exception:
            # corrupt file: keep a backup, start fresh
            try:
                os.replace(str(self.path), str(self.path) + ".bad")
            except Exception:
                pass

    def save(self):
        with self.lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".data-", suffix=".json", dir=str(self.path.parent))
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(self.data, f, indent=1)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, str(self.path))
            except Exception:
                try:
                    os.unlink(tmp)
                except Exception:
                    pass
                raise

    # ---- items (cache of every resolved Item, keyed by id) ----
    def put_item(self, item):
        with self.lock:
            old = self.data["items"].get(item["id"], {})
            merged = dict(old)
            merged.update({k: v for k, v in item.items() if v is not None or k not in old})
            # keep user state from the old record
            for k in ("progress", "last_watched"):
                if old.get(k) and not item.get(k):
                    merged[k] = old[k]
            self.data["items"][item["id"]] = merged
            self.save()
            return dict(merged)

    def get_item(self, item_id):
        with self.lock:
            it = self.data["items"].get(item_id)
            return dict(it) if it else None

    def update_item(self, item_id, **fields):
        with self.lock:
            it = self.data["items"].get(item_id)
            if it is None:
                return None
            it.update(fields)
            self.save()
            return dict(it)

    # ---- history ----
    def touch_history(self, item_id):
        with self.lock:
            h = [i for i in self.data["history"] if i != item_id]
            h.insert(0, item_id)
            self.data["history"] = h[:MAX_HISTORY]
            if item_id in self.data["items"]:
                self.data["items"][item_id]["last_watched"] = int(time.time())
            self.save()

    def history(self):
        with self.lock:
            return [dict(self.data["items"][i]) for i in self.data["history"] if i in self.data["items"]]

    def remove_history(self, item_id):
        with self.lock:
            self.data["history"] = [i for i in self.data["history"] if i != item_id]
            self.save()

    def clear_history(self):
        with self.lock:
            self.data["history"] = []
            self.save()

    # ---- follows ----
    def follows(self):
        with self.lock:
            return [dict(self.data["items"][i]) for i in self.data["follows"] if i in self.data["items"]]

    def follow(self, item_id):
        with self.lock:
            if item_id not in self.data["follows"]:
                self.data["follows"].append(item_id)
                self.save()

    def unfollow(self, item_id):
        with self.lock:
            self.data["follows"] = [i for i in self.data["follows"] if i != item_id]
            self.save()

    # ---- settings ----
    def settings(self):
        with self.lock:
            return dict(self.data["settings"])

    def set_settings(self, d):
        with self.lock:
            s = self.data["settings"]
            for k, v in (d or {}).items():
                if k not in DEFAULT_SETTINGS:
                    continue
                if k == "live_poll_minutes":
                    try:
                        v = max(1, int(v))
                    except Exception:
                        continue
                elif k == "low_latency":
                    v = bool(v)
                elif v is None:
                    v = DEFAULT_SETTINGS[k]
                s[k] = v
            self.save()
            return dict(s)

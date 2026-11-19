"""Background live checker for followed channels (and recently watched channels)."""
import threading

from . import profile
from concurrent.futures import ThreadPoolExecutor


class LiveChecker:
    def __init__(self, store, resolver, emit, browser=None):
        self.browser = browser
        self.store = store
        self.resolver = resolver
        self.emit = emit
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._run_lock = threading.Lock()
        self.thread = None
        self.browser = None  # TwitchBrowser (official Helix API) when configured: batch live status + viewers

    def start(self):
        self.thread = threading.Thread(target=self._loop, name="live-checker", daemon=True)
        self.thread.start()

    def stop(self):
        self._stop.set()
        self._wake.set()

    def _targets(self):
        seen, out = set(), []
        for it in self.store.follows() + self.store.history()[:30]:
            if it.get("kind") == "channel" and it["id"] not in seen:
                seen.add(it["id"])
                out.append(it)
        return out

    def _helix_status(self, targets):
        """{item_id: fields} for every twitch channel target via Helix /streams (100 logins per call).
        Returns None when Helix isn't configured or fails, so the streamlink path is used instead."""
        b = self.browser
        if not b or not b.configured():
            return None
        logins = [t["id"].split(":", 1)[1] for t in targets
                  if t.get("platform") == "twitch" and t["id"].startswith("twitch:")]
        out = {"twitch:" + l: {"is_live": False, "viewers": None} for l in logins}
        try:
            for i in range(0, len(logins), 100):
                d = b._get("/streams", [("user_login", l) for l in logins[i:i + 100]] + [("first", 100)])
                for st in d.get("data", []):
                    login = (st.get("user_login") or "").lower()
                    thumb = (st.get("thumbnail_url") or "").replace("{width}", "440").replace("{height}", "248")
                    out["twitch:" + login] = {
                        "is_live": True, "viewers": st.get("viewer_count"),
                        "category": st.get("game_name") or None, "stream_title": st.get("title"),
                        "started_at": st.get("started_at"), "thumbnail": thumb or None,
                    }
        except Exception:
            return None
        return out

    def check_now(self):
        """Check all targets; returns list of updated follow Items."""
        with self._run_lock:
            targets = self._targets()
            helix = self._helix_status(targets)

            def one(it):
                if helix is not None and it["id"] in helix:
                    fields = dict(helix[it["id"]])
                else:
                    try:
                        fields = self.resolver.check_live(it)
                    except Exception:
                        fields = {"is_live": False} if it.get("platform") == "twitch" else {}
                if profile.is_stale(it):
                    try:
                        fields.update(profile.fetch(self.resolver.session.http, it))
                    except Exception:
                        pass
                if fields:
                    self.store.update_item(it["id"], **fields)

            if targets:
                with ThreadPoolExecutor(max_workers=6) as ex:
                    list(ex.map(one, targets))
                self._add_viewers(targets)
            items = self.store.follows()
            items.sort(key=lambda i: (not i.get("is_live"), (i.get("title") or "").lower()))
            self.emit({"type": "live", "items": items})
            return items

    def _add_viewers(self, targets):
        b = self.browser
        if not b or not b.configured():
            return
        tw = {it["id"].split(":", 1)[1].lower(): it["id"] for it in targets if it.get("platform") == "twitch"}
        try:
            live = b.live_by_login(list(tw))
        except Exception:
            return
        for login, item_id in tw.items():
            info = live.get(login)
            self.store.update_item(item_id, viewers=info["viewers"] if info else None)

    def _loop(self):
        self._wake.wait(3)  # let the UI come up first
        while not self._stop.is_set():
            try:
                self.check_now()
            except Exception:
                pass
            mins = self.store.settings().get("live_poll_minutes") or 3
            self._wake.clear()
            self._wake.wait(max(1, int(mins)) * 60)

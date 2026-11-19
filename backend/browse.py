"""Browse Twitch top games / live streams via the official Helix API (app access token).

Credentials come from env vars TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET, which may be
set in a `.env` file next to app.py or in ~/.lightweight/.env (real env vars win).
"""
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HELIX = "https://api.twitch.tv/helix"
TOKEN_URL = "https://id.twitch.tv/oauth2/token"
PAGE_SIZE = 40


class BrowseError(Exception):
    pass


def load_dotenv(*paths):
    """Minimal .env loader: KEY=VALUE lines, # comments, optional quotes. Never overrides real env."""
    for p in paths:
        try:
            lines = Path(p).read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            if k.startswith("export "):
                k = k[7:].strip()
            v = v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            os.environ.setdefault(k, v)


def _size(url, w, h):
    return (url or "").replace("{width}", str(w)).replace("{height}", str(h)) or None


class TwitchBrowser:
    def __init__(self, http):
        self.http = http  # requests.Session
        self._token = None
        self._token_exp = 0
        self._lock = threading.Lock()

    @property
    def client_id(self):
        return os.environ.get("TWITCH_CLIENT_ID", "").strip()

    @property
    def client_secret(self):
        return os.environ.get("TWITCH_CLIENT_SECRET", "").strip()

    def configured(self):
        return bool(self.client_id and self.client_secret)

    def _get_token(self, force=False):
        with self._lock:
            if not force and self._token and time.time() < self._token_exp - 60:
                return self._token
            if not self.configured():
                raise BrowseError("Twitch API credentials missing (set TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET in .env)")
            r = self.http.post(TOKEN_URL, data={
                "client_id": self.client_id, "client_secret": self.client_secret,
                "grant_type": "client_credentials"}, timeout=15)
            if r.status_code != 200:
                raise BrowseError("Twitch auth failed (%d) – check your client ID / secret" % r.status_code)
            d = r.json()
            self._token = d["access_token"]
            self._token_exp = time.time() + int(d.get("expires_in", 3600))
            return self._token

    def _get(self, path, params):
        for attempt in (0, 1):
            tok = self._get_token(force=attempt == 1)
            r = self.http.get(HELIX + path, params=params, timeout=15, headers={
                "Client-Id": self.client_id, "Authorization": "Bearer " + tok})
            if r.status_code == 401 and attempt == 0:
                continue  # token expired/revoked → refresh once
            if r.status_code != 200:
                raise BrowseError("Twitch API error %d" % r.status_code)
            return r.json()

    def top_games(self, cursor=None, first=PAGE_SIZE):
        params = {"first": first}
        if cursor:
            params["after"] = cursor
        d = self._get("/games/top", params)
        items = [{"id": g["id"], "name": g["name"], "box_art": _size(g.get("box_art_url"), 285, 380)}
                 for g in d.get("data", [])]
        self._add_viewers(items)
        return items, (d.get("pagination") or {}).get("cursor")

    def _add_viewers(self, games):
        """Approximate viewers per game = sum of its top 100 live streams (Helix has no direct field)."""
        def one(g):
            try:
                d = self._get("/streams", {"game_id": g["id"], "first": 100})
                g["viewers"] = sum(s.get("viewer_count", 0) for s in d.get("data", []))
            except Exception:
                g["viewers"] = None
        with ThreadPoolExecutor(max_workers=10) as ex:
            list(ex.map(one, games))

    def streams(self, game_id=None, cursor=None, first=PAGE_SIZE):
        params = {"first": first}
        if game_id:
            params["game_id"] = game_id
        if cursor:
            params["after"] = cursor
        d = self._get("/streams", params)
        items = []
        for s in d.get("data", []):
            login = s["user_login"]
            items.append({
                "id": "twitch:" + login, "platform": "twitch", "kind": "channel",
                "url": "https://www.twitch.tv/" + login,
                "title": s.get("title") or login, "author": s.get("user_name") or login,
                "category": s.get("game_name") or "",
                "thumbnail": _size(s.get("thumbnail_url"), 440, 248),
                "is_live": True, "viewers": s.get("viewer_count", 0),
                "language": s.get("language"),
            })
        return items, (d.get("pagination") or {}).get("cursor")

    def live_by_login(self, logins):
        """{login: {"viewers", "title", "category", "started_at"}} for logins that are live (batched by 100)."""
        logins = [l.lower() for l in logins if l]
        out = {}
        for i in range(0, len(logins), 100):
            d = self._get("/streams", [("user_login", l) for l in logins[i:i + 100]] + [("first", 100)])
            for s in d.get("data", []):
                out[s["user_login"].lower()] = {"viewers": s.get("viewer_count", 0), "title": s.get("title"),
                                                "category": s.get("game_name"), "started_at": s.get("started_at")}
        return out

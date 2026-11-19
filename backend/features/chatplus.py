"""chatplus: live-chat extras (mention highlight, per-user mute list).

Stored as top-level settings keys `chat_mention_name` (str) and `chat_muted` ([logins]).

VOD chat replay is intentionally NOT implemented: the only remaining source of
Twitch VOD comments is GQL `VideoCommentsByOffsetOrCursor` with Twitch's private
web client id (v5 /comments is gone, Helix has no endpoint, yt-dlp dropped rechat),
which CONTRACT.md forbids.
"""
import re

_LOGIN = re.compile(r"^[a-z0-9_]{1,25}$")


def _get(api):
    with api._store.lock:
        s = api._store.data["settings"]
        name = str(s.get("chat_mention_name") or "")
        muted = [m for m in (s.get("chat_muted") or []) if isinstance(m, str)]
    return {"mention_name": name, "muted": muted}


def cp_get(api):
    return _get(api)


def cp_set_mention(api, name):
    name = str(name or "").strip().lstrip("@")[:40]
    with api._store.lock:
        api._store.data["settings"]["chat_mention_name"] = name
        api._store.save()
    return _get(api)


def cp_mute(api, login, muted=True):
    login = str(login or "").strip().lower().lstrip("@")
    if not _LOGIN.match(login):
        from backend.resolver import ResolveError
        raise ResolveError("Invalid username")
    with api._store.lock:
        s = api._store.data["settings"]
        cur = [m for m in (s.get("chat_muted") or []) if isinstance(m, str) and m != login]
        if muted:
            cur.append(login)
        s["chat_muted"] = cur[-500:]
        api._store.save()
    return _get(api)


def setup(api):
    return {"cp_get": cp_get, "cp_set_mention": cp_set_mention, "cp_mute": cp_mute}

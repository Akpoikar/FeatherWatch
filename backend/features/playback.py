"""Playback tuning: quality cap / battery saver, persisted under settings["playback"]."""

QUALITY_CAPS = ("off", "720p", "480p", "lowest")
DEFAULTS = {"quality_cap": "off", "battery_saver": False, "show_latency": True}


def _clean(d):
    p = dict(DEFAULTS)
    for k, v in (d or {}).items():
        if k not in DEFAULTS:
            continue
        if k == "quality_cap":
            v = v if v in QUALITY_CAPS else "off"
        else:
            v = bool(v)
        p[k] = v
    return p


def pb_get(api):
    with api._store.lock:
        cur = api._store.data["settings"].get("playback")
    return {"playback": _clean(cur if isinstance(cur, dict) else {})}


def pb_set(api, d):
    with api._store.lock:
        cur = api._store.data["settings"].get("playback")
        merged = dict(cur) if isinstance(cur, dict) else {}
        merged.update(d if isinstance(d, dict) else {})
        p = _clean(merged)
        api._store.data["settings"]["playback"] = p
        api._store.save()
    return {"playback": p}


def setup(api):
    return {"pb_get": pb_get, "pb_set": pb_set}

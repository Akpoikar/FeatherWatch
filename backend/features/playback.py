"""Playback tuning: quality cap / battery saver / rewind window, persisted under settings["playback"]."""

QUALITY_CAPS = ("off", "720p", "480p", "lowest")
# Seconds of already-watched video kept in memory so you can rewind. 0 = keep everything (uses lots of RAM on long streams).
REWIND_WINDOWS = (30, 120, 300, 600, 1800, 3600, 0)
DEFAULTS = {"quality_cap": "off", "battery_saver": False, "show_latency": True, "rewind_window": 1800}


def _clean(d):
    p = dict(DEFAULTS)
    for k, v in (d or {}).items():
        if k not in DEFAULTS:
            continue
        if k == "quality_cap":
            v = v if v in QUALITY_CAPS else "off"
        elif k == "rewind_window":
            try:
                v = int(v)
            except (TypeError, ValueError):
                v = DEFAULTS[k]
            v = v if v in REWIND_WINDOWS else DEFAULTS[k]
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

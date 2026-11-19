"""Theme / appearance feature: persists UI appearance under settings["appearance"]."""

DEFAULTS = {
    "preset": "midnight",
    "accent": "",
    "compact": False,
    "side_width": 240,
    "card": "medium",
    "font_scale": 100,
    "radius": 10,
    "reduce_motion": False,
    "hide_offline": False,
}


def _clean(d):
    p = dict(DEFAULTS)
    for k, v in (d or {}).items():
        if k not in DEFAULTS:
            continue
        try:
            if k in ("compact", "reduce_motion", "hide_offline"):
                v = bool(v)
            elif k == "side_width":
                v = max(180, min(360, int(v)))
            elif k == "font_scale":
                v = max(90, min(120, int(v)))
            elif k == "radius":
                v = max(0, min(20, int(v)))
            elif k == "card":
                v = v if v in ("small", "medium", "large") else "medium"
            else:
                v = str(v)[:40]
        except Exception:
            continue
        p[k] = v
    return p


def theme_get(api):
    with api._store.lock:
        cur = api._store.data["settings"].get("appearance")
    return {"appearance": _clean(cur if isinstance(cur, dict) else {})}


def theme_set(api, d):
    p = _clean(d if isinstance(d, dict) else {})
    with api._store.lock:
        api._store.data["settings"]["appearance"] = p
        api._store.save()
    return {"appearance": p}


def setup(api):
    return {"theme_get": theme_get, "theme_set": theme_set}

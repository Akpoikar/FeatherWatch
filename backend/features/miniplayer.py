"""Mini player: shrink the main window into a small always-on-top video window."""
from backend.resolver import ResolveError

MINI_W, MINI_H = 400, 225
MARGIN = 24
_saved = {}


def _win(api):
    w = getattr(api, "_window", None)
    if w is None:
        raise ResolveError("Window not available")
    return w


def _primary_screen():
    try:
        import webview
        scr = webview.screens
        if scr:
            s = scr[0]
            return (int(getattr(s, "x", 0) or 0), int(getattr(s, "y", 0) or 0),
                    int(s.width), int(s.height))
    except Exception:
        pass
    return None


def mini_enter(api, width=MINI_W, height=MINI_H):
    w = _win(api)
    if not _saved:
        _saved.update({
            "width": getattr(w, "width", None), "height": getattr(w, "height", None),
            "x": getattr(w, "x", None), "y": getattr(w, "y", None),
            "on_top": bool(getattr(w, "on_top", False)),
        })
    width, height = int(width), int(height)
    w.resize(width, height)
    scr = _primary_screen()
    if scr:
        sx, sy, sw, sh = scr
        try:
            w.move(sx + sw - width - MARGIN, sy + sh - height - MARGIN - 40)
        except Exception:
            pass
    try:
        w.on_top = True
    except Exception:
        pass
    return {"mini": True}


def mini_exit(api):
    w = _win(api)
    s = dict(_saved)
    _saved.clear()
    try:
        w.on_top = s.get("on_top", False)
    except Exception:
        pass
    if s.get("width") and s.get("height"):
        w.resize(int(s["width"]), int(s["height"]))
    if s.get("x") is not None and s.get("y") is not None:
        try:
            w.move(int(s["x"]), int(s["y"]))
        except Exception:
            pass
    return {"mini": False}


def setup(api):
    return {"mini_enter": mini_enter, "mini_exit": mini_exit}


def shutdown(api):
    _saved.clear()

"""Early startup hook for the updater feature (FeatherWatch).

Lives next to app.py (NOT inside the `backend` package) because backend/__init__.py
imports yt_dlp immediately; the overlay must be on sys.path before that happens.

Overlay layout (frozen builds only, written by backend/features/updater.py):
    ~/.featherwatch/pylibs/<python-tag>/<pkg>/          one dir per package, put on sys.path
    ~/.featherwatch/pylibs/<python-tag>/overlay.json    {"pkg": {"version": ..., "bundled": ...}}
If importing an overlay package raises, that package's overlay is removed and the
bundled copy is used instead (rollback). Stdlib only.
"""
import json
import os
import shutil
import sys
from pathlib import Path

PACKAGES = ("yt_dlp", "streamlink")  # import order matters (see backend/__init__.py)
DIST = {"yt_dlp": "yt-dlp", "streamlink": "streamlink"}
STATUS = {"applied": {}, "rolled_back": {}, "dir": None}


def py_tag():
    return "cp%d%d" % sys.version_info[:2]


def overlay_dir(base=None):
    base = Path(base) if base else Path.home() / ".featherwatch" / "pylibs"
    return base / py_tag()


def _vt(v):
    out = []
    for p in str(v).replace("-", ".").split("."):
        n = "".join(c for c in p if c.isdigit())
        out.append(int(n) if n else 0)
    return tuple(out)


def _bundled_version(dist):
    try:
        from importlib import metadata
        return metadata.version(dist)
    except Exception:
        return None


def _purge(mod):
    for k in list(sys.modules):
        if k == mod or k.startswith(mod + "."):
            sys.modules.pop(k, None)


def apply_overlay(base=None, force=False):
    """Prepend overlay package dirs to sys.path. Only active in frozen builds unless force=True."""
    if not (getattr(sys, "frozen", False) or force or os.environ.get("FEATHERWATCH_OVERLAY")):
        return STATUS
    try:
        d = overlay_dir(base)
        STATUS["dir"] = str(d)
        meta_f = d / "overlay.json"
        if not meta_f.is_file():
            return STATUS
        meta = json.loads(meta_f.read_text())
        changed = False
        for mod in PACKAGES:
            info = meta.get(mod)
            pdir = d / mod
            if not info or not (pdir / mod / "__init__.py").is_file():
                continue
            bundled = _bundled_version(DIST[mod])
            if bundled and _vt(bundled) >= _vt(info.get("version", "0")):
                # app was upgraded past the overlay: drop the stale overlay
                shutil.rmtree(pdir, ignore_errors=True)
                meta.pop(mod, None)
                changed = True
                continue
            sys.path.insert(0, str(pdir))
            try:
                __import__(mod)
                STATUS["applied"][mod] = info.get("version")
            except Exception as e:  # rollback to bundled
                _purge(mod)
                try:
                    sys.path.remove(str(pdir))
                except ValueError:
                    pass
                shutil.rmtree(pdir, ignore_errors=True)
                meta.pop(mod, None)
                changed = True
                STATUS["rolled_back"][mod] = "%s: %s" % (type(e).__name__, e)
        if changed:
            meta_f.write_text(json.dumps(meta, indent=1))
    except Exception as e:  # never block startup
        STATUS["error"] = str(e)
    return STATUS

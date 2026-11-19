"""Updater feature: keeps streamlink and yt-dlp current.

Source mode (venv):  `python -m pip install -U streamlink yt-dlp` into the running interpreter.
Frozen mode (PyInstaller): download the pure-python wheel from PyPI, verify sha256, unpack
into ~/.featherwatch/pylibs/<tag>/<pkg>/ ; updater_boot.apply_overlay() puts it on sys.path
at next start (with automatic rollback on import failure).
Settings live in settings["updater"]. All failures are non-fatal.
"""
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

from backend.resolver import ResolveError

PKGS = {"streamlink": "streamlink", "yt-dlp": "yt_dlp"}  # dist name -> import name
PYPI = "https://pypi.org/pypi/%s/json"
TIMEOUT = 20
DAY = 86400
DEFAULTS = {"auto": True, "last_check": 0}

_lock = threading.Lock()
_state = {"busy": False, "latest": {}, "msg": "", "installed": {}, "error": ""}
_stop = threading.Event()
OVERLAY_BASE = None  # tests may override (Path); None -> ~/.featherwatch/pylibs


def is_frozen():
    return bool(getattr(sys, "frozen", False))


def _boot():
    try:
        import updater_boot
        return updater_boot
    except Exception:
        return None


def overlay_dir():
    ub = _boot()
    if ub:
        return ub.overlay_dir(OVERLAY_BASE)
    base = Path(OVERLAY_BASE) if OVERLAY_BASE else Path.home() / ".featherwatch" / "pylibs"
    return base / ("cp%d%d" % sys.version_info[:2])


# ---------- versions ----------
def vtuple(v):
    """Rough PEP 440 release tuple (enough for these packages' version schemes)."""
    m = re.match(r"\s*v?(\d+(?:\.\d+)*)", str(v))
    if not m:
        return (0,)
    t = [int(x) for x in m.group(1).split(".")]
    while len(t) > 1 and t[-1] == 0:
        t.pop()
    return tuple(t)


def current_versions():
    out = {"python": "%d.%d.%d" % sys.version_info[:3]}
    try:
        import streamlink
        out["streamlink"] = streamlink.__version__
    except Exception:
        out["streamlink"] = None
    try:
        from yt_dlp.version import __version__ as yv
        out["yt-dlp"] = yv
    except Exception:
        out["yt-dlp"] = None
    return out


def _dist_version(dist):
    """Installed version of a dependency (None if unknown, e.g. metadata not bundled)."""
    try:
        from importlib import metadata
        return metadata.version(dist)
    except Exception:
        pass
    try:
        mod = __import__(dist.lower().replace("-", "_"))
        return getattr(mod, "__version__", None)
    except Exception:
        return None


def _get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "FeatherWatch-updater", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def pypi_info(dist):
    d = _get_json(PYPI % dist)
    return {"version": d["info"]["version"], "requires_dist": d["info"].get("requires_dist") or [],
            "requires_python": d["info"].get("requires_python") or "", "urls": d.get("urls") or []}


# ---------- minimal requirement checks (frozen mode has no `packaging`) ----------
def _spec_ok(have, spec):
    hv = vtuple(have)
    for part in [p.strip() for p in spec.split(",") if p.strip()]:
        m = re.match(r"(===|==|!=|>=|<=|~=|>|<)\s*(.+)", part)
        if not m:
            continue
        op, v = m.group(1), m.group(2).strip()
        if v.endswith(".*"):
            pre = vtuple(v[:-2])
            match = (hv + (0,) * len(pre))[:len(pre)] == pre
            if (op == "==" and not match) or (op == "!=" and match):
                return False
            continue
        tv = vtuple(v)
        ok = {"==": hv == tv, "===": hv == tv, "!=": hv != tv, ">=": hv >= tv, "<=": hv <= tv,
              ">": hv > tv, "<": hv < tv, "~=": hv >= tv and hv[:max(1, len(tv) - 1)] == tv[:max(1, len(tv) - 1)]}[op]
        if not ok:
            return False
    return True


def _marker_applies(marker):
    if not marker:
        return True
    if "extra" in marker:
        return False  # optional extras are not needed
    try:
        from packaging.markers import Marker
        return Marker(marker).evaluate()
    except Exception:
        pass
    # tiny fallback: python_version comparisons only, joined by "and"
    pyv = "%d.%d" % sys.version_info[:2]
    for cond in marker.split(" and "):
        m = re.match(r'\s*python_version\s*(==|!=|>=|<=|>|<)\s*["\']([^"\']+)["\']\s*$', cond)
        if m and not _spec_ok(pyv, m.group(1) + m.group(2)):
            return False
    return True


def unmet_deps(requires_dist, requires_python=""):
    """List of human-readable unmet requirements for the *running* environment."""
    bad = []
    pyv = "%d.%d.%d" % sys.version_info[:3]
    if requires_python and not _spec_ok(pyv, requires_python):
        bad.append("Python %s (have %s)" % (requires_python, pyv))
    for req in requires_dist:
        body, _, marker = req.partition(";")
        if not _marker_applies(marker.strip()):
            continue
        m = re.match(r"\s*([A-Za-z0-9_.\-]+)\s*(\[[^\]]*\])?\s*\(?([^)]*)\)?", body)
        if not m:
            continue
        name, spec = m.group(1), m.group(3).strip()
        have = _dist_version(name)
        if have is None:
            # unknown in a frozen bundle (no metadata) -> only fail if the module itself is missing
            try:
                __import__(name.lower().replace("-", "_"))
                continue
            except Exception:
                bad.append("%s %s (missing)" % (name, spec))
                continue
        if spec and not _spec_ok(have, spec):
            bad.append("%s %s (have %s)" % (name, spec, have))
    return bad


# ---------- settings ----------
def _cfg(api):
    with api._store.lock:
        c = api._store.data["settings"].get("updater")
    out = dict(DEFAULTS)
    if isinstance(c, dict):
        out.update({k: c[k] for k in DEFAULTS if k in c})
    return out


def _save_cfg(api, **kw):
    with api._store.lock:
        c = api._store.data["settings"].get("updater")
        c = dict(c) if isinstance(c, dict) else dict(DEFAULTS)
        c.update(kw)
        api._store.data["settings"]["updater"] = c
        api._store.save()
    return c


def _emit(api, **ev):
    ev["type"] = "upd_status"
    try:
        api._emit(ev)
    except Exception:
        pass


# ---------- check ----------
def check(api=None):
    cur = current_versions()
    pend = _state["installed"]
    latest, errors = {}, []
    for dist in PKGS:
        try:
            latest[dist] = pypi_info(dist)["version"]
        except Exception as e:
            errors.append("%s: %s" % (dist, e))
    _state["latest"] = latest
    updates = [d for d in PKGS if latest.get(d) and cur.get(d) and vtuple(latest[d]) > vtuple(cur[d])
               and not (pend.get(d) and vtuple(pend[d]) >= vtuple(latest[d]))]
    if api is not None:
        _save_cfg(api, last_check=time.time())
    return {"current": cur, "latest": latest, "updates": updates, "errors": errors}


# ---------- install: source mode ----------
def pip_cmd(dists, dry_run=False):
    cmd = [sys.executable, "-m", "pip", "install", "-U", "--disable-pip-version-check", "--no-input"]
    if dry_run:
        cmd.append("--dry-run")
    dists = list(dists)
    if "yt-dlp" in dists and "yt-dlp-ejs" not in dists:
        dists.append("yt-dlp-ejs")  # yt-dlp's YouTube challenge-solver scripts; versioned alongside yt-dlp
    return cmd + dists


def install_source(dists, dry_run=False):
    r = subprocess.run(pip_cmd(dists, dry_run), capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        raise ResolveError("pip failed: " + (r.stderr or r.stdout).strip()[-400:])
    return r.stdout


# ---------- install: frozen mode (overlay) ----------
def pick_wheel(urls):
    for u in urls:
        if u.get("packagetype") == "bdist_wheel" and u.get("filename", "").endswith("-py3-none-any.whl"):
            return u
    return None


def install_overlay(dist, info=None):
    """Download + verify + unpack the pure-python wheel of `dist`. Returns installed version."""
    mod = PKGS[dist]
    info = info or pypi_info(dist)
    bad = unmet_deps(info["requires_dist"], info["requires_python"])
    if bad:
        raise ResolveError("%s %s needs newer bundled dependencies (%s) - update the app instead"
                           % (dist, info["version"], "; ".join(bad)))
    w = pick_wheel(info["urls"])
    if not w:
        raise ResolveError("%s %s has no pure-python wheel" % (dist, info["version"]))
    want = (w.get("digests") or {}).get("sha256")
    if not want:
        raise ResolveError("no sha256 published for " + w["filename"])
    req = urllib.request.Request(w["url"], headers={"User-Agent": "FeatherWatch-updater"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    if hashlib.sha256(data).hexdigest() != want:
        raise ResolveError("sha256 mismatch for " + w["filename"])
    root = overlay_dir()
    root.mkdir(parents=True, exist_ok=True)
    tmp = root / (mod + ".new")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for n in z.namelist():  # zip-slip guard
            p = (tmp / n).resolve()
            if not str(p).startswith(str(tmp.resolve()) + os.sep):
                raise ResolveError("unsafe path in wheel: " + n)
        z.extractall(tmp)
    if not (tmp / mod / "__init__.py").is_file():
        shutil.rmtree(tmp, ignore_errors=True)
        raise ResolveError("wheel does not contain package " + mod)
    final = root / mod
    shutil.rmtree(final, ignore_errors=True)
    tmp.rename(final)
    mf = root / "overlay.json"
    try:
        meta = json.loads(mf.read_text())
    except Exception:
        meta = {}
    meta[mod] = {"version": info["version"], "dist": dist, "installed": time.time(),
                 "bundled": current_versions().get(dist)}
    mf.write_text(json.dumps(meta, indent=1))
    return info["version"]


def install(api, dists=None):
    dists = [d for d in (dists or list(PKGS)) if d in PKGS]
    done, errors = {}, []
    if is_frozen():
        for d in dists:
            try:
                done[d] = install_overlay(d)
            except Exception as e:
                errors.append("%s: %s" % (d, e))
    else:
        try:
            install_source(dists)
            for d in dists:
                v = _venv_version(d)
                if v:
                    done[d] = v
        except Exception as e:
            errors.append(str(e))
    _state["installed"].update(done)
    return {"installed": done, "errors": errors}


def _venv_version(dist):
    """Version now on disk (fresh subprocess: in-process modules are still the old ones)."""
    try:
        r = subprocess.run([sys.executable, "-c", "import importlib.metadata as m,sys;print(m.version(sys.argv[1]))", dist],
                           capture_output=True, text=True, timeout=30)
        return r.stdout.strip() or None
    except Exception:
        return None


def _run(api, do_install, force=False):
    if not _lock.acquire(blocking=False):
        raise ResolveError("An update check is already running")
    try:
        _state.update(busy=True, error="")
        _emit(api, busy=True)
        res = check(api)
        res["installed"] = {}
        if do_install and res["updates"]:
            r = install(api, res["updates"])
            res["installed"] = r["installed"]
            res["errors"] += r["errors"]
            res["updates"] = [d for d in res["updates"] if d not in r["installed"]]
        return res
    finally:
        _state["busy"] = False
        _lock.release()


def _status(api):
    ub = _boot()
    st = getattr(ub, "STATUS", {}) if ub else {}
    return {"current": current_versions(), "latest": _state["latest"], "pending": dict(_state["installed"]),
            "busy": _state["busy"], "frozen": is_frozen(), "settings": _cfg(api),
            "overlay": {"applied": st.get("applied", {}), "rolled_back": st.get("rolled_back", {}),
                        "dir": str(overlay_dir())}}


# ---------- API ----------
def upd_status(api):
    return _status(api)


def upd_check(api):
    res = _run(api, do_install=False)
    out = _status(api)
    out.update(updates=res["updates"], errors=res["errors"])
    return out


def upd_install(api):
    res = _run(api, do_install=True)
    out = _status(api)
    out.update(updates=res["updates"], errors=res["errors"], installed=res["installed"])
    return out


def upd_set(api, d):
    d = d if isinstance(d, dict) else {}
    kw = {}
    if "auto" in d:
        kw["auto"] = bool(d["auto"])
    return {"settings": _save_cfg(api, **kw) if kw else _cfg(api)}


def upd_rollback(api):
    """Remove the frozen-mode overlay (takes effect on restart)."""
    shutil.rmtree(overlay_dir(), ignore_errors=True)
    _state["installed"].clear()
    return {"removed": True}


def upd_restart(api):
    if is_frozen():
        exe = sys.executable
        cmd = [exe] + sys.argv[1:]
        # macOS .app: relaunch the bundle so it gets a proper Dock icon
        app = exe.split(".app/Contents/MacOS/")[0] + ".app" if ".app/Contents/MacOS/" in exe else None
        if app and sys.platform == "darwin" and shutil.which("open"):
            cmd = ["open", "-n", app] + (["--args"] + sys.argv[1:] if sys.argv[1:] else [])
    else:
        cmd = [sys.executable] + sys.argv
    kw = {"close_fds": True, "cwd": os.getcwd()}
    if os.name == "nt":
        kw["creationflags"] = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        kw["start_new_session"] = True
    subprocess.Popen(cmd, **kw)

    def _close():
        time.sleep(0.4)
        w = getattr(api, "_window", None)
        try:
            if w is not None:
                w.destroy()
            else:
                os._exit(0)
        except Exception:
            os._exit(0)
    threading.Thread(target=_close, daemon=True).start()
    return {"restarting": True}


def _background(api):
    if _stop.wait(20):
        return
    try:
        cfg = _cfg(api)
        if time.time() - float(cfg.get("last_check") or 0) < DAY:
            return
        res = _run(api, do_install=bool(cfg.get("auto")))
        _emit(api, busy=False, auto=True, updates=res["updates"], installed=res["installed"], errors=res["errors"],
              latest=_state["latest"])
    except Exception as e:
        _emit(api, busy=False, auto=True, errors=[str(e)])


def setup(api):
    threading.Thread(target=_background, args=(api,), daemon=True, name="upd-bg").start()
    return {"upd_status": upd_status, "upd_check": upd_check, "upd_install": upd_install,
            "upd_set": upd_set, "upd_rollback": upd_rollback, "upd_restart": upd_restart}


def shutdown(api):
    _stop.set()

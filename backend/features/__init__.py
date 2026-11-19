"""Feature plug-ins. Each module defines `setup(api)` returning {name: function}.

Every returned function is attached to the Api object (so JS can call
window.pywebview.api.<name>(...)) and wrapped with api_method ({ok:..} / errors).
Functions get the Api instance as their first argument: def my_call(api, x): ...
Optional `shutdown(api)` is called when the window closes.
"""
import importlib
import traceback

FEATURES = ["chat", "multiview", "clip", "channel"]


def load(api, wrap):
    mods = []
    for name in FEATURES:
        try:
            mod = importlib.import_module("backend.features." + name)
        except ModuleNotFoundError as e:
            if e.name == "backend.features." + name:
                continue  # feature not written yet
            traceback.print_exc()
            continue
        except Exception:
            traceback.print_exc()
            continue
        try:
            for fname, fn in (mod.setup(api) or {}).items():
                setattr(api, fname, wrap(_bind(fn, api)))
            mods.append(mod)
        except Exception:
            traceback.print_exc()
    return mods


def _bind(fn, api):
    import functools

    @functools.wraps(fn)
    def bound(*a, **kw):
        return fn(api, *a, **kw)
    return bound


def shutdown(api, mods):
    for m in mods:
        if hasattr(m, "shutdown"):
            try:
                m.shutdown(api)
            except Exception:
                pass

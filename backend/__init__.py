"""FeatherWatch backend: resolver, HLS proxy, store, recorder, live checker."""

import os as _os
import sys as _sys

# Apps launched from Finder/Dock don't get the shell PATH, so Homebrew tools (deno for yt-dlp's
# YouTube challenge solver, ffmpeg for clips) would be invisible. Add the standard locations.
if _sys.platform == "darwin":
    _path = _os.environ.get("PATH", "").split(_os.pathsep)
    for _d in ("/opt/homebrew/bin", "/usr/local/bin"):
        if _d not in _path and _os.path.isdir(_d):
            _path.append(_d)
    _os.environ["PATH"] = _os.pathsep.join(p for p in _path if p)

# Import order matters: streamlink and yt-dlp both patch urllib3.util.url._PERCENT_RE.
# If streamlink patches first, yt-dlp's wrapper breaks streamlink's requests
# ("'Urllib3UtilUrlPercentReOverride' object has no attribute 'sub'"). yt-dlp first is fine.
try:
    import yt_dlp  # noqa: F401
except ImportError:
    pass

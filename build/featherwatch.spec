# PyInstaller spec for FeatherWatch (onedir). Run from repo root:
#   pyinstaller --noconfirm --clean --distpath dist --workpath .pyi-build build/featherwatch.spec
import os, sys
from PyInstaller.utils.hooks import collect_all, collect_submodules

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
ICONS = os.path.join(ROOT, "build", "icons")
sys.path.insert(0, ROOT)  # so collect_submodules can import backend
IS_MAC = sys.platform == "darwin"
IS_WIN = sys.platform.startswith("win")

datas = [(os.path.join(ROOT, "ui"), "ui")]
if os.path.exists(os.path.join(ROOT, ".env.example")):
    datas.append((os.path.join(ROOT, ".env.example"), "."))  # never .env
binaries = []
# backend.features.* are imported via importlib -> list them explicitly.
hiddenimports = collect_submodules("backend")
assert any(m.startswith("backend.features.") for m in hiddenimports), "backend.features not found"
if os.path.exists(os.path.join(ROOT, "updater_boot.py")):
    hiddenimports.append("updater_boot")
for pkg in ("streamlink", "yt_dlp", "yt_dlp_ejs"):
    d, b, h = collect_all(pkg)
    datas += d; binaries += b; hiddenimports += h

if IS_MAC:
    hiddenimports += ["webview.platforms.cocoa"]
elif IS_WIN:
    hiddenimports += ["webview.platforms.edgechromium", "webview.platforms.winforms",
                      "clr", "clr_loader", "pythonnet"]
    for pkg in ("pythonnet", "clr_loader"):
        try:
            d, b, h = collect_all(pkg)
            datas += d; binaries += b; hiddenimports += h
        except Exception:
            pass

a = Analysis([os.path.join(ROOT, "app.py")], pathex=[ROOT], binaries=binaries,
             datas=datas, hiddenimports=hiddenimports, excludes=["tkinter"], noarchive=False)
pyz = PYZ(a.pure)
icon = os.path.join(ICONS, "FeatherWatch.icns" if IS_MAC else "FeatherWatch.ico")
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="FeatherWatch",
          console=False, upx=False, icon=icon if (IS_MAC or IS_WIN) else None)
coll = COLLECT(exe, a.binaries, a.datas, upx=False, name="FeatherWatch")

if IS_MAC:
    app = BUNDLE(coll, name="FeatherWatch.app", icon=icon,
                 bundle_identifier="com.featherwatch.app",
                 info_plist={
                     "CFBundleName": "FeatherWatch",
                     "CFBundleDisplayName": "FeatherWatch",
                     "CFBundleShortVersionString": os.environ.get("FW_VERSION", "1.0.0"),
                     "CFBundleVersion": os.environ.get("FW_VERSION", "1.0.0"),
                     "NSHighResolutionCapable": True,
                     "LSMinimumSystemVersion": "11.0",
                     "NSAppTransportSecurity": {"NSAllowsArbitraryLoads": True},
                 })

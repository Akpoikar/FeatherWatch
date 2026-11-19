# Lightweight

**A tiny desktop app for watching Twitch, YouTube, Kick, and anything else [streamlink](https://streamlink.github.io/) supports.**
Runs on Windows and macOS (Linux works too).

Lightweight uses the webview your OS already has (WebView2 on Windows, WKWebView on macOS) through [pywebview](https://pywebview.flowrl.com/). It doesn't bundle Electron or Chromium, so the app is a few MB and doesn't need hundreds of MB of RAM just to start.

---

## Features

- **Sidebar**: watch history plus followed channels, with live/offline status that refreshes automatically
- **Open any link**: paste or drag in a channel name, Twitch channel/VOD/clip, YouTube video/live/@channel, Kick, and more. A bare name is treated as a Twitch channel.
- **Custom player** (hls.js through a local HLS proxy)
  - DVR seek and a **Go live** button
  - Quality and playback-speed selection
  - Theatre mode and Picture-in-Picture
- **Twitch chat**: read-only, shown next to the player
- **Record to disk**: saves to `~/Videos/Lightweight` (`~/Movies/Lightweight` on macOS)
- **Open in VLC / mpv**: hands the (ad-filtered) stream to an external player
- **VOD resume**: continues from where you stopped
- **Command palette** and keyboard shortcuts

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` / `K` | Play / pause |
| `←` / `→` | Seek back / forward 10 s |
| `J` / `L` | Seek back / forward 10 s |
| `F` | Fullscreen |
| `M` | Mute |
| `T` | Theatre mode |
| `C` | Toggle chat |
| `?` | Show shortcuts |
| `Ctrl/Cmd + K` | Command palette |
| `Ctrl/Cmd + V` | Paste a link and play it |

## Supported sites

Twitch (live, VODs, clips), YouTube (live and VOD, using yt-dlp as a fallback), Kick, and [every site streamlink has a plugin for](https://streamlink.github.io/plugins.html).

## Requirements

- **Python 3.9+**
- **Windows**: the [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/). It comes preinstalled on Windows 10 and 11.
- **macOS**: nothing extra
- **Optional**: [VLC](https://www.videolan.org/) or [mpv](https://mpv.io/) for the "Open in VLC" button

## Install & run

**Windows (PowerShell)**
```powershell
git clone <repo-url> Lightweight; cd Lightweight
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```
> If PowerShell refuses to run the activate script, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` first.

**macOS (zsh)**
```zsh
git clone <repo-url> Lightweight && cd Lightweight
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

## Building a standalone app

The build scripts create `.venv` if it doesn't exist, install `requirements-dev.txt`, and run PyInstaller. The finished app goes to `dist/`.

```zsh
./build/build.sh            # macOS / Linux → dist/Lightweight.app (macOS)
```
```powershell
.\build\build.ps1           # Windows → dist\Lightweight\Lightweight.exe
```

PyInstaller's temporary files go to `.pyi-build/`, which is git-ignored.

## Where your data lives

History, follows, VOD positions and settings are all stored in one JSON file:

```
~/.lightweight/data.json        (Windows: %USERPROFILE%\.lightweight\data.json)
```

To reset the app, delete that file.

## Troubleshooting

| Problem | Fix |
|---|---|
| **Ads on Twitch** | Ad segments are removed using streamlink's own Twitch ad detection (same as streamlink → VLC). During an ad break you may see a short pause instead of the ad. |
| **"No playable streams" / nothing plays** | The channel is probably offline. Follow it and the sidebar will show when it goes live. |
| **macOS: "app can't be opened" (Gatekeeper)** | The build isn't signed. Right-click the app → **Open**, or run `xattr -dr com.apple.quarantine dist/Lightweight.app`. |
| **macOS: `NotOpenSSLWarning` / LibreSSL warning** | Apple's system Python is linked against LibreSSL. Install Python from [python.org](https://www.python.org/downloads/) or Homebrew (`brew install python`) and create the venv again. |
| **Windows: blank window** | Install or repair the WebView2 runtime. |
| **"Open in VLC" does nothing** | Install VLC, or set `player_path` in settings to your VLC/mpv executable. |

## Project structure

```
Lightweight/
├── app.py               # entry point: pywebview window + JS API
├── backend/
│   ├── resolver.py      # streamlink / yt-dlp URL resolution
│   ├── proxy.py         # local HLS proxy (127.0.0.1, rewrites m3u8)
│   ├── store.py         # ~/.lightweight/data.json
│   ├── recorder.py      # record streams to disk
│   └── live.py          # background live-status checker
├── ui/
│   ├── index.html, style.css, app.js
│   └── vendor/hls.min.js
├── build/
│   ├── build.sh         # macOS / Linux build
│   └── build.ps1        # Windows build
├── requirements.txt
└── requirements-dev.txt # + PyInstaller
```

## Ideas / roadmap

Features that streamlink and yt-dlp would make possible:

- **Multi-stream view**: watch 2–4 streams in a grid
- **Clip export**: save the last N seconds of the DVR buffer to a file
- **Go-live notifications** for followed channels (native OS notifications)
- **Audio-only mode** for podcasts and music streams, using little bandwidth
- **Schedule recording**: start recording automatically when a follow goes live
- **YouTube / Twitch search** via yt-dlp
- **Subtitles / captions** for YouTube VODs
- **Chapters and VOD timestamps** shown on the seek bar
- **Import follows** from a list or OPML
- **Low-latency tuning** and buffer controls per site
- **Download VODs** in the background with yt-dlp
- **Tray icon / mini player** that stays on top

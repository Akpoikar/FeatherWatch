#!/usr/bin/env python3
"""Import Twitch follows from text copied off twitch.tv's "Following" page (or one name per line).

Usage:  python tools/import_follows.py follows.txt      (or pipe the text on stdin)
Handles lines like "Gosu", "死神丶 (shinigxmii)" and skips "Live", "Offline", viewer counts, game names.
Live status fills in on the app's next live check (or press refresh).
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.store import Store  # noqa: E402

LOGIN = re.compile(r"^[A-Za-z0-9_]{3,25}$")
PAREN = re.compile(r"\(([A-Za-z0-9_]{3,25})\)\s*$")
NOISE = {"live", "offline"}


def parse(text):
    lines = [l.strip() for l in text.splitlines()]
    names = []
    for i, line in enumerate(lines):
        if not line:
            continue
        m = PAREN.search(line)
        login = m.group(1) if m else (line if LOGIN.match(line) else None)
        if not login or login.lower() in NOISE:
            continue
        # a channel name is followed (after blanks) by a game name/"Offline"; a game name is followed by "Live"
        nxt = next((l for l in lines[i + 1:] if l), "")
        if nxt.lower() == "live":
            continue  # this line was a one-word game title
        names.append((login.lower(), line))
    seen, out = set(), []
    for login, display in names:
        if login not in seen:
            seen.add(login)
            out.append((login, display))
    return out


def main():
    text = Path(sys.argv[1]).read_text(encoding="utf-8") if len(sys.argv) > 1 else sys.stdin.read()
    store = Store()
    added = 0
    for login, display in parse(text):
        item_id = "twitch:" + login
        if not store.get_item(item_id):
            store.put_item({
                "id": item_id, "platform": "twitch", "kind": "channel",
                "url": "https://www.twitch.tv/" + login, "title": display, "author": display,
                "category": None, "thumbnail": None, "is_live": None,
                "last_watched": None, "progress": 0, "duration": None,
            })
        store.follow(item_id)
        added += 1
    print(f"Imported {added} follows")


if __name__ == "__main__":
    main()

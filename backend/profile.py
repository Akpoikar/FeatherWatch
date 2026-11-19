"""Channel profile (avatar + bio) from the public channel page's OpenGraph tags.

No private APIs: this reads the same <meta property="og:*"> tags any link preview uses.
On Twitch, og:description is the bio while offline and the stream title while live,
so the bio is only updated from offline pages.
"""
import html
import re
import time

TTL = 24 * 3600
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def _meta(page, key):
    for pat in (r'<meta[^>]+(?:property|name)="%s"[^>]*content="([^"]*)"',
                r'<meta[^>]+content="([^"]*)"[^>]*(?:property|name)="%s"'):
        m = re.search(pat % re.escape(key), page)
        if m:
            return html.unescape(m.group(1)).strip()
    return None


def channel_url(item):
    """Page that describes the channel behind an item, or None."""
    if item.get("platform") == "twitch" and item.get("kind") == "channel":
        return "https://www.twitch.tv/" + item["id"].split(":", 1)[1]
    if item.get("kind") == "channel" and item.get("url"):
        return item["url"]
    return None


def is_stale(item):
    return not item.get("profile_ts") or time.time() - item["profile_ts"] > TTL


def fetch(http, item):
    """Return fields to merge into the item: avatar, bio (when known), profile_ts."""
    url = channel_url(item)
    if not url:
        return {}
    r = http.get(url, headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.8"}, timeout=15)
    r.encoding = "utf-8"
    page = r.text
    out = {}
    img = _meta(page, "og:image")
    if img and ("profile_image" in img or item.get("platform") != "twitch"):
        out["avatar"] = img.replace("-300x300.", "-150x150.")
        out["profile_ts"] = int(time.time())  # only cache once we got a real page; otherwise retry next time
    title = _meta(page, "og:title") or ""
    desc = _meta(page, "og:description")
    live_page = title.endswith("Live on Twitch")
    if desc and not live_page:
        # Twitch appends a generic sentence when there is no custom bio
        generic = re.sub(r"\s*\S+ streams live on Twitch!.*$", "", desc).strip(" -–—")
        out["bio"] = generic
    return out

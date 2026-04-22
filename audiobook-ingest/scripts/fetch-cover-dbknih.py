#!/usr/bin/env python3
"""Scrape cover image from databazeknih.cz for a given book.

Usage: fetch-cover-dbknih.py --title "Název" --author "Autor" --out cover.jpg

Workflow:
1. Search databazeknih.cz with title + author.
2. Pick first book result (/prehled-knihy/...).
3. Fetch detail page, extract og:image URL.
4. Download image to --out.

Exit codes:
  0 - cover downloaded
  1 - no search results
  2 - search result has no cover (og:image missing)
  3 - download failed
"""
import argparse
import re
import sys
import unicodedata
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
BASE = "https://www.databazeknih.cz"

SEARCH_URL = BASE + "/search?q={q}"
BOOK_LINK_RE = re.compile(r'href="(/prehled-knihy/[^"]+)"')
OG_IMAGE_RE = re.compile(r'og:image"?\s*content="([^"]+)"')

# Penalize results with these markers — usually spin-offs, not the main novel
SPINOFF_MARKERS = ["komiks", "manga", "gift", "illustrated", "deluxe", "box",
                   "ilustrovane", "ilustrovana", "audiokniha"]


def slugify(text: str) -> str:
    """Normalize text to a databazeknih-style slug (ASCII, lowercase, hyphens)."""
    nfkd = unicodedata.normalize("NFKD", text)
    ascii_text = "".join(c for c in nfkd if not unicodedata.combining(c))
    ascii_text = ascii_text.lower()
    ascii_text = re.sub(r"[^a-z0-9]+", "-", ascii_text)
    return ascii_text.strip("-")


def score_candidate(href: str, title_slug: str) -> int:
    """Lower is better. Prefer matches that contain title as a prefix, penalize spin-offs."""
    # Strip /prehled-knihy/ prefix and trailing -<id>
    m = re.match(r"/prehled-knihy/(.+)-(\d+)$", href)
    if not m:
        return 1_000_000
    slug = m.group(1)
    score = 0
    if not slug.startswith(title_slug + "-") and slug != title_slug:
        score += 1000  # doesn't start with title — weaker match
    for marker in SPINOFF_MARKERS:
        if marker in slug:
            score += 500
    # Shorter = more likely the main title
    score += len(slug)
    return score


def http_get(url: str, referer: str = None) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/jpeg,*/*;q=0.8",
            "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
        },
    )
    if referer:
        req.add_header("Referer", referer)
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read()


def search_book(title: str, author: str) -> str | None:
    query = f"{title} {author}".strip()
    # Use quote_plus (spaces → +); databazeknih.cz ranks differently with %20 vs +.
    url = SEARCH_URL.format(q=urllib.parse.quote_plus(query))
    html = http_get(url).decode("utf-8", errors="replace")
    matches = BOOK_LINK_RE.findall(html)
    if not matches:
        return None
    # Deduplicate while preserving order, pick best candidate by slug score
    seen = set()
    uniq = []
    for m in matches:
        if m not in seen:
            seen.add(m)
            uniq.append(m)
    title_slug = slugify(title)
    best = min(uniq, key=lambda h: score_candidate(h, title_slug))
    return BASE + best


def get_cover_url(book_url: str) -> str | None:
    html = http_get(book_url).decode("utf-8", errors="replace")
    m = OG_IMAGE_RE.search(html)
    if not m:
        return None
    return m.group(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--title", required=True)
    ap.add_argument("--author", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    book_url = search_book(args.title, args.author)
    if not book_url:
        print(f"No search results for: {args.title} / {args.author}", file=sys.stderr)
        sys.exit(1)
    print(f"book page: {book_url}", file=sys.stderr)

    cover_url = get_cover_url(book_url)
    if not cover_url:
        print(f"No og:image on {book_url}", file=sys.stderr)
        sys.exit(2)
    print(f"cover url: {cover_url}", file=sys.stderr)

    try:
        data = http_get(cover_url, referer=book_url)
    except Exception as e:
        print(f"Download failed: {e}", file=sys.stderr)
        sys.exit(3)

    with open(args.out, "wb") as f:
        f.write(data)
    print(f"Saved → {args.out} ({len(data)} bytes)")


if __name__ == "__main__":
    main()

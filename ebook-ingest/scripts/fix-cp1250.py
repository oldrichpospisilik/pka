#!/usr/bin/env python3
"""Fix EPUB texts where cp1250 bytes were misdecoded as latin1.

Usage: fix-cp1250.py <kniha.epub>

Rewrites HTML files inside the EPUB in-place, replacing garbled chars
(ø, è, ì, ù, ð, ï, ò …) with correct Czech diacritics (ř, č, ě, ů, ď, ï, ň).

Preserves EPUB structure (mimetype file must be stored, not deflated).
"""
import os
import re
import sys
import shutil
import tempfile
import zipfile

# Most common latin1→cp1250 remapping for Czech text
REPLACEMENTS = {
    "ø": "ř", "Ø": "Ř",
    "è": "č", "È": "Č",
    "ì": "ě", "Ì": "Ě",
    "ù": "ů", "Ù": "Ů",
    "ð": "đ", "Ð": "Đ",
    "š": "š", "Š": "Š",  # usually correct already
    "ò": "ň", "Ò": "Ň",
    "å": "ĺ", "Å": "Ĺ",
    "ê": "ę", "Ê": "Ę",
    "¨": "¨",
    "¾": "ž", "®": "Ž",
    "»": "ť", "«": "Ť",
    "µ": "µ",
    "ñ": "ń", "Ñ": "Ń",
    "ý": "ý", "Ý": "Ý",  # usually correct
    "ó": "ó", "Ó": "Ó",  # usually correct
    "á": "á", "Á": "Á",  # usually correct
    "í": "í", "Í": "Í",  # usually correct
    "é": "é", "É": "É",  # usually correct
    "ú": "ú", "Ú": "Ú",  # usually correct
}

# Only apply if these garbled chars appear in Czech words (near other Czech letters)
TRIGGER_CHARS = set("øèìùðòê¾®»")

HTML_EXTS = (".html", ".xhtml", ".htm")


def should_fix(content: str) -> bool:
    """Count garbled chars to decide whether to apply fix."""
    count = sum(content.count(c) for c in TRIGGER_CHARS)
    return count > 20


def fix_content(content: str) -> tuple[str, int]:
    replaced = 0
    for bad, good in REPLACEMENTS.items():
        if bad == good:
            continue
        n = content.count(bad)
        if n > 0:
            content = content.replace(bad, good)
            replaced += n
    return content, replaced


def process_epub(epub_path: str) -> int:
    """Returns total number of character replacements made."""
    if not epub_path.lower().endswith(".epub"):
        print(f"Not an EPUB: {epub_path}", file=sys.stderr)
        return -1

    with tempfile.TemporaryDirectory() as tmp:
        extract_dir = os.path.join(tmp, "unzip")
        os.makedirs(extract_dir)
        with zipfile.ZipFile(epub_path) as zf:
            zf.extractall(extract_dir)

        total_replaced = 0
        any_fix = False
        for root, _, files in os.walk(extract_dir):
            for f in files:
                if not f.lower().endswith(HTML_EXTS):
                    continue
                path = os.path.join(root, f)
                with open(path, "r", encoding="utf-8", errors="replace") as fh:
                    content = fh.read()
                if not should_fix(content):
                    continue
                new_content, n = fix_content(content)
                if n > 0:
                    with open(path, "w", encoding="utf-8") as fh:
                        fh.write(new_content)
                    total_replaced += n
                    any_fix = True

        if not any_fix:
            return 0

        # Repack — mimetype stored, rest deflated
        new_epub = epub_path + ".tmp"
        with zipfile.ZipFile(new_epub, "w") as zout:
            mimetype_path = os.path.join(extract_dir, "mimetype")
            if os.path.exists(mimetype_path):
                zout.write(mimetype_path, "mimetype", zipfile.ZIP_STORED)
            for root, _, files in os.walk(extract_dir):
                for f in files:
                    full = os.path.join(root, f)
                    rel = os.path.relpath(full, extract_dir)
                    if rel == "mimetype":
                        continue
                    zout.write(full, rel, zipfile.ZIP_DEFLATED)
        shutil.move(new_epub, epub_path)
        return total_replaced


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: fix-cp1250.py <kniha.epub>", file=sys.stderr)
        sys.exit(1)
    n = process_epub(sys.argv[1])
    if n == -1:
        sys.exit(2)
    print(f"Replaced {n} chars")

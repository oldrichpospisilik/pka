#!/usr/bin/env python3
"""NFC normalize EPUB text (fixes dotless-i + combining acute → í, etc.).

Usage: nfc-normalize.py <kniha.epub>

Also replaces bare ı (dotless i) → i.
"""
import os
import sys
import shutil
import tempfile
import unicodedata
import zipfile

HTML_EXTS = (".html", ".xhtml", ".htm")


def fix_content(content: str) -> tuple[str, int]:
    normalized = unicodedata.normalize("NFC", content)
    # Replace lingering dotless-i (often used in place of i in bad OCR)
    dotless_count = normalized.count("ı")
    normalized = normalized.replace("ı", "i")

    # Count actual difference as a rough metric
    changed = dotless_count + (1 if normalized != content else 0)
    return normalized, changed


def process_epub(epub_path: str) -> int:
    if not epub_path.lower().endswith(".epub"):
        print(f"Not an EPUB: {epub_path}", file=sys.stderr)
        return -1

    with tempfile.TemporaryDirectory() as tmp:
        extract_dir = os.path.join(tmp, "unzip")
        os.makedirs(extract_dir)
        with zipfile.ZipFile(epub_path) as zf:
            zf.extractall(extract_dir)

        any_change = False
        total = 0
        for root, _, files in os.walk(extract_dir):
            for f in files:
                if not f.lower().endswith(HTML_EXTS):
                    continue
                path = os.path.join(root, f)
                with open(path, "r", encoding="utf-8", errors="replace") as fh:
                    content = fh.read()
                new_content, n = fix_content(content)
                if new_content != content:
                    with open(path, "w", encoding="utf-8") as fh:
                        fh.write(new_content)
                    total += n
                    any_change = True

        if not any_change:
            return 0

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
        return total


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: nfc-normalize.py <kniha.epub>", file=sys.stderr)
        sys.exit(1)
    n = process_epub(sys.argv[1])
    if n == -1:
        sys.exit(2)
    print(f"Normalized (changes: {n})")

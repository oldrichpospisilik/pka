#!/usr/bin/env python3
"""Merge broken paragraphs in EPUB where each line is its own <p>.

Usage: merge-paragraphs.py <kniha.epub>

Logic:
- If previous <p> doesn't end with terminal punctuation (.!?:;"'»)
  and next <p> starts with a lowercase letter → merge them.
- Hyphen breaks on paragraph boundary: `slovo-</p><p>pokračování` → `slovopokračování`.
"""
import os
import re
import sys
import shutil
import tempfile
import zipfile

HTML_EXTS = (".html", ".xhtml", ".htm")

TERMINAL_PUNCT = set('.!?:;"\'»)]')
# Czech lowercase letters + English
LOWERCASE_RE = re.compile(r"^[a-zěščřžýáíéúůďťňa-ž]")

# Matches a paragraph's inner text content
P_RE = re.compile(r"<p([^>]*)>(.*?)</p>", re.DOTALL | re.IGNORECASE)


def merge_in_html(content: str) -> tuple[str, int, int]:
    """Returns (new_content, merged_count, hyphen_count)."""
    hyphen_count = 0

    # Fix hyphenated words split across paragraphs: `word-</p><p attrs>next` → `wordnext</p><p attrs>`
    # (We drop the </p><p> boundary so the word becomes whole again; the old second paragraph
    # still opens after the merged word.)
    hyphen_pattern = re.compile(
        r"([a-zA-ZěščřžýáíéúůďťňĚŠČŘŽÝÁÍÉÚŮĎŤŇ]+)-\s*</p>\s*<p([^>]*)>\s*([a-zěščřžýáíéúůďťň])",
        re.DOTALL,
    )

    def _join_hyphen(m: re.Match) -> str:
        nonlocal hyphen_count
        hyphen_count += 1
        return m.group(1) + m.group(3) + f"</p><p{m.group(2)}>"

    content = hyphen_pattern.sub(_join_hyphen, content)

    # Then: merge consecutive paragraphs where prev lacks terminal punct, next starts lowercase
    merged_count = [0]

    def split_paragraphs(html: str) -> list:
        parts = []
        last_end = 0
        for m in P_RE.finditer(html):
            if m.start() > last_end:
                parts.append(("text", html[last_end:m.start()]))
            parts.append(("p", m.group(1), m.group(2)))
            last_end = m.end()
        if last_end < len(html):
            parts.append(("text", html[last_end:]))
        return parts

    def join_parts(parts: list) -> str:
        out = []
        for part in parts:
            if part[0] == "text":
                out.append(part[1])
            else:
                out.append(f"<p{part[1]}>{part[2]}</p>")
        return "".join(out)

    parts = split_paragraphs(content)
    # Merge consecutive <p> that satisfy conditions
    i = 0
    new_parts = []
    while i < len(parts):
        part = parts[i]
        if part[0] != "p":
            new_parts.append(part)
            i += 1
            continue

        attrs, inner = part[1], part[2]
        # Look ahead for next <p>, skipping pure whitespace text parts
        j = i + 1
        while j < len(parts) and parts[j][0] == "text" and parts[j][1].strip() == "":
            j += 1

        if j < len(parts) and parts[j][0] == "p":
            next_attrs, next_inner = parts[j][1], parts[j][2]
            # Strip inner text for inspection
            stripped_prev = re.sub(r"<[^>]+>", "", inner).strip()
            stripped_next = re.sub(r"<[^>]+>", "", next_inner).lstrip()
            if (
                stripped_prev
                and stripped_next
                and stripped_prev[-1] not in TERMINAL_PUNCT
                and LOWERCASE_RE.match(stripped_next)
            ):
                # Merge
                merged_inner = inner.rstrip() + " " + next_inner.lstrip()
                new_parts.append(("p", attrs, merged_inner))
                merged_count[0] += 1
                i = j + 1
                continue
        new_parts.append(part)
        i += 1

    new_content = join_parts(new_parts)
    return new_content, merged_count[0], hyphen_count


def is_poetry_or_drama(epub_path: str) -> bool:
    name = os.path.basename(epub_path).lower()
    markers = ["r.u.r", "hamlet", "macbeth", "othello", "romeo", "julius caesar",
               "bílá nemoc", "matka", "ze života hmyzu", "faust"]
    return any(m in name for m in markers)


def process_epub(epub_path: str) -> tuple[int, int]:
    if not epub_path.lower().endswith(".epub"):
        print(f"Not an EPUB: {epub_path}", file=sys.stderr)
        return (-1, -1)

    if is_poetry_or_drama(epub_path):
        print(f"Skipping drama/poetry: {epub_path}", file=sys.stderr)
        return (0, 0)

    with tempfile.TemporaryDirectory() as tmp:
        extract_dir = os.path.join(tmp, "unzip")
        os.makedirs(extract_dir)
        with zipfile.ZipFile(epub_path) as zf:
            zf.extractall(extract_dir)

        total_merged = 0
        total_hyphen = 0
        any_change = False
        for root, _, files in os.walk(extract_dir):
            for f in files:
                if not f.lower().endswith(HTML_EXTS):
                    continue
                path = os.path.join(root, f)
                with open(path, "r", encoding="utf-8", errors="replace") as fh:
                    content = fh.read()
                new_content, merged, hyphen = merge_in_html(content)
                if new_content != content:
                    with open(path, "w", encoding="utf-8") as fh:
                        fh.write(new_content)
                    total_merged += merged
                    total_hyphen += hyphen
                    any_change = True

        if not any_change:
            return (0, 0)

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
        return (total_merged, total_hyphen)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: merge-paragraphs.py <kniha.epub>", file=sys.stderr)
        sys.exit(1)
    merged, hyphen = process_epub(sys.argv[1])
    if merged == -1:
        sys.exit(2)
    print(f"Merged {merged} paragraphs, fixed {hyphen} hyphens")

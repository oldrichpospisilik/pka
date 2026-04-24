#!/usr/bin/env python3
"""Fix cp1250→latin1 garbled diacritics in ID3/MP4 text tags.

Usage: fix-comm-cp1250.py --dir <book-dir>

Targets tags: COMM, TIT2, TPE1, TALB, TCOM on MP3; ©cmt, ©nam, ©ART, ©alb, ©wrt on M4A.

Applies only if trigger chars (ø, è, ì, ù, ð, ò, ¾, ») appear > threshold.
"""
import argparse
import os
import sys

from mutagen.id3 import ID3, ID3NoHeaderError, COMM
from mutagen.mp4 import MP4

REPLACEMENTS = {
    "ø": "ř", "Ø": "Ř",
    "è": "č", "È": "Č",
    "ì": "ě", "Ì": "Ě",
    "ù": "ů", "Ù": "Ů",
    "ð": "đ", "Ð": "Đ",
    "ò": "ň", "Ò": "Ň",
    "¾": "ž", "®": "Ž",
    "»": "ť", "«": "Ť",
    "ê": "ę", "Ê": "Ę",
}
TRIGGER = set("øèìùðò¾®»")

AUDIO_EXTS = (".mp3", ".m4a", ".m4b")

ID3_TEXT_FRAMES = ["TIT2", "TPE1", "TALB", "TCOM", "TPE2"]


def fix_str(s: str) -> tuple[str, int]:
    if not any(c in TRIGGER for c in s):
        return s, 0
    n = 0
    out = s
    for bad, good in REPLACEMENTS.items():
        count = out.count(bad)
        if count:
            out = out.replace(bad, good)
            n += count
    return out, n


def fix_mp3(path: str) -> int:
    try:
        id3 = ID3(path)
    except ID3NoHeaderError:
        return 0
    changed = 0
    # Text frames
    for key in ID3_TEXT_FRAMES:
        frames = id3.getall(key)
        for fr in frames:
            new_texts = []
            any_change = False
            for t in fr.text:
                fixed, n = fix_str(str(t))
                if n:
                    any_change = True
                    changed += n
                new_texts.append(fixed)
            if any_change:
                fr.text = new_texts
                fr.encoding = 1  # UTF-16 with BOM — v2.3 safe for non-latin
    # COMM frames
    comms = id3.getall("COMM")
    new_comms = []
    for c in comms:
        new_texts = []
        any_change = False
        for t in c.text:
            fixed, n = fix_str(str(t))
            if n:
                any_change = True
                changed += n
            new_texts.append(fixed)
        if any_change:
            c.text = new_texts
            c.encoding = 1  # UTF-16 with BOM — v2.3 safe for non-latin
        new_comms.append(c)

    if changed:
        id3.save(path, v2_version=3)
    return changed


def fix_mp4(path: str) -> int:
    mp4 = MP4(path)
    changed = 0
    for key in ["\xa9nam", "\xa9ART", "\xa9alb", "\xa9wrt", "\xa9cmt"]:
        if key not in mp4:
            continue
        values = mp4[key]
        new_vals = []
        any_change = False
        for v in values:
            fixed, n = fix_str(str(v))
            if n:
                any_change = True
                changed += n
            new_vals.append(fixed)
        if any_change:
            mp4[key] = new_vals
    if changed:
        mp4.save()
    return changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    args = ap.parse_args()

    if not os.path.isdir(args.dir):
        print(f"Not a directory: {args.dir}", file=sys.stderr)
        sys.exit(1)

    total = 0
    touched_files = 0
    for f in sorted(os.listdir(args.dir)):
        full = os.path.join(args.dir, f)
        if not (os.path.isfile(full) and f.lower().endswith(AUDIO_EXTS)):
            continue
        if f.lower().endswith(".mp3"):
            n = fix_mp3(full)
        else:
            n = fix_mp4(full)
        if n:
            touched_files += 1
            total += n

    print(f"Fixed {total} chars in {touched_files} files")


if __name__ == "__main__":
    main()

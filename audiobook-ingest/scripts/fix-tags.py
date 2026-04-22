#!/usr/bin/env python3
"""Normalize ID3/MP4 tags across all audio files in an audiobook directory.

Usage:
  fix-tags.py --dir <book-dir> --author "Jméno Příjmení" --album "Název" \
              [--year 2024] [--comment "Čte: XY"] [--genre Audiokniha]

For each .mp3 sets ID3 frames (TPE1, TALB, TIT2, TRCK, TCON, TCOM, TDRC, COMM).
For each .m4a/.m4b sets MP4 atoms (©ART, ©alb, ©nam, trkn, ©gen, ©wrt, ©day, ©cmt).

Does NOT touch audio data; only tags. Preserves APIC/covr if already present.

Track numbering: taken from filename if it starts with NN (01, 02, ...),
otherwise assigned by sorted order.
"""
import argparse
import os
import re
import sys

from mutagen.easyid3 import EasyID3
from mutagen.id3 import ID3, ID3NoHeaderError, TIT2, TPE1, TALB, TRCK, TCON, TCOM, TDRC, COMM
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4

AUDIO_EXTS = (".mp3", ".m4a", ".m4b")
LEADING_NUM_RE = re.compile(r"^(\d{1,4})\b")
CHAPTER_RE = re.compile(r"^\d+\s*[-_.]\s*(.+)$")


def natural_sort_key(s: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def infer_chapter_title(filename: str, book_title: str) -> str:
    """Extract chapter title from filename. Falls back to track number string."""
    base = os.path.splitext(os.path.basename(filename))[0]
    # Strip leading number + separator
    m = CHAPTER_RE.match(base)
    if m:
        chapter = m.group(1).strip()
        # Remove book title prefix if redundant (e.g. "Kniha prvni - Duna, cast 1" keeps)
        # but "Kóma" chapter when filename was "01 - Kóma" → keep "Kóma"
        return chapter
    # No chapter title — use filename base or track number
    num_m = LEADING_NUM_RE.match(base)
    if num_m:
        return num_m.group(1).zfill(2)
    return base


def infer_track_number(filename: str, fallback: int) -> int:
    base = os.path.splitext(os.path.basename(filename))[0]
    m = LEADING_NUM_RE.match(base)
    if m:
        return int(m.group(1))
    return fallback


def process_mp3(path: str, args, track_num: int):
    try:
        id3 = ID3(path)
    except ID3NoHeaderError:
        id3 = ID3()
    # Preserve APIC (cover)
    apic = id3.getall("APIC")

    # Clear text frames we will rewrite, but keep others
    for key in ["TPE1", "TALB", "TIT2", "TRCK", "TCON", "TCOM", "TDRC"]:
        id3.delall(key)

    id3.add(TPE1(encoding=3, text=[args.author]))
    id3.add(TALB(encoding=3, text=[args.album]))
    id3.add(TCON(encoding=3, text=[args.genre]))
    id3.add(TCOM(encoding=3, text=[args.author]))
    if args.year:
        id3.add(TDRC(encoding=3, text=[args.year]))

    chapter = infer_chapter_title(path, args.album)
    id3.add(TIT2(encoding=3, text=[chapter]))
    id3.add(TRCK(encoding=3, text=[str(track_num).zfill(2)]))

    if args.comment:
        # Remove existing COMM frames, add new one (eng)
        id3.delall("COMM")
        id3.add(COMM(encoding=3, lang="eng", desc="", text=[args.comment]))

    # Restore APIC if was present
    for pic in apic:
        id3.add(pic)

    id3.save(path, v2_version=3)


def process_mp4(path: str, args, track_num: int):
    mp4 = MP4(path)
    # Preserve existing cover
    mp4["\xa9ART"] = [args.author]
    mp4["\xa9alb"] = [args.album]
    mp4["\xa9gen"] = [args.genre]
    mp4["\xa9wrt"] = [args.author]
    if args.year:
        mp4["\xa9day"] = [args.year]
    chapter = infer_chapter_title(path, args.album)
    mp4["\xa9nam"] = [chapter]
    mp4["trkn"] = [(track_num, 0)]
    if args.comment:
        mp4["\xa9cmt"] = [args.comment]
    mp4.save()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--author", required=True)
    ap.add_argument("--album", required=True)
    ap.add_argument("--genre", default="Audiokniha")
    ap.add_argument("--year", default="")
    ap.add_argument("--comment", default="")
    args = ap.parse_args()

    if not os.path.isdir(args.dir):
        print(f"Not a directory: {args.dir}", file=sys.stderr)
        sys.exit(1)

    files = []
    for f in os.listdir(args.dir):
        full = os.path.join(args.dir, f)
        if os.path.isfile(full) and f.lower().endswith(AUDIO_EXTS):
            files.append(full)
    files.sort(key=lambda p: natural_sort_key(os.path.basename(p)))

    if not files:
        print(f"No audio files in {args.dir}", file=sys.stderr)
        sys.exit(1)

    processed = 0
    failed = []
    for i, path in enumerate(files, start=1):
        track = infer_track_number(path, i)
        try:
            if path.lower().endswith(".mp3"):
                process_mp3(path, args, track)
            else:
                process_mp4(path, args, track)
            processed += 1
        except Exception as e:
            failed.append((path, str(e)))

    print(f"Tagged {processed}/{len(files)} files")
    for p, err in failed:
        print(f"  FAILED {p}: {err}", file=sys.stderr)
    if failed:
        sys.exit(2)


if __name__ == "__main__":
    main()

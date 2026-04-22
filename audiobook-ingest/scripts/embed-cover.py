#!/usr/bin/env python3
"""Embed cover image into all mp3/m4a/m4b files in a directory.

Usage: embed-cover.py --dir <book-dir> --cover <cover.jpg>

For MP3: adds APIC (cover-front) frame. Replaces any existing APIC.
For M4A/M4B: sets 'covr' atom with MP4Cover.
"""
import argparse
import os
import sys

from mutagen.id3 import ID3, ID3NoHeaderError, APIC
from mutagen.mp4 import MP4, MP4Cover

AUDIO_EXTS = (".mp3", ".m4a", ".m4b")


def guess_mime(path: str) -> str:
    p = path.lower()
    if p.endswith(".png"):
        return "image/png"
    return "image/jpeg"


def embed_mp3(audio_path: str, cover_bytes: bytes, mime: str):
    try:
        id3 = ID3(audio_path)
    except ID3NoHeaderError:
        id3 = ID3()
    id3.delall("APIC")
    id3.add(APIC(encoding=3, mime=mime, type=3, desc="Cover", data=cover_bytes))
    id3.save(audio_path, v2_version=3)


def embed_mp4(audio_path: str, cover_bytes: bytes, mime: str):
    mp4 = MP4(audio_path)
    fmt = MP4Cover.FORMAT_PNG if mime == "image/png" else MP4Cover.FORMAT_JPEG
    mp4["covr"] = [MP4Cover(cover_bytes, imageformat=fmt)]
    mp4.save()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--cover", required=True)
    args = ap.parse_args()

    if not os.path.isfile(args.cover):
        print(f"Cover not found: {args.cover}", file=sys.stderr)
        sys.exit(1)
    if not os.path.isdir(args.dir):
        print(f"Not a directory: {args.dir}", file=sys.stderr)
        sys.exit(1)

    with open(args.cover, "rb") as f:
        cover_bytes = f.read()
    mime = guess_mime(args.cover)

    processed = 0
    failed = []
    for f in sorted(os.listdir(args.dir)):
        full = os.path.join(args.dir, f)
        if not (os.path.isfile(full) and f.lower().endswith(AUDIO_EXTS)):
            continue
        try:
            if f.lower().endswith(".mp3"):
                embed_mp3(full, cover_bytes, mime)
            else:
                embed_mp4(full, cover_bytes, mime)
            processed += 1
        except Exception as e:
            failed.append((full, str(e)))

    print(f"Embedded cover into {processed} files")
    for p, err in failed:
        print(f"  FAILED {p}: {err}", file=sys.stderr)
    if failed:
        sys.exit(2)


if __name__ == "__main__":
    main()

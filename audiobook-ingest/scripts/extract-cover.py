#!/usr/bin/env python3
"""Extract embedded cover from an audio file and save it as a standalone image.

Usage: extract-cover.py <audio-file> <output-image>

Supports MP3 (APIC) and M4A/M4B (covr).
"""
import os
import sys

from mutagen.id3 import ID3, ID3NoHeaderError
from mutagen.mp4 import MP4


def extract(audio: str, out: str) -> int:
    ext = audio.lower()
    if ext.endswith(".mp3"):
        try:
            id3 = ID3(audio)
        except ID3NoHeaderError:
            return 1
        apics = id3.getall("APIC")
        if not apics:
            return 1
        pic = apics[0]
        with open(out, "wb") as f:
            f.write(pic.data)
        return 0
    elif ext.endswith((".m4a", ".m4b")):
        mp4 = MP4(audio)
        if "covr" not in mp4:
            return 1
        cover = mp4["covr"][0]
        with open(out, "wb") as f:
            f.write(bytes(cover))
        return 0
    return 2


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: extract-cover.py <audio> <output-image>", file=sys.stderr)
        sys.exit(2)
    rc = extract(sys.argv[1], sys.argv[2])
    if rc == 1:
        print("No cover found", file=sys.stderr)
        sys.exit(1)
    if rc == 2:
        print("Unsupported format", file=sys.stderr)
        sys.exit(2)
    print(f"Extracted cover → {sys.argv[2]}")

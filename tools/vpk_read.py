"""Minimal VPK reader: list and extract entries from a pak01_dir.vpk (v1/v2).

Used to read the host's own Panorama bootstrap and styles so the addon talks to the same client
API and palette it does. Entries live either inline in the directory archive or in a numbered
`pak01_NNN.vpk` beside it; both are read here. No third-party packages.
"""

from __future__ import annotations

import os
import struct
import sys

MAGIC = 0x55AA1234
INLINE = 0x7FFF


def _read_tree(path: str):
    data = open(path, "rb").read()
    sig, ver, tree_size = struct.unpack_from("<III", data, 0)
    if sig != MAGIC:
        raise SystemExit(f"{path}: not a VPK (sig {sig:#x})")
    if ver not in (1, 2):
        raise SystemExit(f"{path}: unsupported VPK version {ver}")

    off = 12
    if ver == 2:
        off += 16
    end = off + tree_size
    pos = off
    entries = []
    while pos < end:
        ext_end = data.index(b"\0", pos)
        ext = data[pos:ext_end].decode("utf-8", "replace")
        pos = ext_end + 1
        if not ext:
            break
        while True:
            dir_end = data.index(b"\0", pos)
            dir_name = data[pos:dir_end].decode("utf-8", "replace")
            pos = dir_end + 1
            if not dir_name:
                break
            while True:
                name_end = data.index(b"\0", pos)
                name = data[pos:name_end].decode("utf-8", "replace")
                pos = name_end + 1
                if not name:
                    break
                crc, preload, archive_index, archive_off, archive_len, term = struct.unpack_from(
                    "<IHHIIH", data, pos
                )
                pos += 18
                entries.append(
                    {
                        "path": f"{dir_name}/{name}.{ext}",
                        "preload": preload,
                        "archive_index": archive_index,
                        "off": archive_off,
                        "length": archive_len,
                        "crc": crc,
                    }
                )

    inline = {}
    for entry in entries:
        if entry["archive_index"] == INLINE:
            inline[entry["path"]] = data[pos : pos + entry["length"]]
            pos += entry["length"]
    return entries, inline


def read_tree(path: str):
    """Return `(entries, inline_blobs)` for a `pak01_dir.vpk`, importable and side-effect free."""
    return _read_tree(path)


def read_entry(directory_vpk: str, path: str):
    """The bytes of one entry by path, or None when it is not in the archive."""
    entries, inline = _read_tree(directory_vpk)
    for entry in entries:
        if entry["path"] == path:
            if path in inline:
                return inline[path]
            return entry_bytes(directory_vpk, entry)
    return None


def entry_bytes(directory_vpk: str, entry: dict):
    """The bytes of one entry, read from the directory archive or its numbered part."""
    entries, inline = _read_tree(directory_vpk)
    del entries
    if entry["path"] in inline:
        return inline[entry["path"]]
    if entry["archive_index"] == INLINE:
        return None
    part = os.path.join(
        os.path.dirname(directory_vpk), f"pak01_{entry['archive_index']:03d}.vpk"
    )
    if not os.path.exists(part):
        return None
    with open(part, "rb") as handle:
        handle.seek(entry["off"])
        return handle.read(entry["length"])


def extract(directory_vpk: str, out_dir: str, want: str | None = None):
    """Extract every entry whose path contains `want` (case-insensitive) under `out_dir`."""
    entries, inline = _read_tree(directory_vpk)
    written = 0
    for entry in entries:
        if want and want.lower() not in entry["path"].lower():
            continue
        blob = inline.get(entry["path"])
        if blob is None:
            blob = entry_bytes(directory_vpk, entry)
        if blob is None:
            print(f"missing archive part for {entry['path']}", file=sys.stderr)
            continue
        target = os.path.join(out_dir, entry["path"])
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as handle:
            handle.write(blob)
        written += 1
    return written


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    directory_vpk = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] not in ("-", "") else None
    want = sys.argv[3] if len(sys.argv) > 3 else None

    entries, _ = _read_tree(directory_vpk)
    if out_dir:
        count = extract(directory_vpk, out_dir, want)
        print(f"extracted {count} entr{'y' if count == 1 else 'ies'} to {out_dir}")
        return 0

    for entry in entries:
        if want and want.lower() not in entry["path"].lower():
            continue
        print(f"{entry['length']:9d}  {entry['path']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

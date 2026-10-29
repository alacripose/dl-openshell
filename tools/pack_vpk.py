"""Pack a directory into a Source VPK (version 1, inline data).

The CSDK's CSDKCfgVPK.exe is not present in every tools install, and the installer still needs one
archive at game/citadel/addons/mods/pak01_dir.vpk. This writes the layout the client reads: a v1
tree with every file inline in the directory archive. No preload and no numbered shards.

usage: pack_vpk.py <content-dir> <out.vpk>
"""

from __future__ import annotations

import pathlib
import struct
import sys
import zlib

MAGIC = 0x55AA1234
INLINE = 0x7FFF


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: pack_vpk.py <content-dir> <out.vpk>", file=sys.stderr)
        return 2

    root = pathlib.Path(sys.argv[1]).resolve()
    out = pathlib.Path(sys.argv[2]).resolve()
    if not root.is_dir():
        print(f"{root}: not a directory", file=sys.stderr)
        return 1

    entries = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        ext = path.suffix.lstrip(".").lower()
        parent, _, name = rel.rpartition("/")
        if ext:
            name = name[: -(len(ext) + 1)]
        entries.append((ext, parent, name, path.read_bytes()))
    entries.sort(key=lambda item: (item[0], item[1], item[2]))
    if not entries:
        print(f"{root}: no files to pack", file=sys.stderr)
        return 1

    body = bytearray()
    tree = bytearray()
    cursor = 0
    index = 0
    while index < len(entries):
        ext = entries[index][0]
        tree += ext.encode("utf-8") + b"\0"
        while index < len(entries) and entries[index][0] == ext:
            directory = entries[index][1]
            tree += directory.encode("utf-8") + b"\0"
            while index < len(entries) and entries[index][0] == ext and entries[index][1] == directory:
                _, _, name, data = entries[index]
                tree += name.encode("utf-8") + b"\0"
                tree += struct.pack(
                    "<IHHIIH",
                    zlib.crc32(data) & 0xFFFFFFFF,
                    0,
                    INLINE,
                    cursor,
                    len(data),
                    0xFFFF,
                )
                body += data
                cursor += len(data)
                index += 1
            tree += b"\0"
        tree += b"\0"
    tree += b"\0"

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(struct.pack("<III", MAGIC, 1, len(tree)) + bytes(tree) + bytes(body))
    print(f"packed {len(entries)} file(s), {out.stat().st_size} bytes at {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

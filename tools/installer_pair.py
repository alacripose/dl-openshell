#!/usr/bin/env python3
"""Which compatible installs exist, and whether each carries the current installer pair.

`install.cmd` runs whatever `install.ps1` sits beside it. A tree that was seeded once keeps the
pair it was seeded with, so an old release installer can sit under a current entry point and
nothing says so. This tool is the reading the installer window shows before it asks the user
whether to add the script to an install: for every tree discovery already knows, it compares the
two files under `game/bin/win64` with the pair this checkout publishes.

The pair is chosen by the tree's shape. A checkout tree (one with `clientaddon/`) gets the
development installer, which compiles and packs from source; a game tree gets the release
installer, which downloads and verifies the published archive. Writing is explicit and refused
outside a compatible install: this tool never creates a game directory, and never seeds a tree
that has no `gameinfo.gi` and no launchable client.

Usage::

    python tools/installer_pair.py [--json] [--check]
    python tools/installer_pair.py --apply PATH [PATH ...]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

from game_tree import (  # noqa: E402  (one parser: the installer window and the wish layer agree)
    BIN,
    compatible,
    game_of,
    shape,
    steam_common,
    steam_libraries,
)
from gen_shell_data import read_installs  # noqa: E402

ENTRY = "install.cmd"
# Where the window and the two installers live for each shape.
PAIRS = {
    "dev": (ROOT / "install.ps1", ROOT / ENTRY),
    "release": (ROOT / "release" / "install.ps1", ROOT / ENTRY),
}


def sha256(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return ""


def known_rows(extra: list[str]) -> list[dict]:
    rows: list[dict] = []
    for tree in steam_common():
        rows.append({"path": str(tree)})
    try:
        rows.extend(read_installs(None, [Path(path) for path in extra]))
    except (OSError, ValueError):
        pass
    try:
        from list_installs import read_hosts

        rows.extend(read_hosts())
    except (OSError, ValueError, ImportError):
        pass
    for path in extra:
        rows.append({"path": path})

    return rows


def known_trees(extra: list[str]) -> list[Path]:
    trees: list[Path] = []
    seen: set[str] = set()
    for row in known_rows(extra):
        raw = str(row.get("path") or "")
        if not raw:
            continue
        path = Path(raw)
        try:
            key = str(path.resolve()).lower()
        except OSError:
            key = raw.lower()
        if key in seen:
            continue
        seen.add(key)
        trees.append(path)
    return trees


def grades(extra: list[str]) -> dict[str, str]:
    """The grade discovery reads for each tree, keyed by resolved path.

    A tools tree is a development install even when it carries a compiled addon instead of a
    source checkout: its installer must compile from this worktree, not download a release.
    """
    found: dict[str, str] = {}
    for row in known_rows(extra):
        raw = str(row.get("path") or "")
        if not raw:
            continue
        try:
            key = str(Path(raw).resolve()).lower()
        except OSError:
            key = raw.lower()
        grade = str((row.get("build") or {}).get("grade") or "")
        if grade and key not in found:
            found[key] = grade
    return found


def reading(root: Path, grade: str = "") -> dict:
    ok, why = compatible(root)
    canonical = PAIRS[shape(root, grade)]
    directory = root / BIN
    entry = directory / ENTRY
    installer = directory / "install.ps1"
    present = {"install.cmd": entry.is_file(), "install.ps1": installer.is_file()}
    if not any(present.values()):
        state = "absent"
    elif not all(present.values()):
        state = "partial"
    elif sha256(entry) == sha256(canonical[1]) and sha256(installer) == sha256(canonical[0]):
        state = "current"
    else:
        state = "stale"
    return {
        "path": str(root).replace("\\", "/"),
        "game": game_of(root),
        "shape": shape(root, grade),
        "compatible": ok,
        "why": why,
        "installer": state,
        "entry": str(entry).replace("\\", "/"),
        "hash": sha256(installer)[:12] if install_ok(present) else "",
    }


def install_ok(present: dict) -> bool:
    return bool(present.get("install.ps1"))


def seed(root: Path, grade: str = "") -> tuple[bool, str]:
    """Write the pair this tree's shape publishes. Refused outside a compatible install."""
    ok, why = compatible(root)
    if not ok:
        return False, why
    installer, entry = PAIRS[shape(root, grade)]
    directory = root / BIN
    if not directory.is_dir():
        return False, f"no {BIN.as_posix()} directory"
    for source, name in ((installer, "install.ps1"), (entry, ENTRY)):
        target = directory / name
        staged = directory / (name + ".new")
        try:
            staged.write_bytes(source.read_bytes())
            staged.replace(target)
        except OSError as error:
            return False, f"{target}: {error}"
        finally:
            if staged.exists():
                try:
                    staged.unlink()
                except OSError:
                    pass
    return True, "seeded"


def main() -> int:
    parser = argparse.ArgumentParser(description="Read or seed the installer pair in compatible installs.")
    parser.add_argument("--json", action="store_true", help="print the reading as JSON")
    parser.add_argument("--check", action="store_true", help="exit 1 when any seeded pair is stale")
    parser.add_argument("--apply", nargs="*", default=None, help="seed these trees (explicit consent)")
    parser.add_argument("--root", action="append", default=[], help="an extra tree to consider")
    args = parser.parse_args()

    trees = known_trees(args.root)
    found = grades(args.root)
    def grade_of(root: Path) -> str:
        try:
            return found.get(str(root.resolve()).lower(), "")
        except OSError:
            return found.get(str(root).lower(), "")

    if args.apply is not None:
        rows = []
        for raw in args.apply:
            root = Path(raw)
            ok, detail = seed(root, grade_of(root))
            rows.append({"path": str(root).replace("\\", "/"), "seeded": ok, "detail": detail})
            print(("seeded   " if ok else "REFUSED  ") + rows[-1]["path"] + "  " + detail)
        return 0 if all(row["seeded"] for row in rows) else 1

    rows = [reading(root, grade_of(root)) for root in trees]
    payload = {
        "pair": {key: {"installer": str(value[0]), "entry": str(value[1])} for key, value in PAIRS.items()},
        "trees": rows,
        "stale": [row["path"] for row in rows if row["installer"] in ("stale", "partial")],
    }

    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        for row in rows:
            print(f"  {row['installer']:<8} {row['shape']:<8} {(row['game'] or '-'):<10} "
                  f"{'compatible' if row['compatible'] else 'refused: ' + row['why']:<30} {row['path']}")
    if args.check:
        return 1 if payload["stale"] else 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Pin the family baseline the in-game shell is drawn against, with its modern identity.

The pinned shell is the Python Popit baseline. The in-game Panorama shell does not call itself by
that baseline's own name: it carries the family naming, `name@<revision>+blake3:<hex>`, the same
identity form `tools/modern_package.py` writes for a package, so the taskbar, the launcher and the
toasts name the build they came from.

The identity is read, never typed: the baseline repository's HEAD gives the revision, and a BLAKE3
digest over its tracked files in sorted path order gives the content hash. Files outside git's index
(venv, logs, receipts) do not move the identity, because they are not the baseline's source.

    python tools/pin_baseline.py            # read the baseline, write docs/family-baseline.json
    python tools/pin_baseline.py --check    # exit 1 when the record is not that baseline
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from blake3 import blake3

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "family-baseline.json"
BASELINE = Path(os.environ.get("FAMILY_BASELINE", "F:/Documents/popit-shell"))
NAME = "dl-openshell"


def git(*args: str) -> str:
    run = subprocess.run(["git", *args], cwd=BASELINE, capture_output=True, text=True, check=False)
    if run.returncode != 0:
        raise SystemExit(f"baseline-unreadable: git {' '.join(args)} said {run.stderr.strip()[:120]}")
    return run.stdout.strip()


def identity() -> dict:
    if not (BASELINE / ".git").exists():
        raise SystemExit(f"baseline-absent: {BASELINE} is not a git checkout")
    commit = git("rev-parse", "HEAD")
    revision = commit[:8]
    tracked = [line for line in git("ls-files").splitlines() if line]
    hasher = blake3()
    for path in sorted(tracked):
        hasher.update(path.encode("utf-8") + b"\0")
        hasher.update((BASELINE / path).read_bytes())
        hasher.update(b"\0")
    digest = hasher.hexdigest()
    return {
        "schema": "openlock.family-baseline/1",
        "name": NAME,
        "repo": str(BASELINE).replace("\\", "/"),
        "commit": commit,
        "revision": revision,
        "files": len(tracked),
        "identity": f"{NAME}@{revision}+blake3:{digest}",
        "blake3": digest,
    }


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    text = json.dumps(identity(), indent=2, ensure_ascii=False) + "\n"
    if "--check" in args:
        current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if current != text:
            print("[FAIL] family-baseline-stale: docs/family-baseline.json is not that baseline")
            return 1
        print("[ok] the baseline record is that baseline")
        return 0
    OUTPUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

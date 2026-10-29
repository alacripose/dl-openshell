#!/usr/bin/env python3
"""List the Deadlock game and reduced-CSDK tools trees on this machine.

This is the discovery half of the boot shell: launch.ps1 asks for one JSON document
and renders it, instead of growing a second set of drive/path heuristics. The
same reader feeds the Tools window in the shell data, so the installs the
launcher offers and the installs the in-game window reports cannot drift.

Usage:
    python tools/list_installs.py [--root PATH ...]

--root adds a tree that is not in the bounded standard locations; it is how an
explicit launch.ps1 -Root path is represented even when it sits elsewhere.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gen_shell_data import read_installs  # noqa: E402


# A tools tree can host the installer without being a launchable game copy. Reduced CSDK
# trees are exactly that: a resource compiler, the VPK packer and the stock layouts, but no
# gameinfo to launch. Keep the same bounded placement rules as the game search.
HOST_PATTERNS = (
    "Users/*/Documents/Documents/Reduced_CSDK_*",
    "Users/*/Documents/Reduced_CSDK_*",
    "Users/*/Documents/*/Reduced_CSDK_*",
    "Users/*/Downloads/Reduced_CSDK_*",
    "Downloaded Files/CSwin64_build_*",
    "Users/*/Downloads/CSwin64_build_*",
    "Users/*/Documents/Documents/deadlockpreview/Project8Staging/*",
    "Users/*/Documents/deadlockpreview/Project8Staging/*",
    "Users/*/*/Project8Staging/*",
    "Projects/*/Project8Staging/*",
    "dev/*/Project8Staging/*",
    "Program Files (x86)/Steam/steamapps/content/app_1422450/depot_1422456",
)


def read_hosts() -> list[dict]:
    """Installer hosts: a tools tree with resourcecompiler.exe, ranked by CSDK number."""
    roots: list[Path] = []
    seen: set[str] = set()

    def remember(root: Path):
        try:
            key = str(root.resolve()).lower()
        except OSError:
            key = str(root).lower()
        if key in seen:
            return
        seen.add(key)
        roots.append(root)

    for letter in "CDEFGHIJKLMNOPQRSTUVWXYZAB":
        drive = Path(f"{letter}:/")
        try:
            if not drive.exists():
                continue
        except OSError:
            continue
        for pattern in HOST_PATTERNS:
            try:
                for candidate in drive.glob(pattern):
                    if (candidate / "game" / "bin" / "win64" / "resourcecompiler.exe").exists():
                        remember(candidate)
            except OSError:
                continue

    hosts = []
    for root in roots:
        text = str(root)
        match = re.search(r"csdk[ _-]?(\d+)", text, re.IGNORECASE)
        number = int(match.group(1)) if match else 0
        is_cs2 = bool(re.search(r"(^|[\\/ ])cs(2|win64|go)|CSwin64", text, re.IGNORECASE))
        has_content = (root / "content" / "citadel_addons").exists()
        has_gameinfo = (root / "game" / "citadel" / "gameinfo.gi").exists()
        hosts.append({
            "path": str(root).replace("\\", "/"),
            "engine": "cs2" if is_cs2 else ("csdk" if number else "unknown"),
            "csdk": number,
            "hasVpkTool": (root / "game" / "bin" / "win64" / "CSDKCfgVPK.exe").exists(),
            "hasContent": has_content,
            "hasGameinfo": has_gameinfo,
            # A host that can package for a Deadlock/Citadel layout. A bare CS2 tools tree can
            # compile models and shaders but needs its own addon package before it can stand in
            # for a Citadel tools install; the launcher shows it and will not auto-select it.
            "deadlockHost": has_gameinfo and has_content,
        })
    hosts.sort(key=lambda row: (row["engine"] == "cs2", -row["csdk"], row["path"].lower()))
    return hosts


def main() -> int:
    parser = argparse.ArgumentParser(description="List Openlock-capable Deadlock installs.")
    parser.add_argument("--root", action="append", default=[], help="extra install root to include")
    args = parser.parse_args()

    installs = read_installs(None, [Path(root) for root in args.root])
    print(json.dumps({"installs": installs, "hosts": read_hosts()}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

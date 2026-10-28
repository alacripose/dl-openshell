#!/usr/bin/env python3
"""Stage an update record for the shell's update window and rebuild the data the UI reads.

The record is client data, so it travels with the package like everything else:

    python tools/stage_update.py --version 1.4.2 --notes "Shop rows fixed" --countdown 90
    python tools/stage_update.py --clear

`--auto` lets the restart job close the client when its countdown reaches zero; without it the
countdown runs but only the player's Restart now closes the client.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RECORD = ROOT / "shell" / "alpha-shell" / "update.json"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", default="")
    parser.add_argument("--title", default="Update ready")
    parser.add_argument("--notes", default="Restart the client to apply the new build.")
    parser.add_argument("--countdown", type=int, default=60)
    parser.add_argument("--auto", action="store_true")
    parser.add_argument("--clear", action="store_true")
    args = parser.parse_args()

    if args.clear:
        RECORD.unlink(missing_ok=True)
        print("cleared the update record")
    else:
        if not args.version:
            parser.error("--version is required unless --clear is used")
        RECORD.write_text(
            json.dumps(
                {
                    "available": True,
                    "version": args.version,
                    "title": args.title,
                    "notes": args.notes,
                    "countdown": max(0, args.countdown),
                    "autoRestart": bool(args.auto),
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"staged update {args.version} at {RECORD}")

    return subprocess.call([sys.executable, str(ROOT / "tools" / "gen_shell_data.py")])


if __name__ == "__main__":
    raise SystemExit(main())

"""Generate the reduced-CSDK shell entry from the live shell, at pack time.

The live shell sheet uses declarations newer Panorama accepts but the reduced CSDK 10 parser
reports as errors (position keywords, rotate transforms) and a renderer assert (rounded borders
with more than one border colour). Rather than deleting those declarations from the live sheet,
this writes a legacy copy for the CSDK 10 entry only. The live files are never modified.

usage: gen_legacy_shell.py <live-layout.xml> <live-sheet.css> <out-layout.xml> <out-sheet.css>
"""

from __future__ import annotations

import pathlib
import re
import sys

# Declarations this older Panorama parser reports as errors, rewritten to the nearest supported
# equivalent instead of deleted. Deleting `position: absolute` alone put the full-screen window
# layers into normal flow, which pushed the taskbar and launcher off the bottom of the screen.
REWRITES = (
    (re.compile(r"^(\s*)position:\s*absolute;\s*$"), r"\1ignore-parent-flow: true;"),
    (re.compile(r"^(\s*)position:\s*relative;\s*$"), r""),
    (re.compile(r"^(\s*)transform:\s*rotate\([^)]*\);\s*$"), r""),
    (re.compile(r"^(\s*)border-radius:\s*[^;]+;\s*$"), r""),
    (re.compile(r"^(\s*)width:\s*fill-remaining-space;\s*$"), r"\1width: 100%;"),
)


def sanitized_sheet(text: str) -> tuple[str, int]:
    kept: list[str] = []
    removed = 0
    for line in text.splitlines():
        for pattern, replacement in REWRITES:
            match = pattern.match(line)
            if not match:
                continue
            removed += 1
            if replacement:
                kept.append(match.expand(replacement))
            break
        else:
            kept.append(line)
    return "\n".join(kept).rstrip() + "\n", removed


def main() -> int:
    if len(sys.argv) != 5:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    live_layout, live_sheet, out_layout, out_sheet = (pathlib.Path(arg) for arg in sys.argv[1:])
    layout = live_layout.read_text(encoding="utf-8")
    if "openlock_shell.css" not in layout:
        print(f"{live_layout}: no openlock_shell.css include", file=sys.stderr)
        return 1

    legacy = layout.replace("openlock_shell.css", "openlock_shell_legacy.css")
    out_layout.parent.mkdir(parents=True, exist_ok=True)
    out_layout.write_text(legacy, encoding="utf-8")

    sheet, removed = sanitized_sheet(live_sheet.read_text(encoding="utf-8"))
    out_sheet.parent.mkdir(parents=True, exist_ok=True)
    out_sheet.write_text(sheet, encoding="utf-8")
    print(f"legacy shell: {out_layout.name}, {out_sheet.name} ({removed} declaration(s) removed)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

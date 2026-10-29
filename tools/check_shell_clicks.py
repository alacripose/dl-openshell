"""Check that the shell's own controls can receive a pointer.

The shell is a Panorama overlay: a panel that sets `hittest="false"` without
`hittestchildren="true"` makes every control below it invisible to the mouse.
That exact change was introduced on the taskbar and launcher and made the
buttons stop responding. This check reads the shipped layout and the generated
controls instead of guessing from a screenshot.

Run: python tools/check_shell_clicks.py
"""

from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHELL = ROOT / "clientaddon" / "panorama" / "layout" / "openlock_shell.xml"
SCRIPT = ROOT / "clientaddon" / "panorama" / "scripts" / "openlock_shell.js"
STYLE = ROOT / "clientaddon" / "panorama" / "styles" / "openlock_shell.css"

# These are the shell-owned pointer surfaces. A layout regression on any of
# them is a dead button, even when the drawing still looks correct.
REQUIRED_CLICK_PATHS = (
    "WindowsButton",
    "LauncherButton",
    "SchemeButton",
    "InstallGradeDev",
    "InstallButton",
)

# Containers that host clickable children but have no handler of their own.
CONTAINER_PATHS = (
    "Taskbar",
    "TabStrip",
    "LauncherBar",
    "ToastStack",
)


def main() -> int:
    errors: list[str] = []
    tree = ET.parse(SHELL)
    root = tree.getroot()
    parent = {child: node for node in root.iter() for child in node}

    def blocked_by_ancestor(node: ET.Element) -> str:
        current = parent.get(node)
        while current is not None:
            if current.get("hittest") == "false" and current.get("hittestchildren") != "true":
                return current.get("id") or current.get("class") or current.tag
            current = parent.get(current)
        return ""

    interactive = 0
    found: set[str] = set()
    for node in root.iter():
        if node.get("onmouseactivate") or node.get("onmousedown") or node.get("onmouseup"):
            interactive += 1
            node_id = node.get("id") or node.get("class") or node.tag
            if node_id in REQUIRED_CLICK_PATHS:
                found.add(node_id)
            if node.get("hittest") == "false":
                errors.append(f"{node_id}: interactive node sets hittest=false")
            blocker = blocked_by_ancestor(node)
            if blocker:
                errors.append(f"{node_id}: blocked by ancestor '{blocker}'")

    for required in REQUIRED_CLICK_PATHS:
        if required not in found:
            errors.append(f"{required}: no pointer handler in {SHELL.name}")

    for node in root.iter():
        node_id = node.get("id")
        if node_id not in CONTAINER_PATHS:
            continue
        if node.get("hittest") == "false":
            errors.append(f"{node_id}: pointer container sets hittest=false")
        blocker = blocked_by_ancestor(node)
        if blocker:
            errors.append(f"{node_id}: pointer container blocked by ancestor '{blocker}'")

    script = SCRIPT.read_text(encoding="utf-8")
    for helper in ("addControl", "titleButton", "showObserverXml"):
        if f"function {helper}" not in script and f"{helper} =" not in script:
            errors.append(f"{helper}: expected pointer helper is missing")

    style = STYLE.read_text(encoding="utf-8")
    # The controls are hidden only by observer grade, never by ordinary chrome.
    for selector in (".LauncherBar", ".Taskbar", ".ToastStack"):
        match = re.search(re.escape(selector) + r"\s*\{([^}]*)\}", style)
        if not match:
            errors.append(f"{selector}: missing style block")
        elif "visibility: collapse" in match.group(1):
            errors.append(f"{selector}: collapsed in the default grade")

    if errors:
        for error in errors:
            print("REFUSED:", error)
        return 1

    print(f"ok: {interactive} pointer control(s) reachable in {SHELL.name}")
    for required in REQUIRED_CLICK_PATHS:
        print(f"  reachable: {required}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

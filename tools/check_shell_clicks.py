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
    # The reduced CSDK 10 client (the host installer shell) exposes no GameUI. A drag that only
    # probes GameUI is refused at runtime, which is how the installer lost pointer drags. Refuse
    # the package at build time instead of shipping a shell whose buttons cannot be dragged.
    if "$.MousePosition" not in script:
        errors.append(
            "openlock_shell.js: no $.MousePosition cursor probe; the host installer would refuse drags"
        )
    # A decorative label or icon left hit-testable sits over its own button and swallows the
    # press. That is the title-bar glyph regression; refuse it at build time.
    if "l.hittest = false" not in script:
        errors.append("addControl: label is hit-testable and would swallow the button press")
    if "i.hittest = false" not in script:
        errors.append("titleButton: icon is hit-testable and would swallow the glyph press")
    for helper in ("addControl", "titleButton"):
        if f"function {helper}" not in script and f"{helper} =" not in script:
            errors.append(f"{helper}: expected pointer helper is missing")

    # A title glyph is a press target on the reduced client, not an activate target.
    if 'press ? "onmousedown" : "onmouseactivate"' not in script:
        errors.append("addControl: title glyphs would wait for an activate event the tools client drops")
    # All four corners must stay real resize drags, not decoration.
    for grip in ("resize-nw", "resize-ne", "resize-sw", "resize-se"):
        if f'"{grip}"' not in script:
            errors.append(f"ResizeGrip: missing '{grip}' drag mode")
    if "makeDraggable(grip" not in script:
        errors.append("ResizeGrip: corner is not bound to a resize drag")

    # Chrome now follows nested HUD containers and eases a top-row window down under the bar.
    # These names make the two live-window paths visible to a source check that cannot run the
    # game's Panorama VM.
    for required in ("function hudWindowCandidates", "startShiftAnimation",
                     "record.targetShiftY", "discoverHudWindows();"):
        if required not in script:
            errors.append(f"script: missing window-chrome path '{required}'")

    # The idle frame is restored from the pointer rectangle, not from a mouseover on a
    # transparent child (which the tools client does not reliably deliver).
    for required in ("function pointerInsideFrame", "record.rect = {", "cursorPoint()",
                     "function updateCompactChrome"):
        if required not in script:
            errors.append(f"script: missing idle-hover path '{required}'")

    # The reduced tools client exposes no cursor at all, so the pointer rectangle alone cannot
    # restore a window. Each window keeps its own hover state, bound to the live panel it frames,
    # and its own idle clock; a global clock would leave every other window expanded.
    for required in ("function enterFrame", "function leaveFrame", "function hoveredByPointer",
                     "function bindFrameHover", "bindFrameHover(win.id, panel)",
                     "f.lastActiveAt"):
        if required not in script:
            errors.append(f"script: missing per-window hover path '{required}'")
    if "now - lastInteractionAt" in script:
        errors.append("script: chrome idle is back on the global interaction clock")

    style = STYLE.read_text(encoding="utf-8")
    # The controls are hidden only by observer grade, never by ordinary chrome.
    for selector in (".LauncherBar", ".Taskbar", ".ToastStack"):
        match = re.search(re.escape(selector) + r"\s*\{([^}]*)\}", style)
        if not match:
            errors.append(f"{selector}: missing style block")
        elif "visibility: collapse" in match.group(1):
            errors.append(f"{selector}: collapsed in the default grade")

    # The 1 px frame and the grips are what disappear at idle. The chrome strip and its controls
    # must not be collapsed: that is the regression where hovering could not bring a window back.
    idle_grip = re.search(r"\.WindowFrame\.CompactHud\.IdleCompact \.ResizeGrip\s*\{([^}]*)\}", style)
    if not idle_grip or "visibility: collapse" not in idle_grip.group(1):
        errors.append(".IdleCompact .ResizeGrip: the frame grips do not hide at idle")
    idle_chrome = re.search(r"\.WindowFrame\.CompactHud\.IdleCompact \.WindowButton[^{]*\{([^}]*)\}", style)
    if idle_chrome and "visibility: collapse" in idle_chrome.group(1):
        errors.append(".IdleCompact .WindowButton: the chrome controls are hidden at idle")
    idle_cost = re.search(r"\.WindowFrame\.CompactHud\.IdleCompact \.WindowCost[^{]*\{([^}]*)\}", style)
    if idle_cost and "visibility: collapse" in idle_cost.group(1):
        errors.append(".IdleCompact .WindowCost: the performance metric is hidden at idle")

    # The context menu must paint above every window layer, not inside one of them.
    for selector in (".ContextDismiss", ".ContextMenu"):
        match = re.search(re.escape(selector) + r"\s*\{([^}]*)\}", style)
        if not match:
            errors.append(f"{selector}: missing style block")
        else:
            z = re.search(r"z-index:\s*(\d+)", match.group(1))
            if not z or int(z.group(1)) < 800:
                errors.append(f"{selector}: does not paint above the taskbar")

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

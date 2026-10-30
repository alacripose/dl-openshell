"""Check that the shell's own controls can receive a pointer.

The shell is a Panorama overlay: a panel that sets `hittest="false"` without
`hittestchildren="true"` makes every control below it invisible to the mouse.
That exact change was introduced on the taskbar and launcher and made the
buttons stop responding. This check reads the shipped layout and the generated
controls instead of guessing from a screenshot.

Run: python tools/check_shell_clicks.py
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHELL = ROOT / "clientaddon" / "panorama" / "layout" / "openlock_shell.xml"
SCRIPT = ROOT / "clientaddon" / "panorama" / "scripts" / "openlock_shell.js"
LAYOUT = ROOT / "clientaddon" / "panorama" / "scripts" / "openlock_layout.js"
STYLE = ROOT / "clientaddon" / "panorama" / "styles" / "openlock_shell.css"
AGENTS = ROOT / "AGENTS.md"
WITNESS = ROOT / "docs" / "shell-test-surface.html"

# These are the shell-owned pointer surfaces. A layout regression on any of
# them is a dead button, even when the drawing still looks correct.
REQUIRED_CLICK_PATHS = (
    "DashboardButton",
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
    parser = argparse.ArgumentParser(description="Check that the shell's own controls can receive a pointer.")
    parser.add_argument("--script", default=str(SCRIPT),
                        help="the shell script to read (a regressed copy is how the guard is proved)")
    args = parser.parse_args()
    script_path = Path(args.script)

    errors: list[str] = []
    shell_text = SHELL.read_text(encoding="utf-8")
    if "openlock_layout.js" not in shell_text:
        errors.append(
            "openlock_shell.xml: the layout pass is not loaded; the shell would fall back "
            "to drawing over the game's default layout"
        )
    if not LAYOUT.is_file():
        errors.append("openlock_layout.js: layout pass module is missing")

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

    script = script_path.read_text(encoding="utf-8")
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

    # A title glyph is a press target on the reduced client, not only an activate target. The
    # shipping client activates after a press and the tools client can drop the activate while a
    # drag poll owns the pointer, so a press control must bind both and guard the duplicate.
    if ('SetPanelEvent("onmousedown", fire)' not in script
            or 'SetPanelEvent("onmouseactivate", fire)' not in script):
        errors.append("addControl: title glyphs would wait for an activate event the tools client drops")
    # All four corners must stay real resize drags, not decoration.
    for grip in ("resize-nw", "resize-ne", "resize-sw", "resize-se"):
        if f'"{grip}"' not in script:
            errors.append(f"ResizeGrip: missing '{grip}' drag mode")
    if "makeDraggable(grip" not in script:
        errors.append("ResizeGrip: corner is not bound to a resize drag")

    # Chrome follows nested HUD containers. A dragged frame keeps the visible box it was given;
    # the placement result is the only position, so a source check can still see the contract
    # even when it cannot run the game's Panorama VM.
    for required in ("function hudWindowCandidates", "discoverHudWindows();",
                     "record.chrome = chrome", "var placed = layoutPlace",
                     "var dispX = placed.x", "var dispY = placed.y",
                     "var scaleX = clamp(g.w / nat.w", "var scaleY = clamp(g.h / nat.h",
                     "frameRecord.rect", "frameRect.y + chrome"):
        if required not in script:
            errors.append(f"script: missing window-chrome path '{required}'")
    for retired in ("startShiftAnimation", "record.targetShiftY", "record.shiftY",
                    "if (!win || !at)"):
        if retired in script:
            errors.append(f"script: retired window-chrome path '{retired}' is back")
    for required in ("pointerDrag.misses", "probe miss", "g.h = height;"):
        if required not in script:
            errors.append(f"script: missing window-gesture contract '{required}'")
    if "if (!panelWindow) g.h = height" in script:
        errors.append("script: live-panel resize is width-only again")
    if "var scale = clamp(g.w / nat.w" in script:
        errors.append("script: panel transform is back to one uniform scale")

    # The window controls are drawn shapes. A WindowGlyph or a glyph.text write is the
    # regression that put Unicode codepoints in a font with no coverage.
    for required in ("function iconStroke", "function iconFrame", "IconMin", "IconMax",
                     "IconRestore", "IconCloseBar"):
        if required not in script:
            errors.append(f"script: missing drawn window control '{required}'")
    for retired in ("WindowGlyph", "glyph.text", 'glyph = "−"', 'glyph = "□"',
                    'glyph = "×"', 'glyph = "▣"'):
        if retired in script:
            errors.append(f"script: typed window glyph '{retired}' is back")

    # The automatic layout pass must be the one owner of edge space. Both the live-panel path and
    # the shell-window path ask it; a build that drops either call has silently stopped reserving
    # room and is back to drawing under the bar.
    if LAYOUT.is_file():
        layout = LAYOUT.read_text(encoding="utf-8")
        for required in ("function place(id, rect, extraTop)", "function placeShell(id, rect)",
                         "function restore(id)", "preShell", "takeRefusals", "OpenlockLayoutPass"):
            if required not in layout:
                errors.append(f"openlock_layout.js: missing arbitration surface '{required}'")
        for required in ("function layoutPlace", "pass.place(", "pass.placeShell",
                         "OpenlockLayoutPass.setOpen", "OpenlockLayoutPass.setViewport",
                         'refuseFeature("Layout refused"'):
            if required not in script:
                errors.append(f"script: layout pass is not wired through '{required}'")
    # The old shortcut is exactly the reported P0: a live HUD element was left under the chrome
    # because `needShift` was pinned to zero. Keep it out of the build.
    for retired in ("dockTop", "needShift = 0"):
        if retired in script:
            errors.append(f"script: retired layout shortcut '{retired}' is back")

    # The idle frame is restored from the pointer rectangle, not from a mouseover on a
    # transparent child (which the tools client does not reliably deliver).
    for required in ("function pointerInsideFrame", "record.rect = {", "cursorPoint()",
                     "function updateCompactChrome"):
        if required not in script:
            errors.append(f"script: missing idle-hover path '{required}'")

    # A focused compact HUD window must promote to the full chrome schema. The old path only
    # restored on hover, so a window focused from the taskbar stayed in the 14 dp strip while a
    # newly opened shell window used the 30 dp title and 26 dp controls.
    for required in ("clearCompactChrome", "focused === f.win.id", "focused === id"):
        if required not in script:
            errors.append(f"script: focus does not promote the compact chrome ({required})")

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
    if ".WindowGlyph" in style:
        errors.append("style: .WindowGlyph is back; controls must be drawn, not typed")
    for required in (".IconStroke", ".IconFrame", ".IconMax", ".IconRestore",
                     ".WindowButton.Maximized .IconRestore"):
        if required not in style:
            errors.append(f"style: missing drawn window control '{required}'")

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

    focused_schema = re.search(r"\.WindowFrame\.CompactHud\.Focused \.WindowTitle\s*\{([^}]*)\}", style)
    if not focused_schema or "height: 30px" not in focused_schema.group(1):
        errors.append(".CompactHud.Focused .WindowTitle: focused HUD window keeps the compact title")

    # CSDK10 asserts in CBaseScrollBar::LoadTransitionData when a scrollbar has no transform
    # transition. The shell sheet is the only place the legacy renderer gets one.
    scrollbar = re.search(r"VerticalScrollBar[^{]*\{([^}]*)\}", style)
    if not scrollbar or "transition-property: transform" not in scrollbar.group(1):
        errors.append("VerticalScrollBar: no transform transition; CSDK10 asserts when a body scrolls")

    # A cell can be split again. The id carries the declared root and the full component path, so
    # a saved row can rebuild each ancestor split before applying the final rectangle.
    for required in ("cellRoot", "cellPath", "function ensureSplitPath", "ensureSplitPath(parentId"):
        if required not in script:
            errors.append(f"script: nested cells cannot be saved and restored ({required})")

    # Taskbar entries expose the same window actions as the title bar. The menu must include a
    # maximize/restore toggle; a menu that can only open, minimize, pin and close strands a
    # maximized window with no way back to its saved rectangle.
    for required in ('tab.SetPanelEvent("oncontextmenu"', 'maximized[win.id] ? "Restore" : "Maximize"'):
        if required not in script:
            errors.append(f"addTab: missing taskbar context action '{required}'")

    # The CSDK10 renderer asserts (source2surface DrawBorder) when a border with a non-zero
    # radius varies by side. The shell then never mounts, so refuse the package at build time.
    for block in re.finditer(r"([^{}]+)\{([^}]*)\}", style):
        selector = block.group(1).strip().splitlines()[-1].strip()
        body = block.group(2)
        radius = re.search(r"border-radius:\s*([0-9.]+)px", body)
        if not radius or float(radius.group(1)) == 0:
            continue
        if re.search(r"border-(top|right|bottom|left)(-color)?:", body):
            errors.append(f"{selector}: rounded border varies by side and asserts on CSDK10")

    # The context menu is a hover surface, not a cursor sample. These names make the contract
    # visible to a source check: the menu and its rows own hover, the rect is measured, and a
    # leave has to survive both dwell clocks before it can close.
    for required in ("function measureContextMenu", "function scheduleContextLeaveCheck",
                     "function bindContextHover", "bindContextHover(contextMenu)",
                     "bindContextHover(item)", 'panel.SetPanelEvent("onmouseover"',
                     "CONTEXT_MIN_OPEN_MS", "CONTEXT_LEAVE_DWELL_MS",
                     "contextRect = measureContextMenu()", "insideContext(at, contextRect)"):
        if required not in script:
            errors.append(f"script: context menu lost its hover contract '{required}'")
    if "watchContextMenu" in script:
        errors.append("script: context menu is back on the 150 ms global cursor poll")
    if "180, 280" in script or "180,280" in script:
        errors.append("script: context menu is back on the guessed 180 x 280 rect")

    # Narrow frames keep their controls in the title strip at every supported narrow width.
    # Refuse a build that collapses them again or drops the compact geometry.
    narrow_button = re.search(r"\.WindowFrame\.Narrow \.WindowButton[^{}]*\{([^}]*)\}", style)
    if not narrow_button:
        errors.append(".WindowFrame.Narrow .WindowButton: missing narrow control rule")
    else:
        body = narrow_button.group(1)
        if "visibility: collapse" in body:
            errors.append(".WindowFrame.Narrow .WindowButton: controls are collapsed again")
        if "visibility: visible" not in body or "width: 8px" not in body or "height: 8px" not in body:
            errors.append(".WindowFrame.Narrow .WindowButton: compact controls are not visible and sized")

    focused_narrow_button = re.search(
        r"\.WindowFrame\.Narrow\.CompactHud\.Focused \.WindowButton\s*\{([^}]*)\}", style)
    if not focused_narrow_button:
        errors.append(
            ".WindowFrame.Narrow.CompactHud.Focused .WindowButton: focused narrow frame has no control rule")
    else:
        body = focused_narrow_button.group(1)
        if "visibility: visible" not in body or "width: 8px" not in body:
            errors.append(
                ".WindowFrame.Narrow.CompactHud.Focused .WindowButton: focused controls are not restored")

    narrow_label = re.search(r"\.WindowFrame\.Narrow \.WindowTitleLabel[^{}]*\{([^}]*)\}", style)
    if not narrow_label or "fill-parent-flow(1)" not in narrow_label.group(1):
        errors.append(".WindowFrame.Narrow .WindowTitleLabel: label does not yield space to the controls")

    # The project rule and its browser witness are part of the shell gate. A test suite that
    # cannot run in-game has to be visible in the minimal browser surface (or the Go shell port);
    # a missing page is a refusal, not a silent pass.
    if not AGENTS.is_file():
        errors.append("AGENTS.md: missing the browser/Go-shell test-witness rule")
    else:
        agents_text = AGENTS.read_text(encoding="utf-8")
        for required in ("browser", "Go shell", "refused"):
            if required.lower() not in agents_text.lower():
                errors.append(f"AGENTS.md: test-witness rule does not name '{required}'")
    if not WITNESS.is_file():
        errors.append("docs/shell-test-surface.html: no browser witness; run tools/shell_test_surface.py")
    else:
        witness = WITNESS.read_text(encoding="utf-8")
        for suite in ("chrome-test", "dashboard-test", "layout-arbitration", "static-check"):
            if f'data-suite="{suite}"' not in witness:
                errors.append(f"shell-test-surface.html: no card for '{suite}'")

    # Optional package envelope, the axis security slice: all four package surfaces must be
    # readable and none may be refused by name. Unsigned is the openlock opt-in default and is
    # not an error; a signed package that does not hold must never reach the shell data.
    sys.path.insert(0, str(ROOT / "tools"))
    import package_envelope  # local import: the checker runs with tools/ off sys.path otherwise

    surfaces = package_envelope.check_surfaces(ROOT)
    if len(surfaces) != 4:
        errors.append(f"package envelope: read {len(surfaces)} surface(s), expected 4")
    for row in surfaces:
        if row["state"] == "refused":
            reason = row["refusals"][0]["kind"] if row["refusals"] else "refused"
            errors.append(f"{row['file']}: package envelope refused by name ({reason})")
        elif row["state"] not in ("signed", "unsigned"):
            errors.append(
                f"{row['file']}: package envelope state '{row['state']}' is not signed or unsigned"
            )
    generator = (ROOT / "tools" / "gen_shell_data.py").read_text(encoding="utf-8")
    for required in ("import package_envelope", "read_envelopes", 'recipe["envelopes"]'):
        if required not in generator:
            errors.append(f"gen_shell_data.py: the package envelope is not wired ({required})")

    # Wishes are the plan the refusals are verdicts on. Every generated wish names a load, its
    # surface and its state; the package declares a window for the list and the shell renders it.
    # A wish list that stopped being generated is a refusal, not an empty window.
    data_path = ROOT / "clientaddon" / "panorama" / "scripts" / "openlock_shell_data.js"
    try:
        payload = json.loads(data_path.read_text(encoding="utf-8").split("var SHELL = ", 1)[1].rstrip().rstrip(";"))
    except (OSError, IndexError, json.JSONDecodeError) as error:
        errors.append(f"openlock_shell_data.js: unreadable shell payload ({error})")
        payload = {}
    wishes = payload.get("wishes") or []
    if not wishes:
        errors.append("openlock_shell_data.js: no wishes; the plan beside the refusals is missing")
    allowed_states = {"loaded", "planned", "missing", "differs", "refused"}
    for wish in wishes:
        if wish.get("state") not in allowed_states:
            errors.append(f"wishes: '{wish.get('id')}' has state '{wish.get('state')}'")
        for field in ("surface", "plan", "why"):
            if field not in wish:
                errors.append(f"wishes: '{wish.get('id')}' is missing {field}")
    kinds = {wish.get("kind") for wish in wishes}
    for required in ("package", "store"):
        if required not in kinds:
            errors.append(f"wishes: no '{required}' wish is generated")
    wish_window = next((row for row in payload.get("windows", []) if row.get("id") == "wishes"), None)
    if not wish_window:
        errors.append("package.shspec: no 'wishes' window")
    elif wish_window.get("view") != "wishes":
        errors.append("package.shspec: 'wishes' window does not resolve to the shell's own renderer")
    for required in ('if (kind === "wishes")', 'OpenlockToast("Wishes"'):
        if required not in script:
            errors.append(f"openlock_shell.js: the wish surface is not rendered ({required})")
    if "def build_wishes" not in generator or 'recipe["wishes"]' not in generator:
        errors.append("gen_shell_data.py: wishes are not generated from the package and the store manifest")

    # The installer window is the surface that asks whether to add the installer to a compatible
    # install. It only exists if install.ps1 still shows the prompt and the reading tool is present.
    pair_tool = ROOT / "tools" / "installer_pair.py"
    if not pair_tool.is_file():
        errors.append("tools/installer_pair.py: the installer pair reader is missing")
    else:
        pair_text = pair_tool.read_text(encoding="utf-8")
        for required in ("--apply", "def seed", "compatible"):
            if required not in pair_text:
                errors.append(f"installer_pair.py: the consent-gated seed is not wired ({required})")
    installer_text = (ROOT / "install.ps1").read_text(encoding="utf-8", errors="replace")
    for required in ("function Invoke-InstallerSeedPrompt", "installer_pair.py",
                     "Add to checked", "SetItemChecked"):
        if required not in installer_text:
            errors.append(f"install.ps1: the installer window does not offer the pair ({required})")

    # The context menu must paint above every window layer, not inside one of them.
    for selector in (".ContextDismiss", ".ContextMenu"):
        match = re.search(re.escape(selector) + r"\s*\{([^}]*)\}", style)
        if not match:
            errors.append(f"{selector}: missing style block")
        else:
            z = re.search(r"z-index:\s*(\d+)", match.group(1))
            if not z or int(z.group(1)) < 800:
                errors.append(f"{selector}: does not paint above the taskbar")

    # A dashboard row is the only way to open a named window from the list. It must be its own
    # control: the Label carries the row's text (which is its name), takes the pointer itself, and
    # owns the activation handler. A row rebuilt as an unnamed Panel with a hit-test-disabled label
    # is addressable only by position, which is the defect this rule protects. Narrow on purpose:
    # it reads the row builder and the declared-window list, not unrelated panels.
    row_match = re.search(r"function actionRow\s*\([^)]*\)\s*\{(.*?)\n    \}", script, re.S)
    if not row_match:
        errors.append("actionRow: the dashboard row builder is missing")
    else:
        body = row_match.group(1)
        for needle, why in (
            ('$.CreatePanel("Label"', "the row is not a Label and carries no text of its own"),
            ("row.text = text", "the row has no text, so it has no name"),
            ("row.hittest = true", "the row is not hit-testable"),
            ('row.SetPanelEvent("onmouseactivate"', "the row has no activation handler"),
        ):
            if needle not in body:
                errors.append("actionRow: " + why)

    declared = re.search(r"headingXd\(body, \"declared windows", script)
    if not declared:
        errors.append("dashboard: the declared-window list is missing")
    else:
        window = script[declared.start():declared.start() + 1400]
        if "actionRow(" not in window:
            errors.append("dashboard: declared-window rows do not use actionRow")
        if re.search(r"actionXd\(body, \(active", window):
            errors.append("dashboard: a declared-window row regressed to an unnamed action panel")

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

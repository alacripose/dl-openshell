#!/usr/bin/env python3
"""Generate the shell's Panorama colour schemes from `.theme` declarations.

A scheme is a palette plus a list of painting rules. The game's own palette is read from its
compiled `citadel_base_styles.vcss_c` at generation time, so a Deadlock update moves the shell
with it instead of leaving a copied hex behind.

Extensions
----------
A `.theme` file with an `extends` row is an extension, not a new scheme. Extensions are applied
to their base in `load-order` order (lowest first, last writer wins), so a mod can retheme the
whole shell, or only the pieces it names, without forking the base scheme. Mounted addons are
scanned for `panorama/schemes/*.theme`: loose directories and VPK archives both work, and the
scan is driven by the game's own `gameinfo.gi` search paths. No server runtime is involved.

Rules
-----
    rule\t<selector>\t<property>\t<value>

A rule may paint a shell element (`.WindowTitle`) or a real game element
(`.CitadelHudTopBar`). Values are hex, `@defineName` from the running game, or `role:<slot>` so
an extension can follow whichever scheme is active. Selectors and properties are allowlisted:
a theme is data, never a stylesheet that can escape its declaration.

The generated CSS is scoped to one class on the shell root and one on the game's HUD root. A
scheme with no rules (the game's default) therefore leaves the actual Deadlock UI untouched.

Usage:
    python tools/gen_shell_theme.py [package-dir] [gameinfo]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "shell" / "alpha-shell"
GAMEINFO = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(
    r"D:/SteamLibrary/steamapps/common/Deadlock/game/citadel/gameinfo.gi"
)
OUTPUT = ROOT / "clientaddon" / "panorama" / "styles" / "openlock_schemes.css"

HEADER = "shploingus.theme/1"

REQUIRED = [
    "body",
    "panel",
    "title",
    "meta",
    "border",
    "borderStrong",
    "ink",
    "muted",
    "accent",
    "alert",
    "alertBody",
]

# Slots the Palette window lets a player repaint one at a time, with the values each click
# steps through. Popit's five are the suite's own tool colours; the wheel's seven are the
# spectral primaries. Every theme exposes the same slot names, so one editor covers all forms.
PALETTE_SLOTS = [
    ("body", "Window body", ["#F4E7C8", "#EADBB4", "#CFE6E4", "#FFD9CE", "#2A2422"]),
    ("panel", "Panel", ["#FFF8E8", "#E8DCC0", "#BFD8E8", "#F6C8B8", "#3A312D"]),
    ("accent", "Accent", ["#6FBF3F", "#4F9E2F", "#8FD95A", "#2E7DFF", "#FF8A00"]),
    ("alert", "Alert", ["#E0452F", "#FF8A00", "#FFD500", "#FF2300", "#C0362A"]),
    ("ink", "Ink", ["#2A2422", "#3A312D", "#121212", "#4A3F38", "#FFF8E8"]),
    ("border", "Rule", ["#2A2422", "#4A3F38", "#8A7F70", "#6FBF3F", "#FFD500"]),
    ("muted", "Muted ink", ["#7A6F62", "#8A7F70", "#5A5148", "#B8A894", "#CFC4B4"]),
]

HEX = re.compile(r"^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")
DEFINE = re.compile(r"@define\s+([A-Za-z0-9_]+)\s*:\s*(#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?)\s*;")
SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
NUMBER = re.compile(r"^(0(\.\d+)?|1(\.0+)?)$")

# A theme can paint colours and opacity only. No layout, no URLs, no resource references: a mod
# theme is data and must not be able to load a file, move a window or hide a control.
SAFE_PROPERTIES = {
    "color",
    "background-color",
    "border-color",
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
    "wash-color",
    "opacity",
}

# A class selector, optionally with a descendant/child chain. The leading dot is required, and
# characters that could terminate the declaration or start another rule are not accepted.
SELECTOR = re.compile(r"^\.[A-Za-z0-9_][A-Za-z0-9_.#:> -]*$")


class ThemeFile:
    def __init__(self, display: str):
        self.display = display
        self.id = ""
        self.label = ""
        self.source = ""
        self.form = ""
        self.renderer = ""
        self.extends = ""
        self.load_order: int | None = None
        self.slots: dict[str, str] = {}
        self.slot_lines: dict[str, int] = {}
        self.rules: list[dict] = []
        self.line = 1

    @property
    def name(self) -> str:
        return self.display


def parse_theme_text(
    text: str,
    display: str,
    source_label: str = "",
    default_load_order: int = 0,
) -> ThemeFile:
    theme = ThemeFile(display)
    lines = text.splitlines()
    if not lines or lines[0].strip() != HEADER:
        raise ValueError(f"{display}:1: expected {HEADER}, not {lines[0] if lines else '<empty>'!r}")

    for index, raw in enumerate(lines[1:], start=2):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        # Tab-indented fields are the canonical form; the same key at column zero is accepted
        # too, so a theme that loses its indentation in an editor still paints instead of being
        # silently ignored. `theme` is the only column-zero header.
        top_key = raw.split("\t", 1)[0].strip()
        if raw.startswith("\t") or top_key in (
            "rule", "extends", "load-order", "label", "source", "form", "renderer", *REQUIRED,
        ):
            parts = [part.strip() for part in raw.strip().split("\t")]
            if not parts or not parts[0]:
                continue
            key = parts[0]
            value = parts[1] if len(parts) > 1 else ""

            if key == "rule":
                if len(parts) < 4:
                    raise ValueError(f"{display}:{index}: rule needs selector, property and value")
                theme.rules.append(
                    {"selector": parts[1], "property": parts[2], "value": parts[3], "line": index}
                )
                continue
            if key == "extends":
                theme.extends = value
                continue
            if key == "load-order":
                if not value.isdigit():
                    raise ValueError(f"{display}:{index}: load-order '{value}' is not an integer")
                theme.load_order = int(value)
                continue
            if key == "label":
                theme.label = value
                continue
            if key == "source":
                theme.source = value
                continue
            if key == "form":
                # The form is the chrome language (geometry, borders, glyph shape). It is a
                # separate axis from the palette: any form composes with any colour theme.
                theme.form = value
                continue
            if key == "renderer":
                # Which surface renderer the shell uses for this scheme. `popit` is the LBP
                # suite port; `generic` is the fallback that keeps working if the port is
                # unavailable. It is independent of the chrome form and the palette.
                theme.renderer = value
                continue
            if key not in REQUIRED:
                # An unknown slot is ignored rather than guessed at; the generator only paints
                # roles it knows, and a typo must not silently become a colour.
                continue
            theme.slots[key] = value
            theme.slot_lines[key] = index
            continue

        fields = [field.strip() for field in raw.split("\t")]
        if fields and fields[0] == "theme" and len(fields) >= 2:
            theme.id = fields[1]
            theme.label = fields[2] if len(fields) > 2 else fields[1]
            theme.line = index

    if not theme.id:
        raise ValueError(f"{display}:1: no theme id")
    if not SLUG.match(theme.id):
        raise ValueError(f"{display}:{theme.line}: theme id {theme.id!r} is not a lowercase slug")
    if theme.extends and not SLUG.match(theme.extends):
        raise ValueError(f"{display}:{theme.line}: extends {theme.extends!r} is not a lowercase slug")
    if theme.form and not SLUG.match(theme.form):
        raise ValueError(f"{display}:{theme.line}: form {theme.form!r} is not a lowercase slug")
    if theme.renderer and theme.renderer not in ("generic", "popit"):
        raise ValueError(f"{display}:{theme.line}: renderer {theme.renderer!r} is not generic or popit")
    if not theme.label:
        theme.label = theme.id
    if not theme.source:
        theme.source = source_label or display
    if theme.load_order is None:
        theme.load_order = default_load_order
    return theme


def parse_theme(path: Path, source_label: str = "", default_load_order: int = 0) -> ThemeFile:
    return parse_theme_text(
        path.read_text(encoding="utf-8", errors="replace"),
        f"themes/{path.name}",
        source_label,
        default_load_order,
    )


def game_defines(gameinfo: Path) -> tuple[dict[str, str], list[dict]]:
    """Every hex `@define` in the game's baseline styles, or one refusal explaining why not."""
    citadel = gameinfo.parent
    vpk = citadel / "pak01_dir.vpk"
    if not vpk.exists():
        return {}, [
            {
                "file": "themes/deadlock.theme",
                "line": 1,
                "subject": "deadlock",
                "why": f"game style archive not found at '{vpk}'",
            }
        ]

    try:
        import vpk_read

        data = vpk_read.read_entry(str(vpk), "panorama/styles/citadel_base_styles.vcss_c")
    except Exception as error:  # a bad archive is a refusal with its own reason, not a crash
        return {}, [
            {
                "file": "themes/deadlock.theme",
                "line": 1,
                "subject": "deadlock",
                "why": f"cannot read citadel_base_styles.vcss_c: {error}",
            }
        ]

    if not data:
        return {}, [
            {
                "file": "themes/deadlock.theme",
                "line": 1,
                "subject": "deadlock",
                "why": "citadel_base_styles.vcss_c is absent from the game archive",
            }
        ]

    text = data.decode("latin-1", "replace")
    defines = {match.group(1): match.group(2) for match in DEFINE.finditer(text)}
    return defines, []


def with_alpha(colour: str, alpha: str) -> str:
    """A scheme colour with a different alpha byte; literal slots are 6 or 8 digit hex."""
    base = colour[1:7].upper()
    return f"#{base}{alpha.upper()}"


def resolve_slots(theme: ThemeFile, defines: dict[str, str], required: bool) -> tuple[dict[str, str], list[dict]]:
    roles: dict[str, str] = {}
    refusals: list[dict] = []
    names = REQUIRED if required else [slot for slot in theme.slots if slot in REQUIRED]

    for slot in names:
        value = theme.slots.get(slot)
        line = theme.slot_lines.get(slot, theme.line)
        if not value:
            refusals.append(
                {
                    "file": theme.name,
                    "line": theme.line,
                    "subject": f"{theme.id}/{slot}",
                    "why": "slot is not declared; a scheme never invents a colour",
                }
            )
            continue

        if value.startswith("@"):
            token = value[1:]
            resolved = defines.get(token)
            if not resolved:
                refusals.append(
                    {
                        "file": theme.name,
                        "line": line,
                        "subject": f"{theme.id}/{slot}",
                        "why": f"the running game declares no @{token}",
                    }
                )
                continue
            value = resolved

        if not HEX.match(value):
            refusals.append(
                {
                    "file": theme.name,
                    "line": line,
                    "subject": f"{theme.id}/{slot}",
                    "why": f"'{value}' is not a six- or eight-digit hex colour",
                }
            )
            continue

        roles[slot] = value.upper()

    return roles, refusals


def resolve_rules(theme: ThemeFile, defines: dict[str, str]) -> tuple[list[dict], list[dict]]:
    """Validate a theme's rules. Values may name a role so they follow the patched scheme."""
    rules: list[dict] = []
    refusals: list[dict] = []

    for rule in theme.rules:
        selector = rule["selector"]
        prop = rule["property"]
        value = rule["value"]
        line = rule["line"]
        subject = f"{theme.id}/{selector}"

        if not SELECTOR.match(selector) or any(ch in selector for ch in "{},;()@\\"):
            refusals.append(
                {
                    "file": theme.name,
                    "line": line,
                    "subject": subject,
                    "why": f"selector '{selector}' is not a plain class selector",
                }
            )
            continue

        if prop not in SAFE_PROPERTIES:
            refusals.append(
                {
                    "file": theme.name,
                    "line": line,
                    "subject": subject,
                    "why": f"property '{prop}' is not one of the scheme's painting properties",
                }
            )
            continue

        if value.startswith("role:"):
            role = value[5:]
            if role not in REQUIRED:
                refusals.append(
                    {
                        "file": theme.name,
                        "line": line,
                        "subject": subject,
                        "why": f"role '{role}' is not a scheme slot",
                    }
                )
                continue
            rules.append({"selector": selector, "property": prop, "role": role, "line": line})
            continue

        if value.startswith("@"):
            token = value[1:]
            resolved = defines.get(token)
            if not resolved:
                refusals.append(
                    {
                        "file": theme.name,
                        "line": line,
                        "subject": subject,
                        "why": f"the running game declares no @{token}",
                    }
                )
                continue
            value = resolved

        if prop == "opacity":
            if not NUMBER.match(value):
                refusals.append(
                    {
                        "file": theme.name,
                        "line": line,
                        "subject": subject,
                        "why": f"opacity '{value}' is not between 0 and 1",
                    }
                )
                continue
        elif not HEX.match(value):
            refusals.append(
                {
                    "file": theme.name,
                    "line": line,
                    "subject": subject,
                    "why": f"'{value}' is not a six- or eight-digit hex colour",
                }
            )
            continue

        rules.append({"selector": selector, "property": prop, "value": value.upper(), "line": line})

    return rules, refusals


def resolve_theme(theme: ThemeFile, defines: dict[str, str]) -> tuple[dict[str, str], list[dict]]:
    roles, refusals = resolve_slots(theme, defines, required=True)
    rules, rule_refusals = resolve_rules(theme, defines)
    theme.rules = rules
    refusals.extend(rule_refusals)
    if not refusals:
        roles["accentSoft"] = with_alpha(roles["accent"], "22")
        roles["accentStrong"] = with_alpha(roles["accent"], "55")
        roles["borderSoft"] = with_alpha(roles["border"], "66")
    return roles, refusals


def apply_extension(
    base: ThemeFile, extension: ThemeFile, defines: dict[str, str]
) -> tuple[dict[str, str], list[dict], list[dict]]:
    slots, refusals = resolve_slots(extension, defines, required=False)
    rules, rule_refusals = resolve_rules(extension, defines)
    refusals.extend(rule_refusals)
    return slots, rules, refusals


# Selector -> (CSS property, role). One table is the whole shell surface: a new shell element
# with a colour belongs here once, or it keeps the hard-coded layout palette and visibly leaves
# the scheme.
RULES: list[tuple[str, list[tuple[str, str]]]] = [
    # The launcher is transparent until hover so the game's top-left logo remains visible.
    (".LauncherButton:hover", [("background-color", "title"), ("border-color", "borderStrong")]),
    (".LauncherLabel", [("color", "accent")]),
    (".Clock", [("background-color", "panel"), ("border-color", "border"), ("color", "accent")]),
    (".VersionLabel", [("background-color", "meta"), ("border-color", "border"), ("color", "muted")]),
    (".ShellTab", [("background-color", "panel"), ("border-color", "border")]),
    (".ShellTab:hover", [("border-color", "borderStrong")]),
    (".ShellTab .ShellTabLabel", [("color", "ink")]),
    (".ShellTab.Active", [("background-color", "title"), ("border-color", "borderStrong")]),
    (".ShellTab.Active .ShellTabLabel", [("color", "ink")]),
    (".ShellTab.Pinned .ShellTabLabel", [("color", "accent")]),
    (".WindowFrame", [("background-color", "body"), ("border-color", "border")]),
    (".WindowFrame.Focused", [("border-color", "borderStrong")]),
    (".WindowFrame.Pinned", [("border-color", "accent")]),
    (".WindowTitle", [("background-color", "title"), ("border-bottom-color", "border")]),
    (".WindowTitleLabel", [("color", "ink")]),
    (".WindowButton", [("background-color", "panel"), ("border-color", "border")]),
    (".WindowButton:hover", [("border-color", "borderStrong")]),
    (".WindowButton Label", [("color", "accent")]),
    (".WindowGlyph", [("color", "accent")]),
    (".WindowButton.PinOn", [("background-color", "title"), ("border-color", "accent")]),
    (".IconBar", [("background-color", "accent")]),
    (".IconHalf", [("background-color", "accent")]),
    (".IconPinHead", [("background-color", "accent")]),
    (".IconPinStem", [("background-color", "accent")]),
    (".IconLeft", [("border-color", "accent")]),
    (".IconRight", [("border-color", "accent")]),
    (".WindowMeta", [("background-color", "meta"), ("border-bottom-color", "border")]),
    (".WindowMetaLabel", [("color", "muted")]),
    (".WindowBody", [("color", "ink")]),
    (".ViewHeading", [("color", "accent")]),
    (".ViewLine", [("color", "ink")]),
    (".ViewMuted", [("color", "muted")]),
    (".ViewAction", [("background-color", "panel"), ("border-color", "border")]),
    (".ViewAction:hover", [("background-color", "title"), ("border-color", "borderStrong")]),
    (".ViewAction Label", [("color", "accent")]),
    (".ConsoleEntry", [("background-color", "meta"), ("border-color", "border"), ("color", "ink")]),
    (".ConsoleEntry:focus", [("border-color", "borderStrong")]),
    (".UiFieldLabel", [("color", "muted")]),
    (".ContextMenu", [("background-color", "body"), ("border-color", "borderStrong")]),
    (".ContextTitle", [("color", "muted")]),
    (".DwellInfo", [("background-color", "body"), ("border-color", "border")]),
    (".DwellTitle", [("color", "ink")]),
    (".DwellBody", [("color", "muted")]),
    (".WindowRefusal", [("background-color", "alertBody"), ("border-top-color", "alert"), ("color", "alert")]),
    (".PanelWindow", [("border-color", "border")]),
    (".PanelWindow.Focused", [("border-color", "borderStrong")]),
    (".PanelWindow.Pinned", [("border-color", "accent")]),
    (".PanelWindow .WindowTitle", [("background-color", "title")]),
    (".PanelWindow .WindowMeta", [("background-color", "meta")]),
    (".PanelWindow .WindowRefusal", [("background-color", "alertBody")]),
    (".ResizeGrip", [
        ("background-color", "border"),
        ("border-top-color", "borderStrong"),
        ("border-left-color", "borderStrong"),
    ]),
    (".ResizeGrip:hover", [("background-color", "borderStrong")]),
    (".DropCell", [("background-color", "accentSoft"), ("border-color", "borderSoft")]),
    (".DropCell:hover", [("background-color", "accentStrong"), ("border-color", "borderStrong")]),
    (".Toast", [
        ("background-color", "title"),
        ("border-color", "border"),
        ("border-left-color", "accent"),
    ]),
    (".Toast.Attention", [("border-left-color", "alert")]),
    (".ToastTitle", [("color", "ink")]),
    (".ToastBody", [("color", "muted")]),
    (".UpdateModal", [("background-color", "body"), ("border-color", "borderStrong")]),
    (".UpdateTitle", [("color", "accent")]),
    (".UpdateBody", [("color", "ink")]),
    (".UpdateCountdown", [("color", "muted")]),
    (".SchemeButton", [("background-color", "panel"), ("border-color", "border")]),
    (".SchemeButton:hover", [("border-color", "borderStrong")]),
    (".SchemeLabel", [("color", "accent")]),
    # The Popit contextual tool surface: the tools belong to the window, so they paint with the
    # same roles as its chrome. Shape rules live in forms/popit.form; these are colour only, so a
    # frame variant can change its silhouette without a theme being able to override it.
    (".PopitDismiss", [("background-color", "borderStrong")]),
    (".PopitPlate", [("background-color", "body"), ("border-color", "border")]),
    (".PopitTail", [("background-color", "body"), ("border-color", "borderStrong")]),
    (".PopitHexEdge", [("background-color", "border")]),
    (".PopitHeaderTitle", [("color", "ink")]),
    (".PopitFrameBadge", [("background-color", "panel"), ("border-color", "border")]),
    (".PopitFrameBadge Label", [("color", "muted")]),
    (".PopitModePill", [("background-color", "panel"), ("border-color", "border")]),
    (".PopitMode", [("color", "muted")]),
    (".PopitMode.Active", [("background-color", "accent"), ("color", "ink")]),
    (".PopitTile", [("background-color", "panel"), ("border-color", "border")]),
    (".PopitTile.Hover", [("background-color", "title"), ("border-color", "borderStrong")]),
    (".PopitTile.Selected", [("background-color", "title"), ("border-color", "accent")]),
    (".PopitTileLabel", [("color", "ink")]),
    (".PopitTile.Selected .PopitTileLabel", [("color", "accent")]),
    (".PopitDetail", [("color", "ink")]),
    (".PopitHint", [("color", "muted")]),
    (".PopitBeam", [("background-color", "accent")]),
    (".IconPopitDot", [("background-color", "accent")]),
    (".PerfGraph", [("background-color", "meta"), ("border-color", "border")]),
    (".PerfBar", [("background-color", "accent")]),
    (".PerfBar.Slow", [("background-color", "alert")]),
    (".PerfValue", [("color", "ink")]),
    (".PerfMuted", [("color", "muted")]),
    (".PickerHighlight", [("border-color", "borderStrong")]),
    (".PickerBadge", [("background-color", "body"), ("border-color", "border")]),
    (".PickerBadgeLabel", [("color", "ink")]),
    (".PickerCancel", [("background-color", "panel"), ("border-color", "border")]),
    (".PickerCancel Label", [("color", "accent")]),
    # The Palette editor is a schema view: one row per editable role, with the scheme's own
    # value on the row. The swatch's fill is inline (the chosen colour), not a scheme role.
    (".PaletteRow", [("background-color", "meta"), ("border-color", "border")]),
    (".PaletteName", [("color", "ink")]),
    (".PaletteValue", [("color", "muted")]),
    (".PaletteNote", [("color", "muted")]),
    (".PaletteReset", [("background-color", "panel"), ("border-color", "border")]),
    (".PaletteReset Label", [("color", "accent")]),
    (".PickerTarget", [("color", "accent")]),
    (".PickerHint", [("color", "muted")]),
]



# The chrome form is the second axis. A scheme names one form; the client puts both classes on
# the shell root, so palette and geometry compose without a second copy of every rule. Values
# below are bucket-labelled the way `voxel-ui` labels its constants: an MD1 rule is cited to MD1,
# a platform translation is ours (the pointer target is 20 dp, not the platform's 44/48 dp touch
# target), and a project extension is named as one rather than passed off as a platform value.
# No form here paints a colour: `openlock_schemes.css` above owns colour for every form.
FORM_LABELS = {
    "material": "Material Design 1",
    "ios": "iOS 6 SpringBoard",
    "touchwiz": "TouchWiz Nature UX",
    "popit": "Popit (LBP3)",
}

FORM_CSS: dict[str, list[str]] = {
    # MD1: 2 dp radius, 8 dp grid, 48 dp row. The desktop shell keeps 30 dp chrome (project
    # extension: a pointer bar is not a 48 dp touch row), but the 2 dp radius and the 8 dp
    # rhythm are the spec's own values.
    "material": [
        ".FormMaterial .WindowFrame { border-radius: 2px; }",
        ".FormMaterial .WindowTitle { height: 30px; padding-left: 8px; padding-right: 4px; }",
        ".FormMaterial .WindowTitleLabel { margin-left: 26px; font-size: 13px; }",
        ".FormMaterial .WindowButton { width: 20px; height: 20px; margin-right: 4px; border-radius: 10px; }",
        ".FormMaterial .WindowButton Label { font-size: 12px; }",
        ".FormMaterial .WindowMeta { height: 16px; padding-left: 8px; }",
        ".FormMaterial .WindowBody { padding: 8px; }",
        ".FormMaterial .Taskbar { height: 30px; }",
        ".FormMaterial .TabStrip { margin-left: 96px; }",
        ".FormMaterial .PreloadStrip { margin-left: 96px; }",
        ".FormMaterial .ShellTab { margin-right: 4px; padding: 3px 10px; border-radius: 0px; border-bottom-width: 2px; }",
        ".FormMaterial .ShellTab.Active { border-bottom-width: 2px; }",
        ".FormMaterial .LauncherButton { border-radius: 0px; padding: 4px 8px; }",
        ".FormMaterial .SchemeButton { width: 20px; height: 20px; border-radius: 10px; }",
        ".FormMaterial .ViewAction { border-radius: 2px; padding: 6px 12px; }",
        ".FormMaterial .ContextMenu { border-radius: 2px; }",
        ".FormMaterial .Toast { border-left-width: 2px; }",
        ".FormMaterial .DwellInfo { border-radius: 2px; }",
        ".FormMaterial .UpdateModal { border-radius: 2px; }",
        ".FormMaterial .PickerBadge { border-radius: 2px; }",
        ".FormMaterial .PickerCancel { border-radius: 2px; }",
    ],
    # iOS 6 SpringBoard: the chrome is a rounded capsule, the tab strip is a dock. HIG's 44 dp
    # touch target is translated to a 20 dp pointer target; that translation is ours and is
    # named rather than presented as a platform value.
    "ios": [
        ".FormIos .WindowFrame { border-radius: 6px; border-width: 1px; }",
        ".FormIos .WindowTitle { height: 30px; padding-left: 8px; padding-right: 4px; }",
        ".FormIos .WindowTitleLabel { margin-left: 24px; font-size: 12px; letter-spacing: 0.2px; }",
        ".FormIos .WindowButton { width: 18px; height: 16px; margin-right: 5px; border-radius: 8px; }",
        ".FormIos .WindowButton Label { font-size: 11px; }",
        ".FormIos .WindowMeta { height: 14px; padding-left: 8px; }",
        ".FormIos .WindowBody { padding: 8px; }",
        ".FormIos .Taskbar { height: 30px; }",
        ".FormIos .TabStrip { margin-left: 168px; width: 60%; }",
        ".FormIos .PreloadStrip { margin-left: 168px; width: 60%; }",
        ".FormIos .ShellTab { margin-right: 4px; padding: 3px 10px; border-radius: 12px; }",
        ".FormIos .ShellTab.Active { border-radius: 12px; }",
        ".FormIos .LauncherButton { border-radius: 12px; padding: 4px 10px; }",
        ".FormIos .SchemeButton { width: 20px; height: 20px; border-radius: 9px; }",
        ".FormIos .ViewAction { border-radius: 10px; padding: 6px 12px; }",
        ".FormIos .ContextMenu { border-radius: 8px; }",
        # No radius: the toast keeps a 3px accent on one side, and the CSDK10 renderer asserts
        # (source2surface DrawBorder) when a rounded border varies by side.
        ".FormIos .Toast { border-left-width: 3px; }",
        ".FormIos .DwellInfo { border-radius: 6px; }",
        ".FormIos .UpdateModal { border-radius: 8px; }",
        ".FormIos .PickerBadge { border-radius: 8px; }",
        ".FormIos .PickerCancel { border-radius: 10px; }",
    ],
    # TouchWiz Nature UX: a 2 dp frame, 8 dp rounded chips, a brighter 2 dp active edge. The
    # radii and the 2 dp edge are TouchWiz's form; chrome height remains this shell's 30 dp.
    "touchwiz": [
        ".FormTouchwiz .WindowFrame { border-radius: 8px; border-width: 2px; }",
        ".FormTouchwiz .WindowTitle { height: 30px; padding-left: 8px; padding-right: 4px; }",
        ".FormTouchwiz .WindowTitleLabel { margin-left: 26px; font-size: 12px; letter-spacing: 0.3px; }",
        ".FormTouchwiz .WindowButton { width: 22px; height: 18px; margin-right: 5px; border-radius: 3px; }",
        ".FormTouchwiz .WindowButton Label { font-size: 12px; }",
        ".FormTouchwiz .WindowMeta { height: 16px; padding-left: 8px; }",
        ".FormTouchwiz .WindowBody { padding: 8px; }",
        ".FormTouchwiz .Taskbar { height: 30px; }",
        ".FormTouchwiz .TabStrip { margin-left: 96px; }",
        ".FormTouchwiz .PreloadStrip { margin-left: 96px; }",
        ".FormTouchwiz .ShellTab { margin-right: 3px; padding: 4px 10px; border-radius: 4px; border-bottom-width: 2px; }",
        ".FormTouchwiz .ShellTab.Active { border-bottom-width: 2px; }",
        ".FormTouchwiz .LauncherButton { border-radius: 4px; border-width: 2px; padding: 3px 9px; }",
        ".FormTouchwiz .SchemeButton { width: 20px; height: 20px; border-radius: 4px; }",
        ".FormTouchwiz .ViewAction { border-radius: 4px; padding: 6px 12px; }",
        ".FormTouchwiz .ContextMenu { border-radius: 4px; }",
        ".FormTouchwiz .Toast { border-left-width: 3px; }",
        ".FormTouchwiz .DwellInfo { border-radius: 4px; }",
        ".FormTouchwiz .UpdateModal { border-radius: 4px; }",
        ".FormTouchwiz .PickerBadge { border-radius: 4px; }",
        ".FormTouchwiz .PickerCancel { border-radius: 4px; }",
    ],
    # Popit: LBP3's rounded slab (the shape people call the Nexus 5 window), 10 dp corners,
    # a 2 dp card edge and circular tool buttons. The proportions are the suite's; the
    # pointer-sized 30 dp chrome is this shell's translation and is named as such.
    "popit": [
        ".FormPopit.RendererPopit .WindowFrame { border-radius: 34px 34px 12px 12px; border-width: 2px; }",
        ".FormPopit .WindowFrame { border-radius: 10px; border-width: 2px; }",
        ".FormPopit .WindowTitle { height: 30px; padding-left: 10px; padding-right: 6px; border-top-left-radius: 8px; border-top-right-radius: 8px; }",
        ".FormPopit .WindowTitleLabel { margin-left: 24px; font-size: 13px; letter-spacing: 0.4px; }",
        ".FormPopit .WindowButton { width: 20px; height: 20px; margin-right: 4px; border-radius: 10px; border-width: 2px; }",
        ".FormPopit .WindowButton Label { font-size: 12px; }",
        ".FormPopit .WindowMeta { height: 16px; padding-left: 10px; border-bottom-width: 2px; }",
        ".FormPopit .WindowBody { padding: 8px; }",
        ".FormPopit .Taskbar { height: 30px; }",
        ".FormPopit .TabStrip { margin-left: 96px; }",
        ".FormPopit .PreloadStrip { margin-left: 96px; }",
        ".FormPopit .ShellTab { margin-right: 4px; padding: 4px 12px; border-radius: 10px; border-width: 2px; }",
        ".FormPopit .ShellTab.Active { border-radius: 10px; }",
        ".FormPopit .LauncherButton { border-radius: 10px; border-width: 2px; padding: 3px 9px; }",
        ".FormPopit .SchemeButton { width: 20px; height: 20px; border-radius: 10px; border-width: 2px; }",
        ".FormPopit .ViewAction { border-radius: 10px; padding: 6px 12px; }",
        ".FormPopit .ContextMenu { border-radius: 10px; }",
        ".FormPopit .Toast { border-left-width: 4px; }",
        ".FormPopit .DwellInfo { border-radius: 10px; }",
        ".FormPopit .UpdateModal { border-radius: 10px; }",
        ".FormPopit .PopitNode { border-radius: 50%; }",
        ".FormPopit .PickerBadge { border-radius: 8px; }",
        ".FormPopit .PickerCancel { border-radius: 10px; }",
    ],
}


# Window geometry is a schema, not a palette property. A form file declares shape rows only;
# the .theme file declares colour slots only. Popit is the default form, so its shape can be
# edited without touching any palette, and a colour scheme can be swapped without changing it.
FORM_HEADER = "shploingus.form/1"
FORM_SAFE_PROPERTIES = {
    "border-radius", "border-width", "border-top-left-radius", "border-top-right-radius",
    "border-bottom-left-radius", "border-bottom-right-radius", "height", "width",
    "padding", "padding-left", "padding-right", "padding-top", "padding-bottom",
    "margin", "margin-left", "margin-right", "margin-top", "margin-bottom", "font-size",
    "letter-spacing", "min-width",
    "min-height", "max-width", "max-height", "background-color", "border-color",
    "border-bottom-width", "border-top-width", "border-left-width", "border-right-width",
    "horizontal-align", "vertical-align", "flow-children", "text-align", "font-weight",
    # Frame schemas need a silhouette, not just a rounded rectangle. Panorama has no
    # `position: absolute`; overlay segments use ignore-parent-flow plus one of the normal
    # alignment properties. These remain shape properties: a form can move or rotate one of
    # its own Popit frame segments, but it cannot paint with a palette role or load a resource.
    "ignore-parent-flow", "transform", "pre-transform-rotate2d", "visibility",
}


def form_class(form: str) -> str:
    return "Form" + str(form).replace("-", " ").replace("_", " ").title().replace(" ", "")


def load_forms(directory: Path) -> tuple[dict[str, dict], list[dict]]:
    forms: dict[str, dict] = {}
    refusals: list[dict] = []
    if not directory.is_dir():
        return forms, refusals

    for path in sorted(directory.glob("*.form")):
        display = f"forms/{path.name}"
        rows = path.read_text(encoding="utf-8", errors="replace").splitlines()
        if not rows or rows[0].strip() != FORM_HEADER:
            refusals.append({"file": display, "line": 1, "subject": path.stem,
                             "why": f"expected {FORM_HEADER}"})
            continue
        form_id = ""
        label = ""
        renderer = "generic"
        rules: list[dict] = []
        for index, raw in enumerate(rows[1:], start=2):
            if not raw.strip() or raw.lstrip().startswith("#"):
                continue
            parts = [part.strip() for part in raw.strip().split("\t")]
            if not parts:
                continue
            if parts[0] == "form" and len(parts) > 1:
                form_id = parts[1]
                continue
            if parts[0] == "label" and len(parts) > 1:
                label = parts[1]
                continue
            if parts[0] == "renderer" and len(parts) > 1:
                renderer = parts[1]
                continue
            if parts[0] != "rule" or len(parts) < 4:
                continue
            selector, prop, value = parts[1], parts[2], parts[3]
            when = parts[4] if len(parts) > 4 else ""
            if when not in ("", "popit", "generic"):
                refusals.append({"file": display, "line": index, "subject": form_id or path.stem,
                                 "why": f"renderer condition '{when}' is not popit or generic"})
                continue
            if not SELECTOR.match(selector) or prop not in FORM_SAFE_PROPERTIES:
                refusals.append({"file": display, "line": index, "subject": form_id or path.stem,
                                 "why": f"rule '{selector} / {prop}' is not a shape property"})
                continue
            if any(token in value.lower() for token in ("url(", "expression", "@")):
                refusals.append({"file": display, "line": index, "subject": form_id or path.stem,
                                 "why": "a form value cannot load a resource"})
                continue
            rules.append({"selector": selector, "property": prop, "value": value, "when": when})
        if not form_id or not SLUG.match(form_id):
            refusals.append({"file": display, "line": 1, "subject": path.stem,
                             "why": "form id is missing or not a lowercase slug"})
            continue
        if renderer not in ("generic", "popit"):
            refusals.append({"file": display, "line": 1, "subject": form_id,
                             "why": f"renderer '{renderer}' is not generic or popit"})
            continue
        forms[form_id] = {"id": form_id, "label": label or form_id, "renderer": renderer, "rules": rules}
    return forms, refusals


def css_comment(text: str) -> str:
    """A theme label/source is data, not a stylesheet: it must not close the comment it sits in."""
    value = re.sub(r"[\r\n]+", " ", str(text))
    return value.replace("/*", "/ *").replace("*/", "* /")[:240]


def scheme_class(theme_id: str) -> str:
    # Keep this identical to schemeClass() in openlock_shell.js: hyphens and underscores both
    # start a new word, so `my-mod` and `my_mod` become the same class the client adds.
    return "Scheme" + theme_id.replace("-", " ").replace("_", " ").title().replace(" ", "")


def write_css(schemes: list[dict], output: Path | None = None) -> None:
    output = output or OUTPUT
    lines = [
        "/* Generated by tools/gen_shell_theme.py from shell/alpha-shell/themes/.",
        "   Edit a .theme file, not this file. Every selector below is one painting rule;",
        "   the base sheet still owns layout and the non-colour properties.",
        "   The scheme class is on the shell root and on the game HUD root, so a rule can",
        "   reach a real Deadlock element. A scheme with no rules leaves the game untouched. */",
        "",
    ]
    for scheme in schemes:
        roles = scheme["roles"]
        lines.append(f"/* {css_comment(scheme['label'])} — {css_comment(scheme['source'])} */")
        for selector, props in RULES:
            values = []
            for prop, role in props:
                if role in roles:
                    values.append(f"{prop}: {roles[role]};")
            if not values:
                continue
            lines.append(f".{scheme_class(scheme['id'])} {selector} {{")
            for value in values:
                lines.append(f"    {value}")
            lines.append("}")
        # A panel window's frame is chrome over a live game panel, never a second body.
        lines.append(f".{scheme_class(scheme['id'])} .WindowFrame.PanelWindow {{")
        lines.append("    background-color: transparent;")
        lines.append("}")

        for rule in scheme.get("rules", []):
            if "role" in rule:
                if rule["role"] not in roles:
                    continue
                value = roles[rule["role"]]
            else:
                value = rule["value"]
            lines.append(f".{scheme_class(scheme['id'])} {rule['selector']} {{")
            lines.append(f"    {rule['property']}: {value};")
            lines.append("}")
        lines.append("")

    # Shape schema first, legacy table second. The .form files are the default package's own
    # geometry; the table remains only so an older package without forms/ still renders.
    schemas, _form_refusals = load_forms(PACKAGE_DIR / "forms")
    for form, schema in schemas.items():
        lines.append(f"/* {css_comment(schema['label'])} chrome form (forms/{form}.form). */")
        for rule in schema["rules"]:
            host = f".{form_class(form)}"
            # A renderer-conditioned row only exists when that renderer is active. The base row
            # above it is the generic fallback, so a package without the Popit port still draws a
            # usable window instead of an unstyled one.
            if rule.get("when") == "popit":
                host += ".RendererPopit"
            lines.append(
                f"{host} {rule['selector']} {{ {rule['property']}: {rule['value']}; }}"
            )
        lines.append("")
    if not schemas:
        # Older package without forms/: keep the legacy table as a fallback only.
        for form, block in FORM_CSS.items():
            lines.append(f"/* {FORM_LABELS.get(form, form)} chrome form. */")
            lines.extend(block)
            lines.append("")

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def search_roots(gameinfo: Path) -> list[tuple[str, Path, int]]:
    """The game's own SearchPaths rows, as (label, absolute root, index)."""
    rows: list[tuple[str, Path, int]] = []
    if not gameinfo.exists():
        return rows

    game = gameinfo.parent.parent
    in_block = False
    depth = 0
    order = 0
    for raw in gameinfo.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.split("//", 1)[0].strip()
        if not line:
            continue
        if line.startswith("SearchPaths"):
            in_block = True
            depth = line.count("{") - line.count("}")
            continue
        if not in_block:
            continue
        depth += line.count("{") - line.count("}")
        if depth <= 0:
            in_block = False
            continue
        fields = line.split()
        if len(fields) < 2 or fields[0] not in ("Game", "addonroot"):
            continue
        relative = fields[1].replace("\\", "/")
        candidate = (game / relative).resolve()
        try:
            candidate.relative_to(game.resolve())
        except ValueError:
            # A search path that escapes the game directory is reported by the Mods view and is
            # never followed by a generator that reads arbitrary local files.
            continue
        rows.append((relative, candidate, order))
        order += 1
    return rows


def _vpk_theme_texts(archive: Path) -> list[tuple[str, str]]:
    """Every `panorama/schemes/*.theme` in one VPK, as (entry path, text)."""
    # Numbered parts (`pak01_000.vpk`) are payload, not directory archives; opening one reads the
    # whole part and its signature is not a VPK header. Only directory archives are scanned.
    if re.search(r"_\d{3}\.vpk$", archive.name.lower()):
        return []
    try:
        import vpk_read

        entries, inline = vpk_read.read_tree(str(archive))
    except BaseException:
        # vpk_read reports a malformed archive with SystemExit; a bad addon is a refusal, never
        # a generation crash.
        return []

    found: list[tuple[str, str]] = []
    for entry in entries:
        path = entry["path"]
        if not path.startswith("panorama/schemes/") or not path.endswith(".theme"):
            continue
        blob = inline.get(path)
        if blob is None and entry["archive_index"] != vpk_read.INLINE:
            part = archive.parent / f"pak01_{entry['archive_index']:03d}.vpk"
            try:
                part.resolve().relative_to(archive.parent.resolve())
            except (OSError, ValueError):
                # A numbered part that resolves through a symlink outside the archive directory
                # is not a payload this addon may read.
                blob = None
            else:
                try:
                    with part.open("rb") as handle:
                        handle.seek(entry["off"])
                        blob = handle.read(entry["length"])
                except OSError:
                    blob = None
        if blob is not None:
            found.append((path, blob.decode("utf-8", "replace")))
    return found


def mounted_themes(search_paths: list[dict] | None, gameinfo: Path) -> list[tuple[ThemeFile | None, str, int]]:
    """Theme extensions a mounted addon contributes, in search-path/load order.

    Scans the loose `panorama/schemes` directory of each search-path root and its immediate addon
    children, plus `*.vpk` archives in those places. The source label is relative to the game
    install, so a generated package never carries this machine's absolute path.
    """
    if search_paths is None:
        roots = search_roots(gameinfo)
    else:
        game = gameinfo.parent.parent
        roots = []
        for index, row in enumerate(search_paths):
            relative = str(row.get("path", "")).replace("\\", "/")
            if not relative or not row.get("exists"):
                continue
            candidate = (game / relative).resolve()
            try:
                candidate.relative_to(game.resolve())
            except ValueError:
                continue
            roots.append((relative, candidate, index))

    themes: list[tuple[ThemeFile | None, str, int]] = []
    seen: set[str] = set()

    def add_text(text: str, display: str, source: str, load_order: int) -> None:
        try:
            theme = parse_theme_text(text, display, source, load_order)
        except ValueError as error:
            themes.append((None, str(error), load_order))
            return
        themes.append((theme, source, load_order))

    def add_archive(archive: Path, mount: str, load_order: int) -> None:
        try:
            archive.resolve().relative_to(gameinfo.parent.parent.resolve())
        except (OSError, ValueError):
            # `root.glob('*.vpk')` follows a symlinked archive; one that leaves the install is
            # not a mounted theme source, matching the loose-file and child-directory checks.
            return
        key = str(archive.resolve()).lower()
        if key in seen:
            return
        seen.add(key)
        for entry, text in _vpk_theme_texts(archive):
            add_text(text, f"{mount}:{entry}", mount, load_order)

    for relative, root, index in roots:
        if not root.exists():
            continue
        base_order = 100 + index * 10

        def add_loose(directory: Path, mount: str) -> None:
            try:
                files = sorted(directory.glob("*.theme"))
            except OSError:
                return
            for offset, file in enumerate(files):
                try:
                    file.resolve().relative_to(gameinfo.parent.parent.resolve())
                except (OSError, ValueError):
                    continue
                key = str(file.resolve()).lower()
                if key in seen:
                    continue
                seen.add(key)
                try:
                    text = file.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                add_text(text, f"{mount}/{file.name}", mount, base_order + offset)

        add_loose(root / "panorama" / "schemes", relative)

        try:
            children = sorted(root.iterdir())
        except OSError:
            children = []
        game_root = gameinfo.parent.parent.resolve()
        for child in children:
            try:
                child.resolve().relative_to(game_root)
            except (OSError, ValueError):
                # A symlinked addon that leaves the install is not a mounted theme source.
                continue
            if child.is_dir():
                add_loose(child / "panorama" / "schemes", f"{relative}/{child.name}")
                for archive in sorted(child.glob("*.vpk")):
                    add_archive(archive, f"{relative}/{child.name}/{archive.name}", base_order)
            elif child.suffix.lower() == ".vpk":
                add_archive(child, f"{relative}/{child.name}", base_order)

        for archive in sorted(root.glob("*.vpk")):
            add_archive(archive, f"{relative}/{archive.name}", base_order)

    return themes


def read_order(theme_dir: Path, known: set[str]) -> tuple[list[str], list[dict]]:
    order: list[str] = []
    refusals: list[dict] = []
    path = theme_dir / "order"
    if path.exists():
        for index, raw in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
            value = raw.split("#", 1)[0].strip()
            if not value:
                continue
            if value in known:
                if value not in order:
                    order.append(value)
            else:
                refusals.append(
                    {
                        "file": "themes/order",
                        "line": index,
                        "subject": value,
                        "why": "the order names a scheme that is not available",
                    }
                )
    for theme_id in sorted(known):
        if theme_id not in order:
            order.append(theme_id)
    return order, refusals


def generate(
    package_dir: Path | None = None,
    gameinfo: Path | None = None,
    search_paths: list[dict] | None = None,
    output: Path | None = None,
) -> dict:
    output = output or OUTPUT
    package_dir = package_dir or PACKAGE_DIR
    gameinfo = gameinfo or GAMEINFO
    theme_dir = package_dir / "themes"
    refusals: list[dict] = []

    files = sorted(theme_dir.glob("*.theme")) if theme_dir.exists() else []
    if not files:
        refusals.append(
            {
                "file": "themes",
                "line": 1,
                "subject": "schemes",
                "why": f"no .theme files under '{theme_dir}'",
            }
        )

    defines, define_refusals = game_defines(gameinfo)
    refusals.extend(define_refusals)

    local: list[ThemeFile] = []
    for path in files:
        try:
            local.append(parse_theme(path))
        except ValueError as error:
            refusals.append({"file": f"themes/{path.name}", "line": 1, "subject": path.stem, "why": str(error)})

    # Extensions shipped beside the base schemes behave like every other mounted extension:
    # load-order decides who writes last, and an extension never silently becomes a base.
    mounted: list[ThemeFile] = []
    for theme, source, _load_order in mounted_themes(search_paths, gameinfo):
        if theme is None:
            refusals.append({"file": "mounted schemes", "line": 1, "subject": "mounted scheme", "why": source})
            continue
        mounted.append(theme)

    base_by_id: dict[str, ThemeFile] = {}
    extensions: list[ThemeFile] = []
    for theme in local + mounted:
        if theme.extends:
            extensions.append(theme)
            continue
        if theme.id in base_by_id:
            source = base_by_id[theme.id].name
            refusals.append(
                {
                    "file": theme.name,
                    "line": theme.line,
                    "subject": theme.id,
                    "why": f"duplicate scheme id; already declared by {source}",
                }
            )
            continue
        base_by_id[theme.id] = theme

    schemes: list[dict] = []
    extension_rows: list[dict] = []

    for base in base_by_id.values():
        roles, base_refusals = resolve_theme(base, defines)
        refusals.extend(base_refusals)
        if base_refusals:
            continue

        applied: list[dict] = []
        rules: list[dict] = list(base.rules)
        base_exts = [ext for ext in extensions if ext.extends == base.id]
        base_exts.sort(key=lambda ext: (ext.load_order if ext.load_order is not None else 100, ext.name))
        for ext in base_exts:
            slots, ext_rules, ext_refusals = apply_extension(base, ext, defines)
            # A bad row is named and skipped; the rest of the extension still applies. Dropping
            # the whole file because one token moved would make mods silently disappear on a
            # game update instead of reporting the one stale declaration.
            refusals.extend(ext_refusals)
            for slot, value in slots.items():
                roles[slot] = value
            # Every derived colour follows the patched accent/border, not the base's original.
            if "accent" in roles:
                roles["accentSoft"] = with_alpha(roles["accent"], "22")
                roles["accentStrong"] = with_alpha(roles["accent"], "55")
            if "border" in roles:
                roles["borderSoft"] = with_alpha(roles["border"], "66")
            rules.extend(ext_rules)
            applied.append(
                {
                    "id": ext.id,
                    "label": ext.label,
                    "source": ext.source,
                    "loadOrder": ext.load_order,
                }
            )

        schemes.append(
            {
                "id": base.id,
                "label": base.label,
                "source": base.source,
                # Colour only. Shape is a separate selector read from forms/<id>.form; no palette
                # carries a form or a renderer, so the two axes cannot silently re-couple.
                "roles": roles,
                "rules": rules,
                "extensions": applied,
                # One editable slot per clickable swatch in the Palette window. Values start at
                # the scheme's own colours, so a player can repaint a single role without
                # rewriting the whole .theme file.
                "palette": [
                    {"slot": slot, "label": label, "value": roles[slot], "steps": steps}
                    for slot, label, steps in PALETTE_SLOTS
                    if slot in roles
                ],
                # Inline repaint targets. Only simple class selectors can be addressed on a
                # live panel; descendant and pseudo rules stay in the generated sheet.
                "paint": [
                    {"selector": selector, "property": prop, "role": role}
                    for selector, props in RULES
                    if re.fullmatch(r"\.[A-Za-z0-9_]+", selector)
                    for prop, role in props
                ]
                + [
                    {"selector": rule["selector"], "property": rule["property"], "role": rule["role"]}
                    for rule in rules
                    if "role" in rule and re.fullmatch(r"\.[A-Za-z0-9_]+", rule["selector"])
                ],
            }
        )

    for ext in extensions:
        if ext.extends not in base_by_id:
            refusals.append(
                {
                    "file": ext.name,
                    "line": ext.line,
                    "subject": ext.id,
                    "why": f"extends '{ext.extends}', which is not a base scheme",
                }
            )
        else:
            extension_rows.append(
                {
                    "id": ext.id,
                    "label": ext.label,
                    "base": ext.extends,
                    "source": ext.source,
                    "loadOrder": ext.load_order,
                }
            )

    default_path = theme_dir / "default"
    default = ""
    if default_path.exists():
        declared = default_path.read_text(encoding="utf-8", errors="replace").strip()
        if declared in {scheme["id"] for scheme in schemes}:
            default = declared
        else:
            refusals.append(
                {
                    "file": "themes/default",
                    "line": 1,
                    "subject": declared or "<empty>",
                    "why": "the default scheme is not one of the available schemes",
                }
            )
    if not default and schemes:
        default = schemes[0]["id"]

    order, order_refusals = read_order(theme_dir, {scheme["id"] for scheme in schemes})
    refusals.extend(order_refusals)
    if order:
        by_id = {scheme["id"]: scheme for scheme in schemes}
        schemes = [by_id[theme_id] for theme_id in order if theme_id in by_id]

    form_schemas, form_refusals = load_forms(package_dir / "forms")
    refusals.extend(form_refusals)
    default_form_path = package_dir / "forms" / "default"
    default_form = ""
    if default_form_path.exists():
        declared = default_form_path.read_text(encoding="utf-8", errors="replace").strip()
        if declared in form_schemas:
            default_form = declared
    if not default_form and form_schemas:
        default_form = "popit" if "popit" in form_schemas else sorted(form_schemas)[0]
    form_rows = [
        {"id": form["id"], "label": form["label"], "renderer": form["renderer"]}
        for form in sorted(form_schemas.values(), key=lambda item: (item["id"] != default_form, item["id"]))
    ]

    write_css(schemes, output) if schemes else output.unlink(missing_ok=True)
    return {
        "default": default,
        # Colour and shape are independent selectors. The shell reads defaultForm separately
        # and adds `.Form*` without touching `.Scheme*`.
        "defaultForm": default_form,
        "forms": form_rows,
        # The shell reads this before it applies a form. A form may ask for the Popit surface
        # port, but the generic renderer is always present as the fallback.
        "renderers": {
            "default": "generic",
            "popit": {
                "available": "popit" in form_schemas,
                "label": "Popit suite port",
            },
        },
        "order": [scheme["id"] for scheme in schemes],
        "schemes": schemes,
        "extensions": extension_rows,
        "refusals": refusals,
    }


def main() -> int:
    data = generate()
    print(
        f"wrote {OUTPUT} ({len(data['schemes'])} scheme(s), {len(data['extensions'])} extension(s), "
        f"default {data['default'] or 'none'}, {len(data['refusals'])} refusal(s))"
    )
    for refusal in data["refusals"]:
        print(f"  refused {refusal['file']}:{refusal['line']} {refusal['subject']} — {refusal['why']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

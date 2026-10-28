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
        if raw.startswith("\t") or top_key in ("rule", "extends", "load-order", "label", "source", *REQUIRED):
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
]


def css_comment(text: str) -> str:
    """A theme label/source is data, not a stylesheet: it must not close the comment it sits in."""
    value = re.sub(r"[\r\n]+", " ", str(text))
    return value.replace("/*", "/ *").replace("*/", "* /")[:240]


def scheme_class(theme_id: str) -> str:
    # Keep this identical to schemeClass() in openlock_shell.js: hyphens and underscores both
    # start a new word, so `my-mod` and `my_mod` become the same class the client adds.
    return "Scheme" + theme_id.replace("-", " ").replace("_", " ").title().replace(" ", "")


def write_css(schemes: list[dict]) -> None:
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
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


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
) -> dict:
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
                "roles": roles,
                "rules": rules,
                "extensions": applied,
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

    write_css(schemes) if schemes else OUTPUT.unlink(missing_ok=True)
    return {
        "default": default,
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

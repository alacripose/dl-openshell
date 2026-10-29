#!/usr/bin/env python3
"""Generate the shell's Panorama data from the alpha-shell display package.

The package is the source of truth: this script reads `package.shspec`,
`package.cells` and `frames/*.frame` and writes a JavaScript literal the client
UI reads. Nothing about a window's title, content id, geometry, opacity or theme
is retyped by hand in the UI.

Refusals are baked rather than dropped: every record the client cannot draw is
emitted with the file and the line it was written on, so the Refusals window and
the console show the same list the server logs.

Usage:
    python tools/gen_shell_data.py [package-dir] [output-js] [gameinfo] [output-schemes-css]
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gen_shell_theme  # noqa: E402  (the theme generator is a sibling tool, not a package)

ROOT = Path(__file__).resolve().parent.parent
PACKAGE_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "shell" / "alpha-shell"
OUTPUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "clientaddon" / "panorama" / "scripts" / "openlock_shell_data.js"
SCHEMES_OUTPUT = Path(sys.argv[4]) if len(sys.argv) > 4 else None


def read_recipe(path: Path):
    data = {
        "format": "",
        "name": "",
        "version": "",
        "windows": [],
        "tabs": [],
        "bar": None,
        "filed": [],
        "pins": [],
        "refusals": [],
    }
    if not path.exists():
        data["refusals"].append({"file": path.name, "line": 1, "subject": "package.shspec", "why": "file is missing"})
        return data

    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    data["format"] = lines[0] if lines else ""
    if not data["format"].startswith("shploingus.recipe/"):
        data["refusals"].append(
            {"file": path.name, "line": 1, "subject": lines[0] if lines else "<empty>", "why": "unknown recipe header"}
        )
        return data

    current = None
    for index, raw in enumerate(lines[1:], start=2):
        if not raw or raw.lstrip().startswith("#"):
            continue
        if raw.startswith("\t"):
            if current is None:
                continue
            fields = raw.lstrip("\t").split("\t")
            if len(fields) < 2:
                continue
            key, value = fields[0], fields[1]
            if key in ("title", "content", "lane", "extent", "theme-role", "behavior", "layout", "record-id", "panel"):
                current[key] = value
                if key == "content":
                    current["contentLine"] = index
            elif key == "scale" and value.isdigit():
                current["scale"] = int(value)
            elif key == "geometry":
                numbers = value.split()
                if len(numbers) == 4 and all(n.lstrip("-").isdigit() for n in numbers):
                    current["x"], current["y"], current["width"], current["height"] = (int(n) for n in numbers)
                else:
                    data["refusals"].append(
                        {"file": path.name, "line": index, "subject": current["id"], "why": f"geometry '{value}' is not four integers"}
                    )
            elif key == "opacity" and value.isdigit():
                current["opacity"] = int(value)
            elif key == "elevation" and value.lstrip("-").isdigit():
                current["elevation"] = int(value)
            elif key == "min-size":
                numbers = value.split()
                if len(numbers) == 2 and all(n.isdigit() for n in numbers):
                    current["minWidth"], current["minHeight"] = (int(n) for n in numbers)
            elif key == "pinnable":
                current["pinnable"] = value.lower() == "true"
            continue

        fields = raw.split("\t")
        key = fields[0]
        if key == "package":
            data["name"] = fields[1] if len(fields) > 1 else ""
            data["version"] = fields[2] if len(fields) > 2 else ""
        elif key == "window":
            current = {
                "id": fields[1] if len(fields) > 1 else f"window-{index}",
                "line": index,
                "title": "",
                "content": "",
                "contentLine": index,
                "lane": "",
                "extent": "",
                "theme-role": "surface",
                "behavior": "",
                "layout": "",
                "record-id": "",
                "panel": "",
                "scale": 100,
                "x": 16,
                "y": 64,
                "width": 480,
                "height": 440,
                "minWidth": 240,
                "minHeight": 192,
                "opacity": 930,
                "elevation": 1,
                "pinnable": False,
            }
            data["windows"].append(current)
        elif key == "tab" and len(fields) > 1:
            data["tabs"].append(fields[1])
        elif key == "bar" and len(fields) > 1:
            data["bar"] = fields[1]
        elif key == "filed" and len(fields) > 2:
            data["filed"].append({"window": fields[1], "tab": fields[2], "line": index})
        elif key == "pin" and len(fields) > 1:
            data["pins"].append(fields[1])

    # A window's declared behavior is delivered by the client's window manager: the title bar
    # moves it, the corner grip resizes it, and the buttons minimize, maximize and close it.
    # Nothing in `behavior` is refused any more, so the list of refusals is only records the
    # client genuinely cannot draw.

    return data


# Content resolution, baked once. The client reads the answer off the window record; it does not
# carry a second copy of this table.
#
# A Deadlock layout is not a standalone page: `citadel_hud_hero_shop.xml`, for example, is the
# content of a live `CitadelHudHeroShop` panel that the game already built in its own HUD tree.
# Loading the layout again under a shell window finds no parent and aborts the client, which is
# exactly the failure this table exists to prevent. The shell therefore **adopts the live panel**
# by id and reparents it into the window; the panel keeps the children, styles and script context
# the game gave it. The window's declared geometry is then its position and scale.
#
# A panel that is not in the HUD when the window opens is a refusal in the window, never a fresh
# load: a component whose parent is missing must not be able to take the client down.
LIVE_PANELS = {
    # Primary shell windows -> the panel the stock HUD actually owns. Prefixed with the lookup
    # kind: `class:` is how the game builds most HUD components (the shop root carries no id),
    # `id:` is a panel that does have a stable id.
    "inventory": ["class:CitadelHudHeroShop"],
    "trees": ["id:ShopModsSelectedBuild"],
    "map-plan": ["class:CitadelHudMapScreen", "class:CitadelHudMap", "id:HudMap", "class:HudMap"],
    "minimap": ["class:HudMinimap"],
    "abilities": ["class:ability_panel"],
    "quickbuy": ["class:HudQuickbuy"],
    "combat-log": ["class:CitadelHudCombatLog"],
    "game-settings": ["class:CitadelHudEscapeMenu"],
}


def panel_candidate(token: str):
    token = token.strip()
    if not token:
        return None
    if token.startswith("class:"):
        return {"kind": "class", "name": token[6:]}
    if token.startswith("id:"):
        return {"kind": "id", "name": token[3:]}
    if token.startswith("token:"):
        return {"kind": "token", "name": token[6:].lower()}
    return {"kind": "class", "name": token}

# Layout basename -> live-panel ids to try, most specific first. The fallbacks are derived, so a
# game update that renames an id costs a refusal rather than a crash.
LAYOUT_PANELS = {
    "citadel_hud_hero_shop": ["CitadelHudHeroShop"],
    "citadel_hud_top_bar": ["TopBar"],
    "hud_minimap": ["hud_minimap", "HudMinimap"],
    "hud_hideout": ["CitadelHudHideout"],
    "hud_escape_menu": ["EscapeMenu"],
    "chat": ["Chat"],
    "citadel_hud_text": ["HudText"],
    "citadel_hud_pregame": ["Pregame"],
    "citadel_hud_match_start": ["MatchStart"],
    "citadel_hud_match_end": ["MatchEnd"],
}

OWN_VIEWS = {
    "mods", "ledger", "docs", "settings", "log", "readout", "table", "notifications", "api-viewer",
    "world-view", "console", "tools", "ui-tree",
}

NO_SOURCE = {
    "streamer": "no streamer source exists on this build; there is nothing to mount",
}


def layout_panel_candidates(layout):
    """The live-panel lookups to try for a shipped layout, most specific first.

    `citadel_hud_hero_shop.xml` belongs to the live `CitadelHudHeroShop`; a component with no
    dedicated live instance gets its own PascalCase name and basename as cheap lookups. The shell
    resolves them against the real HUD at open time and refuses if none is mounted, so a wrong
    guess is a refusal, not a fabricated panel.
    """
    stem = layout.rsplit("/", 1)[-1]
    if "." in stem:
        stem = stem.rsplit(".", 1)[0]
    names = list(LAYOUT_PANELS.get(stem, []))
    parts = stem.split("_")
    pascal = "".join(part[:1].upper() + part[1:] for part in parts if part)
    for candidate in (pascal, stem):
        if candidate and candidate not in names:
            names.append(candidate)

    out = []
    for name in names:
        if name.startswith("class:") or name.startswith("id:"):
            out.append(panel_candidate(name))
        else:
            out.append({"kind": "id", "name": name})
    return [c for c in out if c]


def resolve_content(windows):
    """Set `panelCandidates` / `view` / `refused` on every window and return the refusals it adds."""
    refusals = []
    for window in windows:
        # An explicit `panel` row is the schema's own declaration of which live game panel this
        # window frames. It wins over the content table, so a window's source is written where the
        # window is written. `scale` is the default percentage of the panel's own size.
        if window.get("panel"):
            candidates = [panel_candidate(token) for token in window["panel"].split(",")]
            window["panelCandidates"] = [c for c in candidates if c]
            window["panelScale"] = max(5, min(400, int(window.get("scale", 100)))) / 100.0
            # A panel window is opened by the shell when its game panel comes on screen; the
            # 322 per-layout game windows are not, or the whole HUD would open at once.
            window["autoFrame"] = True
            continue

        content = window["content"]
        if content in LIVE_PANELS:
            window["panelCandidates"] = [panel_candidate(name) for name in LIVE_PANELS[content]]
            window["autoFrame"] = True
        elif content.startswith("file://"):
            window["panelCandidates"] = layout_panel_candidates(content)
        elif content in OWN_VIEWS:
            window["view"] = content
        else:
            window["refused"] = NO_SOURCE.get(content, f"no mounted source for content '{content}'")
            refusals.append(
                {
                    "file": "package.shspec",
                    "line": window.get("contentLine", window.get("line", 1)),
                    "subject": window["id"],
                    "why": f"content '{content}': {window['refused']}",
                }
            )
    return refusals


def read_cells(path: Path):
    refusals = []
    if not path.exists():
        refusals.append({"file": path.name, "line": 1, "subject": "package.cells", "why": "file is missing"})
        return "", -1, refusals

    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    header = lines[0] if lines else ""
    if header != "shploingus.cells/1":
        refusals.append({"file": path.name, "line": 1, "subject": header, "why": "unknown cells header"})
        return header, -1, refusals

    for index, raw in enumerate(lines[1:], start=2):
        parts = raw.split("\t")
        if len(parts) >= 2 and parts[0] == "cells" and parts[1].isdigit():
            refusals.append(
                {
                    "file": path.name,
                    "line": index,
                    "subject": f"cells {parts[1]}",
                    "why": "the host draws composed panels only; a cell raster, its layers and frames cannot be mounted here",
                }
            )
            return header, int(parts[1]), refusals
    return header, -1, refusals


def read_frames(directory: Path):
    refusals = []
    if not directory.exists():
        return refusals

    for frame in sorted(directory.glob("*.frame")):
        lines = frame.read_text(encoding="utf-8", errors="replace").splitlines()
        header = lines[0] if lines else ""
        if header != "shploingus.cellframe/1":
            refusals.append({"file": f"frames/{frame.name}", "line": 1, "subject": header, "why": "unknown cellframe header"})
            continue

        frame_id = ""
        line = 2
        why = "cell data frame: fields, shapers and projections cannot be drawn as a Panorama panel"
        for index, raw in enumerate(lines[1:], start=2):
            parts = raw.lstrip("\t").split("\t")
            if len(parts) >= 2 and parts[0] == "frame" and not frame_id:
                frame_id = parts[1]
                line = index
            if len(parts) >= 2 and parts[0] == "shaper":
                why = f"cell data frame: shaper '{parts[1]}' and its projection cannot be drawn as a Panorama panel"
                line = index
                break
        refusals.append({"file": f"frames/{frame.name}", "line": line, "subject": frame_id or frame.name, "why": why})
    return refusals


def read_deadlock_windows(path: Path):
    """One shell window per real game layout, from the catalog the SDK listing produced."""
    windows = []
    if not path.exists():
        return windows

    for index, raw in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
        if not raw or raw.startswith("#") or not raw.startswith("window\t"):
            continue
        fields = raw.split("\t")
        if len(fields) < 4:
            continue
        pos = (index - 1) % 10
        windows.append(
            {
                "id": fields[1],
                "line": index,
                "title": fields[2],
                "content": fields[3],
                "contentLine": index,
                "lane": "game",
                "extent": "square-pixels",
                "theme-role": "surface",
                "behavior": "close",
                "layout": "close",
                "record-id": f"deadlock-{fields[1]}",
                "x": 16 + pos * 48,
                "y": 48 + pos * 32,
                "width": 480,
                "height": 440,
                "minWidth": 240,
                "minHeight": 192,
                "opacity": 930,
                "elevation": 1,
                "pinnable": False,
            }
        )
    return windows


def read_search_paths(gameinfo: Path):
    """The games the client mounts, read from the same gameinfo.gi the engine reads.

    The UI half is a Panorama mod, so it cannot enumerate a filesystem at runtime; the module is
    baked with the search-path list instead. A listed path that is missing, or present without a
    panorama tree, is emitted with its state rather than skipped: the Mods window shows what the
    game will and will not mount.
    """
    rows = []
    if not gameinfo.exists():
        return rows, {"file": gameinfo.name, "line": 1, "subject": "search paths",
                      "why": f"no gameinfo.gi at '{gameinfo}'"}

    game_root = gameinfo.parent.parent.resolve()
    in_block = False
    depth = 0
    for index, raw in enumerate(gameinfo.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
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
        root = (gameinfo.parent.parent / relative).resolve()
        try:
            root.relative_to(game_root)
            inside = True
        except ValueError:
            # Never stat or list a search path outside the install: a gameinfo entry is not a
            # reason for the generator to read another directory, and the layout/theme scanners
            # already refuse these roots.
            inside = False
        rows.append(
            {
                "kind": fields[0],
                # Relative to the game root: the VPK is installed under any drive or user and must
                # not carry this machine's path into someone else's client.
                "path": relative,
                "line": index,
                "exists": inside and root.exists(),
                "mounts": _mounts(root) if inside else "outside game root",
            }
        )
    return rows, None


def _mounts(root: Path):
    """What a search path actually contributes: loose panorama files, a mounted vpk, or nothing."""
    if not root.exists():
        return "missing"
    if (root / "panorama" / "layout").exists() and any((root / "panorama" / "layout").iterdir()):
        return "panorama tree"
    if any(root.glob("pak01_dir.vpk")):
        return "vpk"
    return "empty"


def read_steam_persona() -> str:
    """Always empty: a package must never carry the builder's Steam name.

    The shell reads the logged-in persona from Steam at runtime, on the machine showing it. A VPK
    built here and copied to someone else must show *their* name, not this builder's.
    """
    return ""


def read_layouts(gameinfo: Path) -> list[str]:
    """Every Deadlock Panorama layout the client can load, as source-style paths.

    Shipping builds carry `panorama/layout/*.vxml_c`; `BLoadLayout` resolves the `.xml` name
    against the compiled resource, which is how the shell itself mounts. The list is baked so
    the console can open a layout without a filesystem read at runtime.
    """
    game = gameinfo.parent.parent
    roots = [gameinfo.parent, game / "core"]
    try:
        search_paths, _refusal = read_search_paths(gameinfo)
    except BaseException:
        search_paths = []
    game_root = game.resolve()
    for row in search_paths:
        if not row.get("exists"):
            continue
        candidate = (game / str(row.get("path", ""))).resolve()
        try:
            candidate.relative_to(game_root)
        except ValueError:
            # A search path that leaves the install is never followed by the layout scan.
            continue
        roots.append(candidate)

    archives: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        archives.extend(root.glob("*.vpk"))
        try:
            children = list(root.iterdir())
        except OSError:
            children = []
        for child in children:
            try:
                child.resolve().relative_to(game_root)
            except (OSError, ValueError):
                continue
            if child.is_dir():
                archives.extend(child.glob("*.vpk"))

    try:
        import vpk_read
    except Exception:
        return []

    layouts: set[str] = set()
    for archive in sorted({path.resolve() for path in archives}):
        try:
            archive.relative_to(game_root)
        except ValueError:
            continue
        if re.search(r"_\d{3}\.vpk$", archive.name.lower()):
            continue
        try:
            entries, _inline = vpk_read.read_tree(str(archive))
        except BaseException:
            continue
        for entry in entries:
            path = entry["path"]
            if path.startswith("panorama/layout/") and path.endswith(".vxml_c"):
                layouts.add(path[: -len(".vxml_c")].replace("\\", "/") + ".xml")
    return sorted(layouts)


def read_tools(gameinfo: Path):
    """The tools available for the game this data was baked against.

    Looked for beside the game first (its own bin and SDK bin), so the list describes the install
    the VPK runs in rather than this checkout. The extra SDK locations are where the authoring
    tools actually live on this machine today; a tool that is absent is listed with the first
    place it was looked for, not with an invented path.
    """
    game = gameinfo.parent.parent
    bases = [
        ("game/bin/win64", game / "bin" / "win64"),
        ("game/bin_tools/win64", game / "bin_tools" / "win64"),
        ("sdk/bin/win64", Path(r"D:/Users/alacrity/Documents/Documents/Reduced_CSDK_12/game/bin/win64")),
        ("downloads", Path(r"C:/Users/ala/Downloads")),
    ]
    tools = ["resourcecompiler.exe", "CSDKCfgVPK.exe", "resourcecopy.exe", "Source2Viewer.exe"]

    found = []
    for name in tools:
        placed = next(((label, base / name) for label, base in bases if (base / name).exists()), None)
        found.append(
            {
                "name": Path(name).stem,
                # A label, not an absolute path: the package is read on another install.
                "path": f"{placed[0]}/{name}" if placed else f"{bases[0][0]}/{name}",
                "exists": placed is not None,
            }
        )
    return found


def read_build(gameinfo: Path) -> dict:
    """The version the shell reports at boot: the package, the git build, and the game build.

    A Panorama mod cannot read the filesystem or run git, so the reading is taken here and baked.
    A missing repository is a fact, not an error: the label then names only what exists.
    """
    build = {
        "version": "",
        "commit": "",
        "branch": "",
        "dirty": False,
        "gameVersion": "",
        "generatedAt": time.strftime("%Y-%m-%d %H:%M"),
    }

    # The installer selects the grade once and writes it into build.json before this generator
    # runs. The shell data must carry that choice: a player-mode release VPK cannot depend on a
    # live server record to hide shell chrome or restore a saved layout.
    state_path = PACKAGE_DIR / "build.json"
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
            if state.get("grade") in ("dev", "observer", "player"):
                build["grade"] = state["grade"]
        except (json.JSONDecodeError, OSError):
            # A malformed build record is reported by the buildState reader below, which keeps
            # its line number; the grade simply stays absent here.
            pass

    manifest = ROOT / "openlock.manifest.json"
    if manifest.exists():
        try:
            record = json.loads(manifest.read_text(encoding="utf-8"))
            build["version"] = str(record.get("version", ""))
            target = record.get("target") or {}
            build["deadlockRevision"] = str(target.get("deadlockRevision", ""))
        except (json.JSONDecodeError, OSError) as error:
            build["manifestError"] = str(error)

    def git(*args):
        return subprocess.run(
            ["git", "-C", str(ROOT)] + list(args),
            capture_output=True, text=True, timeout=5, check=False,
        )

    try:
        result = git("rev-parse", "--short", "HEAD")
        if result.returncode == 0:
            build["commit"] = result.stdout.strip()
        result = git("rev-parse", "--abbrev-ref", "HEAD")
        if result.returncode == 0:
            build["branch"] = result.stdout.strip()
        result = git("status", "--porcelain")
        if result.returncode == 0:
            build["dirty"] = bool(result.stdout.strip())
    except (OSError, subprocess.SubprocessError):
        # No repository in this checkout: the label says so below rather than inventing one.
        build["commit"] = ""

    steam = gameinfo.parent / "steam.inf"
    if steam.exists():
        for raw in steam.read_text(encoding="utf-8", errors="replace").splitlines():
            if raw.startswith("ClientVersion="):
                build["gameVersion"] = raw.split("=", 1)[1].strip()
                break

    label = []
    if build["version"]:
        label.append("v" + build["version"])
    if build["commit"]:
        label.append(build["commit"] + ("+" if build["dirty"] else ""))
    if build["gameVersion"]:
        label.append("game " + build["gameVersion"])
    build["label"] = "  ·  ".join(label) or "openlock"
    return build


def main():
    recipe = read_recipe(PACKAGE_DIR / "package.shspec")
    recipe["windows"].extend(read_deadlock_windows(PACKAGE_DIR / "deadlock.windows"))
    content_refusals = resolve_content(recipe["windows"])
    cells_format, cells_version, cells_refusals = read_cells(PACKAGE_DIR / "package.cells")
    frame_refusals = read_frames(PACKAGE_DIR / "frames")
    recipe["refusals"] = content_refusals + cells_refusals + frame_refusals + recipe["refusals"]
    recipe["cellsFormat"] = cells_format
    recipe["cellsVersion"] = cells_version

    gameinfo = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(
        r"D:/SteamLibrary/steamapps/common/Deadlock/game/citadel/gameinfo.gi"
    )
    search_paths, path_refusal = read_search_paths(gameinfo)
    if path_refusal:
        recipe["refusals"].append(path_refusal)
    recipe["searchPaths"] = search_paths
    recipe["searchPathsSource"] = gameinfo.name
    recipe["tools"] = read_tools(gameinfo)
    recipe["layouts"] = read_layouts(gameinfo)
    recipe["steamName"] = read_steam_persona()
    recipe["build"] = read_build(gameinfo)

    # The colour schemes are generated from the package's theme declarations and the game's own
    # @define table. The generator writes the stylesheet as a side effect; the data here is what
    # the shell reads to name the schemes and to say why one is unavailable.
    try:
        themes = gen_shell_theme.generate(PACKAGE_DIR, gameinfo, search_paths, SCHEMES_OUTPUT)
        recipe["themes"] = themes
        recipe["refusals"].extend(themes.get("refusals", []))
    except Exception as error:  # a broken theme is a refusal, not a build crash
        recipe["themes"] = {"default": "", "order": [], "schemes": [], "refusals": []}
        recipe["refusals"].append(
            {"file": "themes", "line": 1, "subject": "schemes", "why": f"theme generation failed: {error}"}
        )

    # The install script records the last successful VPK build here. It is a client data file, so the
    # Tools window reads the same record the tools wrote rather than a hand-copied number.
    build_state_path = PACKAGE_DIR / "build.json"
    if build_state_path.exists():
        try:
            recipe["buildState"] = json.loads(build_state_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            recipe["buildState"] = {"stage": "unknown"}
            recipe["refusals"].append(
                {"file": "build.json", "line": error.lineno, "subject": "build",
                 "why": f"not JSON: {error.msg}"}
            )
    else:
        recipe["buildState"] = {"stage": "unknown"}

    # A staged update is a package record, not a hard-coded string in the UI. tools/stage_update.py
    # writes it; with no record the shell shows nothing, which is the normal case.
    update_path = PACKAGE_DIR / "update.json"
    if update_path.exists():
        try:
            update = json.loads(update_path.read_text(encoding="utf-8"))
            update.setdefault("available", bool(update.get("version")))
            recipe["update"] = update
        except json.JSONDecodeError as error:
            recipe["refusals"].append(
                {"file": "update.json", "line": error.lineno, "subject": "update",
                 "why": f"not JSON: {error.msg}"}
            )
    else:
        recipe["update"] = {"available": False}

    payload = json.dumps(recipe, indent=2, ensure_ascii=False)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        "// Generated by tools/gen_shell_data.py from the alpha-shell display package.\n"
        "// Edit the package, not this file.\n"
        f"var SHELL = {payload};\n",
        encoding="utf-8",
    )
    print(f"wrote {OUTPUT} ({len(recipe['windows'])} windows, {len(recipe['refusals'])} refusals)")


if __name__ == "__main__":
    main()

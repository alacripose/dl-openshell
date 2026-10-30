"""The general game-folder reading: `game/<name>/gameinfo.gi`, clients, panorama, shape.

A Source 2 tree declares its game in `game/<name>/gameinfo.gi`: `citadel` for Deadlock, `csgo` for
CS2, `dota` for Dota 2, `hlvr` for Alyx. Nothing here is Deadlock-specific; the installer window and
the shell's wish layer both read the same parser instead of each keeping a list of folder names.

`steam_libraries` is Steam's own record of where its libraries live, so a game on another drive or
under a non-default folder name is found rather than guessed at.
"""

from __future__ import annotations

import re
from pathlib import Path

# Where Steam itself is installed on a drive. A game library, however, can be named anything and
# sit anywhere; the fixed leaves used elsewhere only cover the default names.
STEAM_ROOTS = (
    "Program Files (x86)/Steam",
    "Program Files/Steam",
    "Steam",
    "Games/Steam",
)
BIN = Path("game") / "bin" / "win64"
CLIENTS = ("deadlock.exe", "project8.exe", "deadworks.exe")
TOOL_NAMES = ("resourcecompiler.exe", "CSDKCfgVPK.exe", "resourcecopy.exe")


def steam_libraries(steam_root: Path | None = None) -> list[Path]:
    """Every folder Steam records as a library, in the order Steam keeps them."""
    candidates: list[Path] = []
    if steam_root is not None:
        candidates.append(Path(steam_root))
    else:
        for letter in "CDEFGHIJKLMNOPQRSTUVWXYZAB":
            drive = Path(f"{letter}:/")
            try:
                if not drive.exists():
                    continue
            except OSError:
                continue
            for place in STEAM_ROOTS:
                candidates.append(drive / place)

    libraries: list[Path] = []
    seen: set[str] = set()
    for root in candidates:
        record = root / "steamapps" / "libraryfolders.vdf"
        try:
            text = record.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for match in re.finditer(r'"path"\s+"([^"]+)"', text):
            library = Path(match.group(1).replace("\\\\", "\\"))
            key = str(library).replace("\\", "/").lower()
            if key in seen:
                continue
            seen.add(key)
            libraries.append(library)
    return libraries


def game_of(root: Path) -> str:
    """The game a tree carries, named by its folder under `game/`."""
    try:
        for entry in sorted((root / "game").iterdir()):
            if (entry / "gameinfo.gi").is_file():
                return entry.name
    except OSError:
        pass
    return ""


def steam_common(libraries: list[Path] | None = None) -> list[Path]:
    """Every Steam library title that declares a Source 2 gameinfo, whatever the game is.

    `steamapps/common` is where a game lives regardless of its name, so this finds CS2
    (`Counter-Strike Global Offensive`) as readily as Deadlock. Bounded to one directory per
    library, never a recursive walk.
    """
    trees: list[Path] = []
    for library in (libraries if libraries is not None else steam_libraries()):
        try:
            entries = sorted((library / "steamapps" / "common").iterdir())
        except OSError:
            continue
        for candidate in entries:
            if game_of(candidate):
                trees.append(candidate)
    return trees


def role(root: Path) -> str:
    """`tools` for a reduced-CSDK host, `game` for a game install.

    A CSwin64 build is the same surface as a `Reduced_CSDK_*` tree: a tooling host that compiles
    and packs, not another game to load the shell UI into. Its `game/core/gameinfo.gi` is the
    CSDK's own core game, which is why naming it by folder alone would call a tools tree a game.

    Every reduced-CSDK build ships `game/core` and a `resourcecompiler.exe`, and some ship
    `project8.exe` or `content/citadel_addons`, so none of those separates a tools host from the
    game. The shipped game is the one with `deadlock.exe` and no separate `bin_tools`.
    """
    try:
        if (root / "game" / "bin_tools").is_dir():
            return "tools"
        if (root / BIN / "deadlock.exe").is_file():
            return "game"
    except OSError:
        pass
    # `citadel` without the shipped client is a project8/reduced-CSDK build, and `core` is the
    # CSDK's own game. Any other game folder (csgo, dota, hlvr) is another game's install.
    return "tools" if game_of(root) in ("citadel", "core") else "game"


def compatible(root: Path) -> tuple[bool, str]:
    if not game_of(root):
        return False, "no game/<name>/gameinfo.gi"
    if not any((root / BIN / name).is_file() for name in CLIENTS):
        try:
            launchable = any((root / BIN).glob("*.exe"))
        except OSError:
            launchable = False
        if not launchable:
            return False, "no launchable client under game/bin/win64"
    return True, ""


def panorama(root: Path, game: str) -> str:
    """The tree's own Panorama root, relative, or '' when the game carries none."""
    for relative in (Path("content") / game / "panorama", Path("game") / game / "panorama"):
        try:
            if (root / relative).is_dir():
                return relative.as_posix()
        except OSError:
            continue
    return ""


def shape(root: Path, grade: str = "") -> str:
    if grade == "dev" or (root / "clientaddon").is_dir():
        return "dev"
    return "release"

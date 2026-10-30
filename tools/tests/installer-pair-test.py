"""Focused harness for the installer pair the window offers to add.

Builds throwaway trees for the four readings the window shows — current, stale, absent and
incompatible — seeds the ones a user would tick, and asserts the pair lands byte-for-byte while a
tree that is not a compatible install is refused and left untouched.

Run: python tools/tests/installer-pair-test.py
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import installer_pair  # noqa: E402

checks = 0
failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global checks, failures
    checks += 1
    if ok:
        print(f"ok: {name}")
    else:
        failures += 1
        print(f"FAILED: {name} - {detail}")


def tree(base: Path, name: str, *, gameinfo: bool = True, pair: str | None = None) -> Path:
    root = base / name
    (root / "game" / "citadel").mkdir(parents=True)
    (root / "game" / "bin" / "win64").mkdir(parents=True)
    if gameinfo:
        (root / "game" / "citadel" / "gameinfo.gi").write_text("SearchPaths\n{\n}\n", encoding="utf-8")
    (root / "game" / "bin" / "win64" / "deadlock.exe").write_bytes(b"MZ")
    if pair:
        target = root / installer_pair.BIN
        if pair == "current":
            shutil.copy2(installer_pair.PAIRS["release"][0], target / "install.ps1")
            shutil.copy2(installer_pair.PAIRS["release"][1], target / "install.cmd")
        elif pair == "stale":
            (target / "install.ps1").write_text("# an older release installer\n", encoding="utf-8")
            shutil.copy2(installer_pair.PAIRS["release"][1], target / "install.cmd")
    return root


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="openlock-pair-") as folder:
        base = Path(folder)
        current = tree(base, "current", pair="current")
        stale = tree(base, "stale", pair="stale")
        absent = tree(base, "absent")
        incompatible = base / "not-a-game"
        (incompatible / "game" / "bin" / "win64").mkdir(parents=True)

        check("a tree with this checkout's pair reads current",
              installer_pair.reading(current)["installer"] == "current",
              installer_pair.reading(current)["installer"])
        stale_reading = installer_pair.reading(stale)
        check("an older pair reads stale", stale_reading["installer"] == "stale", stale_reading["installer"])
        check("a compatible tree with no pair reads absent",
              installer_pair.reading(absent)["installer"] == "absent",
              installer_pair.reading(absent)["installer"])
        check("a tree without gameinfo is not compatible",
              not installer_pair.reading(incompatible)["compatible"])

        ok, detail = installer_pair.seed(stale)
        check("seeding a stale tree writes the current pair", ok, detail)
        check("the seeded pair now reads current",
              installer_pair.reading(stale)["installer"] == "current",
              installer_pair.reading(stale)["installer"])

        ok, detail = installer_pair.seed(absent)
        check("seeding an opted-in tree with no pair works", ok, detail)
        check("the seeded tree now reads current",
              installer_pair.reading(absent)["installer"] == "current",
              installer_pair.reading(absent)["installer"])

        refused, why = installer_pair.seed(incompatible)
        check("seeding an incompatible tree is refused", not refused, why)
        check("a refused seed writes nothing",
              not (incompatible / installer_pair.BIN / "install.ps1").exists(),
              "install.ps1 was written")

        armed = installer_pair.seed(stale)
        check("a current pair can be rewritten without a partial",
              armed[0] and all((stale / installer_pair.BIN / name).is_file()
                               for name in ("install.ps1", "install.cmd")))

        # Another game's install lives wherever its library is, and its shape decides which
        # installer it carries. The window must offer it, not only a folder named SteamLibrary.
        library = base / "ol-lib-beta"
        other_game = tree(library / "steamapps" / "common", "Deadlock")
        (other_game / "game" / "bin" / "win64" / "project8.exe").write_bytes(b"MZ")
        steam = base / "steam"
        (steam / "steamapps").mkdir(parents=True)
        (steam / "steamapps" / "libraryfolders.vdf").write_text(
            '"libraryfolders"\n{\n\t"1"\n\t{\n\t\t"path"\t\t"%s"\n\t}\n}\n'
            % str(library).replace("\\", "\\\\"),
            encoding="utf-8",
        )
        import gen_shell_data  # noqa: E402

        recorded = [str(path).lower() for path in gen_shell_data.steam_libraries(steam)]
        check("Steam's library record names a library outside the default leaves",
              str(library).lower() in recorded, str(recorded))

        original = gen_shell_data.steam_libraries
        gen_shell_data.steam_libraries = lambda root=None: [library]
        try:
            discovered = [
                str(row.get("path", "")).replace("\\", "/").lower()
                for row in gen_shell_data.read_installs(None, [])
            ]
        finally:
            gen_shell_data.steam_libraries = original
        check("discovery offers an install found only through that record",
              any(path.endswith("ol-lib-beta/steamapps/common/deadlock") for path in discovered),
              str(discovered))

        check("a client other than deadlock.exe is a compatible install",
              installer_pair.reading(other_game)["compatible"])
        seeded, detail = installer_pair.seed(other_game)
        check("another game's install accepts the release pair", seeded, detail)
        check("its installer is the release installer byte for byte",
              (other_game / installer_pair.BIN / "install.ps1").read_bytes()
              == installer_pair.PAIRS["release"][0].read_bytes())

        checkout = tree(base, "checkout")
        (checkout / "clientaddon").mkdir()
        seeded, detail = installer_pair.seed(checkout)
        pair = other_game / installer_pair.BIN / "install.ps1"
        check("a checkout-shaped tree accepts the development installer",
              seeded and (checkout / installer_pair.BIN / "install.ps1").read_bytes()
              != pair.read_bytes(), detail)

        # A tools tree carries a compiled addon, not necessarily a checkout, and discovery still
        # reads it as dev grade. Handing it the download installer would break the dev contract.
        tools_tree = tree(base, "tools-grade")
        check("a dev-grade tree with no checkout reads as the dev shape",
              installer_pair.shape(tools_tree, "dev") == "dev")
        seeded, detail = installer_pair.seed(tools_tree, "dev")
        check("a dev-grade tree receives this worktree's installer",
              seeded and (tools_tree / installer_pair.BIN / "install.ps1").read_bytes()
              == installer_pair.PAIRS["dev"][0].read_bytes(), detail)
        check("and its reading follows the dev pair, not the release one",
              installer_pair.reading(tools_tree, "dev")["installer"] == "current",
              installer_pair.reading(tools_tree, "dev")["installer"])

        # Another game is any Source 2 title with a gameinfo, not just Deadlock's citadel folder.
        cs2 = tree(library / "steamapps" / "common", "Counter-Strike Global Offensive",
                   gameinfo=False)
        (cs2 / "game" / "csgo").mkdir(parents=True, exist_ok=True)
        (cs2 / "game" / "csgo" / "gameinfo.gi").write_text("GameInfo\n{\n}\n", encoding="utf-8")
        (cs2 / "game" / "bin" / "win64" / "cs2.exe").write_bytes(b"MZ")
        (cs2 / "game" / "bin" / "win64" / "deadlock.exe").unlink()

        common = installer_pair.steam_common([library])
        check("the library's titles are enumerated by gameinfo, whatever the game is",
              any(path.name == cs2.name for path in common),
              str([path.name for path in common]))
        cs2_reading = installer_pair.reading(cs2)
        check("CS2's tree reads compatible and names its game",
              cs2_reading["compatible"] and cs2_reading["game"] == "csgo",
              str(cs2_reading))
        check("Deadlock's tree names citadel", installer_pair.reading(other_game)["game"] == "citadel",
              installer_pair.reading(other_game)["game"])
        seeded, detail = installer_pair.seed(cs2)
        check("CS2's tree accepts the release pair",
              seeded and (cs2 / installer_pair.BIN / "install.ps1").read_bytes()
              == installer_pair.PAIRS["release"][0].read_bytes(), detail)

        # The same parser feeds the shell's wish layer, so a discovered CS2 tree is a plan the
        # shell notifies about, not a verdict against the tree.
        import game_tree
        import gen_shell_data  # noqa: E402

        (cs2 / "content" / "csgo" / "panorama").mkdir(parents=True, exist_ok=True)
        import list_installs  # noqa: E402

        original_common = game_tree.steam_common
        original_hosts = list_installs.read_hosts
        game_tree.steam_common = lambda libraries=None: [cs2, other_game]
        list_installs.read_hosts = lambda: []
        try:
            games = gen_shell_data.read_game_installs([])
        finally:
            game_tree.steam_common = original_common
            list_installs.read_hosts = original_hosts
        check("the wish layer reads both discovered games",
              sorted(row["game"] for row in games) == ["citadel", "csgo"],
              str([row["game"] for row in games]))
        cs2_row = next(row for row in games if row["game"] == "csgo")
        check("the other game's Panorama root is read, not assumed",
              cs2_row["panorama"] == "content/csgo/panorama", cs2_row["panorama"])

        wishes = gen_shell_data.build_wishes(ROOT / "shell" / "alpha-shell",
                                             {"windows": []}, [], games)
        game_wishes = [wish for wish in wishes if wish["kind"] == "game"]
        check("each discovered install is a game wish, never a refusal",
              len(game_wishes) == 2 and not any(w["state"] == "refused" for w in game_wishes),
              str([(w["surface"], w["state"]) for w in game_wishes]))
        cs2_wish = next(wish for wish in game_wishes if "csgo" in wish["surface"])
        check("the CS2 wish names the game, its shape, and the tree",
              cs2_wish["state"] == "planned" and "csgo" in cs2_wish["plan"]
              and "release shape" in cs2_wish["plan"] and str(cs2).replace("\\", "/") in cs2_wish["plan"],
              cs2_wish["plan"])
        check("the wish detail names the Panorama renderer it would load",
              "content/csgo/panorama" in cs2_wish["detail"], cs2_wish["detail"])

        # A CSwin64 build is the same surface as a Reduced_CSDK tree: a tooling host, not another
        # game. Calling it a game would publish a wish to load a shell UI into a compiler tree.
        host = tree(base, "CSwin64_build_1", gameinfo=False)
        (host / "game" / "core").mkdir(parents=True, exist_ok=True)
        (host / "game" / "core" / "gameinfo.gi").write_text("GameInfo\n{\n}\n", encoding="utf-8")
        (host / "game" / "bin" / "win64" / "resourcecompiler.exe").write_bytes(b"MZ")
        (host / "game" / "bin" / "win64" / "cs2.exe").write_bytes(b"MZ")
        (host / "game" / "bin" / "win64" / "deadlock.exe").unlink()
        check("a CSwin64 build is read as a tools host, not a game",
              game_tree.role(host) == "tools" and game_tree.role(cs2) == "game",
              f"{game_tree.role(host)} {game_tree.role(cs2)}")

        list_installs.read_hosts = lambda: [{"path": str(host)}]
        game_tree.steam_common = lambda libraries=None: []
        try:
            host_rows = gen_shell_data.read_game_installs([])
        finally:
            list_installs.read_hosts = original_hosts
            game_tree.steam_common = original_common
        host_wishes = gen_shell_data.build_wishes(ROOT / "shell" / "alpha-shell",
                                                  {"windows": []}, [], host_rows)
        host_wish = next(wish for wish in host_wishes if wish["kind"] == "game")
        check("the tools host is planned, not missing a Panorama UI it never had",
              host_wish["state"] == "planned" and "installer host" in host_wish["plan"],
              f"{host_wish['state']} {host_wish['plan']}")

        generated = ROOT / "clientaddon" / "panorama" / "scripts" / "openlock_shell_data.js"
        if generated.is_file():
            text = generated.read_text(encoding="utf-8", errors="replace")
            data = json.loads(text[text.index("var SHELL =") + len("var SHELL ="):]
                              .rstrip().rstrip(";"))
            live = [wish for wish in data.get("wishes", []) if wish.get("kind") == "game"]
            check("the generated shell data carries this machine's game wishes",
                  bool(live) and not any(wish.get("state") == "refused" for wish in live),
                  str([(w.get("surface"), w.get("state")) for w in live]))

    print(f"ok: {checks} installer pair check(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

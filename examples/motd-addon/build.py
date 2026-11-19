"""Build the MOTD demo as a modern `secure-shell.surface/<32 hex>` package.

The package is a canonical `secure-shell.package/<32 hex>` directory: `manifest.json` + `payload.bin`,
BLAKE3 identity, and a `secure-shell.surface/<32 hex>` payload. There is no SHPKG frame and no package
emit path for the legacy format. The VPK still carries the compiled resources for a mounted
layout, but the window declaration comes from the modern package.

Run from this folder:
    python build.py --game "D:\\SteamLibrary\\steamapps\\common\\Deadlock\\game"
    python build.py --game ... --motd "C:\\servers\\one\\motd.txt" --no-install
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DEFAULT_GAME = Path(os.environ.get("DEADLOCK_GAME", r"D:\SteamLibrary\steamapps\common\Deadlock\game"))
DEFAULT_SDK = Path(os.environ.get("OPENLOCK_SDK", r"D:\Users\alacrity\Documents\Documents\Reduced_CSDK_12"))
PACKAGE_ID = "motd-demo"
WINDOW_ID = "motd-panel"


def resolve_game(value: str) -> Path:
    path = Path(value).expanduser().resolve()
    if (path / "citadel" / "gameinfo.gi").exists():
        return path
    if (path / "game" / "citadel" / "gameinfo.gi").exists():
        return path / "game"
    raise SystemExit(f"not a Deadlock game directory: {path}")


def resolve_sdk(value: str) -> Path:
    path = Path(value).expanduser().resolve()
    compiler = path / "game" / "bin" / "win64" / "resourcecompiler.exe"
    packer = path / "game" / "bin" / "win64" / "CSDKCfgVPK.exe"
    if compiler.exists() and packer.exists():
        return path
    raise SystemExit(f"SDK needs resourcecompiler.exe and CSDKCfgVPK.exe under {path}")


def render_layout(motd: str) -> str:
    template = (HERE / "panorama" / "layout" / "motd-panel.xml").read_text(encoding="utf-8")
    lines = [line.rstrip() for line in motd.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    lines = [line for line in lines if line.strip()]
    if not lines:
        lines = ["Welcome to the server."]
    labels = "\n".join(
        '        <Label class="MotdLine" textwrap="true" text="' + escape(line, {'"': "&quot;"}) + '" />'
        for line in lines
    )
    return template.replace("{{MOTD_LINES}}", labels)


def write_modern_package(package_dir: Path) -> str:
    """Invoke the one modern packer; this example has no legacy emit path."""
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "tools" / "modern_package.py"),
            "--surface",
            str(HERE / "package.surface"),
            "--out",
            str(package_dir),
            "--name",
            PACKAGE_ID,
        ],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise SystemExit(f"modern packer failed ({result.returncode})\n{result.stdout}\n{result.stderr}")
    return (package_dir / "identity.txt").read_text(encoding="utf-8").strip()


def pack_vpk(packer: Path, content: Path, archive: Path) -> None:
    if archive.exists():
        archive.unlink()
    log = archive.with_suffix(".pack.log")
    with log.open("w", encoding="utf-8") as handle:
        process = subprocess.Popen(
            [str(packer), str(content), str(archive)],
            cwd=str(ROOT),
            stdout=handle,
            stderr=subprocess.STDOUT,
        )
        last = -1
        stable = 0
        deadline = time.time() + 25
        while time.time() < deadline:
            if archive.exists() and archive.stat().st_size > 0:
                size = archive.stat().st_size
                if size == last:
                    stable += 1
                else:
                    stable, last = 0, size
                if stable >= 3:
                    break
            if process.poll() is not None:
                break
            time.sleep(0.25)
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
    if not archive.exists() or archive.stat().st_size == 0:
        tail = log.read_text(encoding="utf-8", errors="replace")[-1500:]
        raise SystemExit(f"CSDKCfgVPK wrote no archive\n{tail}")


def validate_vpk(archive: Path) -> set[str]:
    sys.path.insert(0, str(ROOT / "tools"))
    import vpk_read  # type: ignore

    entries, _ = vpk_read.read_tree(str(archive))
    names = {entry["path"] for entry in entries}
    required = {"panorama/layout/motd-panel.vxml_c", "panorama/styles/motd.vcss_c"}
    missing = required - names
    if missing:
        raise SystemExit(f"VPK is missing {sorted(missing)}; entries: {sorted(names)}")
    return names


def main() -> int:
    parser = argparse.ArgumentParser(description="Build and install the dl-openshell MOTD demo addon.")
    parser.add_argument("--game", default=str(DEFAULT_GAME), help="Deadlock game directory (the one with citadel/)")
    parser.add_argument("--sdk", default=str(DEFAULT_SDK), help="CSDK root with resourcecompiler.exe and CSDKCfgVPK.exe")
    parser.add_argument("--motd", default=str(HERE / "motd.txt"), help="server MOTD text to bake into the layout")
    parser.add_argument("--no-install", action="store_true", help="build the VPK but do not copy it into the game")
    args = parser.parse_args()

    game = resolve_game(args.game)
    sdk = resolve_sdk(args.sdk)
    motd = Path(args.motd).read_text(encoding="utf-8")
    compiler = sdk / "game" / "bin" / "win64" / "resourcecompiler.exe"
    packer = sdk / "game" / "bin" / "win64" / "CSDKCfgVPK.exe"

    stage = ROOT / "dist" / "motd_demo"
    if stage.exists():
        shutil.rmtree(stage)
    content = stage / "content"
    (content / "panorama" / "layout").mkdir(parents=True)
    (content / "panorama" / "styles").mkdir(parents=True)

    layout = render_layout(motd)
    (content / "panorama" / "layout" / f"{WINDOW_ID}.xml").write_text(layout, encoding="utf-8")
    shutil.copy2(HERE / "panorama" / "styles" / "motd.css", content / "panorama" / "styles" / "motd.css")

    compile_root = sdk / "content" / "citadel_addons" / "motd_demo"
    built_root = sdk / "game" / "citadel_addons" / "motd_demo"
    for path in (compile_root, built_root):
        if path.exists():
            shutil.rmtree(path)
    compile_root.mkdir(parents=True)
    shutil.copytree(content / "panorama", compile_root / "panorama")

    inputs = [
        (compile_root / "panorama" / "layout" / f"{WINDOW_ID}.xml").resolve(),
        (compile_root / "panorama" / "styles" / "motd.css").resolve(),
    ]
    command = [
        str(compiler),
        "-f",
        "-nop4",
        "-DANGER_MODE_ignore_schema_mismatches",
        "-game",
        str(sdk / "game" / "citadel"),
        "-i",
        *[str(path) for path in inputs],
    ]
    result = subprocess.run(command, cwd=str(sdk), capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"resourcecompiler failed ({result.returncode})\n{result.stdout}\n{result.stderr}")

    compiled_layout = built_root / "panorama" / "layout" / f"{WINDOW_ID}.vxml_c"
    compiled_style = built_root / "panorama" / "styles" / "motd.vcss_c"
    missing = [str(path) for path in (compiled_layout, compiled_style) if not path.exists()]
    if missing:
        raise SystemExit(f"resourcecompiler wrote no {missing}")

    package = stage / "motd-demo.pkg"
    identity = write_modern_package(package)

    vpk_root = stage / "vpk"
    (vpk_root / "panorama" / "layout").mkdir(parents=True)
    (vpk_root / "panorama" / "styles").mkdir(parents=True)
    shutil.copy2(compiled_layout, vpk_root / "panorama" / "layout" / f"{WINDOW_ID}.vxml_c")
    shutil.copy2(compiled_style, vpk_root / "panorama" / "styles" / "motd.vcss_c")

    archive = stage / "motd-demo.vpk"
    pack_vpk(packer, vpk_root, archive)
    names = validate_vpk(archive)

    game_vpks = game / "citadel" / "deadworks_addons" / "vpks"
    target = game_vpks / "motd-demo.pkg"
    if not args.no_install:
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(package, target)
        shutil.copy2(archive, game_vpks / "motd-demo.vpk")

    print(f"package   {identity}")
    print(f"path      {package}")
    print(f"archive   {archive}")
    print(f"entries   {', '.join(sorted(names))}")
    print(f"window    addon:{PACKAGE_ID}:{WINDOW_ID}")
    print(f"installed {target if not args.no_install else '(not installed)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

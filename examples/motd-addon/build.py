"""Build the MOTD demo as a real shploingus package and install its addon VPK.

The package frame is SHPKG003: the eight-byte magic, a little-endian recipe length, the
SHA-256 of the recipe, the shploingus.recipe/3 source, then the artifact table. The VPK
carries the same compiled layout and stylesheet, because the loader resolves a window's
layout only when the archive actually contains it.

Run from this folder:
    python build.py --game "D:\\SteamLibrary\\steamapps\\common\\Deadlock\\game"
    python build.py --game ... --motd "C:\\servers\\one\\motd.txt" --no-install
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import struct
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


def write_frame(recipe: bytes, artifacts: list[tuple[str, bytes]]) -> bytes:
    if not recipe.endswith(b"\n"):
        recipe += b"\n"
    if b"\r" in recipe:
        recipe = recipe.replace(b"\r\n", b"\n").replace(b"\r", b"\n")

    parts = [
        b"SHPKG003",
        struct.pack("<I", len(recipe)),
        hashlib.sha256(recipe).digest(),
        recipe,
        struct.pack("<I", len(artifacts)),
    ]
    for path, data in artifacts:
        encoded = path.encode("utf-8")
        parts.extend((struct.pack("<H", len(encoded)), encoded, struct.pack("<I", len(data)), data))
    return b"".join(parts)


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
    required = {"addons/motd.shpkg", "panorama/layout/motd-panel.vxml_c", "panorama/styles/motd.vcss_c"}
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

    recipe = (HERE / "package.shspec").read_bytes()
    layout_bytes = layout.encode("utf-8")
    style_bytes = (HERE / "panorama" / "styles" / "motd.css").read_bytes()
    artifacts = [
        (f"panorama/layout/{WINDOW_ID}.xml", layout_bytes),
        ("panorama/styles/motd.css", style_bytes),
        (f"panorama/layout/{WINDOW_ID}.vxml_c", compiled_layout.read_bytes()),
        ("panorama/styles/motd.vcss_c", compiled_style.read_bytes()),
    ]
    frame = write_frame(recipe, artifacts)
    shpkg = stage / "motd.shpkg"
    shpkg.write_bytes(frame)

    vpk_root = stage / "vpk"
    (vpk_root / "panorama" / "layout").mkdir(parents=True)
    (vpk_root / "panorama" / "styles").mkdir(parents=True)
    (vpk_root / "addons").mkdir(parents=True)
    shutil.copy2(shpkg, vpk_root / "addons" / "motd.shpkg")
    shutil.copy2(compiled_layout, vpk_root / "panorama" / "layout" / f"{WINDOW_ID}.vxml_c")
    shutil.copy2(compiled_style, vpk_root / "panorama" / "styles" / "motd.vcss_c")

    archive = stage / "motd-demo.vpk"
    pack_vpk(packer, vpk_root, archive)
    names = validate_vpk(archive)

    target = game / "citadel" / "deadworks_addons" / "vpks" / "motd-demo.vpk"
    if not args.no_install:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(archive, target)

    print(f"package   {PACKAGE_ID} ({len(frame)} bytes, SHA-256 {hashlib.sha256(frame).hexdigest()})")
    print(f"archive   {archive}")
    print(f"entries   {', '.join(sorted(names))}")
    print(f"window    addon:{PACKAGE_ID}:{WINDOW_ID}")
    print(f"installed {target if not args.no_install else '(not installed)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

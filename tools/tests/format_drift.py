#!/usr/bin/env python3
"""Recompute every current format id and check every recorded occurrence.

The expected ids are not read from the files being checked. They are recomputed from the contract
bytes, then compared with the source, generated payloads, docs, landing material, release installer,
release VPK and the extracted entries inside VPK archives. A stale hash, a missing required current
hash, a changed contract byte, or an unreadable archive is a failure.

Run from the openlock repository root:

    python tools/tests/format_drift.py
"""
from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import modern_package  # noqa: E402
import vpk_read  # noqa: E402

# The simple families are the same `FormatFamilies.Simple` contract in FormatFamilies.cs: the
# family, its legacy counter and its reader are the only per-family inputs.
SIMPLE_FAMILIES = {
    "openlock.game": 1,
    "shploingus.recipe": 3,
    "shploingus.cells": 1,
    "shploingus.cellframe": 1,
    "shploingus.deadlock": 1,
    "openlock.layout": 1,
    "openlock.layouts": 1,
    "openlock.envelope": 1,
    "openlock.build": 1,
    "openlock.observer": 1,
    "shploingus.theme": 1,
    "shploingus.form": 1,
    "openlock.popit-elements": 2,
    "openlock.cua-client": 1,
    "secure-shell.axis": 1,
    "cua.fleet.summary": 1,
    "goose.vanilla": 1,
    "goose.client": 1,
    "goose.java": 1,
    "goose.native": 1,
    "dl-enclave.sig": 1,
}

# These contracts live in ModernPackage.cs / SurfaceDocument.cs / modern_package.py. Importing the
# Python implementation makes this guard recompute the package, surface and file-index ids from
# the same contract lines the packer uses.
CONTRACT_IDS = {
    "openlock.addons": modern_package.ADDONS_SCHEMA,
    "goose.mod": modern_package.GOOSE_MOD_SCHEMA,
    "dl-enclave.pkg": modern_package.DL_ENCLAVE_SCHEMA,
    "secure-shell.package": modern_package.PACKAGE_SCHEMA,
    "secure-shell.surface": modern_package.SURFACE_SCHEMA,
    "secure-shell.files": modern_package.FILES_SCHEMA,
}

# These are deliberate negative fixtures. They are accepted only in the test surfaces named by
# `is_test_surface`; the same bytes in a source, generated, documentation or release file fail.
TEST_SENTINELS = {"0" * 32, "f" * 32}


def expected_ids() -> dict[str, str]:
    expected: dict[str, str] = {}
    for family, legacy in SIMPLE_FAMILIES.items():
        text = (f"family\t{family}\n"
                f"legacy-family\t{family}\n"
                f"legacy-schema\t{legacy}\n"
                f"reader\t{family}.reader.v1\n")
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        expected[family] = f"{family}/{digest[:32]}"
    expected.update(CONTRACT_IDS)
    return expected


def scan_files() -> list[Path]:
    roots = [
        ROOT / "README.md",
        ROOT / "AGENTS.md",
        ROOT / "install.ps1",
        ROOT / "src",
        ROOT / "tools",
        ROOT / "clientaddon",
        ROOT / "shell",
        ROOT / "patches",
        ROOT / "examples",
        ROOT / "landing",
        ROOT / "docs",
        ROOT / "dist",
        ROOT / "release",
        ROOT / "artifacts" / "packagetests",
        ROOT / "artifacts" / "packages",
        ROOT / "artifacts" / "rebuild" / "vpk-root",
        ROOT / "artifacts" / "rebuild" / "extracted",
        ROOT / "artifacts" / "rebuild" / "content",
    ]
    files: list[Path] = []
    for path in roots:
        if path.is_file():
            files.append(path)
        elif path.is_dir():
            files.extend(candidate for candidate in path.rglob("*") if candidate.is_file())
    return files


def is_test_surface(relative: Path) -> bool:
    """Only the checked-in negative-fixture test trees may contain sentinel ids."""
    return relative.parts[:2] in (("tools", "tests"), ("artifacts", "packagetests"))


def scan_bytes(data: bytes, label: str, expected: dict[str, str],
               problems: list[str], counts: dict[str, int]) -> None:
    pattern = re.compile(rb"\b([a-z][a-z0-9.-]*)/([0-9a-f]{32})\b")
    for match in pattern.finditer(data):
        family = match.group(1).decode("ascii")
        suffix = match.group(2).decode("ascii")
        if family not in expected:
            # Only fail on a familiar namespace; do not turn random compressed bytes into a
            # format claim.
            if family.startswith(("openlock.", "shploingus.", "goose.", "dl-enclave.",
                                   "secure-shell.", "cua.")):
                problems.append(f"{label}: unknown format family {family}/{suffix}")
            continue
        if suffix == expected[family].split("/", 1)[1]:
            counts["checked"] += 1
            continue
        if suffix in TEST_SENTINELS and is_test_surface(Path(label.split("::", 1)[0])):
            counts["sentinels"] += 1
            continue
        problems.append(f"{label}: {family}/{suffix} != recorded {expected[family]}")


def entry_bytes(path: Path, entry: dict, inline: dict) -> bytes | None:
    """Read one VPK entry, including entries in numbered sidecar archives."""
    blob = inline.get(entry["path"])
    if blob is not None:
        return blob
    return vpk_read.entry_bytes(str(path), entry)


def scan_vpk(path: Path, relative: Path, expected: dict[str, str],
             problems: list[str], counts: dict[str, int]) -> bytes:
    """Scan the real bytes of every extracted entry, not the directory listing.

    The project's VPK writer stores entries inline and uncompressed, so an extracted entry is the
    payload the client reads. Reading the tree first also covers a numbered `pak01_NNN.vpk`.
    """
    try:
        raw = path.read_bytes()
        scan_bytes(raw, f"{relative}::archive", expected, problems, counts)
        entries, inline = vpk_read.read_tree(str(path))
    except Exception as error:  # noqa: BLE001 - a malformed shipped archive is a failure
        problems.append(f"{relative}: VPK unreadable: {error}")
        return b""
    counts["vpk_entries"] += len(entries)
    collected: list[bytes] = []
    for entry in entries:
        try:
            data = entry_bytes(path, entry, inline)
        except Exception as error:  # noqa: BLE001 - report the exact entry
            problems.append(f"{relative}::{entry['path']}: entry unreadable: {error}")
            continue
        if data is None:
            problems.append(f"{relative}::{entry['path']}: entry data missing")
            continue
        collected.append(data)
        label = f"{relative}::{entry['path']}"
        scan_bytes(data, label, expected, problems, counts)
        if entry["path"].endswith(".vjs_c"):
            counts["compiled_entries"] += 1
    return b"\n".join(collected)


def main() -> int:
    expected = expected_ids()
    problems: list[str] = []
    counts = {"checked": 0, "sentinels": 0, "vpk_entries": 0, "compiled_entries": 0}
    excluded = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"}
    vpk_data: dict[Path, bytes] = {}

    for path in scan_files():
        relative = path.relative_to(ROOT)
        if path.suffix.lower() in excluded:
            continue
        if path.suffix.lower() == ".vpk":
            vpk_data[path] = scan_vpk(path, relative, expected, problems, counts)
            continue
        try:
            data = path.read_bytes()
        except OSError as error:
            problems.append(f"{relative}: unreadable: {error}")
            continue
        scan_bytes(data, str(relative), expected, problems, counts)

    # A checksum is also a recorded surface.
    checksum_path = ROOT / "release" / "openshell-player.sha256"
    vpk_path = ROOT / "release" / "openshell-player.vpk"
    if checksum_path.is_file() and vpk_path.is_file():
        recorded = checksum_path.read_text(encoding="utf-8").strip().split()[0]
        actual = hashlib.sha256(vpk_path.read_bytes()).hexdigest()
        if recorded != actual:
            problems.append(f"release/openshell-player.sha256: {recorded} != {actual}")

    # Required current ids in the surfaces that are actually shipped or generated. These checks
    # catch an artifact that was rebuilt from an older contract even when its stale hash was
    # removed rather than replaced. VPKs are checked through extracted entry bytes above and here.
    required = {
        "release/install.ps1": ["openlock.build"],
        "release/openshell-player.vpk": [
            "openlock.addons", "shploingus.theme", "openlock.game", "shploingus.recipe",
            "shploingus.cells", "openlock.envelope", "openlock.build",
        ],
        "dist/openlock_ui/pak01_dir.vpk": [
            "openlock.addons", "shploingus.theme", "openlock.game", "shploingus.recipe",
            "shploingus.cells", "openlock.envelope", "openlock.build",
        ],
        "dist/motd_demo/motd-demo.pkg/manifest.json": [
            "secure-shell.package", "secure-shell.surface",
        ],
        "dist/motd_demo/motd-demo.pkg/payload.bin": ["secure-shell.surface"],
        "dist/cua-client/manifest.json": ["openlock.cua-client"],
        "dist/cua-client/app.js": ["secure-shell.axis", "cua.fleet.summary"],
        "landing/index.html": ["shploingus.recipe"],
        "landing/tools/addons.json": ["shploingus.recipe"],
        "examples/motd-addon/package.surface": ["secure-shell.surface"],
        "docs/popit-elements.json": ["openlock.popit-elements"],
    }
    for relative, families in required.items():
        path = ROOT / relative
        if not path.is_file():
            problems.append(f"{relative}: required surface is missing")
            continue
        if path.suffix.lower() == ".vpk":
            data = vpk_data.get(path)
            if data is None:
                data = scan_vpk(path, Path(relative), expected, problems, counts)
                vpk_data[path] = data
        else:
            data = path.read_bytes()
        for family in families:
            current = expected[family].encode("ascii")
            if current not in data:
                problems.append(f"{relative}: missing {expected[family]}")

    if problems:
        print("format drift guard: FAILED", file=sys.stderr)
        for problem in problems:
            print("  " + problem, file=sys.stderr)
        return 1
    print(
        "format drift guard: OK "
        f"({counts['checked']} recorded ids checked, {len(expected)} families, "
        f"{counts['vpk_entries']} VPK entries including "
        f"{counts['compiled_entries']} compiled .vjs_c payloads, "
        f"{counts['sentinels']} test-only sentinels ignored)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

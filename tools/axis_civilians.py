#!/usr/bin/env python3
"""Probe the CUA axis machine and hand its civilians to the shell as a Popit window.

The shell already mounts packages: a modern `.pkg` carries a surface document, and
`dl_openshell_deliver <path>` hands that surface to every connected shell live. This tool is the
probe half of that path. It is a client of the Debian machine's axis routes:

* `/api/axis/system` names the machine, its version and the client digest it sees;
* `/api/axis/civilians` gives the score, the band and the required capabilities;
* `/api/axis/stars` gives the star count and the axes it is measured over.

The window is a Popit application window: one panel, a plate label, a meta label per fact and one
row per civilian. Every value is drawn from the reading, and the surface is packed by
`tools/modern_package.py`, so the delivery carries a real package identity
(`name@revision+blake3:<hex>`) rather than a rewritten file.

    python tools/axis_civilians.py                 # read the machine, write the package
    python tools/axis_civilians.py --deliver-cmd   # print the in-game delivery command

The machine answers on Windows when loopback resolves and through WSL when it does not;
`FAMILY_AXIS` and `FAMILY_AXIS_DISTRO` name the endpoint and the distribution.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from modern_package import write_surface  # noqa: E402 - the one packer

SURFACE_SCHEMA = "secure-shell.surface/7af4f34e745ebf547b3fc71146ef314c"
OUT = ROOT / "dist" / "axis-civilians"
NAME = "axis-civilians"

MACHINE = os.environ.get("FAMILY_AXIS", "http://127.0.0.1:8787")
DISTRO = os.environ.get("FAMILY_AXIS_DISTRO", "Debian")
READINGS = ("/api/axis/system", "/api/axis/civilians", "/api/axis/stars")

MAX_ROWS = 12


def fetch(path: str) -> dict:
    try:
        with urllib.request.urlopen(f"{MACHINE}{path}", timeout=6) as answer:  # noqa: S310 - loopback
            return json.loads(answer.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
        pass
    run = subprocess.run(
        ["wsl.exe", "-d", DISTRO, "-e", "curl", "-s", "-m", "6", f"http://127.0.0.1:8787{path}"],
        capture_output=True, text=True, check=False,
    )
    if run.returncode != 0 or not run.stdout.strip():
        raise SystemExit(f"axis-machine-absent: {path} did not answer at {MACHINE}")
    try:
        return json.loads(run.stdout)
    except json.JSONDecodeError as error:
        raise SystemExit(f"axis-machine-refused: {path} returned no json, {error}") from error


def reading() -> dict:
    system = fetch(READINGS[0])
    civilians = fetch(READINGS[1])
    stars = fetch(READINGS[2]).get("contract", {})
    facts = {
        "host": str(system.get("host", "the machine")),
        "version": str(system.get("version", "")),
        "client": str(system.get("client", "")),
        "score": civilians.get("score", 0),
        "band": str(civilians.get("band", "")),
        "state": str(civilians.get("state", "")),
        "required": [str(item) for item in civilians.get("required", [])],
        "components": civilians.get("components", []),
        "stars": int(stars.get("starCount", 0)),
        "axes": int(stars.get("axisCount", 0)),
    }
    facts["digest"] = hashlib.sha256(
        json.dumps({k: v for k, v in facts.items() if k != "client"}, sort_keys=True).encode("utf-8")
    ).hexdigest()
    return facts


def rows(facts: dict) -> list[tuple[str, str]]:
    """One line per civilian component: its name, its weight and what the machine says it holds."""
    out = []
    for component in facts["components"][:MAX_ROWS]:
        detail = str(component.get("detail", ""))
        name = str(component.get("id", "civilian"))
        # The row names the line that makes the machine's civilian a bot in this lobby.
        out.append((name, f"{component.get('value', 0)}/{component.get('weight', 0)} {detail}  openlock_axis_bot {name}"))
    return out


def surface(facts: dict) -> str:
    lines = [
        SURFACE_SCHEMA,
        "surface\t" + NAME,
        "requires\tobserve",
        # The Popit window: a tab on the right dock, moved by its plate and resized by its grip.
        "window\tcivilians-panel\tCivilians\ttab\tright-dock\t180\t150\t460\t380\t280\t150\ttrue\tfalse"
        "\tminimize,maximize,close\tdrag,resize\tsurface\treadout",
        "node\tcivilians-panel\tciv-root\t-\tpane\tsurface\t-",
        "node\tcivilians-panel\tciv-title\tciv-root\tlabel\ttitle\tCivilians",
        "node\tcivilians-panel\tciv-machine\tciv-root\tlabel\tbody\t"
        + f"{facts['host']} {facts['version']}".strip(),
        "node\tcivilians-panel\tciv-score\tciv-root\tlabel\tmeta\t"
        + f"score {facts['score']} in band {facts['band']}",
        "node\tcivilians-panel\tciv-stars\tciv-root\tlabel\tmeta\t"
        + f"{facts['stars']} stars over {facts['axes']} axes",
    ]
    for index, (name, detail) in enumerate(rows(facts)):
        lines.append(f"node\tcivilians-panel\tciv-row-{index}\tciv-root\tlabel\tbody\t{name}  {detail}")
    lines.append(f"node\tcivilians-panel\tciv-digest\tciv-root\tlabel\tmeta\treading {facts['digest'][:12]}")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    facts = reading()
    OUT.mkdir(parents=True, exist_ok=True)
    document = OUT / "axis-civilians.surface"
    document.write_text(surface(facts), encoding="utf-8")
    package = OUT / f"{NAME}.pkg"
    write_surface(document, package, NAME, 1)
    identity = (package / "identity.txt").read_text(encoding="utf-8").strip()
    if "--deliver-cmd" in args:
        print(f"dl_openshell_deliver {package}")
        return 0
    print(json.dumps({
        "machine": facts["host"],
        "version": facts["version"],
        "score": facts["score"],
        "band": facts["band"],
        "stars": facts["stars"],
        "axes": facts["axes"],
        "digest": facts["digest"],
        "identity": identity,
        "package": str(package.relative_to(ROOT)).replace("\\", "/"),
        "deliver": f"dl_openshell_deliver {package}",
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

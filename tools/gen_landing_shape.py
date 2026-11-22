#!/usr/bin/env python3
"""Generate the landing page's contour facts from the machine and this repository.

The page keeps its own design, but the contour section's numbers and sentences are not typed
into it. They are read from the same two records the shell is built from:

* `docs/contour.json` and `docs/family-look.json` give the shape and the accepted corner;
* the Debian machine's axis routes give what the family says about itself;
* `tools/contour_gate.py` gives the check count that holds the shape.

The result is `landing/family-look.json`, which `landing/contour.js` renders into the page at
view time. Every sentence is checked by the family prose tools before it is written.

    python tools/gen_landing_shape.py            # read the machine, write the facts
    python tools/gen_landing_shape.py --check    # exit 1 when the file is not these records
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTOUR = ROOT / "docs" / "contour.json"
LOOK = ROOT / "docs" / "family-look.json"
OUTPUT = ROOT / "landing" / "family-look.json"
GATE = ROOT / "tools" / "contour_gate.py"

MACHINE = os.environ.get("FAMILY_AXIS", "http://127.0.0.1:8787")
DISTRO = os.environ.get("FAMILY_AXIS_DISTRO", "Debian")
READINGS = ("/api/axis/system", "/api/axis/civilians", "/api/axis/stars")

PROSE_TOOL = Path("<home>/Documents/deadlock-model-forge/tools/ui_prose.py")
PROSE_MJS = Path("F:/Documents/brass-meridian/tools/prose.mjs")
MAX_WORDS = 18
MAX_CHARS = 92


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
        raise SystemExit(f"landing-machine-absent: {path} did not answer at {MACHINE}")
    return json.loads(run.stdout)


def machine() -> dict:
    readings = {path: fetch(path) for path in READINGS}
    system = readings["/api/axis/system"]
    civilians = readings["/api/axis/civilians"]
    stars = readings["/api/axis/stars"].get("contract", {})
    facts = {
        "host": system.get("host", ""),
        "version": system.get("version", ""),
        "score": civilians.get("score", 0),
        "band": civilians.get("band", ""),
        "stars": stars.get("starCount", 0),
        "axes": stars.get("axisCount", 0),
    }
    # The digest covers the facts the page prints, not the uptime a live route carries, so the
    # same reading on the same machine seals to the same value.
    facts["digest"] = hashlib.sha256(json.dumps(facts, sort_keys=True).encode("utf-8")).hexdigest()
    return facts


def gate_counts() -> dict:
    env = dict(os.environ, OPENLOCK_CONTOUR_GENERATOR="1")
    run = subprocess.run([sys.executable, str(GATE), "--json"], cwd=ROOT, env=env,
                         capture_output=True, text=True, check=False)
    try:
        data = json.loads(run.stdout)
    except json.JSONDecodeError:
        raise SystemExit(f"landing-gate-unreadable: {run.stdout[:120]}{run.stderr[:120]}")
    # The shape checks, not the page's own check: a page cannot count itself.
    return {"checks": data.get("shape_checks", data.get("checks", 0)),
            "refusals": len(data.get("refusals", []))}


def prose_check(texts: list[str]) -> None:
    for text in texts:
        if len(text.split()) > MAX_WORDS or len(text) > MAX_CHARS:
            raise SystemExit(f"landing-prose-budget: {text[:60]}")
    if not PROSE_TOOL.exists():
        raise SystemExit("landing-prose-missing: the family prose checker is not on disk")
    spec = importlib.util.spec_from_file_location("family_ui_prose", PROSE_TOOL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with tempfile.TemporaryDirectory() as folder:
        planted = Path(folder) / "landing.py"
        planted.write_text("".join(f"hint(layout, {text!r})\n" for text in texts), encoding="utf-8")
        hits, visible = module.scan([planted])
    if hits or visible == 0:
        detail = "; ".join(f"{hit['rule']} {hit['text'][:40]}" for hit in hits[:3])
        raise SystemExit(f"landing-prose-refused: {detail or 'no string was read'}")
    if PROSE_MJS.exists():
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "copy.md"
            path.write_text("\n\n".join(texts), encoding="utf-8")
            script = (
                f'import {{ reviewProse }} from {json.dumps(PROSE_MJS.as_uri())};'
                'import { readFileSync } from "node:fs";'
                f'const issues = reviewProse(readFileSync({json.dumps(str(path).replace(chr(92), "/"))}, "utf8"));'
                'if (issues.length) { console.error(JSON.stringify(issues)); process.exit(1); }'
            )
            run = subprocess.run(["node", "--input-type=module", "-e", script],
                                 capture_output=True, text=True, check=False)
        if run.returncode != 0:
            raise SystemExit(f"landing-prose-refused: prose.mjs said {run.stderr.strip()[:160]}")


def build() -> str:
    contour = json.loads(CONTOUR.read_text(encoding="utf-8"))
    look = json.loads(LOOK.read_text(encoding="utf-8"))
    machine_facts = machine()
    gate = gate_counts()
    corner = look["corner_px"]
    surfaces = len(look["surfaces"])
    copy = {
        "lede": f"One corner, {corner['width']} by {corner['height']} px, on a chip and a window",
        "caption": f"{machine_facts['host']} reads {machine_facts['stars']} stars over {machine_facts['axes']} axes",
        "note": f"The gate holds {gate['checks']} checks and {surfaces} surfaces take this corner",
    }
    prose_check(list(copy.values()))
    text = {
        "schema": "openlock.landing-look/1",
        "machine": machine_facts,
        "gate": gate,
        "contour": contour,
        "look": look,
        "copy": copy,
    }
    return json.dumps(text, indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    text = build()
    if "--check" in args:
        current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if current != text:
            print("[FAIL] landing-shape-stale: landing/family-look.json is not these records")
            return 1
        print("[ok] the landing shape facts are these records")
        return 0
    OUTPUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

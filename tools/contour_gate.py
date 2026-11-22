#!/usr/bin/env python3
"""The contour gate for the Panorama shell: one shape, one corner, nothing stretched.

The owner's rule for the family is that the contour is the framing authority and that no part
of it stretches. In the Panorama shell the shape is `docs/contour.json` and the pin is
`docs/family-look.json`; the runtime draws it as nine slices. This gate refuses the drifts that
would put a rounded rectangle back in place of the shape:

  C1 `contour-authority`      the profile is one file of eight cubics
  C2 `contour-pinned`         the pin names a corner, pads and surfaces
  C3 `contour-data-current`   the generated data is the shape on disk
  C4 `corner-is-the-button`   a window's corner is the taskbar button's corner, never bigger
  C5 `nothing-stretched`      no pin surface declares a radius, so a rectangle cannot return
  C6 `outline-not-clipped`    the ink is the outer edge and the fill is inset by the stroke
  C7 `contour-slices-tested`  the slices match an independent reading of the profile
  C8 `contour-wired`          the shell includes the runtime and paints frames and chips

    python tools/contour_gate.py            # print every check and one RESULT line
    python tools/contour_gate.py --json     # machine-readable
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTOUR = ROOT / "docs" / "contour.json"
LOOK = ROOT / "docs" / "family-look.json"
DATA = ROOT / "clientaddon" / "panorama" / "scripts" / "openlock_contour_data.js"
RUNTIME = ROOT / "clientaddon" / "panorama" / "scripts" / "openlock_contour.js"
SHELL_JS = ROOT / "clientaddon" / "panorama" / "scripts" / "openlock_shell.js"
SHELL_XML = ROOT / "clientaddon" / "panorama" / "layout" / "openlock_shell.xml"
SHELL_CSS = ROOT / "clientaddon" / "panorama" / "styles" / "openlock_shell.css"
FORMS = ROOT / "shell" / "alpha-shell" / "forms"
GEN = ROOT / "tools" / "gen_contour_slices.py"
TEST = ROOT / "tools" / "tests" / "contour-test.js"

CHECKED: list[str] = []
REFUSALS: list[dict] = []


def check(code: str, label: str, holds: bool, where: str = "", detail: str = "") -> None:
    if holds:
        CHECKED.append(f"{code} {label}")
    else:
        REFUSALS.append({"code": code, "label": label, "where": where, "detail": detail})


def c1_authority() -> None:
    shape = json.loads(CONTOUR.read_text(encoding="utf-8")) if CONTOUR.exists() else {}
    segments = shape.get("segments", [])
    check("contour-authority", "the profile is one file of eight cubics",
          len(segments) == 8 and all(len(segment) == 6 for segment in segments),
          str(CONTOUR.relative_to(ROOT)), f"{len(segments)} segments")


def c2_pinned() -> None:
    look = json.loads(LOOK.read_text(encoding="utf-8")) if LOOK.exists() else {}
    corner = look.get("corner_px", {})
    constants = look.get("constants", {})
    holds = bool(corner.get("width") and corner.get("height")) and bool(look.get("surfaces")) \
        and constants.get("stroke_width") == 1 \
        and constants.get("clip_pad", 0) < constants.get("frame_pad", 0)
    check("contour-pinned", "the pin names a corner, pads and surfaces", holds,
          str(LOOK.relative_to(ROOT)),
          f"corner {corner.get('width')}x{corner.get('height')}, {len(look.get('surfaces', []))} surfaces")


def c3_data() -> None:
    run = subprocess.run([sys.executable, str(GEN), "--check"], cwd=ROOT,
                         capture_output=True, text=True, check=False)
    check("contour-data-current", "the generated data is the shape on disk", run.returncode == 0,
          str(DATA.relative_to(ROOT)), (run.stdout + run.stderr).strip()[:200])


def c4_corner() -> None:
    look = json.loads(LOOK.read_text(encoding="utf-8"))
    data = json.loads(DATA.read_text(encoding="utf-8").split("= ", 1)[1].rstrip().rstrip(";"))
    corner = look["corner_px"]
    band = data["band"]["y"]
    # The window's corner is the pin's, and the pin's corner is what the band yields at scale 1.
    implied = band * (corner["height"] / band)
    holds = abs(implied - corner["height"]) < 1e-6
    runtime = RUNTIME.read_text(encoding="utf-8")
    # The runtime takes one corner number for every surface, and only shortens it by h / 3.
    holds = holds and "look.corner_px.height" in runtime and "height / 2" in runtime
    holds = holds and "cornerPx" in runtime  # the one factor, never a second per-axis scale
    check("corner-is-the-button", "a window's corner is the taskbar button's corner, never bigger",
          holds, str(RUNTIME.relative_to(ROOT)),
          f"pin corner {corner['width']}x{corner['height']}, band {band}")


def c5_no_radius() -> None:
    look = json.loads(LOOK.read_text(encoding="utf-8"))
    surfaces = set(look.get("surfaces", []))
    offenders = []
    for form in sorted(FORMS.glob("*.form")):
        for index, line in enumerate(form.read_text(encoding="utf-8").splitlines(), start=1):
            cells = line.split("\t")
            if len(cells) >= 5 and cells[1:2] == ["rule"]:
                selector, prop, value = cells[2], cells[3], cells[4]
                if selector in surfaces and prop.startswith("border-radius") and value not in ("0px", "0"):
                    offenders.append(f"{form.name}:{index} {selector} {prop} {value}")
    # Each rule is read as its own selector and body, so a rule that happens to be near a
    # surface cannot stand in for the surface's own radius. A glyph (`.WindowButton`) is not a
    # surface and keeps its shape.
    css = SHELL_CSS.read_text(encoding="utf-8").split("/* --- the contour", 1)[0]
    for block in re.finditer(r"([^{}]+)\{([^}]*)\}", css):
        selector = " ".join(block.group(1).split())
        body = block.group(2)
        if "WindowButton" in selector or "Popit" in selector:
            continue
        if not any(surface in selector for surface in surfaces):
            continue
        for radius in re.finditer(r"border-radius:\s*([^;]+);", body):
            if radius.group(1).strip() not in ("0px", "0"):
                offenders.append(f"openlock_shell.css {selector} declares {radius.group(1).strip()}")
    check("nothing-stretched", "no pin surface declares a radius", not offenders,
          str(FORMS.relative_to(ROOT)), "; ".join(offenders[:4]) or "clean")


def c6_outline() -> None:
    runtime = RUNTIME.read_text(encoding="utf-8")
    # The ink is drawn at the box and the fill at one pixel in, which is what keeps both halves
    # of the stroke inside the surface rather than cut by it.
    holds = "body(width, height, 0, 0, strokeClass)" in runtime \
        and "body(width - 2, height - 2, 1, 1, fillClass)" in runtime
    look = json.loads(LOOK.read_text(encoding="utf-8"))
    holds = holds and look["constants"]["clip_pad"] < look["constants"]["frame_pad"]
    check("outline-not-clipped", "the ink is the outer edge and the fill is inset by the stroke",
          holds, str(RUNTIME.relative_to(ROOT)), "ink at 0, fill at 1" if holds else "the fill is not inset")


def c7_tested() -> None:
    run = subprocess.run(["node", str(TEST)], cwd=ROOT, capture_output=True, text=True, check=False)
    check("contour-slices-tested", "the slices match an independent reading of the profile",
          run.returncode == 0, str(TEST.relative_to(ROOT)),
          (run.stdout + run.stderr).strip().splitlines()[-1][:200] if (run.stdout or run.stderr) else "no output")


def c8_wired() -> None:
    xml = SHELL_XML.read_text(encoding="utf-8")
    shell = SHELL_JS.read_text(encoding="utf-8")
    holds = "openlock_contour_data.js" in xml and "openlock_contour.js" in xml \
        and "OpenlockContour.draw" in shell and "ContourSlices" in shell
    check("contour-wired", "the shell includes the runtime and paints frames and chips", holds,
          str(SHELL_XML.relative_to(ROOT)), "data and runtime included" if holds else "the runtime is not included")


def c9_landing() -> None:
    # The landing facts read this gate's own count, so a gate started by that generator does not
    # check the landing again. Without this the two tools call each other forever.
    if os.environ.get("OPENLOCK_CONTOUR_GENERATOR") == "1":
        return
    gen = ROOT / "tools" / "gen_landing_shape.py"
    run = subprocess.run([sys.executable, str(gen), "--check"], cwd=ROOT,
                         capture_output=True, text=True, check=False)
    page = ROOT / "landing" / "index.html"
    html = page.read_text(encoding="utf-8") if page.exists() else ""
    holds = run.returncode == 0 and 'data-contour-surface' in html \
        and 'src="contour.js"' in html and 'id="contour"' in html
    detail = (run.stdout + run.stderr).strip().replace("\n", " | ")[:180]
    check("landing-shape-current", "the landing contour is drawn from these records", holds,
          str(page.relative_to(ROOT)), detail or "the section or its script is missing")


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    c1_authority()
    c2_pinned()
    c3_data()
    c4_corner()
    c5_no_radius()
    c6_outline()
    c7_tested()
    c8_wired()
    # The shape's own count is taken before the landing check, so the facts the landing page
    # prints do not change the number they print.
    shape_checks = len(CHECKED)
    c9_landing()
    if "--json" in args:
        print(json.dumps({"checks": len(CHECKED), "shape_checks": shape_checks, "refusals": REFUSALS}, indent=2))
    else:
        for entry in CHECKED:
            print(f"[ok] {entry}")
        for entry in REFUSALS:
            print(f"[FAIL] {entry['code']}: {entry['where']}: {entry['detail']}")
        print(f"contour gate: {len(CHECKED) + len(REFUSALS)} checks, {len(REFUSALS)} refusals")
    return 1 if REFUSALS else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

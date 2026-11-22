#!/usr/bin/env python3
"""The options gate: Popit is the pinned baseline, every other form and theme is an option on it.

The owner's ruling is not a style preference, it is a structural fact of the shell: the Popit
shell's contour and visual baseline are the shape that ships, and every other form and theme
(brass, family, deadlock, alpha, holo, material, ios, touchwiz) layers on top of it without
replacing, reinterpreting or degrading it. A theme therefore owns colour, and a form owns identity
and colour; neither may declare a contour, a window frame, the resize grips, the taskbar or slot
metrics, or a layout.

This gate reads the hand-editable files, not a generated blob, so the rule is checkable in the same
form the owner edits:

  O1 `popit-default`        themes/default names popit
  O2 `popit-form-default`   forms/default names popit
  O3 `popit-first`          themes/order begins with popit
  O4 `popit-in-data`        the generated data agrees with all three of the above
  O5 `themes-colour-only`   no theme declares a geometry, slot or layout rule
  O6 `forms-colour-only`    no form other than popit declares a geometry, slot or layout rule
  O7 `pinned-source`        the pinned sheet and the family look carry the numbers options inherit
  O8 `popit-form-pinned`    the popit form is the geometry source and declares the contour frame

    python tools/contour_options_gate.py            # every check and one result line
    python tools/contour_options_gate.py --json     # machine-readable
    python tools/contour_options_gate.py --selftest # plant drift and prove the gate refuses it
    python tools/contour_options_gate.py --archive <pak01_dir.vpk>   # read a built archive
"""
from __future__ import annotations

import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
THEMES = ROOT / "shell" / "alpha-shell" / "themes"
FORMS = ROOT / "shell" / "alpha-shell" / "forms"
DATA = ROOT / "clientaddon" / "panorama" / "scripts" / "openlock_shell_data.js"
PINNED = ROOT / "clientaddon" / "panorama" / "styles" / "openlock_pinned.css"
LOOK = ROOT / "docs" / "family-look.json"

PINNED_THEME = "popit"
PINNED_FORM = "popit"

# Properties an option may declare. A colour is the theme and form option surface: it repaints
# without moving a single edge. Everything not listed here is geometry, a slot size or a layout,
# and those belong to the pinned contour alone.
COLOUR_PROPERTIES = {
    "background-color",
    "border-color",
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
    "color",
    "wash-color",
    "box-shadow",
    "text-shadow",
}

# Keys a theme or form file may carry outside its rules. They name the option, they never shape it.
IDENTITY_KEYS = {"theme", "form", "label", "source", "renderer", "extends", "load-order", "option"}
SIGNATURE = re.compile(r"^shploingus\.(theme|form)/[0-9a-f]+$")

CHECKED: list[str] = []
REFUSALS: list[dict] = []


def check(code: str, detail: str, holds: bool, where: str = "", why: str = "") -> None:
    if holds:
        CHECKED.append(f"{code} {detail}")
    else:
        REFUSALS.append({"code": code, "where": where, "detail": why or detail})


# --- the readers -----------------------------------------------------------------------------
#
# A theme file is a signature line, comment lines starting with #, a `theme <id>` line, tab-indented
# key/value lines, and `rule` lines with a selector and a property. Forms are the same shape with
# `form <id>`. Reading them here keeps the gate independent of the generator: if the generator and
# this reader disagree about a file, the file is what the owner edits and the file wins.

def read_file(path: Path) -> dict:
    entry = {
        "path": path,
        "kind": "",
        "id": "",
        "keys": {},          # key -> (value, line)
        "rules": [],         # (selector, property, value, line)
        "roles": {},         # role -> (value, line)
        "errors": [],
        "signature": False,
    }
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError as error:
        entry["errors"].append(f"unreadable: {error}")
        return entry

    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if SIGNATURE.match(line):
            entry["signature"] = True
            continue
        cells = [cell for cell in line.split("\t") if cell != ""]
        if len(cells) == 1:
            if cells[0] in {"theme", "form"}:
                entry["errors"].append(f"{number}: '{cells[0]}' with no id")
            continue
        head = cells[0]
        if head in {"theme", "form"} and not raw[:1].isspace():
            entry["kind"] = head
            entry["id"] = cells[1]
            continue
        if head == "rule":
            if len(cells) >= 4:
                entry["rules"].append((cells[1], cells[2].strip(), cells[3].strip(), number))
            else:
                entry["errors"].append(f"{number}: rule needs selector, property and value")
            continue
        if head in IDENTITY_KEYS:
            entry["keys"][head] = (cells[1] if len(cells) > 1 else "", number)
            continue
        # Anything else in a theme is a colour role slot.
        entry["roles"][head] = (cells[1] if len(cells) > 1 else "", number)
    return entry


def theme_files() -> list[dict]:
    return [read_file(path) for path in sorted(THEMES.glob("*.theme"))]


def form_files() -> list[dict]:
    return [read_file(path) for path in sorted(FORMS.glob("*.form"))]


def read_word(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8-sig").strip().splitlines()[0].strip()
    except (OSError, IndexError):
        return ""


def read_order() -> list[str]:
    try:
        lines = path_lines(FORMS.parent / "themes" / "order")
    except OSError:
        return []
    order = []
    for line in lines:
        line = line.split("#", 1)[0].strip()
        if line:
            order.append(line)
    return order


def path_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8-sig").splitlines()


# --- the checks ------------------------------------------------------------------------------

def o1_default() -> None:
    default = read_word(THEMES / "default")
    check("popit-default", f"themes/default is {default}", default == PINNED_THEME,
          str((THEMES / "default").relative_to(ROOT)),
          f"themes/default is '{default}', not the pinned '{PINNED_THEME}'")


def o2_default_form() -> None:
    default = read_word(FORMS / "default")
    check("popit-form-default", f"forms/default is {default}", default == PINNED_FORM,
          str((FORMS / "default").relative_to(ROOT)),
          f"forms/default is '{default}', not the pinned '{PINNED_FORM}'")


def o3_order() -> None:
    order = read_order()
    first = order[0] if order else ""
    check("popit-first", f"order[0] is {first or '(empty)'}",
          first == PINNED_THEME, "shell/alpha-shell/themes/order",
          f"order begins with '{first}', so an option competes with the pinned baseline")


def o4_data() -> None:
    text = DATA.read_text(encoding="utf-8") if DATA.exists() else ""
    default = re.search(r'"default":\s*"([^"]*)"', text)
    form = re.search(r'"defaultForm":\s*"([^"]*)"', text)
    order_block = re.search(r'"order":\s*\[(.*?)\]', text, re.S)
    order = re.findall(r'"([^"]+)"', order_block.group(1)) if order_block else []
    stale = []
    if not default or default.group(1) != PINNED_THEME:
        stale.append("themes.default")
    if not form or form.group(1) != PINNED_FORM:
        stale.append("themes.defaultForm")
    if not order or order[0] != PINNED_THEME:
        stale.append("themes.order[0]")
    check("popit-in-data", "the generated data carries the pinned default",
          not stale, str(DATA.relative_to(ROOT)) if DATA.exists() else "generated data missing",
          "stale generated data: " + ", ".join(stale) + " — run tools/gen_shell_data.py")


def o5_themes() -> None:
    bad = []
    for entry in theme_files():
        for selector, prop, _value, line in entry["rules"]:
            if prop not in COLOUR_PROPERTIES:
                bad.append(f"{entry['id'] or entry['path'].name}:{line} {selector} {prop}")
        if entry["kind"] != "theme":
            bad.append(f"{entry['path'].name}: no theme id")
        for error in entry["errors"]:
            bad.append(f"{entry['path'].name}:{error}")
    check("themes-colour-only", f"{len(theme_files())} themes declare colour rules only",
          not bad, "shell/alpha-shell/themes",
          "geometry or slot rules found: " + " | ".join(bad[:6]))


def o6_forms() -> None:
    bad = []
    forms = form_files()
    for entry in forms:
        if entry["id"] == PINNED_FORM:
            continue
        for selector, prop, _value, line in entry["rules"]:
            if prop not in COLOUR_PROPERTIES:
                bad.append(f"{entry['id'] or entry['path'].name}:{line} {selector} {prop}")
        for error in entry["errors"]:
            bad.append(f"{entry['path'].name}:{error}")
    options = [entry["id"] for entry in forms if entry["id"] and entry["id"] != PINNED_FORM]
    check("forms-colour-only", f"{len(options)} option forms inherit the contour ({', '.join(options)})",
          not bad, "shell/alpha-shell/forms",
          "a form other than popit declares geometry: " + " | ".join(bad[:6]))


def o7_pinned_source() -> None:
    look = json.loads(LOOK.read_text(encoding="utf-8")) if LOOK.exists() else {}
    constants = look.get("constants", {})
    corner = look.get("corner_px", {})
    css = PINNED.read_text(encoding="utf-8") if PINNED.exists() else ""
    bar = re.search(r"\.Taskbar\s*\{[^}]*height:\s*(\d+)px", css, re.S)
    grips = re.search(r"\.WindowFrame \.ResizeGrip\s*\{[^}]*visibility:\s*visible", css, re.S)
    problems = []
    if constants.get("bar_height") != 48:
        problems.append(f"family-look bar_height is {constants.get('bar_height')!r}, not 48")
    if not bar or bar.group(1) != "48":
        problems.append("openlock_pinned.css does not pin the bar at 48px")
    if corner.get("width") != 7.67 or corner.get("height") != 11.0:
        problems.append(f"family-look corner is {corner!r}, not 7.67x11.00")
    if not grips:
        problems.append("openlock_pinned.css does not keep the window resize grips visible")
    check("pinned-source", "the pinned sheet and the family look carry the inherited numbers",
          not problems, "docs/family-look.json + openlock_pinned.css", " | ".join(problems))


def o8_popit_form() -> None:
    popit = next((entry for entry in form_files() if entry["id"] == PINNED_FORM), None)
    if popit is None:
        check("popit-form-pinned", "the popit form declares the geometry", False,
              "shell/alpha-shell/forms/popit.form", "the popit form is missing")
        return
    frame = [rule for rule in popit["rules"] if rule[0] == ".WindowFrame" and rule[1] == "border-width"]
    renderer = popit["keys"].get("renderer", ("", 0))[0]
    holds = bool(frame) and renderer == "popit" and not popit["errors"]
    check("popit-form-pinned", f"the popit form owns the frame and the {renderer or 'no'} renderer",
          holds, "shell/alpha-shell/forms/popit.form",
          "the popit form lost its frame rule or its rendered form")


# --- the selftest ----------------------------------------------------------------------------

def selftest() -> int:
    """A gate nobody has seen refuse is a gate that may not refuse at all."""
    with tempfile.TemporaryDirectory() as raw:
        sandbox = Path(raw)
        shutil.copytree(THEMES, sandbox / "themes")
        shutil.copytree(FORMS, sandbox / "forms")

        def failures_for(theme_drift: str = "", form_drift: str = "") -> list[str]:
            planted = []
            if theme_drift:
                target = sandbox / "themes" / "holo.theme"
                original = target.read_text(encoding="utf-8")
                planted.append((target, original))
                target.write_text(original + theme_drift, encoding="utf-8")
            if form_drift:
                target = sandbox / "forms" / "ios.form"
                original = target.read_text(encoding="utf-8")
                planted.append((target, original))
                target.write_text(original + form_drift, encoding="utf-8")
            found = []
            for entry in [read_file(path) for path in sorted((sandbox / "themes").glob("*.theme"))]:
                for selector, prop, _value, line in entry["rules"]:
                    if prop not in COLOUR_PROPERTIES:
                        found.append(f"theme {entry['id']} {selector} {prop}")
            for entry in [read_file(path) for path in sorted((sandbox / "forms").glob("*.form"))]:
                if entry["id"] == PINNED_FORM:
                    continue
                for selector, prop, _value, line in entry["rules"]:
                    if prop not in COLOUR_PROPERTIES:
                        found.append(f"form {entry['id']} {selector} {prop}")
            for target, original in planted:
                target.write_text(original, encoding="utf-8")
            return found

        clean = failures_for()
        theme_drift = failures_for(theme_drift="\trule\t.WindowFrame\tborder-radius\t9px\n")
        form_drift = failures_for(form_drift="\trule\t.Taskbar\theight\t30px\n")

        ordered = sandbox / "themes" / "order"
        original = ordered.read_text(encoding="utf-8")
        ordered.write_text("family\n" + original, encoding="utf-8")
        order_first = read_word_from(ordered)

    checks = [
        ("clean-set", clean == [], clean),
        ("theme-geometry-refused", theme_drift == ["theme holo .WindowFrame border-radius"], theme_drift),
        ("form-slot-refused", form_drift == ["form ios .Taskbar height"], form_drift),
        ("order-read", order_first == "family", order_first),
    ]
    bad = [name for name, ok, _ in checks if not ok]
    for name, ok, seen in checks:
        print(f"[{'ok' if ok else 'FAIL'}] selftest {name}" + ("" if ok else f": {seen}"))
    print(f"options gate selftest: {len(checks)} checks, {len(bad)} failures")
    return 1 if bad else 0


def read_word_from(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8-sig").strip().splitlines()[0].strip()
    except (OSError, IndexError):
        return ""


# --- the archive ------------------------------------------------------------------------------
#
# The built archive is the artifact the player installs, so the pinned baseline is proven there and
# not only in the checkout: the generated data the client reads, the pinned sheet, the contour
# runtime, the four grips and the carrier rule all have to be inside it.

def archive_facts(archive: Path) -> list[tuple[str, bool, str]]:
    sys.path.insert(0, str(ROOT / "tools"))
    import vpk_read  # the family's own reader, so the proof uses the same parser the installer does

    with tempfile.TemporaryDirectory() as raw:
        out = Path(raw)
        saved = sys.argv
        sys.argv = ["vpk_read.py", str(archive), str(out)]
        try:
            vpk_read.main()
        finally:
            sys.argv = saved
        files = {path.relative_to(out).as_posix(): path.read_bytes() for path in out.rglob("*") if path.is_file()}

        def text(name: str) -> str:
            return files.get(name, b"").decode("utf-8", "replace")

        data = text("panorama/scripts/openlock_shell_data.js")
        pinned = text("panorama/styles/openlock_pinned.css")
        schemes = text("panorama/styles/openlock_schemes.css")
        boot = text("panorama/scripts/openlock_boot.js")
        shell = text("panorama/scripts/openlock_shell.js")
        runtime = text("panorama/scripts/openlock_contour.js")

        default = re.search(r'"themes":\s*\{\s*"default":\s*"([^"]*)"', data)
        form = re.search(r'"defaultForm":\s*"([^"]*)"', data)
        order = re.search(r'"order":\s*\[\s*"([^"]*)"', data)
        brass = '"id": "brass"' in data

        facts = [
            ("archive-popit-default", bool(default) and default.group(1) == PINNED_THEME,
             f"themes.default is {default.group(1) if default else 'missing'}"),
            ("archive-popit-form", bool(form) and (form.group(1) or "") == PINNED_FORM,
             f"themes.defaultForm is {form.group(1) if form else 'missing'}"),
            ("archive-popit-first", bool(order) and (order.group(1) or "") == PINNED_THEME,
             f"themes.order[0] is {order.group(1) if order else 'missing'}"),
            ("archive-brass-option", brass, "the brass meridian scheme is in the generated data"),
            ("archive-pinned-bar", bool(re.search(r"\.Taskbar\s*\{[^}]*height:\s*48px", pinned, re.S)),
             "openlock_pinned.css pins the 48px bar inside the archive"),
            ("archive-four-grips", bool(re.search(r"\.WindowFrame \.ResizeGrip\s*\{[^}]*visibility:\s*visible", pinned, re.S))
             and "GripNW" in pinned and "GripSE" in pinned,
             "the window resize grips are visible in the pinned sheet inside the archive"),
            ("archive-contour-runtime", "OpenlockContour" in runtime and "OpenlockContour" in shell,
             "the contour runtime is archived and the shell calls it"),
            ("archive-carrier-rule", "OpenlockStandaloneHost" in boot and "carrier" in boot,
             "openlock_boot.js carries the host-carrier rule"),
            ("archive-forms-folded", not re.search(r"\.Taskbar\s*\{[^}]*height:\s*(30px|28px)", schemes, re.S),
             "no option form sets the taskbar height in the generated schemes sheet"),
        ]
    return facts


def archive_mode(archive: Path) -> int:
    if not archive.exists():
        print(f"[FAIL] archive-missing: {archive} does not exist")
        return 1
    facts = archive_facts(archive)
    bad = [name for name, ok, _ in facts if not ok]
    for name, ok, detail in facts:
        print(f"[{'ok' if ok else 'FAIL'}] {name}: {detail}")
    print(f"archive {archive.name}: {len(facts)} checks, {len(bad)} failures")
    return 1 if bad else 0


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if "--selftest" in args:
        return selftest()
    if "--archive" in args:
        return archive_mode(Path(args[args.index("--archive") + 1]))

    o1_default()
    o2_default_form()
    o3_order()
    o4_data()
    o5_themes()
    o6_forms()
    o7_pinned_source()
    o8_popit_form()

    if "--json" in args:
        print(json.dumps({"checks": len(CHECKED), "refusals": REFUSALS}, indent=2))
    else:
        for entry in CHECKED:
            print(f"[ok] {entry}")
        for entry in REFUSALS:
            print(f"[FAIL] {entry['code']}: {entry['where']}: {entry['detail']}")
        print(f"contour options gate: {len(CHECKED) + len(REFUSALS)} checks, {len(REFUSALS)} refusals")
    return 1 if REFUSALS else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

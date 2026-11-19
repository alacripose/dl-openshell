"""The Popit convention gate: declared elements, pair roles and persistence against the code.

The design bible is a specification, so this gate treats `docs/popit-elements.json` as the
declaration and the source as the implementation. It refuses when:

  E1  a declared file is missing;
  E2  a declared symbol is not in its file;
  E3  a declared selector is not in the Popit or pair stylesheet;
  E4  the pair table is not the 37-pair `openlock.popit-pairs` table, or a pair class is missing;
  E5  a pair paints its slab from `primary` instead of the LBP3 background role `secondary`;
  E6  the form still carries the retired spine/tray geometry, or the root/child contour is absent;
  E7  the pair is not persisted: `pair:<slug>` in the snapshot, `popitLayout.pair` on load, and a
      validated `case "pair"` in the host parser;
  E8  reduced motion is decorative: no `.ReducedMotion` rule or no `setReducedMotion` path;
  E9  the root/child model is gone: no `.PopitRoot`, `.PopitChild` or `.PopitBack` in the stylesheet.

    python tools/popit_parity.py             # print the table and one RESULT line
    python tools/popit_parity.py --receipt   # also write artifacts/receipts/popit-parity.json
    python tools/popit_parity.py --json      # machine-readable result

No claim is made about how the surface renders in game; the Node suite proves behaviour and this
gate proves the declaration and the generated data agree with the source.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ELEMENTS = ROOT / "docs" / "popit-elements.json"
POPIT_JS = ROOT / "clientaddon" / "panorama" / "scripts" / "openlock_popit.js"
SHELL_JS = ROOT / "clientaddon" / "panorama" / "scripts" / "openlock_shell.js"
PAIR_JS = ROOT / "clientaddon" / "panorama" / "scripts" / "openlock_pairs.js"
CSS = ROOT / "clientaddon" / "panorama" / "styles" / "openlock_popit.css"
PAIR_CSS = ROOT / "clientaddon" / "panorama" / "styles" / "openlock_pairs.css"
FORM = ROOT / "shell" / "alpha-shell" / "forms" / "popit.form"
DATA = ROOT / "shell" / "alpha-shell" / "popit-pairs.json"
PROFILE = ROOT / "src" / "Openlock" / "Shell" / "LayoutProfiles.cs"
RECEIPT = ROOT / "artifacts" / "receipts" / "popit-parity.json"

PREFIX = "openlock.popit-pairs/"
ROLES = ("primary", "secondary", "tertiary", "emphasis")
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def pair_class(pair_id: str) -> str:
    """Keep identical to pairClass() in openlock_popit.js and pair_class() in the generator."""
    return "Pair" + "".join(word[:1].upper() + word[1:] for word in re.split(r"[-_]", pair_id) if word)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else ""


def check() -> dict:
    refusals: list[str] = []
    rows: list[dict] = []

    def row(criterion: str, subject: str, ok: bool, detail: str) -> None:
        rows.append({"criterion": criterion, "subject": subject, "ok": ok, "detail": detail})
        if not ok:
            refusals.append(f"{criterion} {subject}: {detail}")

    for path in (ELEMENTS, POPIT_JS, SHELL_JS, PAIR_JS, CSS, PAIR_CSS, FORM, DATA, PROFILE):
        row("E1", str(path.relative_to(ROOT)), path.is_file(), "declared source is missing" if not path.is_file() else "present")

    try:
        elements = json.loads(ELEMENTS.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return {"ok": False, "rows": rows, "refusals": refusals + [f"E1 docs/popit-elements.json: {error}"]}

    css_text = CSS.read_text(encoding="utf-8", errors="replace") if CSS.is_file() else ""
    for element in elements.get("elements", []):
        element_id = str(element.get("id") or "?")
        path = ROOT / str(element.get("file") or "")
        text = path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""
        symbol = str(element.get("symbol") or "")
        if symbol:
            row("E2", element_id, symbol in text, f"symbol '{symbol}' is not in {element.get('file')}")
        selector = str(element.get("selector") or "")
        # A selector is a stylesheet fact only when it names a Popit class. `.PopitCell` is the
        # hover target the shell paints on a live panel, not a surface rule, and the fixed
        # alphabet is a behaviour, not a selector.
        if selector.startswith(".") and not selector.startswith(".PopitCell"):
            row("E3", element_id, selector in css_text, f"selector '{selector}' is not in openlock_popit.css")

    data = json.loads(DATA.read_text(encoding="utf-8")) if DATA.is_file() else {}
    pairs = data.get("pairs") or []
    row("E4", "format", str(data.get("format", "")).startswith(PREFIX), f"format is {data.get('format')!r}")
    row("E4", "count", len(pairs) == 37, f"{len(pairs)} pairs; the forge table carries 37")
    ids = [str(pair.get("id") or "") for pair in pairs]
    row("E4", "unique", len(set(ids)) == len(ids), "a pair id appears twice")
    row("E4", "default", str(data.get("default") or "") in ids, f"default {data.get('default')!r} is not a pair")
    row("E4", "slugs", all(SLUG.match(pair_id) for pair_id in ids), "a pair id is not a lowercase slug")

    pair_css = PAIR_CSS.read_text(encoding="utf-8", errors="replace") if PAIR_CSS.is_file() else ""
    pair_js = PAIR_JS.read_text(encoding="utf-8", errors="replace") if PAIR_JS.is_file() else ""
    for pair in pairs:
        pair_id = str(pair.get("id") or "")
        klass = pair_class(pair_id)
        row("E4", f"class:{pair_id}", f".{klass} .PopitRoot" in pair_css, f"no .{klass} block")
        row("E4", f"table:{pair_id}", json.dumps(pair_id) in pair_js, "pair is not in the generated JS table")
        for role in ROLES:
            value = str(pair.get(role) or "")
            row("E4", f"colour:{pair_id}.{role}", re.match(r"^#[0-9a-fA-F]{6}$", value) is not None, f"{role} {value!r} is not #RRGGBB")
        slab = next((line for line in pair_css.splitlines() if line.startswith(f".{klass} .PopitRoot {{")), "")
        row("E5", pair_id, f"background-color: {pair.get('secondary')}E6" in slab,
            "the slab is not painted from the secondary/background role")
        row("E5", pair_id, f"border-color: {pair.get('primary')}" in slab,
            "the slab border is not painted from the primary/highlight role")

    form = FORM.read_text(encoding="utf-8", errors="replace") if FORM.is_file() else ""
    row("E6", "spine", ".PopitSpine" not in form, "retired spine geometry is still in the form")
    row("E6", "tray", ".PopitTray" not in form, "retired tray geometry is still in the form")
    row("E6", "root", ".PopitRoot" in form and ".PopitChild" in form, "the root/child contour is not declared")
    row("E6", "contour", "border-radius\t26px 22px 26px 22px" in form, "the crowned per-corner approximation is missing")

    shell = SHELL_JS.read_text(encoding="utf-8", errors="replace") if SHELL_JS.is_file() else ""
    profile = PROFILE.read_text(encoding="utf-8", errors="replace") if PROFILE.is_file() else ""
    row("E7", "snapshot", '";pair:"' in shell or ';pair:' in shell, "the snapshot does not emit a pair field")
    row("E7", "load", "popitLayout.pair" in shell and "popitPair = popitLayout.pair" in shell, "a saved pair is not applied on load")
    row("E7", "host", 'case "pair"' in profile and "PopitPairPattern" in profile, "the host does not parse and validate pair:<slug>")
    row("E7", "save", "popitLayout.pair = pair.id" in shell, "choosing a pair does not update the saved layout")

    row("E8", "css", ".ReducedMotion" in css_text, "no reduced-motion rule")
    row("E8", "path", "function setReducedMotion" in POPIT_JS.read_text(encoding="utf-8", errors="replace"), "no setReducedMotion path")

    row("E9", "root", ".PopitRoot" in css_text, "the stylesheet has no root")
    row("E9", "child", ".PopitChild" in css_text and ".ChildOpen" in css_text, "the stylesheet has no child reveal state")
    row("E9", "back", ".PopitBack" in css_text, "the stylesheet has no Back control")

    receipt = {
        "format": "openlock.popit-parity/1",
        "subject": {
            "docs/popit-elements.json": digest(ELEMENTS),
            "clientaddon/panorama/scripts/openlock_popit.js": digest(POPIT_JS),
            "clientaddon/panorama/scripts/openlock_shell.js": digest(SHELL_JS),
            "clientaddon/panorama/scripts/openlock_pairs.js": digest(PAIR_JS),
            "clientaddon/panorama/styles/openlock_popit.css": digest(CSS),
            "clientaddon/panorama/styles/openlock_pairs.css": digest(PAIR_CSS),
            "shell/alpha-shell/forms/popit.form": digest(FORM),
            "shell/alpha-shell/popit-pairs.json": digest(DATA),
            "src/Openlock/Shell/LayoutProfiles.cs": digest(PROFILE),
        },
        "rows": rows,
        "refusals": refusals,
        "ok": not refusals,
    }
    return receipt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", action="store_true", help="write artifacts/receipts/popit-parity.json")
    parser.add_argument("--json", action="store_true", help="print the result as JSON")
    args = parser.parse_args(argv)

    result = check()
    if args.receipt:
        RECEIPT.parent.mkdir(parents=True, exist_ok=True)
        RECEIPT.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8", newline="\n")
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        for entry in result["rows"]:
            if not entry["ok"]:
                print(f"REFUSED {entry['criterion']} {entry['subject']}: {entry['detail']}")
        failed = len(result["refusals"])
        total = len(result["rows"])
        print(f"RESULT: popit-parity {'refused' if failed else 'held'} "
              f"({total - failed}/{total} checks, {len(result['rows'])} declared facts)")
        if failed:
            print("named, not implemented: the in-game render of the crowned contour; "
                  "Panorama approximates it with per-corner radii")
    return 1 if result["refusals"] else 0


if __name__ == "__main__":
    sys.exit(main())

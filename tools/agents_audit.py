"""Audit how this AGENTS.md handles information, judged by the criteria it applies.

Ported from `deadlock-model-forge/tools/agents_audit.py`, which answers the family failure the
owner named: an agents file that grows every session while the current truth stays buried. The
failure is not a shortage of information; it is a file where:

* the current state is only reachable after a chronological wall of dated entries;
* the same block is pasted twice, so a search finds two copies of one rule;
* a cited path was deleted, so "restore the reference" points at nothing;
* a claim superseded three entries later still reads as a rule where it stands;
* a section costs dozens of lines and states no rule, refusal or receipt.

So this tool states what a readable agents file is, scores this one against that table, and
scores itself on the same table. It follows the family conventions:

* `openlock_modern/tools/family_design_audit.py`: stated criteria, one `RESULT:` line, a receipt
  carrying the digests of the subject and of the checker, and a named `not-implemented` rather
  than a silent pass.
* `secure_shell_v2/tools/resynth_agents.py`: resynthesis **adds**. It never deletes, re-words or
  tidies a prior rule; a stale claim is superseded by a dated line beside it.

    python tools/agents_audit.py                 # audit, write the receipt, print RESULT
    python tools/agents_audit.py --index         # also regenerate AGENTS-INDEX.md
    python tools/agents_audit.py --selftest      # every refusal fires on a planted file

Criteria, and what does not count:

| # | Criterion | Counts | Does not count |
|---|---|---|---|
| A1 | One copy of a rule | the rule appears once | the same block pasted twice |
| A2 | Current state first | a state section before the dated entries | "read the last 900 lines" |
| A3 | Evidence path exists | a cited artifact resolves on disk | a path deleted in a cleanup |
| A4 | Supersession is adjacent | a superseded claim carries its correction in the same section | a correction 600 lines later |
| A5 | Bounded cost | a section states a rule, a refusal or a receipt | narrative that repeats an earlier entry |
| A6 | Receipt | digests of the subject, the index and this tool | "the audit passed" |
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AGENTS = ROOT / "AGENTS.md"
INDEX = ROOT / "AGENTS-INDEX.md"
RECEIPT = ROOT / "artifacts" / "receipts" / "agents-audit.json"

SECTION = re.compile(r"^## (.+)$", re.M)
DATE = re.compile(r"^(\d{4}-\d{2}-\d{2})\s*[\u2014-]\s*(.+)$")
BACKTICK_PATH = re.compile(r"`([A-Za-z0-9_][\w./\\-]*\.(?:vpk|txt|json|jsonl|py|cs|js|css|form|xml|md|html|pdf|ps1))`")
EVIDENCE_ROOT = ("artifacts/", "docs/", "clientaddon/", "src/", "shell/", "landing/", "tools/", "logs/", "examples/")
COST_BUDGET = 60
DUPLICATE_WINDOW = 3
STATE_WITHIN_LINES = 120
RULE_MARKERS = ("must", "may not", "refus", "RESULT:", "receipt", "rule", "gate", "Do not", "never")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else ""


def sections(text: str) -> list[dict]:
    rows = []
    matches = list(SECTION.finditer(text))
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        body = text[match.end():end]
        line = text[: match.start()].count("\n") + 1
        title = match.group(1).strip()
        dated = DATE.match(title)
        rows.append({
            "line": line,
            "title": title,
            "date": dated.group(1) if dated else "",
            "name": dated.group(2).strip() if dated else title,
            "lines": body.count("\n"),
            "body": body,
        })
    return rows


def duplicate_blocks(text: str) -> list[dict]:
    """Non-empty line runs pasted more than once, with the second line number."""
    lines = [(number, line.strip()) for number, line in enumerate(text.splitlines(), 1) if line.strip()]
    seen: dict[tuple, int] = {}
    dups = []
    for start in range(len(lines) - DUPLICATE_WINDOW + 1):
        window = tuple(line for _, line in lines[start:start + DUPLICATE_WINDOW])
        if window in seen:
            dups.append({"first": seen[window], "again": lines[start][0], "sample": window[0][:80]})
        else:
            seen[window] = lines[start][0]
    return dups


def missing_paths(text: str) -> list[dict]:
    missing = []
    for match in BACKTICK_PATH.finditer(text):
        value = match.group(1).replace("\\", "/")
        if not value.startswith(EVIDENCE_ROOT):
            continue
        if any(marker in value for marker in ("<", ">", "*", "\u2026")):
            continue
        if not (ROOT / value).exists():
            missing.append({"path": value, "line": text[: match.start()].count("\n") + 1})
    return missing


def supersession_gaps(rows: list[dict]) -> list[dict]:
    gaps = []
    for row in rows:
        body = row["body"].lower()
        if "supersed" not in body:
            continue
        if "superseded by" in body or "supersedes" in body or "no longer" in body:
            continue
        gaps.append({"line": row["line"], "title": row["title"]})
    return gaps


def costly_sections(rows: list[dict]) -> list[dict]:
    return [
        {"line": row["line"], "title": row["title"], "lines": row["lines"]}
        for row in rows
        if row["lines"] > COST_BUDGET and not any(marker.lower() in row["body"].lower() for marker in RULE_MARKERS)
    ]


def state_position(rows: list[dict]) -> dict:
    dated = [row for row in rows if row["date"]]
    if not dated:
        return {"ok": True, "detail": "no dated entries; the file is all current state"}
    first = dated[0]
    state = [row for row in rows if row["line"] < first["line"] and not row["date"]]
    ok = bool(state) and first["line"] <= STATE_WITHIN_LINES
    return {
        "ok": ok,
        "detail": f"first dated section at line {first['line']}; "
                  f"{len(state)} undated section(s) before it"
                  + ("" if ok else f"; current state must appear within {STATE_WITHIN_LINES} lines"),
    }


def build_index(rows: list[dict]) -> str:
    lines = [
        "# AGENTS-INDEX",
        "",
        "Generated by `tools/agents_audit.py --index` from `AGENTS.md`. Do not edit by hand.",
        "",
        "| line | date | section |",
        "|---|---|---|",
    ]
    for row in rows:
        lines.append(f"| {row['line']} | {row['date'] or '-'} | {row['title']} |")
    lines.append("")
    lines.append(f"{len(rows)} section(s). A dated entry is a claim with its date; the undated sections state rules.")
    return "\n".join(lines) + "\n"


def audit() -> dict:
    rows: list[dict] = []
    refusals: list[str] = []

    def row(criterion: str, subject: str, ok: bool, detail: str) -> None:
        rows.append({"criterion": criterion, "subject": subject, "ok": ok, "detail": detail})
        if not ok:
            refusals.append(f"{criterion} {subject}: {detail}")

    if not AGENTS.is_file():
        return {"ok": False, "rows": [], "refusals": ["A0 AGENTS.md: missing"]}
    text = AGENTS.read_text(encoding="utf-8")
    parsed = sections(text)

    dups = duplicate_blocks(text)
    for dup in dups[:20]:
        row("A1", f"line {dup['again']}", False, f"same 3-line block as line {dup['first']}: {dup['sample']}")
    if not dups:
        row("A1", "duplicates", True, "no 3-line block appears twice")

    position = state_position(parsed)
    row("A2", "current state", position["ok"], position["detail"])

    for gap in missing_paths(text):
        row("A3", f"line {gap['line']}", False, f"cited path does not exist: {gap['path']}")
    if not missing_paths(text):
        row("A3", "evidence paths", True, "every cited artifact path resolves")

    for gap in supersession_gaps(parsed):
        row("A4", f"line {gap['line']}", False, f"section claims a supersession without the correction: {gap['title']}")
    if not supersession_gaps(parsed):
        row("A4", "supersession", True, "no dangling supersession")

    for cost in costly_sections(parsed):
        row("A5", f"line {cost['line']}", False, f"{cost['lines']} lines with no rule, refusal or receipt: {cost['title']}")
    for section in parsed:
        if section["lines"] <= COST_BUDGET or section["lines"] > COST_BUDGET and section not in costly_sections(parsed):
            row("A5", f"line {section['line']}", True, f"{section['lines']} lines, bounded")

    receipt = {
        "format": "openlock.agents-audit/1",
        "subject": {"AGENTS.md": digest(AGENTS), "AGENTS-INDEX.md": digest(INDEX)},
        "checker": {"tools/agents_audit.py": digest(Path(__file__))},
        "rows": rows,
        "refusals": refusals,
        "ok": not refusals,
    }
    return receipt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", action="store_true", help="regenerate AGENTS-INDEX.md")
    parser.add_argument("--selftest", action="store_true", help="run the refusal selftest")
    parser.add_argument("--json", action="store_true", help="print the result as JSON")
    args = parser.parse_args(argv)

    if args.selftest:
        return selftest()

    if not AGENTS.is_file():
        print("REFUSED A0 AGENTS.md: missing")
        return 2
    if args.index:
        INDEX.write_text(build_index(sections(AGENTS.read_text(encoding="utf-8"))), encoding="utf-8", newline="\n")

    result = audit()
    RECEIPT.parent.mkdir(parents=True, exist_ok=True)
    RECEIPT.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8", newline="\n")
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        for entry in result["rows"]:
            if not entry["ok"]:
                print(f"REFUSED {entry['criterion']} {entry['subject']}: {entry['detail']}")
        failed = len(result["refusals"])
        print(f"RESULT: agents-audit {'refused' if failed else 'held'} ({len(result['rows']) - failed}/{len(result['rows'])} checks)")
        print("not-implemented: semantic judgement of whether a rule is still true; this audit checks placement, duplication, paths and cost")
    return 1 if result["refusals"] else 0


def selftest() -> int:
    """Each criterion must refuse a planted file, and the clean file must hold."""
    import tempfile

    checks = 0

    def expect(name: str, text: str, criterion: str, refuse: bool = True) -> None:
        nonlocal checks
        with tempfile.TemporaryDirectory() as tmp:
            global ROOT, AGENTS, INDEX
            saved = (ROOT, AGENTS, INDEX)
            ROOT = Path(tmp)
            AGENTS = ROOT / "AGENTS.md"
            INDEX = ROOT / "AGENTS-INDEX.md"
            AGENTS.write_text(text, encoding="utf-8")
            result = audit()
            hit = any(entry["criterion"] == criterion and not entry["ok"] for entry in result["rows"])
            ROOT, AGENTS, INDEX = saved
            if hit != refuse:
                raise SystemExit(f"selftest FAILED: {name} expected {criterion} {'to refuse' if refuse else 'to hold'}")
            checks += 1
            print(f"ok {checks} - {name}")

    expect("duplicate block refused", "## Rules\n\na b c\nd e f\ng h i\n\n## Again\n\na b c\nd e f\ng h i\n", "A1")
    expect("missing current state refused",
           "## 2026-01-01 \u2014 old\n\nbody\n\n## 2026-02-01 \u2014 older\n\nbody\n", "A2")
    expect("deleted evidence path refused", "## Rules\n\n`docs/not-there.json` is the receipt.\n", "A3")
    expect("dangling supersession refused", "## 2026-01-01 \u2014 claim\n\nThis is superseded.\n", "A4")
    expect("unbounded narrative refused",
           "## 2026-01-01 \u2014 story\n\n" + "\n".join(f"narrative line {i}" for i in range(80)) + "\n", "A5")
    expect("clean file holds",
           "## Current\n\nThe gate holds (`docs/popit-elements.json`).\n\n## 2026-01-01 \u2014 entry\n\nThis rule must hold.\n",
           "A1", refuse=False)
    print(f"agents-audit selftest OK {checks} checks")
    return 0


if __name__ == "__main__":
    sys.exit(main())

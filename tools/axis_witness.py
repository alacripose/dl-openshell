#!/usr/bin/env python3
"""Axis civilian code witnesses: every worktree result names the file that is its site.

The vocabulary is the axis layer's, not a second one. A **cell** is a ladder reading over a
witness file: a readable witness whose predicates pass is ``held``; a readable witness whose
predicate fails is ``absent``, a state and not a refusal; a witness that cannot be named or
opened is a **refusal**, because the record could not say anything. Grades are the axis evidence
grades A-D (A external oracle, B read back from the tree's bytes, C self-report, D declared) and
a grade is never rendered as a number or a percentage.

The store is MongoDB and the read-back is the point. ``record`` writes the run's cells, then
reads them back and compares them with what it wrote. ``verify`` re-derives every cell from the
bytes on disk and compares that reading with the stored run. A run that only wrote is not
verified.

Usage::

    python tools/axis_witness.py record [--json] [--mongo-uri URI] [--root PATH]
    python tools/axis_witness.py verify [--json] [--run ID] [--mongo-uri URI]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PORTS = ("mongodb://127.0.0.1:27017", "mongodb://127.0.0.1:27018")
DATABASE = "openlock_axis"

# The worktree's declared segments. Each names one file that is the segment, the same rule the
# axis subject table keeps: a witness is the site, never a sibling's file.
SUBJECTS = (
    ("boot-shell", "launch.ps1", "the boot entry: refusals, the witness gate and the shell handoff"),
    ("installer", "install.ps1", "the installer engine and its standalone WinForms path"),
    ("install-discovery", "tools/list_installs.py", "install and tools-host discovery"),
    ("shell-script", "clientaddon/panorama/scripts/openlock_shell.js", "the in-game window manager"),
    ("shell-data", "clientaddon/panorama/scripts/openlock_shell_data.js", "the generated package data"),
    ("shell-data-source", "tools/gen_shell_data.py", "the generator that writes the package data"),
    ("shell-clicks", "tools/check_shell_clicks.py", "the pointer-surface check"),
    ("axis-witness", "tools/axis_witness.py", "this gate"),
    ("parity-gate", "tools/parity_check.py", "the install/repo/GitHub/live-client parity gate"),
)

LANGUAGE_BY_SUFFIX = {
    ".ps1": "powershell",
    ".psm1": "powershell",
    ".py": "python",
    ".js": "node",
    ".json": "json",
    ".xml": "read",
    ".css": "read",
    ".shspec": "read",
    ".theme": "read",
    ".cells": "read",
    ".md": "read",
    ".txt": "read",
}

PS_PARSE = r"""
$ErrorActionPreference = 'Stop'
$paths = Get-Content -LiteralPath $args[0] -Raw | ConvertFrom-Json
$out = @()
foreach ($path in $paths) {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile([string]$path, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) {
        $first = $errors[0]
        $out += [pscustomobject]@{ path = [string]$path; ok = $false; line = [int]$first.Extent.StartLineNumber; message = [string]$first.Message }
    } else {
        $out += [pscustomobject]@{ path = [string]$path; ok = $true; line = 0; message = '' }
    }
}
$out | ConvertTo-Json -Compress -Depth 4
"""

PY_PARSE = r"""
import json, sys
paths = json.load(open(sys.argv[1], encoding='utf-8'))
out = []
for path in paths:
    try:
        source = open(path, 'rb').read()
        compile(source, path, 'exec')
        out.append({'path': path, 'ok': True, 'line': 0, 'message': ''})
    except SyntaxError as error:
        out.append({'path': path, 'ok': False, 'line': int(error.lineno or 0), 'message': error.msg})
    except Exception as error:
        out.append({'path': path, 'ok': False, 'line': 0, 'message': str(error)})
json.dump(out, sys.stdout)
"""

JSON_PARSE = r"""
import json, sys
paths = json.load(open(sys.argv[1], encoding='utf-8'))
out = []
for path in paths:
    try:
        json.load(open(path, encoding='utf-8'))
        out.append({'path': path, 'ok': True, 'line': 0, 'message': ''})
    except json.JSONDecodeError as error:
        out.append({'path': path, 'ok': False, 'line': int(error.lineno or 0), 'message': error.msg})
    except Exception as error:
        out.append({'path': path, 'ok': False, 'line': 0, 'message': str(error)})
json.dump(out, sys.stdout)
"""


@dataclass(frozen=True)
class Subject:
    area: str
    witness: str
    why: str


@dataclass
class Predicate:
    name: str
    status: str
    detail: str = ""
    line: int = 0

    def doc(self) -> dict:
        return {"name": self.name, "status": self.status, "detail": self.detail, "line": self.line}


@dataclass
class Cell:
    subject: str
    area: str
    witness: str
    why: str
    digest: str
    size: int
    site: str
    state: str
    grade: str
    grade_basis: str
    predicates: list[Predicate] = field(default_factory=list)
    refusal: dict | None = None

    def doc(self, run: str, build: dict) -> dict:
        return {
            "run": run,
            "recordedAt": build["at"],
            "branch": build["branch"],
            "commit": build["commit"],
            "dirty": build["dirty"],
            "subject": self.subject,
            "area": self.area,
            "witness": self.witness,
            "why": self.why,
            "sha256": self.digest,
            "bytes": self.size,
            "site": self.site,
            "state": self.state,
            "grade": self.grade,
            "gradeBasis": self.grade_basis,
            "predicates": [predicate.doc() for predicate in self.predicates],
        }


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def git(root: Path, *args: str) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), *args], capture_output=True, text=True, timeout=20
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def build_label(root: Path) -> dict:
    head = git(root, "rev-parse", "--short", "HEAD") or "uncommitted"
    status = git(root, "status", "--porcelain")
    return {
        "commit": head,
        "branch": git(root, "rev-parse", "--abbrev-ref", "HEAD") or "unknown",
        "dirty": bool(status),
    }


def changed_paths(root: Path) -> list[tuple[str, str]]:
    """(path, status) for every tracked or untracked change, deletions included."""
    result = subprocess.run(
        ["git", "-C", str(root), "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        capture_output=True,
        timeout=30,
    )
    if result.returncode != 0:
        return []
    tokens = [token.decode("utf-8", "replace") for token in result.stdout.split(b"\x00") if token]
    rows: list[tuple[str, str]] = []
    index = 0
    while index < len(tokens):
        entry = tokens[index]
        index += 1
        if len(entry) < 4:
            continue
        status = entry[:2]
        rows.append((entry[3:], status))
        if "R" in status or "C" in status:
            index += 1  # the rename/copy source follows in -z form and is not a second subject
    return rows


def read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def run_checked(command: list[str], timeout: int = 300) -> subprocess.CompletedProcess:
    return subprocess.run(command, capture_output=True, text=True, timeout=timeout)


def temp_json(directory: Path, name: str, data) -> Path:
    path = directory / name
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def check_powershell(paths: list[str], scratch: Path) -> dict[str, tuple[str, str, int]]:
    script = scratch / "parse.ps1"
    script.write_text(PS_PARSE, encoding="utf-8")
    listing = temp_json(scratch, "ps-paths.json", paths)
    try:
        result = run_checked(
            [
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(script),
                str(listing),
            ]
        )
    except (OSError, subprocess.SubprocessError) as error:
        return {path: ("BLOCKED", f"the PowerShell parser did not run: {error}", 0) for path in paths}
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "no parser output").strip().splitlines()[-1]
        return {path: ("BLOCKED", f"the PowerShell parser refused to run: {detail}", 0) for path in paths}
    try:
        rows = json.loads(result.stdout or "[]")
    except json.JSONDecodeError:
        return {path: ("BLOCKED", "the PowerShell parser returned unreadable JSON", 0) for path in paths}
    if isinstance(rows, dict):
        rows = [rows]
    return {
        str(row["path"]): (
            "PASS" if row.get("ok") else "FAIL",
            str(row.get("message", "")),
            int(row.get("line") or 0),
        )
        for row in rows
    }


def check_python(paths: list[str], scratch: Path) -> dict[str, tuple[str, str, int]]:
    script = scratch / "parse.py"
    script.write_text(PY_PARSE, encoding="utf-8")
    listing = temp_json(scratch, "py-paths.json", paths)
    try:
        result = run_checked([sys.executable, str(script), str(listing)])
    except (OSError, subprocess.SubprocessError) as error:
        return {path: ("BLOCKED", f"the Python parser did not run: {error}", 0) for path in paths}
    try:
        rows = json.loads(result.stdout or "[]")
    except json.JSONDecodeError:
        return {path: ("BLOCKED", "the Python parser returned unreadable JSON", 0) for path in paths}
    return {
        str(row["path"]): (
            "PASS" if row.get("ok") else "FAIL",
            str(row.get("message", "")),
            int(row.get("line") or 0),
        )
        for row in rows
    }


def check_json(paths: list[str], scratch: Path) -> dict[str, tuple[str, str, int]]:
    script = scratch / "parse_json.py"
    script.write_text(JSON_PARSE, encoding="utf-8")
    listing = temp_json(scratch, "json-paths.json", paths)
    try:
        result = run_checked([sys.executable, str(script), str(listing)])
        rows = json.loads(result.stdout or "[]")
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return {path: ("BLOCKED", "the JSON reader did not run", 0) for path in paths}
    return {
        str(row["path"]): (
            "PASS" if row.get("ok") else "FAIL",
            str(row.get("message", "")),
            int(row.get("line") or 0),
        )
        for row in rows
    }


def check_node(paths: list[str]) -> dict[str, tuple[str, str, int]]:
    results: dict[str, tuple[str, str, int]] = {}
    for path in paths:
        try:
            result = run_checked(["node", "--check", path], timeout=60)
        except (OSError, subprocess.SubprocessError) as error:
            results[path] = ("BLOCKED", f"node --check did not run: {error}", 0)
            continue
        if result.returncode == 0:
            results[path] = ("PASS", "", 0)
        else:
            message = (result.stderr or result.stdout or "syntax error").strip().splitlines()
            line = 0
            if message:
                tail = message[-3:] if len(message) >= 3 else message
                for piece in tail:
                    marker = piece.find(":")
                    if marker > 0 and piece[:marker].endswith((".js", ".mjs", ".cjs")):
                        try:
                            line = int(piece[marker + 1 :].split(":")[1])
                        except (ValueError, IndexError):
                            line = 0
            results[path] = ("FAIL", message[-1] if message else "syntax error", line)
    return results


def syntax_results(root: Path, witnesses: list[str]) -> tuple[dict[str, tuple[str, str, int]], str]:
    """One reading per witness: (status, detail, line) and the grade the reading earns."""
    by_language: dict[str, list[str]] = {}
    for witness in witnesses:
        language = LANGUAGE_BY_SUFFIX.get(Path(witness).suffix.lower(), "read")
        by_language.setdefault(language, []).append(str(root / witness))

    results: dict[str, tuple[str, str, int]] = {}
    grades: dict[str, str] = {}
    with tempfile.TemporaryDirectory(prefix="openlock-axis-") as scratch_name:
        scratch = Path(scratch_name)
        for language, absolute in by_language.items():
            if language == "powershell":
                batch = check_powershell(absolute, scratch)
                grades.update({path: "A" for path in batch})
            elif language == "python":
                batch = check_python(absolute, scratch)
                grades.update({path: "A" for path in batch})
            elif language == "json":
                batch = check_json(absolute, scratch)
                grades.update({path: "A" for path in batch})
            elif language == "node":
                batch = check_node(absolute)
                grades.update({path: "A" for path in batch})
            else:
                batch = {path: ("NOT_APPLICABLE", "no independent parser applies to this file", 0) for path in absolute}
                grades.update({path: "B" for path in absolute})
            for path, reading in batch.items():
                results[path] = reading

    relative = {str(root / witness): witness for witness in witnesses}
    readings = {relative[path]: reading for path, reading in results.items()}
    readings_by_grade = {relative[path]: grades.get(path, "B") for path in results}
    return readings, readings_by_grade


def worktree_subjects(root: Path) -> tuple[list[Subject], list[dict]]:
    declared = {witness: (area, why) for area, witness, why in SUBJECTS}
    subjects: list[Subject] = [Subject(area, witness, why) for area, witness, why in SUBJECTS]
    seen = set(declared)
    refusals: list[dict] = []

    for path, status in changed_paths(root):
        if path in seen:
            continue
        seen.add(path)
        if "D" in status:
            refusals.append(
                {
                    "kind": "unwitnessed",
                    "subject": path,
                    "witness": path,
                    "detail": f"the worktree deleted this file ({status.strip()}); a deleted witness has no cell",
                    "site": f"{path}:1",
                }
            )
            continue
        subjects.append(Subject("worktree", path, "a worktree change outside the declared segments"))
    return subjects, refusals


def build_cells(root: Path, subjects: list[Subject] | None = None) -> tuple[list[Cell], list[dict]]:
    if subjects is None:
        subjects, refusals = worktree_subjects(root)
    else:
        refusals = []

    witnesses = [subject.witness for subject in subjects if (root / subject.witness).is_file()]
    readings, grades = syntax_results(root, witnesses)

    cells: list[Cell] = []
    for subject in subjects:
        path = root / subject.witness
        if not path.is_file():
            refusals.append(
                {
                    "kind": "unwitnessed",
                    "subject": subject.area,
                    "witness": subject.witness,
                    "detail": f"the declared witness {subject.witness} is not on disk",
                    "site": f"{subject.witness}:1",
                }
            )
            continue
        try:
            data = path.read_bytes()
        except OSError as error:
            refusals.append(
                {
                    "kind": "unreadable",
                    "subject": subject.area,
                    "witness": subject.witness,
                    "detail": f"the witness could not be read: {error}",
                    "site": f"{subject.witness}:1",
                }
            )
            continue

        status, detail, line = readings.get(
            subject.witness, ("BLOCKED", "the witness was readable but no check ran", 0)
        )
        predicate = Predicate("syntax", status, detail, line)
        held = status in ("PASS", "NOT_APPLICABLE")
        grade = grades.get(subject.witness, "B")
        if status == "BLOCKED":
            grade = "D"
        basis = {
            "A": "an independent language engine parsed the witness",
            "B": "the witness was read back from the tree's own bytes",
            "C": "the subject reported its own state",
            "D": "declared, with no check that ran",
        }[grade]
        cells.append(
            Cell(
                subject=subject.area,
                area=subject.area,
                witness=subject.witness,
                why=subject.why,
                digest=hashlib.sha256(data).hexdigest(),
                size=len(data),
                site=f"{subject.witness}:{line or 1}",
                state="held" if held else "absent",
                grade=grade,
                grade_basis=basis,
                predicates=[predicate],
            )
        )
    return cells, refusals


def candidate_uris(explicit: str | None) -> list[str]:
    if explicit:
        return [explicit]
    configured = os.environ.get("OPENLOCK_MONGO_URI")
    if configured:
        return [configured]
    return list(DEFAULT_PORTS)


class Store:
    def __init__(self, uri: str):
        try:
            from pymongo import MongoClient
        except ImportError as error:
            raise RuntimeError(
                "the axis store needs pymongo: python -m pip install pymongo"
            ) from error
        self.client = MongoClient(uri, serverSelectionTimeoutMS=1500)
        self.client.admin.command("ping")
        self.uri = uri
        self.db = self.client[DATABASE]

    def close(self):
        self.client.close()


def open_store(explicit: str | None) -> Store:
    failures = []
    for uri in candidate_uris(explicit):
        try:
            return Store(uri)
        except Exception as error:  # noqa: BLE001 - every driver failure is a store refusal
            failures.append(f"{uri}: {error}")
    raise RuntimeError("no MongoDB is reachable (" + "; ".join(failures) + ")")


def compare(recorded: list[dict], current: list[Cell], recorded_refusals: list[dict] | None = None, current_refusals: list[dict] | None = None) -> list[str]:
    mismatches: list[str] = []
    by_witness = {cell.witness: cell for cell in current}
    for doc in recorded:
        witness = doc["witness"]
        cell = by_witness.get(witness)
        if cell is None:
            mismatches.append(f"{witness}: recorded but not re-derived")
            continue
        if doc["sha256"] != cell.digest:
            mismatches.append(f"{witness}: recorded digest {doc['sha256'][:12]} but the file is {cell.digest[:12]}")
            continue
        stored = {row["name"]: row["status"] for row in doc.get("predicates", [])}
        now = {row.name: row.status for row in cell.predicates}
        if stored != now:
            mismatches.append(f"{witness}: recorded predicates {stored} but the tree reads {now}")
        if doc.get("state") != cell.state or doc.get("grade") != cell.grade:
            mismatches.append(
                f"{witness}: recorded {doc.get('state')}/{doc.get('grade')} but the tree reads {cell.state}/{cell.grade}"
            )
    for cell in current:
        if cell.witness not in {doc["witness"] for doc in recorded}:
            mismatches.append(f"{cell.witness}: re-derived but not recorded")

    stored_refusals = {
        (row.get("kind"), row.get("witness")) for row in (recorded_refusals or [])
    }
    current_refusals = {
        (row.get("kind"), row.get("witness")) for row in (current_refusals or [])
    }
    for kind, witness in sorted(stored_refusals - current_refusals):
        mismatches.append(f"{witness}: recorded refusal {kind} but the tree no longer refuses it")
    for kind, witness in sorted(current_refusals - stored_refusals):
        mismatches.append(f"{witness}: refusal {kind} was not recorded")
    return mismatches


def store_run(store: Store, run: str, build: dict, cells: list[Cell], refusals: list[dict]) -> dict:
    database = store.db
    documents = [cell.doc(run, build) for cell in cells]
    if documents:
        database.witnesses.insert_many(documents)
    if refusals:
        database.refusals.insert_many([{**refusal, "run": run, "recordedAt": build["at"]} for refusal in refusals])
    database.runs.insert_one(
        {
            "run": run,
            "recordedAt": build["at"],
            "branch": build["branch"],
            "commit": build["commit"],
            "dirty": build["dirty"],
            "cells": len(documents),
            "refusals": len(refusals),
            "uri": store.uri,
        }
    )

    read_back = list(database.witnesses.find({"run": run}, {"_id": 0}))
    mismatches = compare(read_back, cells)
    if mismatches:
        result = "FAIL"
    elif refusals:
        result = "ABSENT"
    else:
        result = "PASS"
    verification = {
        "run": run,
        "verifiedAt": utc_now(),
        "result": result,
        "cells": len(read_back),
        "refusals": len(refusals),
        "mismatches": mismatches,
        "uri": store.uri,
    }
    database.verifications.insert_one(dict(verification))
    return verification


def latest_run(database) -> dict | None:
    return database.runs.find_one(sort=[("recordedAt", -1), ("_id", -1)])


def record_command(args) -> tuple[dict, int]:
    root = Path(args.root).resolve()
    build = {"at": utc_now(), **build_label(root)}
    cells, refusals = build_cells(root)
    run = uuid.uuid4().hex[:16]

    payload = {
        "run": run,
        "at": build["at"],
        "commit": build["commit"],
        "branch": build["branch"],
        "dirty": build["dirty"],
        "cells": [
            {
                "subject": cell.area,
                "witness": cell.witness,
                "state": cell.state,
                "grade": cell.grade,
                "site": cell.site,
                "predicates": [predicate.doc() for predicate in cell.predicates],
            }
            for cell in cells
        ],
        "refusals": refusals,
    }
    try:
        store = open_store(args.mongo_uri)
    except Exception as error:  # noqa: BLE001 - an absent store is a named refusal
        payload.update({"state": "BLOCKED", "refusal": "mongodb_unavailable", "detail": str(error)})
        return payload, 2
    try:
        verification = store_run(store, run, build, cells, refusals)
        payload.update({"state": verification["result"], "store": {"uri": store.uri, "database": DATABASE}, "verification": verification})
        return payload, 0 if verification["result"] == "PASS" else 1
    finally:
        store.close()


def verify_command(args) -> tuple[dict, int]:
    try:
        store = open_store(args.mongo_uri)
    except Exception as error:  # noqa: BLE001 - an absent store is a named refusal
        return {
            "state": "BLOCKED",
            "refusal": "mongodb_unavailable",
            "detail": str(error),
        }, 2
    try:
        database = store.db
        if args.run:
            run = database.runs.find_one({"run": args.run})
        else:
            run = latest_run(database)
        if not run:
            return {"state": "ABSENT", "detail": "no axis run is recorded in the store"}, 1
        recorded = list(database.witnesses.find({"run": run["run"]}, {"_id": 0}))
        recorded_refusals = list(database.refusals.find({"run": run["run"]}, {"_id": 0}))
        # Re-derive the run's own witnesses, not the current git status: after a commit the set of
        # changed files is different, and verifying against that set would say nothing about the
        # bytes the run actually read.
        subjects = [Subject(doc["area"], doc["witness"], doc.get("why", "")) for doc in recorded]
        current, refusals = build_cells(ROOT, subjects)
        mismatches = compare(recorded, current, recorded_refusals, refusals)
        if not recorded:
            mismatches.append("the run recorded no cells")
        result = "FAIL" if mismatches else "PASS"
        verification = {
            "run": run["run"],
            "verifiedAt": utc_now(),
            "result": result,
            "cells": len(recorded),
            "refusals": len(refusals),
            "mismatches": mismatches,
            "uri": store.uri,
        }
        database.verifications.insert_one(dict(verification))
        return {
            "state": result,
            "run": run["run"],
            "commit": run.get("commit"),
            "store": {"uri": store.uri, "database": DATABASE},
            "verification": verification,
            "cells": [
                {
                    "subject": doc["area"],
                    "witness": doc["witness"],
                    "state": doc["state"],
                    "grade": doc["grade"],
                    "site": doc["site"],
                    "predicates": doc.get("predicates", []),
                }
                for doc in recorded
            ],
        }, 0 if result == "PASS" else 1
    finally:
        store.close()


def print_human(payload: dict) -> None:
    print(f"axis {payload.get('state', 'UNKNOWN')}  run {payload.get('run', '-')}  {payload.get('commit', '-')}")
    for cell in payload.get("cells", []):
        detail = "; ".join(
            f"{row['name']} {row['status']}" + (f" at {cell['site']}" if row['status'] == 'FAIL' else "")
            for row in cell.get("predicates", [])
        )
        print(f"  {cell['state']:<7} {cell['grade']}  {cell['witness']:<52} {detail}")
    for refusal in payload.get("refusals", []):
        print(f"  REFUSED {refusal['kind']:<10} {refusal['witness']}  {refusal['detail']}")
    verification = payload.get("verification") or {}
    if verification.get("mismatches"):
        for mismatch in verification["mismatches"]:
            print(f"  MISMATCH {mismatch}")
    store = payload.get("store") or {}
    if store:
        print(f"store {store.get('uri')}/{store.get('database')}  read back {verification.get('cells', 0)} cell(s)")
    if payload.get("detail") and payload.get("state") == "BLOCKED":
        print(f"  {payload['detail']}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Axis code witnesses over the Openlock worktree.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    recorder = subparsers.add_parser("record", help="derive every cell, write the run and read it back")
    recorder.add_argument("--root", default=str(ROOT))
    recorder.add_argument("--mongo-uri", default=None)
    recorder.add_argument("--json", action="store_true")
    verifier = subparsers.add_parser("verify", help="re-derive the tree and compare it with a stored run")
    verifier.add_argument("--run", default=None)
    verifier.add_argument("--mongo-uri", default=None)
    verifier.add_argument("--json", action="store_true")
    args = parser.parse_args()

    if args.command == "record":
        payload, code = record_command(args)
    else:
        payload, code = verify_command(args)
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print_human(payload)
    return code


if __name__ == "__main__":
    raise SystemExit(main())

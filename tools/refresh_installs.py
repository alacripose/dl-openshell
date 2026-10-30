#!/usr/bin/env python3
"""Rebuild every installed shell that is not the current source.

A dev-grade install may not drift from the worktree (AGENTS.md, "Dev-grade installs"). Making that
true by hand, one tree at a time, is how the drift list grew to three trees: whoever shipped a
change installed it into the tree they were testing and left the others behind. This tool is the
missing half of the install gate: install.ps1 calls it at the end of every run, so one install
pushes the change into every tree that already carries the shell.

The reading is the same one tools/parity_check.py makes — the baked ``sourceDigest``, the build
commit and the delivery feature markers — so a tree this tool calls current is a tree parity calls
current. A tree that still differs after its rebuild is refused by name; so is a tree whose client
is running and cannot be replaced.

A tree that carries no shell is not refreshed: installing the shell into a new game is a choice,
not a repair.

Usage::

    python tools/refresh_installs.py [--root PATH ...] [--grade dev|observer|player|keep]
                                     [--dry-run] [--json] [--python EXE]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

from axis_witness import git  # noqa: E402
from gen_shell_data import read_installs, source_digest  # noqa: E402
from parity_check import delivery_failures, shell_build  # noqa: E402

INSTALLER = ROOT / "install.ps1"
SHIPPING_GRADES = ("dev", "observer", "player")


def known_trees(explicit: list[str]) -> list[Path]:
    """Every tree this machine's own discovery knows about, deduplicated by real path."""
    rows: list[dict] = []
    try:
        rows.extend(read_installs(None, []))
    except (OSError, ValueError):
        pass
    try:
        from list_installs import read_hosts  # local import: a host scan is not always wanted

        rows.extend(read_hosts())
    except (OSError, ValueError, ImportError):
        pass
    for path in explicit:
        rows.append({"path": path})

    trees: list[Path] = []
    seen: set[str] = set()
    for row in rows:
        raw = str(row.get("path") or "")
        if not raw:
            continue
        path = Path(raw)
        try:
            key = str(path.resolve()).lower()
        except OSError:
            key = raw.lower()
        if key in seen:
            continue
        seen.add(key)
        trees.append(path)
    return trees


def reading(path: Path) -> dict:
    return shell_build(path)


def stale_reasons(build: dict, head: str, expected: str) -> list[str]:
    reasons: list[str] = []
    if expected:
        delivered = str(build.get("sourceDigest") or "")
        if not delivered:
            reasons.append("the shell data carries no source digest")
        elif delivered != expected:
            reasons.append(f"source digest {delivered[:12]} != worktree {expected[:12]}")
    if head and str(build.get("commit") or "") != head:
        reasons.append(f"baked commit {build.get('commit') or '(none)'} != HEAD {head}")
    reasons.extend(delivery_failures(build, expected))
    return reasons


def grade_for(build: dict, requested: str) -> str:
    if requested != "keep":
        return requested
    grade = str(build.get("grade") or "").lower()
    return grade if grade in SHIPPING_GRADES else "dev"


def rebuild(path: Path, grade: str, python: str) -> tuple[int, str]:
    """Run the installer for one tree. Its own refresh pass is suppressed, so there is no recursion."""
    command = [
        "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(INSTALLER),
        "-DeadlockRoot", str(path), "-Grade", grade, "-NoUi", "-NoRefresh", "-NoParity",
        "-Python", python,
    ]
    result = subprocess.run(
        command, cwd=ROOT, text=True, encoding="utf-8", errors="replace",
        capture_output=True, check=False,
    )
    output = ((result.stdout or "") + (result.stderr or "")).strip()
    return result.returncode, output


def main() -> int:
    parser = argparse.ArgumentParser(description="Rebuild every installed shell that is not the current source.")
    parser.add_argument("--root", action="append", default=[], help="an extra tree to consider")
    parser.add_argument("--grade", default="keep", choices=("dev", "observer", "player", "keep"),
                        help="grade the rebuilt trees carry; keep preserves each tree's own grade")
    parser.add_argument("--dry-run", action="store_true", help="report the stale trees without rebuilding")
    parser.add_argument("--force", action="store_true",
                        help="rebuild every shell tree, stale or not (a build-product change)")
    parser.add_argument("--json", action="store_true", help="print the reading as JSON")
    parser.add_argument("--python", default=sys.executable, help="the Python the installer should use")
    args = parser.parse_args()

    head = git(ROOT, "rev-parse", "--short", "HEAD")
    expected = source_digest()
    trees = known_trees(args.root)

    carriers = []
    for path in trees:
        build = reading(path)
        if build["kind"] == "none":
            continue
        reasons = stale_reasons(build, head, expected)
        if args.force:
            reasons = reasons or ["forced rebuild"]
        carriers.append({
            "path": str(path),
            "kind": build["kind"],
            "grade": str(build.get("grade") or ""),
            "commit": str(build.get("commit") or ""),
            "stale": reasons,
            "rebuilt": False,
            "code": None,
        })

    # Tools and loose trees first, packed archives last. The installer wipes `dist/openlock_ui` on
    # every run, so the packed archive that parity compares against must be the run's last product;
    # a tools rebuild after it would leave no built VPK and an install cell that cannot hold.
    carriers.sort(key=lambda row: 1 if row["kind"] == "vpk" else 0)

    pending = [row for row in carriers if row["stale"]]
    for row in pending:
        path = Path(row["path"])
        grade = grade_for(reading(path), args.grade)
        row["grade"] = grade
        if args.dry_run:
            continue
        code, output = rebuild(path, grade, args.python)
        build = reading(path)
        after = stale_reasons(build, head, expected)
        if after:
            # The packer on this SDK can leave a file handle that outlives its run, and a rebuild
            # started against that handle fails once. One retry is a lock, not a policy: a tree
            # that is still stale after it is refused by name below.
            code, retry_output = rebuild(path, grade, args.python)
            output += "\n" + retry_output
            build = reading(path)
            after = stale_reasons(build, head, expected)
        row["code"] = code
        row["rebuilt"] = True
        row["after"] = after
        row["commit"] = str(build.get("commit") or "")
        if code != 0 and not row["after"]:
            # The installer can exit non-zero only after its parity gate found another tree still
            # behind. The tree itself carries the source, so this is not a refusal for this row;
            # the outer run's parity reading is what decides the fleet.
            row["note"] = "installer exit " + str(code) + " came after the tree was written"
        row["output"] = output[-2000:] if output else ""

    refusals = []
    for row in pending:
        if args.dry_run:
            refusals.append({"path": row["path"], "why": "would be rebuilt: " + "; ".join(row["stale"])})
            continue
        if row.get("after"):
            refusals.append({"path": row["path"], "why": "; ".join(row["after"])})

    # The installer window is the only surface that can ask about installer pairs, so every
    # dev-grade install has to be able to open it: the current pair is part of a dev tree being
    # current. A game tree is left to the window's explicit tick.
    from installer_pair import reading as pair_reading, seed as pair_seed  # local: optional surface

    seeded = []
    for row in carriers:
        if str(row.get("grade") or "").lower() != "dev":
            continue
        path = Path(row["path"])
        pair = pair_reading(path)
        if pair["installer"] == "current":
            continue
        if args.dry_run:
            seeded.append({"path": row["path"], "state": pair["installer"], "seeded": False})
            continue
        ok, detail = pair_seed(path)
        seeded.append({"path": row["path"], "state": pair["installer"], "seeded": ok, "detail": detail})
        if not ok:
            refusals.append({"path": row["path"], "why": "installer pair: " + detail})

    payload = {
        "head": head,
        "sourceDigest": expected,
        "trees": carriers,
        "installerPairs": seeded,
        "refusals": refusals,
        "state": "REFUSED" if refusals else ("STALE" if pending and args.dry_run else "CURRENT"),
    }

    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(f"refresh: {len(carriers)} shell tree(s), {len(pending)} stale, HEAD {head or '(none)'} "
              f"digest {expected[:12] or '(none)'}")
        for row in carriers:
            mark = "stale" if row["stale"] else "current"
            print(f"  {mark:<7} {row['kind']:<5} grade {row['grade'] or '?':<8} {row['path']}")
            for reason in row["stale"]:
                print(f"          {reason}")
            if row.get("note"):
                print(f"          {row['note']}")
        for row in seeded:
            mark = "seeded" if row["seeded"] else "stale-pair"
            print(f"  {mark:<10} installer {row['state']:<8} {row['path']}")
        print("state:", payload["state"])
        for refusal in refusals:
            print(f"  REFUSED {refusal['path']}  {refusal['why']}")

    return 0 if not refusals else 1


if __name__ == "__main__":
    raise SystemExit(main())

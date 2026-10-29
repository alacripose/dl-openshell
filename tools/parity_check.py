#!/usr/bin/env python3
"""Double verification of an installed shell, and its parity with every authority.

install.ps1 already compares the archive it copies with the archive it built. This gate repeats
that check independently: it hashes the installed VPK again, reads the commit and grade baked into
its ``openlock_shell_data.js``, and compares that reading with the worktree, ``origin/main`` and
the live Steam client. The installer's record is the first reading; this is the second.

A mismatch on the worktree, GitHub or the install is a refusal: the client must not launch a build
that is not the pushed tree. A live client carrying another build is an **absence**, named with
its own commit and hash, because the shipping client and a development tools install are different
surfaces and divergence there is a fact to report, not a reason to refuse a local mount.

Usage::

    python tools/parity_check.py --install PATH [--live PATH] [--json] [--mongo-uri URI]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

import vpk_read  # noqa: E402
from axis_witness import DATABASE, git, open_store, utc_now  # noqa: E402
from gen_shell_data import read_installs  # noqa: E402

BUILT_VPK = ROOT / "dist" / "openlock_ui" / "pak01_dir.vpk"
BUILD_RECORD = Path("game") / "bin" / "win64" / "openlock.build.json"
INSTALLED_VPK = Path("game") / "citadel" / "addons" / "mods" / "pak01_dir.vpk"
GAMEINFO = Path("game") / "citadel" / "gameinfo.gi"
DATA_ENTRY = "openlock_shell_data.js"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def vpk_build(vpk: Path) -> dict:
    """The build the VPK itself carries: commit, dirty flag and grade from its shell data."""
    entries, inline = vpk_read._read_tree(str(vpk))
    for entry in entries:
        if not entry["path"].endswith(DATA_ENTRY):
            continue
        blob = inline.get(entry["path"])
        if blob is None:
            blob = vpk_read.entry_bytes(str(vpk), entry)
        if blob is None:
            return {}
        text = blob.decode("utf-8", "replace")
        found = {}
        for key in ("commit", "dirty", "grade"):
            match = re.search(r'"' + key + r'"\s*:\s*"?([^",\r\n]*)"?', text)
            if match:
                found[key] = match.group(1).strip().strip('"')
        if "dirty" in found:
            found["dirty"] = found["dirty"] == "true"
        return found
    return {}


def remote_main(root: Path) -> tuple[str, str]:
    """(commit, detail) for refs/heads/main on origin. An unreachable remote is not a commit."""
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "ls-remote", "origin", "refs/heads/main"],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return "", str(error)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "git ls-remote failed").strip()
        return "", detail.splitlines()[-1]
    line = (result.stdout or "").strip().splitlines()[0] if result.stdout.strip() else ""
    return (line.split()[0][:7] if line else ""), ""


def read_record(root: Path) -> dict:
    path = root / BUILD_RECORD
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def mounted(root: Path) -> bool:
    path = root / GAMEINFO
    try:
        text = path.read_text(encoding="utf-8", errors="replace").replace("\\", "/").lower()
    except OSError:
        return False
    return "citadel/addons/mods" in text


def cell(name: str, state: str, grade: str, witness: str, detail: str, sha: str = "") -> dict:
    return {
        "cell": name,
        "state": state,
        "grade": grade,
        "witness": str(witness),
        "detail": detail,
        "sha256": sha,
    }


def repo_cell(root: Path, head: str, dirty: bool) -> dict:
    if not head:
        return cell("repo", "absent", "D", root, "the worktree has no readable git HEAD")
    return cell("repo", "held", "A", root, f"{head} {'dirty' if dirty else 'clean'}")


def github_cell(root: Path, head: str, remote: str, error: str) -> dict:
    if error:
        return cell("github", "blocked", "D", "origin/main", f"origin/main could not be read: {error}")
    if remote and head and remote.startswith(head):
        return cell("github", "held", "A", "origin/main", f"origin/main {remote} matches HEAD")
    return cell(
        "github",
        "absent",
        "A",
        "origin/main",
        f"origin/main {remote or '(none)'} does not match HEAD {head or '(none)'}",
    )


def install_cell(root: Path, head: str) -> dict:
    witness = root / INSTALLED_VPK
    record = read_record(root)
    if not witness.is_file():
        return cell("install", "absent", "B", witness, "no installed VPK in the selected tree")
    if not BUILT_VPK.is_file():
        return cell("install", "absent", "B", BUILT_VPK, "the worktree has no built VPK to compare with")

    installed_hash = sha256_file(witness)
    built_hash = sha256_file(BUILT_VPK)
    baked = vpk_build(witness)
    committed = str(baked.get("commit") or "")
    facts = []
    failures = []

    facts.append(f"sha {installed_hash[:12]}")
    if installed_hash != built_hash:
        failures.append(f"installed sha {installed_hash[:12]} != built {built_hash[:12]}")
    else:
        facts.append("hash matches the built archive")

    if committed:
        facts.append(f"commit {committed}{'+' if baked.get('dirty') else ''}")
        if head and committed != head:
            failures.append(f"baked commit {committed} != HEAD {head}")
    else:
        failures.append("no build commit is baked into the installed VPK")

    record_state = f"{record.get('stage', '?')}/{record.get('state', '?')}"
    facts.append(f"installer record {record_state}")
    if record_state != "installed/ok":
        failures.append("installer record is not installed/ok")

    mount = mounted(root)
    facts.append("mount present" if mount else "mount missing from gameinfo.gi")
    if not mount:
        failures.append("citadel/addons/mods is not in gameinfo.gi")

    detail = "; ".join(facts)
    if failures:
        return cell("install", "absent", "B", witness, detail + " | " + "; ".join(failures), installed_hash)
    return cell("install", "held", "B", witness, detail, installed_hash)


def find_live(explicit: str) -> Path | None:
    if explicit:
        return Path(explicit)
    try:
        rows = read_installs(None, [])
    except (OSError, ValueError):
        return None
    steam = [row for row in rows if "steam" in str(row.get("path", "")).lower()]
    if not steam:
        return None
    preferred = [row for row in steam if str(row.get("path", "")).lower().endswith("/deadlock")]
    choose = (preferred or steam)[0]
    return Path(str(choose["path"]))


def live_cell(root: Path | None, installed_hash: str) -> dict:
    if root is None:
        return cell("live", "absent", "D", "steam", "no Steam Deadlock install was found")
    witness = root / INSTALLED_VPK
    if not witness.is_file():
        return cell("live", "absent", "B", witness, "the live client carries no Openlock VPK")
    live_hash = sha256_file(witness)
    baked = vpk_build(witness)
    committed = str(baked.get("commit") or "unknown")
    grade = str(baked.get("grade") or "?")
    detail = f"build {committed}{'+' if baked.get('dirty') else ''} grade {grade} sha {live_hash[:12]}"
    if live_hash == installed_hash:
        return cell("live", "held", "B", witness, detail + "; matches the installed build", live_hash)
    return cell("live", "absent", "B", witness, detail + "; differs from the installed build", live_hash)


def derive(install_root: Path, live_override: str) -> tuple[dict, int]:
    head = git(ROOT, "rev-parse", "--short", "HEAD")
    dirty = bool(git(ROOT, "status", "--porcelain"))
    remote, remote_error = remote_main(ROOT)
    cells = [
        repo_cell(ROOT, head, dirty),
        github_cell(ROOT, head, remote, remote_error),
        install_cell(install_root, head),
    ]
    installed_hash = cells[2]["sha256"]
    live_root = find_live(live_override)
    cells.append(live_cell(live_root, installed_hash))

    by_name = {row["cell"]: row for row in cells}
    refusals = []
    if by_name["github"]["state"] == "blocked":
        refusals.append(
            {
                "kind": "unreachable",
                "cell": "github",
                "detail": by_name["github"]["detail"],
            }
        )
    for name in ("repo", "github", "install"):
        if by_name[name]["state"] != "held":
            refusals.append(
                {
                    "kind": "mismatch" if by_name[name]["state"] == "absent" else by_name[name]["state"],
                    "cell": name,
                    "detail": by_name[name]["detail"],
                }
            )

    if any(name in {r["cell"] for r in refusals} for name in ("repo", "install")):
        state = "FAIL"
    elif refusals:
        state = "BLOCKED"
    else:
        state = "PASS"

    detail = ""
    if by_name["live"]["state"] != "held":
        detail = "the live Steam client is not this build: " + by_name["live"]["detail"]
    payload = {
        "state": state,
        "at": utc_now(),
        "commit": head,
        "branch": git(ROOT, "rev-parse", "--abbrev-ref", "HEAD"),
        "dirty": dirty,
        "install": str(install_root),
        "live": str(live_root) if live_root else "",
        "cells": cells,
        "refusals": refusals,
        "detail": detail,
    }
    return payload, 0 if state == "PASS" else (2 if state == "BLOCKED" else 1)


def store_run(payload: dict, uri: str | None) -> dict:
    """Write the reading, read it back, and record whether the store agrees with the gate."""
    run = uuid.uuid4().hex[:16]
    payload["run"] = run
    store = open_store(uri)
    try:
        document = {
            "run": run,
            "recordedAt": payload["at"],
            "commit": payload["commit"],
            "branch": payload["branch"],
            "dirty": payload["dirty"],
            "install": payload["install"],
            "live": payload["live"],
            "state": payload["state"],
            "detail": payload["detail"],
            "cells": payload["cells"],
            "refusals": payload["refusals"],
        }
        store.db.parity.insert_one(dict(document))
        read_back = store.db.parity.find_one({"run": run}, {"_id": 0})
        stored = {row["cell"]: (row["state"], row.get("sha256", "")) for row in (read_back or {}).get("cells", [])}
        current = {row["cell"]: (row["state"], row.get("sha256", "")) for row in payload["cells"]}
        mismatches = [
            f"{name}: wrote {current.get(name)} but read {stored.get(name)}"
            for name in sorted(set(stored) | set(current))
            if stored.get(name) != current.get(name)
        ]
        verification = {
            "run": run,
            "verifiedAt": utc_now(),
            "result": "PASS" if not mismatches else "FAIL",
            "cells": len(stored),
            "mismatches": mismatches,
            "uri": store.uri,
        }
        store.db.parityVerifications.insert_one(dict(verification))
        payload["store"] = {"uri": store.uri, "database": DATABASE}
        payload["verification"] = verification
        if mismatches:
            payload["state"] = "FAIL"
        return payload
    finally:
        store.close()


def print_human(payload: dict) -> None:
    print(f"parity {payload.get('state', 'UNKNOWN')}  run {payload.get('run', '-')}  {payload.get('commit', '-')}")
    for row in payload.get("cells", []):
        print(f"  {row['state']:<7} {row['grade']}  {row['cell']:<8} {row['detail']}")
        print(f"          {row['witness']}")
    for refusal in payload.get("refusals", []):
        print(f"  REFUSED {refusal['kind']:<10} {refusal['cell']}  {refusal['detail']}")
    verification = payload.get("verification") or {}
    store = payload.get("store") or {}
    if store:
        print(f"store {store.get('uri')}/{store.get('database')}  read back {verification.get('cells', 0)} cell(s)")
    for mismatch in verification.get("mismatches", []):
        print(f"  MISMATCH {mismatch}")
    if payload.get("detail"):
        print(f"  {payload['detail']}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify an installed Openlock shell against repo, GitHub and the live client.")
    parser.add_argument("--install", required=True, help="the Deadlock or tools tree the shell was installed into")
    parser.add_argument("--live", default="", help="the Steam Deadlock tree; auto-detected when omitted")
    parser.add_argument("--mongo-uri", default=None)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    install_root = Path(args.install)
    if not (install_root / GAMEINFO).is_file():
        payload = {
            "state": "FAIL",
            "at": utc_now(),
            "cells": [],
            "refusals": [
                {
                    "kind": "unreadable",
                    "cell": "install",
                    "detail": f"{install_root} has no game/citadel/gameinfo.gi",
                }
            ],
            "detail": "",
        }
        code = 1
    else:
        payload, code = derive(install_root, args.live)

    if payload["cells"]:
        try:
            payload = store_run(payload, args.mongo_uri)
        except Exception as error:  # noqa: BLE001 - an absent store is a named refusal
            payload["state"] = "BLOCKED"
            payload["detail"] = f"the parity run could not be recorded: {error}"
            payload["refusals"].append(
                {"kind": "unverified", "cell": "store", "detail": str(error)}
            )
            code = 2

    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print_human(payload)
    return code


if __name__ == "__main__":
    raise SystemExit(main())

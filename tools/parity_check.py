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
from gen_shell_data import feature_gaps, read_installs, source_digest  # noqa: E402

BUILT_VPK = ROOT / "dist" / "openlock_ui" / "pak01_dir.vpk"
BUILD_RECORD = Path("game") / "bin" / "win64" / "openlock.build.json"
INSTALLED_VPK = Path("game") / "citadel" / "addons" / "mods" / "pak01_dir.vpk"
LOOSE_DATA = Path("game") / "citadel" / "addons" / "mods" / "panorama" / "scripts" / "openlock_shell_data.vjs_c"
TOOLS_DATA = Path("game") / "citadel_addons" / "openlock_ui" / "panorama" / "scripts" / "openlock_shell_data.vjs_c"
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
        return build_from_text(blob.decode("utf-8", "replace"))
    return {}


def build_from_text(text: str) -> dict:
    found = {}
    for key in ("commit", "dirty", "grade", "sourceDigest"):
        match = re.search(r'"' + key + r'"\s*:\s*"?([^",\r\n]*)"?', text)
        if match:
            found[key] = match.group(1).strip().strip('"')
    if "dirty" in found:
        found["dirty"] = found["dirty"] == "true"
    return found


def shell_script(root: Path, kind: str, witness: Path) -> str:
    """The delivered shell plus its companion modules, from a VPK or the loose tree.

    Delivery and Popit live in their own scripts by design. Reading only `openlock_shell.js`
    would report those capabilities missing from a correct build, so the gate reads the whole
    shell script set and tests the capability markers against it.
    """
    names = ("openlock_shell", "openlock_delivery", "openlock_popit", "openlock_audio")
    texts: list[str] = []
    if kind == "vpk":
        entries, inline = vpk_read._read_tree(str(witness))
        for entry in entries:
            path = str(entry["path"])
            if not path.startswith("panorama/scripts/"):
                continue
            base = Path(path).name
            if not any(base in (f"{name}.js", f"{name}.vjs_c") for name in names):
                continue
            blob = inline.get(path)
            if blob is None:
                blob = vpk_read.entry_bytes(str(witness), entry)
            if blob is not None:
                texts.append(blob.decode("utf-8", "replace"))
        return "\n".join(texts)

    for name in names:
        for suffix in (".vjs_c", ".js"):
            path = witness.parent / f"{name}{suffix}"
            if path.is_file():
                texts.append(path.read_text(encoding="utf-8", errors="replace"))
                break
    return "\n".join(texts)


def delivery_failures(shell: dict, expected_digest: str) -> list[str]:
    """Reasons an installed shell is not the current source, independent of its git commit."""
    failures: list[str] = []
    if expected_digest:
        delivered = str(shell.get("sourceDigest") or "")
        if not delivered:
            failures.append("the shell data carries no source digest; rebuild and reinstall")
        elif delivered != expected_digest:
            failures.append(
                f"source digest {delivered[:12]} != current worktree {expected_digest[:12]}"
            )
    missing = shell.get("missingFeatures") or {}
    if missing:
        failures.append(
            "missing current shell feature marker(s): "
            + "; ".join(f"{feature} [{' '.join(markers)}]" for feature, markers in missing.items())
        )
    return failures


def shell_build(root: Path) -> dict:
    """What shell a tree actually runs, whether it is loose compiled resources or a packed VPK.

    A live install can carry both: the VPK from the last packaged install and loose `_c`
    resources from a later map-reload install. The loose copy wins because the client resolves it
    first; reporting the stale archive would call a working client out of date. A CSDK10 tools
    tree has its own `citadel_addons` slot, which is a different surface from a game archive.
    """
    tools = root / TOOLS_DATA
    loose = root / LOOSE_DATA
    if tools.is_file():
        kind = "tools"
        witness = tools
        baked = build_from_text(tools.read_text(encoding="utf-8", errors="replace"))
    elif loose.is_file():
        kind = "loose"
        witness = loose
        baked = build_from_text(loose.read_text(encoding="utf-8", errors="replace"))
    else:
        archive = root / INSTALLED_VPK
        if not archive.is_file():
            return {
                "kind": "none", "witness": root / INSTALLED_VPK, "sha256": "",
                "commit": "", "dirty": False, "grade": "", "sourceDigest": "",
                "missingFeatures": {},
            }
        kind = "vpk"
        witness = archive
        baked = vpk_build(archive)

    script = shell_script(root, kind, witness)
    return {
        "kind": kind,
        "witness": witness,
        "sha256": sha256_file(witness),
        "commit": str(baked.get("commit") or ""),
        "dirty": bool(baked.get("dirty")),
        "grade": str(baked.get("grade") or ""),
        "sourceDigest": str(baked.get("sourceDigest") or ""),
        "missingFeatures": feature_gaps(script),
    }


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


def tools_mounted(root: Path) -> bool:
    """The CSDK10 tools slot is `AddonRoot citadel_addons`, not the shipping addon archive."""
    path = root / GAMEINFO
    try:
        text = path.read_text(encoding="utf-8", errors="replace").replace("\\", "/").lower()
    except OSError:
        return False
    return "addonroot" in text and "citadel_addons" in text and (root / TOOLS_DATA).is_file()


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


def install_cell(root: Path, head: str, expected_digest: str) -> dict:
    # A CSDK10 tools install writes its live slot under AddonRoot citadel_addons. That slot is the
    # client's authority even when a game addon VPK exists beside it in the same tree.
    tools = root / TOOLS_DATA
    if tools.is_file():
        record = read_record(root)
        baked = build_from_text(tools.read_text(encoding="utf-8", errors="replace"))
        committed = str(baked.get("commit") or "")
        facts = ["server tools slot"]
        failures = []
        if committed:
            facts.append(f"commit {committed}{'+' if baked.get('dirty') else ''}")
            if head and committed != head:
                failures.append(f"baked commit {committed} != HEAD {head}")
        else:
            failures.append("no build commit is baked into the tools shell data")
        record_state = f"{record.get('stage', '?')}/{record.get('state', '?')}"
        facts.append(f"installer record {record_state}")
        if record_state != "installed/ok":
            failures.append("installer record is not installed/ok")
        mount = tools_mounted(root)
        facts.append("tools mount present" if mount else "tools mount missing from gameinfo.gi")
        if not mount:
            failures.append("AddonRoot citadel_addons is not mounted")
        failures.extend(delivery_failures(shell_build(root), expected_digest))
        # A game archive in the same tree is a different surface. Report its build, but do not
        # fail the tools gate on it: the tools client mounts AddonRoot citadel_addons, not this
        # archive. The live Steam client is compared separately above.
        game_vpk = root / INSTALLED_VPK
        if game_vpk.is_file():
            game = vpk_build(game_vpk)
            game_commit = str(game.get("commit") or "")
            facts.append(f"game archive {game_commit or '(no commit)'} (not the tools mount)")
        detail = "; ".join(facts)
        if failures:
            return cell("install", "absent", "B", tools, detail + " | " + "; ".join(failures), sha256_file(tools))
        return cell("install", "held", "B", tools, detail, sha256_file(tools))

    # A live game install writes loose compiled resources beside the (still open) VPK. The VPK is
    # stale by design in that mode, so the commit baked into the loose shell data is the authority.
    loose = root / LOOSE_DATA
    if loose.is_file():
        record = read_record(root)
        baked = build_from_text(loose.read_text(encoding="utf-8", errors="replace"))
        committed = str(baked.get("commit") or "")
        facts = ["live compiled resources"]
        failures = []
        if committed:
            facts.append(f"commit {committed}{'+' if baked.get('dirty') else ''}")
            if head and committed != head:
                failures.append(f"baked commit {committed} != HEAD {head}")
        else:
            failures.append("no build commit is baked into the live shell data")
        record_state = f"{record.get('stage', '?')}/{record.get('state', '?')}"
        facts.append(f"installer record {record_state}")
        if record_state != "installed/ok":
            failures.append("installer record is not installed/ok")
        mount = mounted(root)
        facts.append("mount present" if mount else "mount missing from gameinfo.gi")
        if not mount:
            failures.append("citadel/addons/mods is not in gameinfo.gi")
        failures.extend(delivery_failures(shell_build(root), expected_digest))
        detail = "; ".join(facts)
        if failures:
            return cell("install", "absent", "B", loose, detail + " | " + "; ".join(failures), sha256_file(loose))
        return cell("install", "held", "B", loose, detail, sha256_file(loose))

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

    failures.extend(delivery_failures(shell_build(root), expected_digest))
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


def live_cell(root: Path | None, installed_hash: str, head: str, expected_digest: str) -> dict:
    if root is None:
        return cell("live", "absent", "D", "steam", "no Steam Deadlock install was found")
    shell = shell_build(root)
    if shell["kind"] == "none":
        return cell("live", "absent", "B", shell["witness"], "the live client carries no Openlock shell")
    live_hash = shell["sha256"]
    committed = shell["commit"] or "unknown"
    grade = shell["grade"] or "?"
    detail = f"{shell['kind']} build {committed}{'+' if shell['dirty'] else ''} grade {grade} sha {live_hash[:12]}"
    failures = delivery_failures(shell, expected_digest)
    if failures:
        return cell("live", "absent", "B", shell["witness"], detail + " | " + "; ".join(failures), live_hash)
    # Different tools compilers produce different bytes for the same source. The source digest is
    # the identity; a commit match is not sufficient, because it cannot see an uncommitted change.
    if expected_digest and shell["sourceDigest"] == expected_digest:
        return cell("live", "held", "B", shell["witness"], detail + "; matches the current source", live_hash)
    if head and shell["commit"] == head:
        return cell("live", "held", "B", shell["witness"], detail + f"; commit matches HEAD {head}", live_hash)
    if live_hash == installed_hash:
        return cell("live", "held", "B", shell["witness"], detail + "; bytes match the installed shell", live_hash)
    return cell("live", "absent", "B", shell["witness"], detail + f"; differs from HEAD {head or '(none)'}", live_hash)


def audit_cell(row: dict, install_root: Path, live_root: Path | None, head: str, expected_digest: str) -> dict | None:
    """One other client or tools shell, measured rather than assumed.

    These are deliberately not gate refusals: a second tools tree or the shipping client may sit
    on an older build and that is a fact to report. The CSDK10 server slot still needs the
    comparison, because a shell update that only reached one tree is not a verified update.
    """
    root = Path(str(row.get("path") or ""))
    if not row or not str(root):
        return None
    try:
        same_install = root.resolve() == install_root.resolve()
        same_live = live_root is not None and root.resolve() == live_root.resolve()
    except OSError:
        same_install = str(root).lower() == str(install_root).lower()
        same_live = live_root is not None and str(root).lower() == str(live_root).lower()
    if same_install or same_live:
        return None

    shell = shell_build(root)
    kind = str(row.get("kind") or "game")
    name = kind + ":" + (root.name or str(root))
    if shell["kind"] == "none":
        return {
            "cell": name,
            "kind": kind,
            "state": "absent",
            "shell": str(row.get("shell") or "unknown"),
            "witness": str(root),
            "commit": "",
            "grade": "",
            "sha256": "",
            "detail": "no Openlock shell is installed in this tree",
        }

    committed = shell["commit"] or "unknown"
    grade = shell["grade"] or "?"
    failures = delivery_failures(shell, expected_digest)
    state = "held" if not failures and head and shell["commit"] == head else "drift"
    detail = (
        f"{shell['kind']} build {committed}{'+' if shell['dirty'] else ''} grade {grade} "
        f"sha {shell['sha256'][:12]} mount {str(row.get('shell') or 'unknown')}"
    )
    if not shell["commit"]:
        detail += "; no build commit is baked into this shell"
    if failures:
        detail += " | " + "; ".join(failures)
    elif state == "drift":
        detail += f"; differs from HEAD {head}"
    else:
        detail += "; matches HEAD and the current source"
    return {
        "cell": name,
        "kind": kind,
        "state": state,
        "shell": str(row.get("shell") or "unknown"),
        "witness": str(shell["witness"]),
        "commit": shell["commit"],
        "grade": shell["grade"],
        "sha256": shell["sha256"],
        "detail": detail,
    }


def audit_installs(install_root: Path, live_root: Path | None, head: str, expected_digest: str) -> list[dict]:
    """Every other client and tools shell the machine's own discovery already knows about.

    `read_installs` covers game trees with a gameinfo. A reduced CSDK tools host can carry the
    shell without one, so `read_hosts` is read too; that is the surface that compiles the shell,
    and a stale loose bundle there would otherwise never be compared.
    """
    try:
        rows = read_installs(install_root / GAMEINFO, [install_root])
    except (OSError, ValueError):
        rows = []
    try:
        from list_installs import read_hosts  # local import: a host scan is not needed by every call

        for host in read_hosts():
            path = str(host.get("path") or "")
            if path:
                rows.append({"path": path, "kind": "toolhost", "shell": "unknown"})
    except (OSError, ValueError, ImportError):
        pass

    audits = []
    seen: set[str] = set()
    for row in rows:
        path = str(row.get("path") or "")
        try:
            key = str(Path(path).resolve()).lower()
        except OSError:
            key = path.lower()
        if not key or key in seen:
            continue
        seen.add(key)
        reading = audit_cell(row, install_root, live_root, head, expected_digest)
        if reading:
            audits.append(reading)
    return audits


def derive(install_root: Path, live_override: str, require_live: bool = False) -> tuple[dict, int]:
    head = git(ROOT, "rev-parse", "--short", "HEAD")
    dirty = bool(git(ROOT, "status", "--porcelain"))
    remote, remote_error = remote_main(ROOT)
    expected_digest = source_digest()
    cells = [
        repo_cell(ROOT, head, dirty),
        github_cell(ROOT, head, remote, remote_error),
        install_cell(install_root, head, expected_digest),
    ]
    installed_hash = cells[2]["sha256"]
    live_root = find_live(live_override)
    cells.append(live_cell(live_root, installed_hash, head, expected_digest))
    audits = audit_installs(install_root, live_root, head, expected_digest)

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
    # A CSDK10 development change is not a completed delivery until the live Steam client carries
    # the same build. Refuse the tools gate when the player client is still on an older one.
    if require_live and by_name["live"]["state"] != "held":
        refusals.append(
            {
                "kind": "undelivered",
                "cell": "live",
                "detail": "the live Steam client has not received this build: " + by_name["live"]["detail"],
            }
        )

    if any(name in {r["cell"] for r in refusals} for name in ("repo", "install")):
        state = "FAIL"
    elif require_live and by_name["live"]["state"] != "held":
        state = "FAIL"
    elif refusals:
        state = "BLOCKED"
    else:
        state = "PASS"

    detail = ""
    if by_name["live"]["state"] != "held":
        detail = "the live Steam client is not this build: " + by_name["live"]["detail"]
    drift = [row for row in audits if row["state"] == "drift"]
    uninstalled = [row for row in audits if row["state"] == "absent"]
    if drift:
        detail = (detail + "; " if detail else "") + (
            f"{len(drift)} other shell tree(s) differ from HEAD: "
            + ", ".join(row["cell"] for row in drift)
        )
    if uninstalled:
        detail = (detail + "; " if detail else "") + (
            f"{len(uninstalled)} client/tools tree(s) carry no shell: "
            + ", ".join(row["cell"] for row in uninstalled)
        )
    payload = {
        "state": state,
        "at": utc_now(),
        "commit": head,
        "branch": git(ROOT, "rev-parse", "--abbrev-ref", "HEAD"),
        "dirty": dirty,
        "install": str(install_root),
        "live": str(live_root) if live_root else "",
        "cells": cells,
        "audits": audits,
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
            "audits": payload["audits"],
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
    for row in payload.get("audits", []):
        print(f"  {row['state']:<7} B  {row['cell']:<16} {row['detail']}")
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
    parser.add_argument(
        "--require-live",
        action="store_true",
        help="refuse the run unless the live Steam client carries the same build",
    )
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
        payload, code = derive(install_root, args.live, args.require_live)

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

#!/usr/bin/env python3
"""Focused proof for the optional package envelope (the axis package-security slice).

Accept, tamper-refusal, wrong-authority and insufficient-work, plus the read-time rule: a
refused surface contributes no window to the shell data. Keys are temporary and outside the
checkout, the same rule axis's Security::open enforces.

Run: python tools/tests/envelope-test.py
"""

from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import gen_shell_data  # noqa: E402
import package_envelope as envelope  # noqa: E402

CHECKS = 0


def check(condition: bool, name: str) -> None:
    global CHECKS
    CHECKS += 1
    if not condition:
        raise SystemExit(f"FAILED: {name}")
    print(f"ok {CHECKS} - {name}")


def refusal_kind(reading: dict) -> str:
    refusals = reading.get("refusals") or []
    return refusals[0]["kind"] if refusals else ""


def main() -> int:
    temp = Path(tempfile.mkdtemp(prefix="openlock-envelope-"))
    try:
        key = bytes.fromhex("11" * envelope.KEY_BYTES)
        other = bytes.fromhex("22" * envelope.KEY_BYTES)
        key_path = temp / "keys" / "signing.key"
        key_path.parent.mkdir(parents=True, exist_ok=True)
        key_path.write_text(key.hex() + "\n", encoding="utf-8")
        check(envelope.load_key(key_path) == key, "a machine key outside the checkout is read")
        # A path inside the real checkout is refused before it is even opened; nothing is
        # written there, which is the rule itself.
        check(envelope.load_key(ROOT / "signing.key") is None,
              "a key inside the checkout is refused (it would name no one)")

        package_text = (ROOT / "shell" / "alpha-shell" / "package.shspec").read_text(encoding="utf-8")
        unsigned = envelope.verify_text(package_text)
        check(unsigned["state"] == "unsigned", "an unsigned package is unsigned, not refused")
        check(not unsigned["refusals"], "an unsigned package raises no refusal")

        signed = envelope.sign_text(package_text, key, work=envelope.MIN_WORK + 2)
        reading = envelope.verify_text(signed, key)
        check(reading["state"] == "signed", "a signed package holds")
        check(reading["authority"] == envelope.TRUSTED_AUTHORITY, "the envelope names its authority")
        check(reading["key"] == envelope.key_id(key), "the envelope names the machine key")
        check(reading["work"] >= envelope.MIN_WORK, "the envelope carries proof of work")

        tampered = signed.replace("alpha-shell", "alpha-shelo", 1)
        check(refusal_kind(envelope.verify_text(tampered, key)) == "digest-mismatch",
              "one byte changed is refused as a digest mismatch")

        foreign_authority = envelope.sign_text(
            package_text, key, authority="foreign.example", work=envelope.MIN_WORK + 2)
        check(refusal_kind(envelope.verify_text(foreign_authority, key)) == "untrusted-key",
              "a foreign authority is refused as an untrusted key")

        check(refusal_kind(envelope.verify_text(signed, other)) == "untrusted-key",
              "a signature by another key is refused as an untrusted key")
        check(refusal_kind(envelope.verify_text(signed, None)) == "untrusted-key",
              "a check with no key refuses rather than inventing one")

        low_floor = signed.replace(f"\twork\t{envelope.MIN_WORK + 2}",
                                   f"\twork\t{envelope.MIN_WORK - 1}")
        check(refusal_kind(envelope.verify_text(low_floor, key)) == "insufficient-work",
              "a declared work below the floor is insufficient work")

        # A nonce mined for another digest proves too few bits for this one.
        under_mined = signed.replace("\tnonce\t", "\tnonce\t0", 1)
        check(refusal_kind(envelope.verify_text(under_mined, key)) == "insufficient-work",
              "a nonce that proves too few bits is insufficient work")

        unreadable = signed.replace("\tsignature\t", "\tnot-a-signature\t", 1)
        check(refusal_kind(envelope.verify_text(unreadable, key)) == "unreadable-envelope",
              "a missing signature field is an unreadable envelope")

        # Baked headers are unreadable too: a file whose first line is not the package header
        # cannot have a body this build can know.
        broken = signed.replace("\trecord-id\topenlock-envelope", "", 1)
        check(refusal_kind(envelope.verify_text(broken, key)) == "unreadable-envelope",
              "an envelope with no record-id is unreadable")

        moved = envelope.sign_text(package_text, key, work=envelope.MIN_WORK + 2)
        block_end = moved.index("\trecord-id\topenlock-envelope\n") + len("\trecord-id\topenlock-envelope\n")
        block = moved[:block_end]
        rest = moved[block_end:]
        misplaced = rest.split("\n", 1)[0] + "\n" + block + rest.split("\n", 1)[1]
        check(refusal_kind(envelope.verify_text(misplaced, key)) == "unreadable-envelope",
              "an envelope below the first record is unreadable, not a window field")

        # The read-time rule. `read_shell_package` must refuse the surface before its windows
        # enter the shell data, and must leave the other (unsigned) surfaces alone.
        package_dir = temp / "package"
        package_dir.mkdir()
        for name in ("deadlock.windows", "package.cells"):
            shutil.copy(ROOT / "shell" / "alpha-shell" / name, package_dir / name)

        unsigned_dir = temp / "unsigned"
        unsigned_dir.mkdir()
        for name in ("package.shspec", "deadlock.windows", "package.cells"):
            shutil.copy(ROOT / "shell" / "alpha-shell" / name, unsigned_dir / name)
        recipe, envelopes, envelope_refusals, _cells = gen_shell_data.read_shell_package(unsigned_dir)
        ids = {window["id"] for window in recipe["windows"]}
        check("inventory" in ids, "an unsigned package still loads its windows unchanged")
        check(not envelope_refusals, "an unsigned package adds no envelope refusal")
        check([row["state"] for row in envelopes].count("unsigned") == 4,
              "the read path reports unsigned for each unsigned surface")

        (package_dir / "package.shspec").write_text(
            signed.replace("alpha-shell", "alpha-shelo", 1), encoding="utf-8")
        recipe, envelopes, envelope_refusals, _cells = gen_shell_data.read_shell_package(
            package_dir, key)
        ids = {window["id"] for window in recipe["windows"]}
        check("inventory" not in ids, "a tampered package contributes no window to the shell data")
        check(any(window["id"] != "inventory" and window["id"].startswith("game-")
                  for window in recipe["windows"]),
              "the untouched game-window surface still loads")
        check(any(row["file"] == "package.shspec" and row["state"] == "refused"
                  for row in envelopes), "the read path names the refused surface")
        check(any(refusal["file"] == "package.shspec" and
                  "digest-mismatch" in refusal["why"] for refusal in envelope_refusals),
              "the read-time refusal carries the digest-mismatch name, not a paint-time guess")

        (package_dir / "package.shspec").write_text(signed, encoding="utf-8")
        recipe, envelopes, envelope_refusals, _cells = gen_shell_data.read_shell_package(
            package_dir, key)
        ids = {window["id"] for window in recipe["windows"]}
        check("inventory" in ids, "the same package signed with a valid envelope loads")
        check(not envelope_refusals, "a valid envelope adds no refusal")

        rows = envelope.check_surfaces(ROOT)
        check(len(rows) == 4, "all four package surfaces are read")
        check(all(row["state"] in ("unsigned", "signed") for row in rows),
              "no shipped surface carries a refused envelope")
    finally:
        shutil.rmtree(temp, ignore_errors=True)

    print(f"envelope-test OK {CHECKS} checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

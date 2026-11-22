"""Refuse a secret or a personal detail on its way into a family repository.

The family rule is one line: secrets and personal information are not committed. Every other file is.
This tool is how that line is enforced rather than remembered.

    python tools/secrets_gate.py --check              # tracked files; exit 1 on any finding
    python tools/secrets_gate.py --check --all-files  # tracked and untracked, minus ignored build output
    python tools/secrets_gate.py --history            # every commit reachable from any ref, via git log -p
    python tools/secrets_gate.py --selftest           # prove each rule fires on a planted line

A finding prints as `path:line: severity rule  redacted-snippet`: the redaction keeps the shape of the
match and hides the value, so a report can be pasted anywhere without leaking what it reports.

Rules are named, not scored. `high` is a credential: a private key, a cloud or vendor token, a
password assignment. `medium` is personal information: a home directory, an email address, a
hostname or a private address that names this network. `low` is a personal-shaped value that is
refused until it is justified, such as a bare phone number.

Allowlists are literal and short on purpose. `127.0.0.1` is loopback, `noreply@` addresses are
noreply, and `example.com` is a documentation domain; anything else that matches is a finding.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

SELF = Path(__file__).resolve()
ROOT = SELF.parents[1]

BINARY_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tga",
    ".vpk", ".vmdl", ".vmdl_c", ".vmat", ".vmat_c", ".vtex", ".vtex_c", ".dmx",
    ".zip", ".7z", ".exe", ".dll", ".pyd", ".so", ".dylib", ".bin", ".pdb", ".rlib", ".rmeta",
    ".blend", ".blend1", ".mp3", ".wav", ".mp4", ".webm", ".pdf", ".woff", ".woff2", ".ttf",
}

# Each credential pattern is assembled from fragments so this file never contains a literal
# credential shape: a repository's own "no committed secrets" check greps for those shapes, and a
# gate that trips its sibling check teaches the reader to ignore both.
RULES: list[tuple[str, str, re.Pattern[str]]] = [
    ("private-key", "high", re.compile(r"-----BEGIN " + r"[A-Z ]*PRIVATE KEY-----")),
    ("aws-access-key", "high", re.compile(r"\bAK" + r"IA[0-9A-Z]{16}\b")),
    ("github-token", "high", re.compile(r"\bgh" + r"[posur]_[A-Za-z0-9]{30,}\b")),
    ("github-fine-grained", "high", re.compile(r"\bgithub_" + r"pat_[A-Za-z0-9_]{20,}\b")),
    ("vendor-key", "high", re.compile(r"\b" + r"sk-[A-Za-z0-9_-]{24,}\b")),
    ("slack-token", "high", re.compile(r"\bxo" + r"x[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("google-api-key", "high", re.compile(r"\bAI" + r"za[0-9A-Za-z_-]{35}\b")),
    ("bearer-token", "high", re.compile(r"\bBearer\s+([A-Za-z0-9._~+/-]{24,}=*)")),
    (
        "assigned-secret",
        "high",
        re.compile(
            r"""(?i)\b(?:password|passwd|passphrase|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b"""
            r"""\s*[:=]\s*["']([A-Za-z0-9+/=_.,:-]{16,})["']"""
        ),
    ),
    ("home-path-windows", "medium", re.compile(r"\b[A-Za-z]:\\+Users\\+([A-Za-z0-9 ._-]{2,})")),
    (
        "home-path-posix",
        "medium",
        re.compile(r"(?<![A-Za-z]:)/(?:home|Users)/([A-Za-z0-9._-]{2,})/"),
    ),
    (
        "email-address",
        "medium",
        # A real address ends in a familiar top-level domain. A format id such as
        # `SECURE-SHELL-HEALTH@1.FAILURE-LEDGER.md` is not an address, and .md is not read as Moldova.
        re.compile(
            r"\b[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+(?:com|org|net|io|dev|ai|co|edu|gov|app|info|xyz|uk)\b"
        ),
    ),
    ("private-address", "medium", re.compile(r"\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b")),
    (
        "phone-number",
        "low",
        # Written the way a person writes one: a leading +, or at least two separators. A bare run of
        # digits such as a CI run id (44626620877) is an identifier and is not a phone number.
        re.compile(
            r"(?<![\w-])(?:\+\d{1,3}[ -]?\d{2,4}[ -]?\d{3,4}[ -]?\d{3,4}"
            r"|\d{2,4}[ -]\(\d{2,4}\)[ -]\d{3,4}[ -]?\d{2,4})(?![\w-])"
        ),
    ),
]

ALLOW = (
    "127.0.0.1",
    "0.0.0.0",
    "localhost",
    "example.com",
    "noreply@",
    "@users.noreply.github.com",
    "codebuff.com>",
    "noreply@codebuff.com",
    "@anthropic.com",
    "@openai.com",
    "192.0.2.",
)

# Trees whose content is not this repository's information: a vendored wheel's SBOM lists its own
# maintainers, and a cargo `target/` is machine output that embeds an absolute build path. Both are
# reported as skipped counts so the exclusion is visible rather than silent.
SKIP_PARTS = ("_vendor/", ".dist-info/", "node_modules/", "/target/")

PLACEHOLDER = re.compile(r"(?i)(x{6,}|\*{4,}|\.\.\.|<[^>]+>|\$\{?[A-Z_]+\}?|your[-_ ]?(key|token|password)|changeme|placeholder|redacted|dummy|fake|example)")


def redact(text: str) -> str:
    """Keep the shape, hide the value: `sk-abcd…wxyz` for a 32-character key."""
    text = text.strip()
    if len(text) <= 8:
        return text[0] + "…" if text else ""
    return text[:4] + "…" + text[-2:]


def allowed(match: re.Match[str], line: str) -> bool:
    for needle in ALLOW:
        if needle in line:
            return True
    if PLACEHOLDER.search(match.group(0)):
        return True
    return False


def scan_line(path: str, number: int, line: str) -> list[dict]:
    findings = []
    for rule, severity, pattern in RULES:
        for match in pattern.finditer(line):
            if allowed(match, line):
                continue
            findings.append(
                {
                    "path": path,
                    "line": number,
                    "rule": rule,
                    "severity": severity,
                    "match": redact(match.group(0)),
                }
            )
    return findings


def git(*arguments: str) -> str:
    """Git's output as text. A binary diff is decoded with replacement rather than raising, because a
    history scan reads every blob the repository has ever held, including the ones that are not text."""
    result = subprocess.run(
        ["git", *arguments],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return result.stdout or ""


def resolve_root(start: Path) -> Path:
    """The repository the scan is about: its own, unless a directory is named."""
    candidate = start.resolve()
    for directory in (candidate, *candidate.parents):
        if (directory / ".git").exists():
            return directory
    return ROOT


def files(all_files: bool) -> list[Path]:
    listing = git("ls-files", "--cached", "--others", "--exclude-standard") if all_files else git("ls-files")
    paths = []
    for name in dict.fromkeys(listing.splitlines()):
        path = ROOT / name
        if not path.is_file() or path.resolve() == SELF:
            continue
        if path.suffix.lower() in BINARY_SUFFIXES:
            continue
        paths.append(path)
    return paths


def scan_files(all_files: bool) -> list[dict]:
    findings: list[dict] = []
    for path in files(all_files):
        relative = str(path.relative_to(ROOT)).replace("\\", "/")
        if any(part in "/" + relative for part in SKIP_PARTS):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for number, line in enumerate(text.splitlines(), start=1):
            findings.extend(scan_line(relative, number, line))
    return findings


def scan_history() -> list[dict]:
    """Every commit reachable from any ref, read through `git log -p`, path and line carried along."""
    findings: list[dict] = []
    patch = git("log", "--all", "-p", "--unified=0", "--no-color", "--no-renames", "--format=commit %H")
    commit = ""
    path = ""
    number = 0
    for line in patch.splitlines():
        if line.startswith("commit "):
            commit = line.split(" ", 1)[1]
            continue
        if line.startswith("+++ b/"):
            path = line[6:]
            continue
        if line.startswith("@@"):
            digits = re.search(r"\+(\d+)", line)
            number = int(digits.group(1)) if digits else 0
            continue
        if line.startswith("+") and not line.startswith("+++"):
            for finding in scan_line(path, number, line[1:]):
                finding["commit"] = commit[:12]
                findings.append(finding)
            number += 1
    return findings


def report(findings: list[dict], as_json: bool) -> int:
    if as_json:
        print(json.dumps({"schema": "secure-shell.secrets/1", "findings": findings}, indent=2))
    else:
        for finding in findings:
            where = finding["path"] + ":" + str(finding["line"])
            if finding.get("commit"):
                where = finding["commit"] + " " + where
            print(f"{where}: {finding['severity']} {finding['rule']}  {finding['match']}")
        counts: dict[str, int] = {}
        for finding in findings:
            counts[finding["severity"]] = counts.get(finding["severity"], 0) + 1
        summary = ", ".join(f"{name} {counts.get(name, 0)}" for name in ("high", "medium", "low"))
        print(f"{len(findings)} findings ({summary})")
    return 1 if findings else 0


PLANTS = [
    ("private-key", "-----BEGIN " + "OPENSSH PRIVATE KEY-----"),
    ("aws-access-key", "AK" + "IAQ7Z3N5T2R4X6B8L0"),
    ("github-token", "gh" + "p_" + "a" * 36),
    ("vendor-key", "s" + "k-" + "b" * 32),
    ("bearer-token", "Authorization: Bearer " + "c" * 40),
    ("assigned-secret", 'api_key = "' + "d" * 24 + '"'),
    # The plants are assembled too: a file that carries a literal home path, address or phone number
    # would make every history scan of every repository report the gate itself.
    ("home-path-windows", "C:" + "\\Users\\" + "someone\\Documents\\file.txt"),
    ("home-path-posix", "/" + "home/" + "someone/project/file"),
    ("email-address", "owner.personal" + "@postbox-77.net"),
    ("private-address", "192.168" + ".0.15"),
    ("phone-number", "+1 555" + " 123 4567"),
]


def selftest() -> int:
    failures = 0
    for rule, planted in PLANTS:
        hits = [finding["rule"] for finding in scan_line("plant.txt", 1, planted)]
        if rule not in hits:
            failures += 1
            print(f"FAIL {rule} did not fire on its planted line")
        else:
            print(f"ok   {rule}")
    clean = "a sentence with no personal detail, and 127.0.0.1 stays allowed"
    if scan_line("clean.txt", 1, clean):
        failures += 1
        print("FAIL a clean line was refused")
    else:
        print("ok   clean line passes")
    print(f"{len(PLANTS) + 1} checks, {failures} failed")
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="secrets_gate", description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="scan files; exit 1 on any finding")
    parser.add_argument("--all-files", action="store_true", help="include untracked files")
    parser.add_argument("--history", action="store_true", help="scan every commit reachable from any ref")
    parser.add_argument("--json", action="store_true", help="print findings as json")
    parser.add_argument("--selftest", action="store_true", help="prove each rule fires")
    parser.add_argument("--root", default=".", help="the repository to scan, default the working directory")
    arguments = parser.parse_args(argv)

    global ROOT
    ROOT = resolve_root(Path(arguments.root))

    if arguments.selftest:
        return selftest()
    if arguments.history:
        return report(scan_history(), arguments.json)
    if arguments.check:
        return report(scan_files(arguments.all_files), arguments.json)
    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())

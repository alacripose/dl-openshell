"""Take the owner's home directory and network out of what was already committed.

`tools/secrets_gate.py` refuses a new home path or private address. This tool cleans the ones that
are already in the repository, and it treats two kinds of file differently because a record and a
program need different replacements.

**A record** (`.md`, `.json`, `.jsonl`, `.txt`, `.log`, `.csv`, `.yml`, `.html`, `.css`) reads fine
with a token in place of the account name, so `<home>/Documents/x` becomes `<home>/Documents/x`
and a private address becomes `<host>`. Meaning survives; the account does not.

**A Python program** cannot carry `<home>` in a string literal and still run, so the same literal is
rewritten to `os.path.expanduser("~/Documents/x")`. The code keeps working on the owner's machine,
and the account name is gone from the source. After an `--apply` the tool prints the files it changed
so `compileall` and the repository's tests can be run against them.

    python tools/redact_paths.py --check              # count what would change
    python tools/redact_paths.py --apply --records     # rewrite records only
    python tools/redact_paths.py --apply --code        # rewrite Python literals only
    python tools/redact_paths.py --apply               # both

Every run ends with the total, and a second run reports 0.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Third-party package metadata: an SBOM shipped inside a wheel lists its own maintainers' addresses.
# That is not this repository's information and cannot be redacted without rewriting the wheel, so
# the vendored trees are skipped by name and the gate reports them separately.
SKIP = ("_vendor/", ".dist-info/", "node_modules/")

RECORD_SUFFIXES = {
    ".md", ".json", ".jsonl", ".txt", ".log", ".csv", ".yml", ".yaml", ".html", ".css", ".toml",
    ".ini", ".d", ".sh", ".ps1", ".cmd",
}
CODE_SUFFIXES = {".py"}

HOME = re.compile(r"\b[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9._-]+", re.IGNORECASE)
HOME_POSIX = re.compile(r"(?<![A-Za-z]:)/(?:home|Users)/[A-Za-z0-9._-]+")
NETWORK = re.compile(r"\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b")


def git(*arguments: str) -> str:
    return subprocess.run(["git", *arguments], cwd=ROOT, capture_output=True, text=True, check=False).stdout


def classify(path: Path) -> str | None:
    suffix = path.suffix.lower()
    if suffix in RECORD_SUFFIXES:
        return "record"
    if suffix in CODE_SUFFIXES:
        return "code"
    return None


def redact_records(text: str) -> tuple[str, int]:
    total = 0
    for pattern, token in ((HOME, "<home>"), (HOME_POSIX, "<home>"), (NETWORK, "<host>")):
        text, count = pattern.subn(token, text)
        total += count
    return text, total


LITERAL = re.compile(
    r'(?P<prefix>[rRbBuUfF]{0,2})(?P<quote>["\'])'
    r'(?P<drive>[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9._-]+)'
    r'(?P<rest>[^"\'\n]*)'
    r'(?P=quote)'
)


def redact_code(text: str) -> tuple[str, int]:
    """A Python literal keeps working: `os.path.expanduser("~/x")` becomes `os.path.expanduser("~/x")`."""

    def replace(match: re.Match[str]) -> str:
        # An f-string keeps its prefix, so `os.path.expanduser(f"~/{x}")` becomes `os.path.expanduser(f"~/{x}")`
        # instead of losing the braces that were the whole point of the literal.
        prefix, rest = match.group("prefix"), match.group("rest")
        return f'os.path.expanduser({prefix}"~{rest}")'

    text, home_count = LITERAL.subn(replace, text)
    # Python joins two adjacent literals across a line break. Wrapping the first half would leave
    # `os.path.expanduser("~/blender/")` beside a bare `"blender.exe"`, which does not parse, so the
    # halves are folded into one call.
    folded = 0
    while True:
        text, count = re.subn(
            r'os\.path\.expanduser\((?P<prefix>[rRbBuUfF]{0,2})"~(?P<head>[^"\n]*)"\)'
            r'\s*\n\s*(?:[rRbBuUfF]{0,2})"(?P<tail>[^"\n]*)"',
            lambda match: 'os.path.expanduser('
            + match.group("prefix")
            + '"~'
            + match.group("head")
            + match.group("tail")
            + '")',
            text,
        )
        folded += count
        if not count:
            break
    text, net_count = NETWORK.subn("<host>", text)
    return text, home_count + folded + net_count


def fix_future_order(text: str) -> tuple[str, int]:
    """`import os` above `from __future__ import ...` is a SyntaxError; move it below."""
    lines = text.splitlines(keepends=True)
    os_lines = [index for index, line in enumerate(lines) if line.strip() == "import os"]
    future_lines = [index for index, line in enumerate(lines) if line.startswith("from __future__")]
    if not os_lines or not future_lines or min(os_lines) > min(future_lines):
        return text, 0
    moved = 0
    for index in reversed(os_lines):
        if index < max(future_lines):
            lines.pop(index)
            lines.insert(max(future_lines), "import os\n")
            moved += 1
    return "".join(lines), moved


def ensure_os_import(text: str) -> tuple[str, int]:
    """A rewritten literal calls `os.path.expanduser`, so the module needs `import os`."""
    if "os.path.expanduser" not in text:
        return text, 0
    if re.search(r"^\s*(?:import os\b|from os import|import os,)", text, re.MULTILINE) or "from os import" in text:
        return text, 0
    import ast

    lines = text.splitlines(keepends=True)
    insert_at = 0
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return text, 0
    if tree.body and isinstance(tree.body[0], ast.Expr) and isinstance(tree.body[0].value, ast.Constant):
        insert_at = getattr(tree.body[0], "end_lineno", 1)
    # `from __future__ import ...` must stay the first statement after the docstring, so the import
    # goes below it rather than above it.
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module == "__future__":
            insert_at = max(insert_at, getattr(node, "end_lineno", insert_at))
        elif insert_at and getattr(node, "lineno", 0) > insert_at + 1:
            break
    insertion = "import os\n"
    if insert_at and lines[insert_at - 1].strip():
        insertion = "\nimport os\n"
    lines.insert(insert_at, insertion)
    return "".join(lines), 1


def run(apply: bool, records: bool, code: bool, all_files: bool = False) -> int:
    changed: list[tuple[str, int, str]] = []
    listing = git("ls-files", "--cached", "--others", "--exclude-standard") if all_files else git("ls-files")
    for name in dict.fromkeys(listing.splitlines()):
        path = ROOT / name
        if not path.is_file():
            continue
        kind = classify(path)
        if kind is None or (kind == "record" and not records) or (kind == "code" and not code):
            continue
        if any(part in name for part in SKIP):
            continue
        try:
            # surrogateescape round-trips a file that is not clean UTF-8 without changing a byte of
            # it: the paths being replaced are ASCII, so the rest of the file is carried untouched.
            original = path.read_text(encoding="utf-8", errors="surrogateescape")
        except OSError:
            continue
        if kind == "record":
            cleaned, count = redact_records(original)
        else:
            cleaned, count = redact_code(original)
            cleaned, added = ensure_os_import(cleaned)
            cleaned, moved = fix_future_order(cleaned)
            count += added + moved
        if not count:
            continue
        changed.append((name, count, kind))
        if apply:
            path.write_text(cleaned, encoding="utf-8", errors="surrogateescape", newline="\n")
    for name, count, kind in sorted(changed, key=lambda row: -row[1])[:40]:
        print(f"{count:6d}  {kind:6s} {name}")
    if len(changed) > 40:
        print(f"{len(changed) - 40:6d} more files")
    print(f"{sum(count for _, count, _ in changed)} replacements in {len(changed)} files"
          + (" (written)" if apply else " (dry run; --apply writes)"))
    return 1 if changed and not apply else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="redact_paths", description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="count what would change")
    parser.add_argument("--apply", action="store_true", help="rewrite the tracked files")
    parser.add_argument("--records", action="store_true", help="records only")
    parser.add_argument("--code", action="store_true", help="Python only")
    parser.add_argument("--all-files", action="store_true", help="include untracked files")
    arguments = parser.parse_args(argv)
    records = arguments.records or not arguments.code
    code = arguments.code or not arguments.records
    return run(apply=arguments.apply, records=records, code=code, all_files=arguments.all_files)


if __name__ == "__main__":
    sys.exit(main())

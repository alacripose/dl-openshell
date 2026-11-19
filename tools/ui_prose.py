"""Stop-slop and declauding checks for the strings a player reads in the shell.

The family writing rules come from two skills, `stop-slop` and `declauding`, and from the
owner's standing instruction that UI prose is checked rather than admired. Their shared bans,
applied to Panorama string literals: em-dash drama, filler openers, intensifier adverbs,
"not just X" staging, and the stock marketing words. This reads the JavaScript with a small
literal scanner, so comments and identifiers do not count and every hit carries the line the
player would see.

    python tools/ui_prose.py             # list hits
    python tools/ui_prose.py --check     # exit 1 when any hit remains
    python tools/ui_prose.py --json      # machine-readable hits
    python tools/ui_prose.py --glob "*.js"   # widen the scan inside the checked directory

A path, a symbol or a one-word label is skipped: the rules are about sentences. The default
scope is the three scripts this rework owns, because a blanket sweep over the whole shell would
report prose that predates the gate and is not this change's to rewrite.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "clientaddon" / "panorama" / "scripts"
DEFAULT_FILES = ("openlock_popit.js", "openlock_pairs.js", "openlock_shell.js")

WORDS = (
    "seamless",
    "robust",
    "powerful",
    "effortless",
    "leverage",
    "utilize",
    "delve",
    "elevate",
    "unlock",
    "unleash",
    "streamline",
    "cutting-edge",
    "game-changer",
    "revolutionary",
    "holistic",
    "synergy",
    "best-in-class",
    "world-class",
    "state-of-the-art",
    "simply",
    "very",
    "really",
    "actually",
    "basically",
    "literally",
    "extremely",
    "highly",
    "truly",
    "quickly",
    "easily",
)
PHRASES = (
    "in order to",
    "it is worth noting",
    "it's worth noting",
    "note that",
    "please note",
    "needless to say",
    "at the end of the day",
    "not just",
    "isn't just",
    "is not just",
    "not only",
    "more than just",
    "little more than",
)
WORDS_RE = re.compile(r"\b(" + "|".join(re.escape(word) for word in WORDS) + r")\b", re.I)
PHRASES_RE = re.compile("|".join(re.escape(phrase) for phrase in PHRASES), re.I)
DASH_RE = re.compile("[\u2014\u2013]")
SENTENCE_RE = re.compile(r"[A-Za-z]{2,}\s+[A-Za-z]")

# A JavaScript string literal: '...', "...", or `...`, with backslash escapes honoured.
LITERAL = re.compile(r"(?<![\\w$.])(?:'((?:[^'\\\\\\n]|\\\\.)*)'|\"((?:[^\"\\\\\\n]|\\\\.)*)\"|`([^`]*)`)")


def _sentences(path: Path):
    text = path.read_text(encoding="utf-8", errors="replace")
    for number, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith(("//", "/*", "*")):
            continue
        for match in LITERAL.finditer(line):
            value = next(group for group in match.groups() if group is not None)
            if len(value) < 8 or not SENTENCE_RE.search(value):
                continue
            if "/" in value or "\\\\" in value:
                continue
            yield number, value.replace("\\\\n", " ").strip()


def scan(paths: list[Path]) -> list[dict]:
    hits: list[dict] = []
    for path in paths:
        for line, text in _sentences(path):
            if DASH_RE.search(text):
                hits.append({"file": path.name, "line": line, "rule": "em-dash", "text": text.strip()})
            for match in PHRASES_RE.finditer(text):
                hits.append({"file": path.name, "line": line, "rule": f"phrase: {match.group(0).lower()}", "text": text.strip()})
            for match in WORDS_RE.finditer(text):
                hits.append({"file": path.name, "line": line, "rule": f"word: {match.group(0).lower()}", "text": text.strip()})
    return hits


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="exit 1 when a hit remains")
    parser.add_argument("--json", action="store_true", help="print hits as JSON")
    parser.add_argument("--glob", default="", help="scan every match in the scripts directory instead")
    args = parser.parse_args(argv)

    if args.glob:
        paths = sorted(SCRIPTS.glob(args.glob))
    else:
        paths = [SCRIPTS / name for name in DEFAULT_FILES]
    hits = scan([path for path in paths if path.is_file()])

    if args.json:
        print(json.dumps(hits, indent=2))
    else:
        for hit in hits:
            print(f"{hit['file']}:{hit['line']} [{hit['rule']}] {hit['text']}")
        print(f"prose: {len(hits)} hit(s) in {len(paths)} file(s)")
    if args.check and hits:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

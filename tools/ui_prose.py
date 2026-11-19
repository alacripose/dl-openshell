"""Stop-slop, declauding and the two-second budget for strings a player reads in the shell.

The family writing rules come from two skills, `stop-slop` and `declauding`, and from the owner's
standing instruction that UI prose is checked rather than admired. Their shared bans, applied to
Panorama string literals: em-dash drama, filler openers, intensifier adverbs, "not just X"
staging, and the stock marketing words.

The budget half is Brass Meridian's two-second rule (`F:/Documents/brass-meridian/docs/PROSE.md`,
`tools/prose.mjs`): one sentence carries one idea, at most 24 words; a UI string is at most 18
words and 92 characters; filler words are banned. This shell reads that rule over the Panorama
strings this rework owns. Long-form docs are **not** under the budget yet: `--docs` reviews them
and names every over-budget paragraph without failing, because the existing prose predates the
rule and a rewrite is its own pass.

    python tools/ui_prose.py             # list hits
    python tools/ui_prose.py --check     # exit 1 when any hit remains
    python tools/ui_prose.py --json      # machine-readable hits
    python tools/ui_prose.py --docs      # also report doc paragraphs over 24 words / 3 sentences
    python tools/ui_prose.py --selftest  # planted over-budget strings must be refused
    python tools/ui_prose.py --glob "*.js"   # widen the scan inside the checked directory

A path, a symbol or a one-word label is skipped: the rules are about sentences. The default scope
is the three scripts this rework owns, because a blanket sweep over the whole shell would report
prose that predates the gate and is not this change's to rewrite.
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
DOCS = ("docs/UI-PASS.md", "README.md")

# Brass Meridian's two-second rule.
MAX_SENTENCE_WORDS = 24
MAX_UI_WORDS = 18
MAX_UI_CHARS = 92

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
    "game-changing",
    "revolutionary",
    "revolutionize",
    "holistic",
    "synergy",
    "empower",
    "tapestry",
    "myriad",
    "plethora",
    "paradigm",
    "meticulous",
    "facilitate",
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
DASH_RE = re.compile("[—–]")
SENTENCE_RE = re.compile(r"[A-Za-z]{2,}\s+[A-Za-z]")
WORD_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9'’/.:%+-]*")
SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


def _literals(line: str) -> list[str]:
    """Every quoted string on one line, read with an explicit scanner.

    A regex for JavaScript literals needs three layers of escaping; a scanner has none, and it
    cannot silently stop matching. A backslash escapes the next character, a quote ends the run,
    and an unterminated quote (a multi-line template) is skipped.
    """
    values: list[str] = []
    index = 0
    length = len(line)
    while index < length:
        quote = line[index]
        if quote not in "'\"`":
            index += 1
            continue
        index += 1
        buffer: list[str] = []
        closed = False
        while index < length:
            char = line[index]
            if char == "\\" and index + 1 < length:
                buffer.append(line[index : index + 2])
                index += 2
                continue
            if char == quote:
                closed = True
                index += 1
                break
            buffer.append(char)
            index += 1
        if not closed:
            break
        values.append("".join(buffer))
    return values


def _sentences(path: Path):
    text = path.read_text(encoding="utf-8", errors="replace")
    for number, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith(("//", "/*", "*")):
            continue
        for value in _literals(line):
            if len(value) < 8 or not SENTENCE_RE.search(value):
                continue
            if "/" in value or "\\" in value:
                continue
            yield number, value.replace("\\n", " ").strip()


def _count_words(text: str) -> int:
    return len(WORD_RE.findall(text))


def _sentences_of(text: str) -> list[str]:
    return [part.strip() for part in SENTENCE_SPLIT.split(text) if _count_words(part) > 0]


def scan(paths: list[Path]) -> list[dict]:
    hits: list[dict] = []
    for path in paths:
        for line, text in _sentences(path):
            words = _count_words(text)
            if words > MAX_UI_WORDS or len(text) > MAX_UI_CHARS:
                hits.append({
                    "file": path.name, "line": line,
                    "rule": f"ui-budget: {words} words / {len(text)} chars", "text": text.strip()
                })
            for sentence in _sentences_of(text):
                count = _count_words(sentence)
                if count > MAX_SENTENCE_WORDS:
                    hits.append({
                        "file": path.name, "line": line,
                        "rule": f"sentence-budget: {count} words", "text": sentence.strip()
                    })
            if DASH_RE.search(text):
                hits.append({"file": path.name, "line": line, "rule": "em-dash", "text": text.strip()})
            for match in PHRASES_RE.finditer(text):
                hits.append({
                    "file": path.name, "line": line,
                    "rule": f"phrase: {match.group(0).lower()}", "text": text.strip()
                })
            for match in WORDS_RE.finditer(text):
                hits.append({
                    "file": path.name, "line": line,
                    "rule": f"word: {match.group(0).lower()}", "text": text.strip()
                })
    return hits


def review_docs(paths, root: Path) -> list[dict]:
    """Report doc paragraphs over the budget. This is a report, not a failing gate yet."""
    hits: list[dict] = []
    for relative in paths:
        path = root / relative
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for raw in re.split(r"\n\s*\n", text):
            block = raw.strip()
            if not block or re.match(r"^(#|\||[-*+]\s|>\s|\d+\.\s|<|\[!|<!--)", block):
                continue
            sentences = _sentences_of(block)
            if len(sentences) > 3:
                hits.append({
                    "file": relative, "line": 0,
                    "rule": f"paragraph: {len(sentences)} sentences", "text": block[:90]
                })
            for sentence in sentences:
                count = _count_words(sentence)
                if count > MAX_SENTENCE_WORDS:
                    hits.append({
                        "file": relative, "line": 0,
                        "rule": f"sentence: {count} words", "text": sentence[:90]
                    })
    return hits


def selftest() -> int:
    import tempfile

    global SCRIPTS
    saved = SCRIPTS
    checks = 0
    try:
        with tempfile.TemporaryDirectory() as tmp:
            SCRIPTS = Path(tmp)
            sample = SCRIPTS / "sample.js"
            sample.write_text(
                'const a = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen";\n'
                'const b = "The quick brown fox jumps over the lazy dog and then it keeps running past the fence and the gate and the road and the hill.";\n'
                'const c = "Pick a pair. Back closes the child.";\n',
                encoding="utf-8"
            )
            rules = [hit["rule"] for hit in scan([sample])]
            if not any(rule.startswith("ui-budget") for rule in rules):
                raise SystemExit("selftest FAILED: a 19-word UI string was not refused")
            checks += 1
            if not any(rule.startswith("sentence-budget") for rule in rules):
                raise SystemExit("selftest FAILED: a 25-word sentence was not refused")
            checks += 1
            clean = SCRIPTS / "clean.js"
            clean.write_text('const d = "Pick a pair. Back closes the child.";\n', encoding="utf-8")
            if scan([clean]):
                raise SystemExit("selftest FAILED: a clean string was refused")
            checks += 1
    finally:
        SCRIPTS = saved
    print(f"ui-prose selftest OK {checks} checks")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="exit 1 when a hit remains")
    parser.add_argument("--json", action="store_true", help="print hits as JSON")
    parser.add_argument("--docs", action="store_true", help="also report doc paragraphs over the budget")
    parser.add_argument("--selftest", action="store_true", help="planted over-budget strings must be refused")
    parser.add_argument("--glob", default="", help="scan every match in the scripts directory instead")
    args = parser.parse_args(argv)

    if args.selftest:
        return selftest()

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
    if args.docs:
        doc_hits = review_docs(DOCS, ROOT)
        for hit in doc_hits:
            print(f"doc-report {hit['file']} [{hit['rule']}] {hit['text']}")
        print(f"docs: {len(doc_hits)} over-budget report(s); "
              "long-form docs are not under the gate yet")
    if args.check and hits:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

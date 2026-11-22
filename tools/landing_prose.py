#!/usr/bin/env python3
"""Read the landing page's own prose with the family checkers before it is published.

`landing/index.html` is a hand-written page, so its sentences were never read by the tools that
refuse bad copy everywhere else in the family. This is that read: every visible sentence is taken
out of the page in order, measured against the family budget, and passed to
`deadlock-model-forge/tools/ui_prose.py` and `brass-meridian/tools/prose.mjs`, which are the two
checkers the Debian machine runs when a family landing page is updated.

What is refused, by name:

* `landing-prose-budget`: a sentence over the family's 24 words.
* `landing-prose-refused`: a rule the family checkers name (an em-dash, a banned word, a banned
  phrase), or a page whose prose could not be read at all.
* `landing-prose-drift`: the page's prose is not the prose that was sealed.

The sentences and the digest of the tools that approved them are sealed in `landing/prose.json`, so
`--check` needs no checker on disk and a later sentence edit fails until the page is read again.

    python tools/landing_prose.py            # read the page, seal landing/prose.json
    python tools/landing_prose.py --check    # exit 1 when the page's prose is not the sealed prose
    python tools/landing_prose.py --selftest # prove a banned sentence is refused
"""
from __future__ import annotations

import os

import hashlib
import html
import importlib.util
import json
import re
import subprocess
import sys
import tempfile
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "landing" / "index.html"
SEAL = ROOT / "landing" / "prose.json"

PROSE_TOOLS = (
    Path(os.path.expanduser("~/Documents/deadlock-model-forge/tools/ui_prose.py")),
    Path("F:/Documents/portal-shell/tools/ui_prose.py"),
)
PROSE_MJS = Path("F:/Documents/brass-meridian/tools/prose.mjs")

MAX_SENTENCE_WORDS = 24
SENTENCE_RE = re.compile(r"[A-Za-z]")
SPLIT_RE = re.compile(r"(?<=[.!?])\s+")

# The blocks a reader reads as prose. A label, a code sample or a drawn table cell is not one.
PROSE_TAGS = {"p", "li", "h1", "h2", "h3", "h4", "figcaption", "th", "td", "button", "a", "em"}
SKIP_TAGS = {"script", "style", "svg", "pre", "code", "kbd", "samp"}


class _Prose(HTMLParser):
    """Collect the text of each prose block, in page order."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[list[str]] = []
        self.stack: list[str] = []
        self.open: list[str] | None = None

    def handle_starttag(self, tag: str, attrs) -> None:
        head, _, _ = tag.partition(".")
        self.stack.append(head)
        if head in PROSE_TAGS and self.open is None and not SKIP_TAGS.intersection(self.stack):
            self.open = []

    def handle_endtag(self, tag: str) -> None:
        head = tag.partition(".")[0]
        if head in self.stack:
            while self.stack and self.stack.pop() != head:
                pass
        if self.open is not None and (head in PROSE_TAGS or not PROSE_TAGS.intersection(self.stack)):
            text = " ".join(" ".join(self.open).split())
            if text:
                self.blocks.append([text])
            self.open = None

    def handle_data(self, data: str) -> None:
        # A label inside <code>, a sample inside <pre> and a drawing are not prose.
        if self.open is not None and not SKIP_TAGS.intersection(self.stack):
            self.open.append(data)


def visible_sentences(page: Path) -> list[str]:
    """Every sentence a reader sees, in page order, without code or drawings."""
    reader = _Prose()
    reader.feed(page.read_text(encoding="utf-8"))
    sentences: list[str] = []
    for (block,) in reader.blocks:
        for sentence in SPLIT_RE.split(html.unescape(block)):
            sentence = " ".join(sentence.split())
            if sentence and SENTENCE_RE.search(sentence) and len(sentence.split()) > 1:
                sentences.append(sentence)
    return sentences


def digest(texts: list[str]) -> str:
    return hashlib.sha256("\n".join(texts).encode("utf-8")).hexdigest()


def tool_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16] if path.exists() else ""


def budget(sentences: list[str]) -> list[str]:
    return [f"{len(s.split())} words: {s[:72]}" for s in sentences if len(s.split()) > MAX_SENTENCE_WORDS]


def ui_prose_hits(sentences: list[str]) -> tuple[list[dict], str]:
    """The family's ban rules, read from ui_prose itself.

    `scan()` is the addon's reader for drawn Panorama strings: it applies the UI punctuation rule,
    where a drawn label may not end in a period. A paragraph on a web page is not a drawn label, so
    this reads the rule set the same module exports (`_bans`) instead of planting the page as
    `hint()` calls and earning a refusal for every paragraph that ends in a sentence.
    """
    tool = next((path for path in PROSE_TOOLS if path.exists()), None)
    if tool is None:
        return [], "missing"
    spec = importlib.util.spec_from_file_location("family_ui_prose", tool)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    rules = getattr(module, "_bans", None)
    if rules is None:
        return [{"rule": "landing-prose-unread", "text": "ui_prose has no rule set"}], str(tool)
    hits: list[dict] = []
    for sentence in sentences:
        for rule in rules(sentence):
            hits.append({"rule": rule, "text": sentence})
    return hits, str(tool)


def mjs_issues(sentences: list[str]) -> list[dict]:
    """prose.mjs's own verdicts, one per sentence, not one blob."""
    if not PROSE_MJS.exists():
        return []
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "copy.md"
        path.write_text("\n\n".join(sentences), encoding="utf-8")
        script = (
            f'import {{ reviewProse }} from {json.dumps(PROSE_MJS.as_uri())};'
            'import { readFileSync } from "node:fs";'
            f'const issues = reviewProse(readFileSync({json.dumps(str(path).replace(chr(92), "/"))}, "utf8"));'
            'console.log(JSON.stringify(issues));'
        )
        run = subprocess.run(["node", "--input-type=module", "-e", script],
                             capture_output=True, text=True, check=False)
    try:
        issues = json.loads(run.stdout or "[]")
    except json.JSONDecodeError:
        return [{"rule": "prose.mjs", "detail": run.stderr.strip()[:200], "text": ""}]
    return [{"rule": f"prose.mjs:{issue.get('kind', 'sentence')}",
             "detail": str(issue.get("detail", "")),
             "text": str(issue.get("text", ""))} for issue in issues]


def read_page() -> tuple[list[str], list[dict]]:
    """Return the page's sentences and every refusal the family checkers make of them.

    The refusal is the record. This tool does not write the page: a sentence the family tools
    refuse is named, kept beside the sentence that earned it, and published on the page's own
    evidence surface. Rewriting the owner's copy to make a checker quiet is not a fix.
    """
    sentences = visible_sentences(PAGE)
    if not sentences:
        return [], [{"rule": "landing-prose-unread", "detail": "no sentence was read", "text": ""}]
    refusals: list[dict] = []
    for line in budget(sentences):
        refusals.append({"rule": "budget", "detail": "over 24 words", "text": line.split(": ", 1)[-1]})
    hits, tool = ui_prose_hits(sentences)
    if tool == "missing" and not PROSE_MJS.exists():
        return sentences, [{"rule": "landing-prose-missing", "detail": tool, "text": "no family checker on disk"}]
    for hit in hits:
        refusals.append({"rule": hit.get("rule", "ui-prose"), "detail": "ui_prose", "text": hit.get("text", "")})
    refusals.extend(mjs_issues(sentences))
    # The same sentence is planted as a literal and as a visible hint, so a rule arrives twice.
    unique: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for refusal in refusals:
        key = (refusal["rule"], refusal["text"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(refusal)
    return sentences, unique


def seal() -> dict:
    sentences, refusals = read_page()
    record = {
        "schema": "openlock.landing-prose/2",
        "page": "landing/index.html",
        "sentences": len(sentences),
        "words": sum(len(s.split()) for s in sentences),
        "longest": max((len(s.split()) for s in sentences), default=0),
        "digest": digest(sentences),
        "checkers": {
            "ui_prose": next((tool_digest(p) for p in PROSE_TOOLS if p.exists()), ""),
            "prose_mjs": tool_digest(PROSE_MJS),
        },
        "refusals": refusals,
    }
    SEAL.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    print(f"read {record['sentences']} sentences, {record['words']} words, "
          f"longest {record['longest']}, {len(refusals)} refusals, digest {record['digest'][:12]}")
    for refusal in refusals[:8]:
        print(f"  refused {refusal['rule']}: {refusal['text'][:80]}")
    return record


def check() -> int:
    if not SEAL.exists():
        print("[FAIL] landing-prose-unsealed: landing/prose.json is missing, run tools/landing_prose.py")
        return 1
    record = json.loads(SEAL.read_text(encoding="utf-8"))
    sentences = visible_sentences(PAGE)
    current = digest(sentences)
    if current != record.get("digest"):
        print(f"[FAIL] landing-prose-drift: the page is {current[:12]}, the seal is "
              f"{str(record.get('digest'))[:12]}")
        return 1
    print(f"landing prose is the sealed prose ({record['sentences']} sentences, "
          f"longest {record['longest']} words, read by ui_prose and prose.mjs)")
    return 0


def selftest() -> int:
    """A banned sentence must be refused by the same path the page takes."""
    planted = PAGE.with_name("index.selftest.html")
    planted.write_text(PAGE.read_text(encoding="utf-8").replace(
        "</main>", "<p>A seamless, robust and cutting edge shell.</p></main>"), encoding="utf-8")
    try:
        sentences = visible_sentences(planted)
        hits, tool = ui_prose_hits(sentences)
        refused = [hit for hit in hits if "seamless" in hit["text"].lower() or "robust" in hit["text"].lower()]
        if tool == "missing" or not refused:
            print("[FAIL] landing-prose-selftest: the planted sentence was not refused")
            return 1
        print(f"[ok] the planted sentence is refused ({refused[0]['rule']})")
        return 0
    finally:
        planted.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    # A refused sentence carries the page's own punctuation; the console must not drop it.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = sys.argv[1:] if argv is None else argv
    if "--check" in args:
        return check()
    if "--selftest" in args:
        return selftest()
    seal()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

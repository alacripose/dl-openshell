#!/usr/bin/env python3
"""Optional package envelopes: a signed package is checked before any of its records are used.

This is the axis package-security slice, not a second package format. The vocabulary is the axis
crates' vocabulary:

* a **signed** package carries an ``envelope`` record over the bytes after it;
* an **unsigned** package carries no envelope and loads unchanged — openlock's opt-in split;
* a **refused** package declares an envelope that does not hold, and its records never reach the
  shell data.

The refusals are the axis ones, named for the fact:

============================  ==========================================================
refusal                       fact
============================  ==========================================================
``unreadable-envelope``       the block cannot be parsed, or names an algorithm this build
                              does not implement (``UnknownSignatureAlgorithm``)
``digest-mismatch``           the body hashes to something other than the recorded digest
                              (``DigestMismatch``)
``untrusted-key``             the authority is missing or foreign, or this machine holds no
                              key under the named identity (``UntrustedKey``)
``insufficient-work``         the nonce does not carry the declared leading zero bits, or the
                              declared work is below this build's floor
``signature-invalid``         the signature names the right key and is not over these bytes
                              (``SignatureInvalid``)
============================  ==========================================================

The signature is HMAC-SHA256, the one algorithm this build implements (axis ``HMAC_SHA256 = 1``).
The key is machine-local, kept outside the checkout, and never created by a check: verifying a
package this machine cannot key refuses it as ``untrusted-key`` rather than inventing a key.

Envelope record, written directly after the file's first line::

    envelope	openlock.envelope/1
    	digest	sha256:<64 lowercase hex of the body>
    	authority	openlock.dev
    	work	16
    	nonce	<decimal>
    	algorithm	1
    	key	sha256:<64 lowercase hex>
    	signature	<128 lowercase hex>
    	record-id	openlock-envelope

``body`` is the file's lines with the envelope block removed, joined by ``\\n``. The work and the
signature cover ``digest\\nauthority\\nwork\\nnonce``: the proof of work attests the body's identity
plus the authority, and the signature covers that same statement, so a nonce mined for another
digest does not transfer.

Run::

    python tools/package_envelope.py --check
    python tools/package_envelope.py --sign shell/alpha-shell/package.shspec --work 16
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import os
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FORMAT = "openlock.envelope/1"
RECORD_ID = "openlock-envelope"
ALGORITHM = 1
MIN_WORK = 12
MAX_WORK = 32
KEY_BYTES = 32
TRUSTED_AUTHORITY = "openlock.dev"

SURFACES = (
    "shell/alpha-shell/package.shspec",
    "shell/alpha-shell/deadlock.windows",
    "shell/alpha-shell/package.cells",
    "patches/openlock.baselines.shspec",
)


def key_path() -> Path | None:
    """Where this machine keeps its key: per-user data, never inside the checkout."""
    explicit = os.environ.get("OPENLOCK_SIGNING_KEY", "").strip()
    if explicit:
        return Path(explicit)
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA", "").strip()
        if not base:
            return None
        return Path(base) / "openlock" / "signing.key"
    base = os.environ.get("XDG_DATA_HOME", "").strip()
    if base:
        return Path(base) / "openlock" / "signing.key"
    home = os.environ.get("HOME", "").strip()
    return Path(home) / ".local" / "share" / "openlock" / "signing.key" if home else None


def key_id(key: bytes) -> str:
    return "sha256:" + hashlib.sha256(key).hexdigest()


def load_key(path: Path | str | None = None, create: bool = False) -> bytes | None:
    """Read the machine key, refusing a path inside the checkout.

    A key in the repository is in every clone, so it names no one (axis ``Security::open``). A
    check never creates a key: a package this machine cannot key is refused, not quietly trusted.
    """
    target = Path(path) if path is not None else key_path()
    if target is None:
        return None
    try:
        resolved = target.resolve()
        resolved.relative_to(ROOT)
    except ValueError:
        pass
    else:
        return None
    if not target.is_file():
        if not create:
            return None
        target.parent.mkdir(parents=True, exist_ok=True)
        text = secrets.token_hex(KEY_BYTES) + "\n"
        try:
            with target.open("x", encoding="utf-8") as handle:
                handle.write(text)
        except FileExistsError:
            pass
    try:
        text = target.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return None
    if len(text) != KEY_BYTES * 2 or any(character not in "0123456789abcdef" for character in text):
        return None
    return bytes.fromhex(text)


def normalize(text: str) -> list[str]:
    return text.replace("\r\n", "\n").replace("\r", "\n").split("\n")


def envelope_block(lines: list[str]) -> tuple[int, int, dict[str, str]] | None:
    """(start, end, fields) of the envelope block, or None when there is none.

    ``end`` is exclusive. A block that starts and never closes is reported with ``end == -1`` so
    the caller can refuse it as unreadable rather than treat the rest of the file as its body.
    """
    start = -1
    for index, raw in enumerate(lines):
        if raw.split("\t", 1)[0] == "envelope":
            start = index
            break
    if start < 0:
        return None
    fields: dict[str, str] = {}
    for index in range(start + 1, len(lines)):
        raw = lines[index]
        if not raw.startswith("\t"):
            return start, -1, fields
        parts = raw.lstrip("\t").split("\t")
        if len(parts) < 2:
            continue
        fields[parts[0]] = parts[1]
        if parts[0] == "record-id":
            return start, index + 1, fields
    return start, -1, fields


def body_of(lines: list[str], start: int, end: int) -> str:
    return "\n".join(lines[:start] + lines[end:])


def leading_zero_bits(digest: bytes) -> int:
    bits = 0
    for byte in digest:
        if byte == 0:
            bits += 8
            continue
        bits += 8 - byte.bit_length()
        break
    return bits


def work_payload(digest: str, authority: str, work: int, nonce: str) -> bytes:
    return f"{digest}\n{authority}\n{work}\n{nonce}".encode("utf-8")


def body_digest(body: str) -> str:
    return "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()


def verdict(state: str, **fields) -> dict:
    return {
        "format": FORMAT,
        "state": state,
        "authority": "",
        "key": "",
        "work": 0,
        "nonce": "",
        "digest": "",
        "line": 1,
        "refusals": [],
        **fields,
    }


def refuse(kind: str, detail: str, line: int = 1, **fields) -> dict:
    record = verdict("refused", line=line, **fields)
    record["refusals"] = [{"kind": kind, "detail": detail, "line": line}]
    return record


def verify_text(text: str, key: bytes | None = None) -> dict:
    lines = normalize(text)
    found = envelope_block(lines)
    if found is None:
        return verdict("unsigned")
    start, end, fields = found
    line = start + 1
    if end < 0:
        return refuse(
            "unreadable-envelope",
            "the envelope record starts and never closes with a record-id; the body it would "
            "cover cannot be known",
            line,
        )
    if start != 1:
        return refuse(
            "unreadable-envelope",
            "the envelope is not the record directly after the first line; the package readers "
            "attach indented fields to the record above them, so a later envelope would edit a "
            "window",
            line,
        )
    declared_format = lines[start].split("\t")
    if len(declared_format) < 2 or declared_format[1] != FORMAT:
        return refuse(
            "unreadable-envelope",
            f"the envelope names format '{declared_format[1] if len(declared_format) > 1 else ''}' "
            f"and this build reads {FORMAT}",
            line,
        )

    required = ("digest", "authority", "work", "nonce", "algorithm", "key", "signature")
    missing = [name for name in required if not fields.get(name)]
    if missing:
        return refuse(
            "unreadable-envelope",
            "the envelope is missing " + ", ".join(missing) + "; an incomplete envelope is not a "
            "weaker one, it is unreadable",
            line,
        )
    if fields.get("record-id") != RECORD_ID:
        return refuse(
            "unreadable-envelope",
            f"the envelope closes with record-id '{fields.get('record-id', '')}' and not {RECORD_ID}",
            line,
        )

    digest = fields["digest"]
    authority = fields["authority"]
    key_text = fields["key"]
    nonce = fields["nonce"]
    signature = fields["signature"]
    try:
        algorithm = int(fields["algorithm"])
        work = int(fields["work"])
    except ValueError:
        return refuse(
            "unreadable-envelope",
            "the envelope's algorithm or work is not an integer",
            line,
            authority=authority,
            key=key_text,
            digest=digest,
        )
    if algorithm != ALGORITHM:
        return refuse(
            "unreadable-envelope",
            f"the envelope names algorithm {algorithm} and this build implements {ALGORITHM}; "
            "the bytes were not checked, so nothing is known about them",
            line,
            authority=authority,
            key=key_text,
            digest=digest,
        )
    if not nonce.isdigit():
        return refuse(
            "unreadable-envelope",
            f"the nonce '{nonce}' is not a decimal number",
            line,
            authority=authority,
            key=key_text,
            digest=digest,
        )
    if not (digest.startswith("sha256:") and len(digest) == 71):
        return refuse(
            "unreadable-envelope",
            f"the digest '{digest}' is not sha256:<64 lowercase hex>",
            line,
            authority=authority,
            key=key_text,
        )
    if not (key_text.startswith("sha256:") and len(key_text) == 71):
        return refuse(
            "unreadable-envelope",
            f"the key '{key_text}' is not sha256:<64 lowercase hex>",
            line,
            authority=authority,
            digest=digest,
        )

    body = body_of(lines, start, end)
    found_digest = body_digest(body)
    if found_digest != digest:
        return refuse(
            "digest-mismatch",
            f"the envelope records {digest} and the body hashes to {found_digest}",
            line,
            authority=authority,
            key=key_text,
            digest=digest,
        )

    if not authority:
        return refuse("untrusted-key", "the envelope names no authority", line, digest=digest)
    if authority != TRUSTED_AUTHORITY:
        return refuse(
            "untrusted-key",
            f"the envelope is signed by authority '{authority}' and this build trusts "
            f"'{TRUSTED_AUTHORITY}'; a valid signature by a foreign authority is not this "
            "verifier's to accept",
            line,
            authority=authority,
            key=key_text,
            digest=digest,
        )
    if key is None:
        return refuse(
            "untrusted-key",
            f"no signing key is held on this machine for authority '{authority}', so {key_text} "
            "cannot be checked. A check never creates a key",
            line,
            authority=authority,
            key=key_text,
            digest=digest,
        )
    if key_text != key_id(key):
        return refuse(
            "untrusted-key",
            f"the envelope names key {key_text} and this machine holds {key_id(key)}",
            line,
            authority=authority,
            key=key_text,
            digest=digest,
        )

    if work < MIN_WORK or work > MAX_WORK:
        return refuse(
            "insufficient-work",
            f"the envelope declares work {work} and this build requires {MIN_WORK}..{MAX_WORK} "
            "leading zero bits; a lower floor is not a proof",
            line,
            authority=authority,
            key=key_text,
            work=work,
            nonce=nonce,
            digest=digest,
        )
    payload = work_payload(digest, authority, work, nonce)
    proved = leading_zero_bits(hashlib.sha256(payload).digest())
    if proved < work:
        return refuse(
            "insufficient-work",
            f"the envelope declares work {work} and nonce {nonce} proves {proved} leading zero "
            "bits",
            line,
            authority=authority,
            key=key_text,
            work=work,
            nonce=nonce,
            digest=digest,
        )

    expected = hmac.new(key, payload, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature.lower(), expected):
        return refuse(
            "signature-invalid",
            f"the signature names {key_text} but is not over this body's work statement",
            line,
            authority=authority,
            key=key_text,
            work=work,
            nonce=nonce,
            digest=digest,
        )

    return verdict(
        "signed",
        authority=authority,
        key=key_text,
        work=work,
        nonce=nonce,
        digest=digest,
        line=line,
    )


def verify_file(path: Path | str, key: bytes | None = None) -> dict:
    target = Path(path)
    try:
        text = target.read_text(encoding="utf-8", errors="replace")
    except OSError as error:
        return refuse("unreadable-envelope", f"{target} cannot be read: {error}")
    result = verify_text(text, key)
    result["file"] = str(target)
    return result


def mine(payload_without_nonce: str, work: int) -> str:
    """Find a nonce whose work statement carries ``work`` leading zero bits."""
    nonce = 0
    while True:
        candidate = str(nonce)
        payload = f"{payload_without_nonce}{candidate}".encode("utf-8")
        if leading_zero_bits(hashlib.sha256(payload).digest()) >= work:
            return candidate
        nonce += 1


def sign_text(text: str, key: bytes, authority: str = TRUSTED_AUTHORITY, work: int = MIN_WORK + 4) -> str:
    """Attach an envelope to ``text``; the body is every line the envelope does not occupy."""
    lines = normalize(text)
    found = envelope_block(lines)
    if found is not None:
        start, end, _ = found
        if end > start:
            lines = lines[:start] + lines[end:]
    if work < MIN_WORK or work > MAX_WORK:
        raise ValueError(f"work must be {MIN_WORK}..{MAX_WORK} leading zero bits")
    prefix = f"{lines[0]}\n" if lines else ""
    rest = lines[1:] if lines else []
    # `verify_text` hashes every line the envelope does not occupy, including the header. The
    # signer must hash the same bytes or its own signature would not verify.
    body = "\n".join(lines)
    digest = body_digest(body)
    nonce = mine(f"{digest}\n{authority}\n{work}\n", work)
    payload = work_payload(digest, authority, work, nonce)
    signature = hmac.new(key, payload, hashlib.sha256).hexdigest()
    block = [
        f"envelope\t{FORMAT}",
        f"\tdigest\t{digest}",
        f"\tauthority\t{authority}",
        f"\twork\t{work}",
        f"\tnonce\t{nonce}",
        f"\talgorithm\t{ALGORITHM}",
        f"\tkey\t{key_id(key)}",
        f"\tsignature\t{signature}",
        f"\trecord-id\t{RECORD_ID}",
    ]
    # `normalize` keeps a trailing empty line, so the join already reproduces the file's final
    # newline. Adding another would put a line into the body that the signer did not hash.
    return prefix + "\n".join(block + rest)


def check_surfaces(root: Path = ROOT, key: bytes | None = None) -> list[dict]:
    """Read the envelope on each of this repo's package surfaces."""
    rows = []
    for relative in SURFACES:
        path = root / relative
        if not path.is_file():
            rows.append({"file": relative, "state": "absent", "why": "file is missing",
                         "refusals": [], "authority": "", "work": 0, "digest": ""})
            continue
        reading = verify_file(path, key)
        reading["file"] = relative
        rows.append(reading)
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify or sign optional package envelopes.")
    parser.add_argument("--check", action="store_true", help="verify every package surface")
    parser.add_argument("--sign", default="", help="attach an envelope to this file (writes it)")
    parser.add_argument("--work", type=int, default=MIN_WORK + 4, help="leading zero bits to mine")
    parser.add_argument("--authority", default=TRUSTED_AUTHORITY)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    if args.sign:
        key = load_key(create=True)
        if key is None:
            print("no machine key outside the checkout; refusing to sign", file=sys.stderr)
            return 1
        target = Path(args.sign)
        text = target.read_text(encoding="utf-8")
        target.write_text(sign_text(text, key, args.authority, args.work), encoding="utf-8")
        print(f"signed {target}")
        return 0

    key = load_key()
    rows = check_surfaces(ROOT, key)
    refused = [row for row in rows if row["state"] == "refused"]
    if args.json:
        import json

        print(json.dumps(rows, indent=2))
    else:
        for row in rows:
            detail = ""
            if row["refusals"]:
                detail = "  ·  " + "; ".join(
                    f"{refusal['kind']}: {refusal['detail']}" for refusal in row["refusals"]
                )
            print(f"{row['file']}: {row['state']}{detail}")
    return 1 if refused else 0


if __name__ == "__main__":
    raise SystemExit(main())

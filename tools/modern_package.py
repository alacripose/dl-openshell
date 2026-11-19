"""The modern package packer: canonical manifest + payload, BLAKE3 identity.

This follows `secure_shell_v2/docs/SECURE-SHELL-RESTORE@1.ARCHITECTURE.md` §5, §7 and §12.8 and
`secure_shell_v2/impl/packages/{canonical,identity,loader}.py`:

  identity = name@<revision>+blake3:<hex>
  digest   = blake3(secure-shell.package/<32 hex>
                    || u64be(len(canonical manifest)) || canonical manifest
                    || u64be(len(payload))            || payload)

The manifest is JSON with sorted keys and no incidental whitespace. The payload is a separate
file and is hashed in bounded chunks, so its size is a 64-bit application fact, not a frame field.
There is no package magic here and no SHPKG frame: the old frame is a read-only legacy decoder.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Iterable

from blake3 import blake3

def format_id(family: str, lines: list[str]) -> str:
    digest = hashlib.sha256(("\n".join(lines) + "\n").encode("utf-8")).hexdigest()
    return f"{family}/{digest[:32]}"


# The id pins the contract, not a hand-bumped counter. Every modern family follows the same rule,
# and every numeric id is a legacy migration input that an emitter rewrites.
PACKAGE_SCHEMA = format_id("secure-shell.package", [
    "family\tsecure-shell.package",
    "legacy-family\tsecure-shell.package",
    "legacy-schema\t1",
    "reader\tsecure-shell.package.reader.v1",
    "algorithm\tblake3",
    "field\tname", "field\trevision", "field\tschemas", "field\tdependencies",
    "field\tentry_points", "field\tlengths",
    "exclude\tsignature", "exclude\tsignature_algorithm", "exclude\treceived_at",
    "exclude\tadmitted_at", "exclude\thash", "exclude\tdigest", "exclude\tnonce",
    "exclude\tchunk_frame",
])
SURFACE_SCHEMA = format_id("secure-shell.surface", [
    "family\tsecure-shell.surface",
    "legacy-family\tdl-enclave.surface",
    "legacy-schema\t1",
    "reader\tsecure-shell.surface.reader.v1",
    "refusal\taction-count", "refusal\tduplicate-window", "refusal\tformat-hash-mismatch",
    "refusal\tformat-id-legacy-emitted", "refusal\tgeometry-invalid", "refusal\tnode-count",
    "refusal\tnode-depth", "refusal\tpin-not-pinnable", "refusal\tsurface-capability",
    "refusal\tsurface-id", "refusal\tsurface-oversize", "refusal\tsurface-schema",
    "refusal\tunknown-lane", "refusal\tunknown-node-kind", "refusal\tunknown-node-parent",
    "refusal\tunknown-node-role", "refusal\tunknown-rule", "refusal\tunknown-theme-role",
    "refusal\twindow-count",
])
FILES_SCHEMA = format_id("secure-shell.files", [
    "family\tsecure-shell.files",
    "legacy-family\tsecure-shell.package.files",
    "legacy-schema\t1",
    "reader\tsecure-shell.files.reader.v1",
    "field\tfiles", "field\tschema",
])
ADDONS_SCHEMA = format_id("openlock.addons", [
    "family\topenlock.addons",
    "legacy-family\topenlock.addons",
    "legacy-schema\t2",
    "reader\topenlock.addons.reader.v1",
    "field\tformat", "field\trevision", "field\tpackages",
    "field\twindows", "field\tliveTree", "field\tbudgets",
    "refusal\tformat", "refusal\trevision",
    "refusal\twindow", "refusal\tnode", "refusal\tbudget",
])
GOOSE_MOD_SCHEMA = format_id("goose.mod", [
    "family\tgoose.mod",
    "legacy-family\tgoose.mod",
    "legacy-schema\t1",
    "reader\tgoose.mod.reader.v1",
    "field\tmod", "field\tsource", "field\tjava", "field\tentrypoint",
    "field\trequires", "field\tcontent", "field\tformat",
])
DL_ENCLAVE_SCHEMA = format_id("dl-enclave.pkg", [
    "family\tdl-enclave.pkg",
    "legacy-family\tdl-enclave.pkg",
    "legacy-schema\t1",
    "reader\tdl-enclave.pkg.reader.v1",
    "field\tpackage", "field\tbuilt-by", "field\tpayload",
    "field\tmodule", "field\tformat", "field\taxes", "field\trequires", "field\trecord-id",
    "refusal\tmagic", "refusal\tframe-version", "refusal\tflags",
    "refusal\theader-oversize", "refusal\theader-key", "refusal\tmodule-kind",
    "refusal\tmodule-path", "refusal\tpayload-digest", "refusal\ttrailer-digest",
    "refusal\tlength",
])
DOMAIN = PACKAGE_SCHEMA.encode("utf-8")
CHUNK = 1 << 20
HARD_CEILING = 64 * 1024 * 1024 * 1024
EXCLUDED = {
    "signature",
    "signature_algorithm",
    "received_at",
    "admitted_at",
    "hash",
    "digest",
    "nonce",
    "chunk_frame",
}
DEFAULT_EXTENSIONS = (".xml", ".js", ".css", ".json", ".tsv", ".surface")


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def kept_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in manifest.items() if key not in EXCLUDED}


def digest_stream(manifest: dict[str, Any], payload_path: Path) -> tuple[str, int]:
    """Hash the declared content without loading the payload into memory."""
    length = payload_path.stat().st_size
    if length > HARD_CEILING:
        raise ValueError(f"payload is {length} bytes; the hard ceiling is {HARD_CEILING}")
    declared = manifest.get("lengths", {}).get("payload")
    if declared != length:
        raise ValueError(f"manifest declares {declared} payload bytes; the file is {length}")

    manifest_bytes = canonical_bytes(kept_manifest(manifest))
    hasher = blake3()
    hasher.update(DOMAIN)
    hasher.update(len(manifest_bytes).to_bytes(8, "big"))
    hasher.update(manifest_bytes)
    hasher.update(length.to_bytes(8, "big"))

    read = 0
    with payload_path.open("rb") as handle:
        while True:
            block = handle.read(CHUNK)
            if not block:
                break
            read += len(block)
            hasher.update(block)
    if read != length:
        raise ValueError(f"payload read {read} of {length} bytes")
    return "blake3:" + hasher.hexdigest(), length


def identity(manifest: dict[str, Any], digest: str) -> str:
    return f"{manifest['name']}@{manifest['revision']}+{digest}"


def write_manifest(target: Path, manifest: dict[str, Any]) -> None:
    target.write_bytes(canonical_bytes(kept_manifest(manifest)))


def collect(root: Path, extensions: Iterable[str] = DEFAULT_EXTENSIONS) -> list[dict[str, Any]]:
    wanted = tuple(extension.lower() for extension in extensions)
    files: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in wanted:
            continue
        if any(part in {".git", "node_modules", "dist", "obj", "bin"} for part in path.relative_to(root).parts):
            continue
        data = path.read_bytes()
        files.append(
            {
                "path": path.relative_to(root).as_posix(),
                "length": len(data),
                "digest": "blake3:" + blake3(data).hexdigest(),
            }
        )
    if not files:
        raise ValueError(f"no files with {', '.join(wanted)} under {root}")
    return files


def write_from_tree(root: Path, out: Path, name: str, revision: int = 1,
                    extensions: Iterable[str] = DEFAULT_EXTENSIONS) -> dict[str, Any]:
    """Pack a source tree as the modern file-index payload (the loader's shape)."""
    files = collect(root, extensions)
    index = {"schema": FILES_SCHEMA, "files": files}
    payload = canonical_bytes(index)
    out.mkdir(parents=True, exist_ok=True)
    payload_path = out / "payload.bin"
    payload_path.write_bytes(payload)
    manifest = {
        "name": name,
        "revision": revision,
        "schemas": sorted([PACKAGE_SCHEMA, FILES_SCHEMA]),
        "dependencies": [],
        "entry_points": [entry["path"] for entry in files],
        "lengths": {"files": len(files), "payload": len(payload)},
    }
    digest, length = digest_stream(manifest, payload_path)
    write_manifest(out / "manifest.json", manifest)
    result = {
        "schema": PACKAGE_SCHEMA,
        "state": "held",
        "root": str(root),
        "files": len(files),
        "manifest": manifest,
        "payload": str(payload_path),
        "length": length,
        "digest": digest,
        "identity": identity(manifest, digest),
    }
    (out / "identity.txt").write_text(result["identity"] + "\n", encoding="utf-8")
    return result


def write_surface(surface_path: Path, out: Path, name: str, revision: int = 1) -> dict[str, Any]:
    """Pack one surface document, upgrading a legacy numeric header on emission."""
    payload = surface_path.read_bytes()
    if len(payload) > 1_048_576:
        raise ValueError(f"surface is {len(payload)} bytes; the surface ceiling is 1048576")
    text = payload.decode("utf-8")
    lines = text.splitlines(keepends=True)
    if not lines:
        raise ValueError("surface-schema: document has no header")
    declared = lines[0].rstrip("\r\n")
    upgraded = declared != SURFACE_SCHEMA
    if upgraded:
        family = declared.rsplit("/", 1)[0] if "/" in declared else ""
        suffix = declared.rsplit("/", 1)[1] if "/" in declared else ""
        if len(suffix) == 32 and all(ch in "0123456789abcdef" for ch in suffix):
            raise ValueError(f"format-hash-mismatch: {declared}; this packer emits {SURFACE_SCHEMA}")
        if family in {"dl-enclave.surface", "secure-shell.surface"} and suffix.isdigit():
            ending = lines[0][len(declared):]
            lines[0] = SURFACE_SCHEMA + ending
            payload = "".join(lines).encode("utf-8")
        else:
            raise ValueError(f"surface-schema: {declared}; this packer emits {SURFACE_SCHEMA}")
    out.mkdir(parents=True, exist_ok=True)
    payload_path = out / "payload.bin"
    payload_path.write_bytes(payload)
    manifest = {
        "name": name,
        "revision": revision,
        "schemas": sorted([PACKAGE_SCHEMA, SURFACE_SCHEMA]),
        "dependencies": [],
        "entry_points": ["surface"],
        "lengths": {"payload": len(payload)},
    }
    digest, length = digest_stream(manifest, payload_path)
    write_manifest(out / "manifest.json", manifest)
    result = {
        "schema": PACKAGE_SCHEMA,
        "state": "held",
        "upgraded": upgraded,
        "surface": str(surface_path),
        "manifest": str(out / "manifest.json"),
        "payload": str(payload_path),
        "length": length,
        "digest": digest,
        "identity": identity(manifest, digest),
    }
    (out / "identity.txt").write_text(result["identity"] + "\n", encoding="utf-8")
    return result


def upgrade_declared(declared: str, current: str, family: str) -> bool:
    """Apply the one id rule and return whether the input was a numeric legacy id."""
    if declared == current:
        return False
    prefix, _, suffix = declared.rpartition("/")
    if prefix != family:
        raise ValueError(f"format-hash-mismatch: {declared}; this rewriter emits {current}")
    if len(suffix) == 32 and all(ch in "0123456789abcdef" for ch in suffix):
        raise ValueError(f"format-hash-mismatch: {declared}; this rewriter emits {current}")
    if suffix.isdigit():
        return True
    raise ValueError(f"format-schema: {declared}; this rewriter emits {current}")


def _replace_first_line(text: str, current: str, family: str) -> tuple[str, bool]:
    lines = text.splitlines(keepends=True)
    if not lines:
        raise ValueError(f"format-schema: {family} document has no header")
    declared = lines[0].rstrip("\r\n")
    upgraded = upgrade_declared(declared, current, family)
    lines[0] = current + lines[0][len(declared):]
    return "".join(lines), upgraded


def write_addons(source: Path, out: Path) -> dict[str, Any]:
    """Rewrite an addon delivery payload; any numeric header becomes the hashed family id."""
    document = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(document, dict) or "format" not in document:
        raise ValueError("format-schema: addon payload has no format")
    upgraded = upgrade_declared(str(document["format"]), ADDONS_SCHEMA, "openlock.addons")
    document["format"] = ADDONS_SCHEMA
    out.mkdir(parents=True, exist_ok=True)
    target = out / "addons.json"
    target.write_text(json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    return {"schema": ADDONS_SCHEMA, "state": "held", "upgraded": upgraded,
            "source": str(source), "payload": str(target), "length": target.stat().st_size}


def write_mod(source: Path, out: Path) -> dict[str, Any]:
    """Rewrite a goose.mod TSV module; the header is the only format-id field."""
    text = source.read_text(encoding="utf-8")
    upgraded_text, upgraded = _replace_first_line(text, GOOSE_MOD_SCHEMA, "goose.mod")
    out.mkdir(parents=True, exist_ok=True)
    target = out / "goose.mod.tsv"
    target.write_bytes(upgraded_text.encode("utf-8"))
    return {"schema": GOOSE_MOD_SCHEMA, "state": "held", "upgraded": upgraded,
            "source": str(source), "payload": str(target), "length": target.stat().st_size}


def write_enclave(source: Path, out: Path) -> dict[str, Any]:
    """Rewrite a dl-enclave.pkg header and its trailer; the payload is carried byte for byte."""
    import struct

    frame = source.read_bytes()
    if len(frame) < 56:
        raise ValueError("length: frame is shorter than the minimum")
    if frame[:8] != b"DLEP\x00\x00\x00\x01":
        raise ValueError("magic: expected DLEP frame")
    if frame[8] != 1 or frame[9] != 0:
        raise ValueError("frame-version: unsupported frame version or flags")
    header_len = struct.unpack("<I", frame[12:16])[0]
    if header_len > 1 << 20 or len(frame) < 16 + header_len + 8 + 32:
        raise ValueError("header-oversize: header length is outside the frame")
    header = frame[16:16 + header_len].decode("utf-8")
    upgraded_header, upgraded = _replace_first_line(header, DL_ENCLAVE_SCHEMA, "dl-enclave.pkg")
    encoded = upgraded_header.encode("utf-8")
    if len(encoded) > 1 << 20:
        raise ValueError("header-oversize: upgraded header is too large")
    body = frame[:12] + struct.pack("<I", len(encoded)) + encoded + frame[16 + header_len:]
    result = body + hashlib.sha256(body).digest()
    out.mkdir(parents=True, exist_ok=True)
    target = out / "package.dle"
    target.write_bytes(result)
    return {"schema": DL_ENCLAVE_SCHEMA, "state": "held", "upgraded": upgraded,
            "source": str(source), "payload": str(target), "length": len(result)}


def write_sparse_proof(out: Path, total: int, name: str = "openlock-size-proof",
                       revision: int = 1) -> dict[str, Any]:
    """Write a payload just over 4 GiB with witnesses at known offsets.

    The body is extended without materializing it as a Python bytes object. The real packer still
    streams every byte into BLAKE3, so the digest covers the payload the reader will read.
    """
    if total <= 4 * 1024 * 1024 * 1024:
        raise ValueError("the proof payload must be larger than 4 GiB")
    if total > HARD_CEILING:
        raise ValueError(f"{total} exceeds the {HARD_CEILING}-byte hard ceiling")
    out.mkdir(parents=True, exist_ok=True)
    payload_path = out / "payload.bin"
    if payload_path.exists():
        payload_path.unlink()
    with payload_path.open("wb") as handle:
        handle.truncate(total)
        # Three witnesses at known offsets. The digest still streams every byte, so an offset
        # shift cannot pass by only checking the sentinels.
        handle.seek(0)
        handle.write(b"\x02")
        handle.seek(total // 2)
        handle.write(b"\x03")
        handle.seek(total - 1)
        handle.write(b"\x01")
    manifest = {
        "name": name,
        "revision": revision,
        "schemas": [PACKAGE_SCHEMA],
        "dependencies": [],
        "entry_points": ["payload.bin"],
        "lengths": {"payload": total},
    }
    digest, length = digest_stream(manifest, payload_path)
    write_manifest(out / "manifest.json", manifest)
    result = {
        "schema": PACKAGE_SCHEMA,
        "state": "held",
        "manifest": str(out / "manifest.json"),
        "payload": str(payload_path),
        "length": length,
        "digest": digest,
        "identity": identity(manifest, digest),
    }
    (out / "identity.txt").write_text(result["identity"] + "\n", encoding="utf-8")
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="openlock modern package")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--tree", help="source tree to pack as a file-index payload")
    mode.add_argument("--surface", help="surface document to pack; numeric legacy headers are upgraded")
    mode.add_argument("--addons", help="addon delivery JSON to rewrite; numeric legacy headers are upgraded")
    mode.add_argument("--mod", help="goose.mod TSV to rewrite; numeric legacy headers are upgraded")
    mode.add_argument("--enclave", help="dl-enclave.pkg frame to rewrite; numeric legacy headers are upgraded")
    mode.add_argument("--proof", action="store_true", help="write a payload just over 4 GiB")
    parser.add_argument("--out", required=True)
    parser.add_argument("--name", default="openlock-size-proof")
    parser.add_argument("--revision", type=int, default=1)
    parser.add_argument("--extensions", default=",".join(DEFAULT_EXTENSIONS))
    arguments = parser.parse_args(argv)
    try:
        if arguments.proof:
            result = write_sparse_proof(
                Path(arguments.out), 4 * 1024 * 1024 * 1024 + 1,
                arguments.name, arguments.revision,
            )
        elif arguments.surface:
            result = write_surface(
                Path(arguments.surface), Path(arguments.out),
                arguments.name, arguments.revision,
            )
        elif arguments.addons:
            result = write_addons(Path(arguments.addons), Path(arguments.out))
        elif arguments.mod:
            result = write_mod(Path(arguments.mod), Path(arguments.out))
        elif arguments.enclave:
            result = write_enclave(Path(arguments.enclave), Path(arguments.out))
        else:
            result = write_from_tree(
                Path(arguments.tree), Path(arguments.out), arguments.name,
                arguments.revision,
                tuple(item.strip() for item in arguments.extensions.split(",") if item.strip()),
            )
    except ValueError as refusal:
        print(json.dumps({"schema": PACKAGE_SCHEMA, "state": "refused", "reason": str(refusal)}, sort_keys=True))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())

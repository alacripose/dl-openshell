#!/usr/bin/env python3
"""Render the shell's procedural UI audio.

The reference is `ala-cities/src/audio.rs`: four short, deterministic UI cues
synthesized from decaying sine voices, never sampled. This tool is the build-time
counterpart. Deadlock's Panorama runtime can only play a named soundevent, so the
samples are rendered here and compiled into the client addon by `install.ps1`.

The four cues are a closed set, one per interface event:

    select  a tool or window was chosen
    place   a choice landed (pin, scheme, shape, picker edit)
    refuse  the shell declined an action
    notify  an observer notice or package update arrived

Usage:
    python tools/gen_shell_audio.py <content-root>
    python tools/gen_shell_audio.py --self-test
"""

from __future__ import annotations

import hashlib
import io
import math
import re
import struct
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AUDIO_JS = ROOT / "clientaddon" / "panorama" / "scripts" / "openlock_audio.js"
SHELL_JS = ROOT / "clientaddon" / "panorama" / "scripts" / "openlock_shell.js"
SAMPLE_RATE = 44_100
ATTACK_SECONDS = 0.004
DECAY_FRACTION = 0.45

# The four events, their lengths, and their voices. A voice is
# (start_hz, end_hz, amplitude); `at` is the voice's start as a fraction of the
# buffer. The refusal's second tone starts halfway through, which is the
# reference's stated intent; its `end_hz < start_hz` guard never fired because
# both refusal tones are static, so this table states the position directly.
CUES = {
    "select": {
        "seconds": 0.06,
        "voices": [(880.0, 880.0, 0.30, 0.0)],
    },
    "place": {
        "seconds": 0.10,
        "voices": [(330.0, 330.0, 0.42, 0.0)],
    },
    "refuse": {
        "seconds": 0.14,
        "voices": [(392.0, 392.0, 0.34, 0.0), (311.0, 311.0, 0.30, 0.5)],
    },
    "notify": {
        "seconds": 0.18,
        "voices": [(440.0, 587.0, 0.30, 0.0)],
    },
}

EVENTS = {
    "select": "Openlock.UI.Select",
    "place": "Openlock.UI.Place",
    "refuse": "Openlock.UI.Refuse",
    "notify": "Openlock.UI.Notify",
}

SOUND_DIR = Path("sounds") / "openlock"
MANIFEST_DIR = Path("soundevents")
MANIFEST_NAME = "openlock_ui.vsndevts"


def synthesize(cue_id: str) -> list[float]:
    """Render one cue. Pure: no clock, no device, no random source."""
    cue = CUES[cue_id]
    total = int(round(cue["seconds"] * SAMPLE_RATE))
    out = [0.0] * total
    for start_hz, end_hz, amplitude, at in cue["voices"]:
        voice_start = min(total - 1, int(total * at))
        voice_len = total - voice_start
        span = voice_len / SAMPLE_RATE
        phase = 0.0
        for i in range(voice_len):
            t = i / SAMPLE_RATE
            hz = start_hz + (end_hz - start_hz) * (t / span)
            phase += 2.0 * math.pi * hz / SAMPLE_RATE
            attack = min(1.0, t / ATTACK_SECONDS)
            decay = math.exp(-t / (span * DECAY_FRACTION))
            out[voice_start + i] += amplitude * attack * decay * math.sin(phase)
    return out


def pcm16(samples: list[float]) -> bytes:
    """Pack mono samples as 16-bit PCM, bounded without clipping."""
    frames = []
    for sample in samples:
        bounded = max(-1.0, min(1.0, sample))
        frames.append(struct.pack("<h", int(round(bounded * 32767.0))))
    return b"".join(frames)


def wav_bytes(samples: list[float]) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(pcm16(samples))
    return buffer.getvalue()


KV3_HEADER = (
    "<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} "
    "format:generic:version{7412167c-06e9-4698-aff2-e63eb59037e7} -->"
)


def manifest() -> str:
    # The header is not decoration: without it resourcecompiler treats the file as
    # KeyValues 1 and fails to parse it, then exits before writing an event. This
    # exact line is what the game's own soundevents carry.
    lines = [
        KV3_HEADER,
        "{",
    ]
    for cue_id, event in EVENTS.items():
        lines.extend(
            [
                f"\t{event} =",
                "\t{",
                '\t\tbase = "Base.UI"',
                # 0 dB is the reference's own level: ala-cities plays the synthesized
                # samples directly. A positive gain here would multiply a 0.26-0.37
                # peak past full scale and clip the place and refuse cues.
                "\t\tvolume = 0.0",
                f'\t\tvsnd_files = "{SOUND_DIR.as_posix()}/{cue_id}.vsnd"',
                f"\t\tvsnd_duration = {CUES[cue_id]['seconds']:.2f}",
                "\t}",
            ]
        )
    lines.append("}")
    return "\n".join(lines) + "\n"


def output_files() -> dict[Path, bytes]:
    files: dict[Path, bytes] = {}
    for cue_id in CUES:
        files[SOUND_DIR / f"{cue_id}.wav"] = wav_bytes(synthesize(cue_id))
    files[MANIFEST_DIR / MANIFEST_NAME] = manifest().encode("utf-8")
    return files


def write(root: Path) -> None:
    for relative, data in output_files().items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()[:12]
        print(f"wrote {target} ({len(data)} bytes, {digest})")


def peak(samples: list[float]) -> float:
    return max((abs(sample) for sample in samples), default=0.0)


def self_test() -> int:
    failures: list[str] = []

    for cue_id in CUES:
        samples = synthesize(cue_id)
        expected = int(round(CUES[cue_id]["seconds"] * SAMPLE_RATE))
        if len(samples) != expected:
            failures.append(f"{cue_id}: length {len(samples)} != {expected}")
        if any(not math.isfinite(sample) or abs(sample) > 1.0 for sample in samples):
            failures.append(f"{cue_id}: sample outside [-1, 1] or non-finite")
        top = peak(samples)
        if top <= 0.1:
            failures.append(f"{cue_id}: peak {top:.3f} is too quiet")
        tail = samples[len(samples) * 9 // 10 :]
        if peak(tail) >= top * 0.35:
            failures.append(f"{cue_id}: tail {peak(tail):.3f} does not decay from {top:.3f}")
        early = samples[: int(0.001 * SAMPLE_RATE)]
        if peak(early) >= top * 0.75:
            failures.append(f"{cue_id}: first millisecond clicks ({peak(early):.3f} vs {top:.3f})")

    if synthesize("place") == synthesize("select"):
        failures.append("place and select render the same samples")
    if synthesize("refuse") == synthesize("place"):
        failures.append("refuse and place render the same samples")
    if synthesize("notify") != synthesize("notify"):
        failures.append("notify is not deterministic")

    # The manifest and the runtime's cue table must agree. A cue renamed in JS
    # without a manifest update is a silent button.
    if AUDIO_JS.exists():
        source = AUDIO_JS.read_text(encoding="utf-8")
        declared = set()
        for cue_id, event in EVENTS.items():
            if f'"{event}"' in source:
                declared.add(event)
        missing = [event for event in EVENTS.values() if event not in declared]
        if missing:
            failures.append("openlock_audio.js is missing " + ", ".join(missing))

    # The shell calls cues by name. A typo would be a silent path that the event table
    # check above cannot see, so every cue("...") call must name one of the four.
    if SHELL_JS.exists():
        called = set(re.findall(r'cue\("([^"]+)"\)', SHELL_JS.read_text(encoding="utf-8")))
        unknown = sorted(called - set(CUES))
        if unknown:
            failures.append("openlock_shell.js calls unknown cue(s): " + ", ".join(unknown))

    # The generated manifest is compiled by resourcecompiler, not by Python. Two
    # properties are load-bearing and have each broken a compile:
    #   * a KV3 header, or the file is parsed as KeyValues 1;
    #   * a .vsnd reference, not the .wav source, which crashes the compiler on
    #     an assert rather than returning an error.
    text = manifest()
    if not text.startswith(KV3_HEADER):
        failures.append("manifest does not start with the KV3 header")
    for cue_id in CUES:
        reference = f'vsnd_files = "{SOUND_DIR.as_posix()}/{cue_id}.vsnd"'
        if reference not in text:
            failures.append(f"manifest does not reference the compiled {cue_id}.vsnd")
    if ".wav" in text:
        failures.append("manifest references a .wav source; resourcecompiler expects .vsnd")
    for event in EVENTS.values():
        if f"{event} =" not in text:
            failures.append(f"manifest is missing the {event} event")

    if failures:
        for failure in failures:
            print(f"FAIL {failure}", file=sys.stderr)
        return 1

    for cue_id in CUES:
        data = wav_bytes(synthesize(cue_id))
        print(
            f"{cue_id:7s} {len(synthesize(cue_id)):5d} samples  "
            f"peak {peak(synthesize(cue_id)):.3f}  "
            f"sha256 {hashlib.sha256(data).hexdigest()[:16]}"
        )
    print(f"ok: {len(CUES)} cues, {len(EVENTS)} soundevents")
    return 0


def main() -> int:
    args = [arg for arg in sys.argv[1:] if arg != "--self-test"]
    if "--self-test" in sys.argv[1:]:
        code = self_test()
        if code != 0 or not args:
            return code
    if len(args) != 1:
        print(__doc__, file=sys.stderr)
        return 2
    write(Path(args[0]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

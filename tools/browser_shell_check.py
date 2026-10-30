#!/usr/bin/env python3
"""Open the browser's minimal shell and read its rendered window geometry.

The fake-tree suites prove the Panorama calls. They cannot prove that a control has pixels or
that the pointer reaches it. This gate loads `docs/shell-minimal.html` in the installed Chromium
(Edge or Chrome), lets the page measure itself, and reads the result out of the dumped DOM. It
never starts the game and it does not touch the live client.

Run: python tools/browser_shell_check.py [--json]
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

import shell_test_surface  # noqa: E402

PAGE = ROOT / "docs" / "shell-minimal.html"


def find_browser() -> str:
    """A Chromium that can dump a DOM without a display server."""
    env = os.environ.get("OPENLOCK_BROWSER", "").strip()
    if env and Path(env).is_file():
        return env
    for name in ("msedge", "msedge.exe", "chrome", "chrome.exe", "chromium", "chromium-browser"):
        found = shutil.which(name)
        if found:
            return found
    for candidate in (
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ):
        if Path(candidate).is_file():
            return candidate
    return ""


SIZES = ((1280, 900), (1024, 768), (900, 1000))

# A refusal that never fires is not a refusal. The probe page is the real witness page with one
# game window forced into the DOM after the shell has drawn; the gameless gate must fail by name.
REFUSAL_PROBE = """
<script>
  window.setTimeout(function () {
    var frame = document.createElement('div');
    frame.className = 'Panel WindowFrame';
    frame.id = 'OpenlockFrame_game_hud_probe';
    frame.style.cssText = 'margin-left:40px;margin-top:60px;width:320px;height:220px;';
    document.body.appendChild(frame);
  }, 2600);
</script>
"""


def read_page(browser: str, page: Path, size: tuple[int, int]) -> tuple[str, str]:
    """(dom, error). A non-zero exit or a page that never measured is an error."""
    with tempfile.TemporaryDirectory(prefix="openlock-browser-") as profile:
        command = [
            browser,
            "--headless",
            "--disable-gpu",
            "--no-sandbox",
            "--no-first-run",
            "--disable-extensions",
            "--hide-scrollbars",
            "--virtual-time-budget=8000",
            f"--window-size={size[0]},{size[1]}",
            f"--user-data-dir={profile}",
            "--dump-dom",
            page.resolve().as_uri(),
        ]
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=90,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as error:
            return "", str(error)
    dom = result.stdout or ""
    if result.returncode != 0:
        detail = (result.stderr or "").strip().splitlines()
        return dom, f"browser exited {result.returncode}: {detail[-1] if detail else 'no stderr'}"
    if "data-shell-draw" not in dom:
        return dom, "the page never wrote data-shell-draw"
    return dom, ""


def parse_reading(dom: str) -> dict:
    state_match = re.search(r'data-shell-draw="(pass|fail)"', dom)
    state = state_match.group(1) if state_match else "fail"
    match = re.search(r'<pre[^>]*id="shell-measure"[^>]*>(.*?)</pre>', dom, re.DOTALL)
    if not match:
        return {"state": state, "issues": ["the measured JSON block is missing"], "frames": []}
    try:
        reading = json.loads(html.unescape(match.group(1)))
    except json.JSONDecodeError as error:
        return {"state": state, "issues": [f"unreadable measured JSON: {error}"], "frames": []}
    reading["state"] = "pass" if state == "pass" and not reading.get("issues") else "fail"
    return reading


def refusal_probe(browser: str) -> tuple[bool, str]:
    """Force a game window into a copy of the page and prove the gate refuses it by name."""
    page = PAGE.read_text(encoding="utf-8", errors="replace")
    if "</body>" not in page:
        return False, "the witness page has no body to probe"
    probed = page.replace("</body>", REFUSAL_PROBE + "</body>")
    with tempfile.TemporaryDirectory(prefix="openlock-refusal-") as folder:
        probe = Path(folder) / "refusal-probe.html"
        probe.write_text(probed, encoding="utf-8")
        dom, error = read_page(browser, probe, (1280, 900))
    if error:
        return False, f"the refusal probe could not run: {error}"
    reading = parse_reading(dom)
    if reading.get("state") == "pass":
        return False, ("the gameless gate passed a page carrying a game-* window; "
                       "the refusal is not enforced")
    issues = " ".join(reading.get("issues") or [])
    if "live-game window" not in issues:
        return False, f"the refusal probe failed for another reason: {issues[:300]}"
    return True, "a game-* frame is refused by name"


def check() -> dict:
    shell_test_surface.write_minimal()
    witness = PAGE.relative_to(ROOT)
    browser = find_browser()
    if not browser:
        return {
            "state": "blocked",
            "witness": str(witness),
            "detail": "no Chromium (Edge or Chrome) was found to draw the minimal shell",
            "reading": {},
        }
    readings = []
    for size in SIZES:
        dom, error = read_page(browser, PAGE, size)
        if error:
            return {
                "state": "blocked",
                "witness": str(witness),
                "detail": f"{Path(browser).name} at {size[0]}x{size[1]}: {error}",
                "reading": {},
            }
        reading = parse_reading(dom)
        readings.append({"size": f"{size[0]}x{size[1]}", **reading})
        if reading.get("state") != "pass":
            issues = reading.get("issues") or ["the page reported fail without a reason"]
            return {
                "state": "absent",
                "witness": str(witness),
                "detail": f"{size[0]}x{size[1]}: " + "; ".join(issues)[:900],
                "reading": readings,
            }
    refused, refusal_detail = refusal_probe(browser)
    if not refused:
        return {
            "state": "absent",
            "witness": str(witness),
            "detail": refusal_detail,
            "reading": readings,
        }
    frames = readings[0].get("frames") or []
    summary = ", ".join(
        f"{row.get('id')} {row.get('w')}x{row.get('h')} ({row.get('controls')} controls, {row.get('grips')} grips)"
        for row in frames
    )
    envelope_states = readings[0].get("envelopes") or []
    if len(envelope_states) != 4 or any(str(state).endswith(":refused") for state in envelope_states):
        return {
            "state": "absent",
            "witness": str(witness),
            "detail": "the package envelopes are not the four readable surfaces: "
                      + (" ".join(envelope_states) or "none"),
            "reading": readings,
        }
    wishes = readings[0].get("wishes") or {}
    game_wishes = wishes.get("game") or []
    if not game_wishes:
        return {
            "state": "absent",
            "witness": str(witness),
            "detail": "the page carries no other-game wish; the plan for a discovered install "
                      "is not in the data it drew from",
            "reading": readings,
        }
    refused_games = [row for row in game_wishes if row.get("state") == "refused"]
    if refused_games:
        return {
            "state": "absent",
            "witness": str(witness),
            "detail": "a compatible install was read as a refusal: "
                      + ", ".join(f"{row.get('surface')} {row.get('plan')}" for row in refused_games),
            "reading": readings,
        }
    game_templates = int(readings[0].get("gameTemplates") or 0)
    if game_templates:
        return {
            "state": "absent",
            "witness": str(witness),
            "detail": f"the gameless witness carries {game_templates} game template(s)",
            "reading": readings,
        }
    wish_summary = ", ".join(f"{row.get('surface')} {row.get('state')}" for row in game_wishes)
    streamer_format = str(readings[0].get("streamerFormat") or "")
    if streamer_format != "openlock.game/1":
        return {
            "state": "absent",
            "witness": str(witness),
            "detail": "the installer build does not carry the game package streamer format",
            "reading": readings,
        }
    return {
        "state": "held",
        "witness": str(witness),
        "detail": f"{Path(browser).name} drew {len(frames)} window(s) and "
                  f"{readings[0].get('launcherRows', 0)} launcher row(s) at "
                  + ", ".join(row['size'] for row in readings) + f": {summary}"
                  + f" | streamer format {streamer_format} present, game declarations refused"
                  + f" | other-game wishes: {wish_summary} (0 game templates)"
                  + f" | envelopes {' '.join(envelope_states)}"
                  + f" | refusal probe: {refusal_detail}",
        "reading": readings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Draw the minimal shell in a real browser and read its geometry.")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = check()
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"browser minimal shell {result['state'].upper()}")
        print(f"  {result['detail']}")
        print(f"  {result['witness']}")
    return 0 if result["state"] == "held" else 1


if __name__ == "__main__":
    raise SystemExit(main())

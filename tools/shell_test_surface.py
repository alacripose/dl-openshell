"""Run the shell's headless suites and write the browser witness page.

A headless pass is not the final verification. This tool runs the fake-tree and
layout checks, captures their exact commands and exit status, and writes
`docs/shell-test-surface.html`. That page is what the user opens in the browser;
a suite with no card is refused rather than counted as green.

Run: python tools/shell_test_surface.py
"""

from __future__ import annotations

import html
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "shell-test-surface.html"
MINIMAL_OUT = ROOT / "docs" / "shell-minimal.html"

SUITES = (
    ("chrome-test", "Window chrome, drag, resize and glyphs", ["node", ".scratch/chrome-test.js"]),
    ("dashboard-test", "Dashboard, cells and saved layout", ["node", ".scratch/dashboard-test.js"]),
    ("layout-arbitration", "Layout arbitration and restore", ["node", ".scratch/layout-arbitration-test.js"]),
    ("package-delivery", "shploingus package delivery and live XML", ["node", ".scratch/test_delivery.js"]),
    ("package-envelope", "Optional axis envelope: accept, tamper, authority, work",
     [sys.executable, ".scratch/envelope-test.py"]),
    ("browser-minimal-shell", "Real shell in an isolated browser: taskbar, windows, controls",
     [sys.executable, "tools/browser_shell_check.py"]),
    ("static-check", "Static pointer and regression checker", [sys.executable, "tools/check_shell_clicks.py"]),
    ("release-download", "Release downloader: retry a dropped connection, refuse by name",
     [sys.executable, ".scratch/download-retry-server.py"]),
    ("split-identity", "Split identity: durable key, id churn across reload, unpinnable refused by name",
     ["node", ".scratch/split-identity-test.js"]),
    ("installer-pair", "Installer pair: current, stale, absent, incompatible, consent seed, Steam library record, another game's tree",
     [sys.executable, ".scratch/installer-pair-test.py"]),
)


def run(name: str, command: list[str]) -> dict:
    try:
        result = subprocess.run(
            command,
            cwd=ROOT,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=180,
            check=False,
        )
        output = (result.stdout or "") + (result.stderr or "")
        status = "PASS" if result.returncode == 0 else "REFUSED"
        code = result.returncode
    except Exception as error:  # command missing, timeout, etc.
        output = str(error)
        status = "REFUSED"
        code = -1
    count = 0
    match = re.search(r"(?:OK|ok:) (\d+)", output)
    if match:
        count = int(match.group(1))
    return {
        "name": name,
        "command": " ".join(command),
        "status": status,
        "code": code,
        "count": count,
        "output": output.strip(),
    }


def card(suite: dict) -> str:
    count = f"{suite['count']} checks" if suite["count"] else "no check count"
    return f"""
      <article class="card {suite['status'].lower()}" data-suite="{html.escape(suite['name'])}">
        <header>
          <h2>{html.escape(suite['name'])}</h2>
          <span class="badge">{suite['status']}</span>
        </header>
        <p class="meta">exit {suite['code']} · {count}</p>
        <code>{html.escape(suite['command'])}</code>
        <pre>{html.escape(suite['output'][-3500:])}</pre>
      </article>"""


def envelope_section() -> str:
    """The four package surfaces and their optional envelope reading.

    Unsigned is the opt-in default; a refused envelope is shown by name, because a package whose
    signature did not hold never reaches the shell data in the first place.
    """
    from package_envelope import check_surfaces

    rows = check_surfaces(ROOT)
    items = []
    for row in rows:
        reason = ""
        if row["refusals"]:
            reason = f" <span class=\"sub\">{html.escape(row['refusals'][0]['kind'])}</span>"
        items.append(
            f"<li><code>{html.escape(row['file'])}</code> "
            f"<span class=\"env {row['state']}\">{row['state']}</span>{reason}</li>"
        )
    return f"""
      <section class="surface">
        <h2>Package envelopes</h2>
        <p class="sub">Optional axis security: a signed package is checked before any of its
        records are used. An unsigned package loads unchanged.</p>
        <ul class="envelopes">{''.join(items)}</ul>
      </section>"""


def wish_section() -> str:
    """The plan the package asked the host to load, read from the generated wish list.

    A refusal on this page is a verdict; a wish is the load that verdict is about. The four
    categories the surface names are the four the generator emits: package surfaces, contents,
    renderer differences and the GitHub addon store.
    """
    import json

    data = ROOT / "clientaddon" / "panorama" / "scripts" / "openlock_shell_data.js"
    try:
        payload = json.loads(data.read_text(encoding="utf-8").split("var SHELL = ", 1)[1]
                             .rstrip().rstrip(";"))
    except (OSError, IndexError, json.JSONDecodeError) as error:
        return (f'<section class="surface"><h2>Wishes</h2>'
                f'<p class="sub">unreadable: {html.escape(str(error))}</p></section>')
    wishes = payload.get("wishes") or []
    rows = []
    for wish in wishes:
        detail = str(wish.get("why") or wish.get("detail") or "")
        rows.append(
            f"<li><code>{html.escape(str(wish.get('surface') or ''))}</code> "
            f"<span class=\"env {html.escape(str(wish.get('state') or ''))}\">"
            f"{html.escape(str(wish.get('state') or ''))}</span> "
            f"{html.escape(str(wish.get('plan') or ''))}"
            + (f" <span class=\"sub\">{html.escape(detail)}</span>" if detail else "")
            + "</li>"
        )
    return f"""
      <section class="surface">
        <h2>Wishes — {len(wishes)} planned load(s)</h2>
        <p class="sub">What this package plans to load, what is missing, where the game answers
        one content with more than one live panel, and the GitHub addon store rows. Rendered by
        the shell's own Wishes window from the same generated list.</p>
        <ul class="envelopes">{''.join(rows)}</ul>
      </section>"""


def write_minimal() -> Path:
    """Write the isolated browser view that boots the real shell.

    The page is assembled from the actual shell XML, data, script and stylesheet. A small
    Panorama adapter supplies the engine API; it does not draw a second shell.
    """
    from shell_sandbox_surface import write as write_sandbox

    return write_sandbox()


def main() -> int:
    results = [run(name, command) for name, _label, command in SUITES]
    failures = [result for result in results if result["status"] != "PASS"]
    banner = (
        "REFUSED — at least one suite has no green witness"
        if failures
        else "All headless suites passed; the live-client rows below remain refused."
    )
    status_class = "refused" if failures else "pass"
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    cards = "".join(card(result) for result in results)
    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Openlock shell test surface</title>
<style>
  :root {{
    --body: #14100b; --panel: #241a10; --ink: #f4e6c8; --muted: #a8977c;
    --gold: #e0b56a; --green: #8fd18f; --red: #e88a72; --line: #8a6f42;
  }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; background: var(--body); color: var(--ink);
    font: 14px/1.45 "Segoe UI", system-ui, sans-serif; }}
  header.top {{ padding: 18px 24px 14px; border-bottom: 1px solid var(--line);
    background: #100d09; }}
  h1 {{ margin: 0 0 4px; font-size: 20px; letter-spacing: .02em; }}
  .sub {{ color: var(--muted); }}
  .banner {{ margin: 18px 24px 0; padding: 10px 14px; border: 1px solid var(--line);
    background: var(--panel); color: var(--ink); }}
  .banner.pass {{ border-color: #4e7a4e; }}
  .banner.refused {{ border-color: #9a4a3a; color: #f0b09e; }}
  main {{ display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(320px, .7fr);
    gap: 18px; padding: 18px 24px 40px; }}
  .cards {{ display: grid; gap: 14px; }}
  .card {{ border: 1px solid var(--line); background: var(--panel); padding: 12px 14px; }}
  .card.refused {{ border-color: #9a4a3a; }}
  .card header {{ display: flex; justify-content: space-between; gap: 12px; align-items: center; }}
  .card h2 {{ margin: 0; font-size: 15px; }}
  .badge {{ font-size: 11px; letter-spacing: .08em; padding: 3px 7px;
    border: 1px solid var(--line); color: var(--green); }}
  .card.refused .badge {{ color: var(--red); border-color: #9a4a3a; }}
  .meta {{ margin: 4px 0 8px; color: var(--muted); font-size: 12px; }}
  code {{ display: block; color: var(--gold); font-size: 12px; margin-bottom: 8px;
    overflow-wrap: anywhere; }}
  pre {{ margin: 0; max-height: 250px; overflow: auto; white-space: pre-wrap;
    color: #d8c7a8; font-size: 11px; background: #0d0a07; padding: 8px 10px;
    border: 1px solid #33281a; }}
  aside {{ display: grid; gap: 14px; align-content: start; }}
  .surface {{ border: 1px solid var(--line); background: #100d09; padding: 12px; }}
  .surface h2 {{ margin: 0 0 10px; font-size: 15px; }}
  .mock-window {{ border: 1px solid var(--gold); background: #14100b; }}
  .mock-title {{ height: 30px; display: flex; align-items: center; gap: 8px;
    padding-left: 10px; background: var(--panel); border-bottom: 1px solid var(--line); }}
  .mock-title span.label {{ flex: 1; font-weight: 600; }}
  .mock-buttons {{ display: flex; gap: 4px; padding-right: 6px; }}
  .mock-btn {{ width: 22px; height: 18px; border: 1px solid var(--line);
    background: #3a2416; position: relative; }}
  .bar {{ position: absolute; left: 6px; top: 8px; width: 8px; height: 1px;
    background: var(--gold); }}
  .square {{ position: absolute; left: 6px; top: 5px; width: 7px; height: 7px;
    border: 1px solid var(--gold); }}
  .restore {{ position: absolute; width: 5px; height: 5px; border: 1px solid var(--gold); }}
  .restore.back {{ left: 5px; top: 4px; }}
  .restore.front {{ left: 9px; top: 8px; }}
  .x {{ position: absolute; width: 6px; height: 1px; background: var(--gold); }}
  .x.a {{ left: 5px; top: 5px; }} .x.b {{ left: 7px; top: 7px; }}
  .x.c {{ left: 9px; top: 9px; }} .x.d {{ left: 9px; top: 5px; }}
  .x.e {{ left: 7px; top: 7px; }} .x.f {{ left: 5px; top: 9px; }}
  .mock-body {{ height: 120px; display: grid; place-items: center; color: var(--muted); }}
  .envelopes {{ margin: 0; padding-left: 18px; color: var(--muted); font-size: 12px; }}
  .envelopes li {{ margin: 3px 0; }}
  .envelopes code {{ display: inline; margin: 0; font-size: 11px; }}
  .env {{ font-size: 10px; letter-spacing: .06em; text-transform: uppercase;
    padding: 1px 5px; border: 1px solid var(--line); }}
  .env.signed {{ color: var(--green); border-color: #4e7a4e; }}
  .env.unsigned {{ color: var(--muted); }}
  .env.refused, .env.absent {{ color: var(--red); border-color: #9a4a3a; }}
  .refusal {{ border: 1px solid #9a4a3a; background: #2a1410; padding: 12px 14px; }}
  .refusal h2 {{ margin: 0 0 6px; color: #f0b09e; font-size: 14px; }}
  .refusal p {{ margin: 0; color: #d6a28f; }}
  footer {{ padding: 0 24px 28px; color: var(--muted); font-size: 12px; }}
  @media (max-width: 900px) {{ main {{ grid-template-columns: 1fr; }} }}
</style>
</head>
<body>
  <header class="top">
    <h1>Openlock shell test surface</h1>
    <div class="sub">Browser witness for the CML/Panorama suites · generated {generated}</div>
  </header>
  <div class="banner {status_class}">{html.escape(banner)}</div>
  <main>
    <section class="cards">
      {cards}
    </section>
    <aside>
      <section class="surface">
        <h2>Launcher / installer surface</h2>
        <div class="mock-window" aria-label="Gameless launcher window with drawn controls">
          <div class="mock-title">
            <span class="label">Launcher</span>
            <span class="mock-buttons">
              <span class="mock-btn"><span class="bar"></span></span>
              <span class="mock-btn"><span class="square"></span></span>
              <span class="mock-btn"><span class="restore back"></span><span class="restore front"></span></span>
              <span class="mock-btn"><span class="x a"></span><span class="x b"></span><span class="x c"></span><span class="x d"></span><span class="x e"></span><span class="x f"></span></span>
            </span>
          </div>
          <div class="mock-body">choose a game install · the shell mounts after launch</div>
        </div>
        <p class="sub">The fake-tree suites assert the DOM classes; this panel makes the drawn
        controls visible so a font or clipping regression is not hidden in terminal output.</p>
      </section>
      {wish_section()}
      {envelope_section()}
      <section class="refusal">
        <h2>REFUSED — game files and templates</h2>
        <p>The browser witness is gameless. It carries the shell's streamer format
        (<code>openlock.game/1</code>) as code, but any <code>game-*</code> window, game layout
        entry, <code>file://</code> resource path, live-panel declaration or streamed game frame in
        the page fails the browser check by name; only the shell/launcher windows the user,
        developer or observer asked for are allowed.</p>
      </section>
      <section class="refusal">
        <h2>REFUSED — live client input</h2>
        <p>Drag, resize, glyph rendering, and the streamed game-window entrance in the running game
        were not observed in this pass. The browser surface is the gameless installer witness: it
        proves the shell's own frames and package surface only, and it refuses any game window or
        cell. The live client remains unobserved; <code>python tools/parity_check.py</code> is the
        separate live-install reading.</p>
      </section>
      <section class="refusal">
        <h2>REFUSED — Go shell port</h2>
        <p>The <code>agent_god_files/holo_shell</code> selftest was not run. It is the alternative
        witness when the browser surface cannot exercise a suite.</p>
      </section>
    </aside>
  </main>
  <footer>
    Reproduce with <code>python tools/shell_test_surface.py</code>. A suite with no card here is
    refused, not green. The parity gate is a separate live-install reading.
  </footer>
</body>
</html>
"""
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(page, encoding="utf-8")
    write_minimal()
    print(f"wrote {OUT.relative_to(ROOT)}")
    print(f"wrote {MINIMAL_OUT.relative_to(ROOT)}")
    for result in results:
        print(f"{result['status']:9} {result['name']:20} exit {result['code']} checks {result['count']}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

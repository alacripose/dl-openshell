"""Assemble the real shell into an isolated browser view.

The fake-tree suites exercise the script's calls. This page is the other witness: it includes the
actual `openlock_shell.xml` root, `openlock_shell_data.js`, `openlock_shell.js`, the shell styles and
a small Panorama-to-DOM adapter. The windows and controls on the page are created by the shell, not
by this file. Chromium then measures what it actually drew.

Run: python tools/shell_sandbox_surface.py
"""

from __future__ import annotations

import html
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGE = ROOT / "docs" / "shell-minimal.html"

DATA_SCRIPT = "clientaddon/panorama/scripts/openlock_shell_data.js"
SCRIPT_FILES = (
    DATA_SCRIPT,
    "clientaddon/panorama/scripts/openlock_audio.js",
    "clientaddon/panorama/scripts/openlock_popit.js",
    "clientaddon/panorama/scripts/openlock_layout.js",
    "clientaddon/panorama/scripts/openlock_split.js",
    "clientaddon/panorama/scripts/openlock_delivery.js",
    # The contour is drawn by the shell, so the fixture carries the shape and its runtime.
    "clientaddon/panorama/scripts/openlock_contour_data.js",
    "clientaddon/panorama/scripts/openlock_contour.js",
    "clientaddon/panorama/scripts/openlock_shell.js",
)
STYLE_FILES = (
    "clientaddon/panorama/styles/openlock_shell.css",
    "clientaddon/panorama/styles/openlock_popit.css",
    # The source tree's generated palettes and form geometry. Using the source file (not a
    # stale dist copy) is what lets the browser witness show the same Popit surface the
    # generator just built.
    "clientaddon/panorama/styles/openlock_schemes.css",
    # The pin loads last, exactly as it does in the game.
    "clientaddon/panorama/styles/openlock_pinned.css",
)

ADAPTER_CSS = r"""
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #0b0907; }
  #Hud { position: fixed; inset: 0; width: 100%; height: 100%; overflow: hidden; }
  #ShellRoot { position: fixed; inset: 0; width: 100%; height: 100%; overflow: hidden;
    color: #f4e6c8; font: 13px/1.3 "Segoe UI", system-ui, sans-serif; }
  .WindowLayer, .PanelLayer, .ToastStack, .DropGrid { position: absolute; left: 0; top: 0;
    width: 100%; height: 100%; }
  .WindowFrame { display: flex; flex-direction: column; box-sizing: border-box;
    position: absolute; }
  .WindowTitle { display: flex; flex: 0 0 30px; flex-direction: row; align-items: center;
    height: 30px; min-height: 30px; min-width: 0; box-sizing: border-box; }
  .WindowFrame.CompactHud .WindowTitle { flex-basis: 16px; height: 16px; min-height: 16px; }
  .WindowTitleLabel { flex: 1 1 auto; min-width: 0; align-self: center;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .WindowSpacer { flex: 1 1 auto; min-width: 1px; }
  .WindowCost { flex: 0 0 auto; align-self: center; }
  .WindowButton { display: flex; flex: 0 0 auto; align-items: center; justify-content: center;
    position: relative; box-sizing: border-box; cursor: pointer; }
  .WindowButton .WindowIcon { position: relative; display: block; flex: 0 0 auto;
    width: 8px; height: 8px; margin: 0; }
  /* The plate is the pinned start-window plate: counts over a Find row, both inside the title's
     own side ink. Panorama's flow-children down/right are flex here, as with the title. */
  .WindowPlate { display: flex; flex: 0 0 auto; flex-direction: column; box-sizing: border-box;
    width: 100%; }
  .WindowFrame.CompactHud .WindowPlate { display: none; }
  .WindowCounts { display: flex; flex: 0 0 14px; flex-direction: row; align-items: baseline; }
  .WindowFindRow { display: flex; flex: 0 0 22px; flex-direction: row; align-items: center; }
  .WindowFindBox { position: relative; display: flex; flex: 1 1 auto; min-width: 0;
    box-sizing: border-box; }
  .WindowFindEntry { display: block; width: 100%; height: 22px; box-sizing: border-box;
    font: inherit; outline: none; }
  .ViewRowBox { position: relative; display: block; box-sizing: border-box; }
  /* Panorama's `ignore-parent-flow` + left/top alignment is absolute placement: the contour's
     rows and rails are panels positioned by their own margins, so the adapter must take them out
     of the flow. Left in flow they stack full width and draw stripes instead of a silhouette. */
  .WindowFrame > .ContourSlices, .ViewRowBox > .ContourSlices, .WindowFindBox > .ContourSlices,
  .ViewAction > .ContourSlices, .ShellTab > .ContourSlices, .WindowsButton > .ContourSlices,
  .BarStart > .ContourSlices, .Clock > .ContourSlices { position: absolute; left: 0; top: 0; z-index: 0; }
  .ContourSlices > * { position: absolute; left: 0; top: 0; }
  /* A slice layer is placed against its own surface, so that surface has to be the containing
     block; a Label host would otherwise anchor the silhouette to the bar behind it. */
  .ShellTab, .WindowsButton, .BarStart, .Clock, .ViewRowBox, .WindowFindBox { position: relative; }
  /* A positioned slice layer paints above a static label in CSS; Panorama paints in child order and
     the layer is the first child. The label is lifted here so a bar cell's text reads. */
  .ShellTabLabel, .WindowsButtonLabel, .LauncherLabel, .SchemeLabel { position: relative; z-index: 1; }
  /* A Panorama label with a fixed height draws one line and ellipsises; a block in CSS would
     wrap its text past that height. */
  .VersionLabel, .WindowTitleLabel, .ShellTabLabel, .WindowsButtonLabel { white-space: nowrap; overflow: hidden; }
  /* A positioned panel paints above in-flow content in CSS, while a Panorama panel paints in child
     order. The silhouette is the first child and must stay behind the text, so the content is
     lifted over it here. */
  .WindowFrame > .WindowTitle, .WindowFrame > .WindowPlate, .WindowFrame > .WindowMeta,
  .WindowFrame > .WindowBody, .WindowFrame > .WindowRefusal,
  .ViewRowBox > .ViewAction, .ViewRowBox > .ViewLine, .ViewRowBox > .ViewMuted,
  .ViewRowBox > .ViewMeta, .ViewRowBox > .ViewHeading,
  .WindowFindBox > .WindowFindEntry { position: relative; z-index: 1; }
  /* A Panorama Label is a block in its parent's flow; a span is inline and would not stack the
     card's two lines. */
  .ViewAction, .ViewLine, .ViewMuted, .ViewMeta, .ViewHeading, .ViewGlyph { display: block; }
  .WindowMeta { display: block; flex: 0 0 17px; height: 17px; box-sizing: border-box;
    overflow: hidden; }
  .WindowFrame.CompactHud .WindowMeta { display: none; }
  .WindowBody { position: relative; flex: 1 1 0; min-height: 0; overflow: hidden;
    box-sizing: border-box; }
  .ResizeGrip { position: absolute; z-index: 60; }
  .GripNW { left: 0; top: 0; } .GripNE { right: 0; top: 0; }
  .GripSW { left: 0; bottom: 0; } .GripSE { right: 0; bottom: 0; }
  .WindowDrag { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }
  .LauncherBar, .Taskbar, .TaskbarRight, .TabStrip, .PreloadStrip, .ToastStack,
  .ContextMenu, .PopitSurface { box-sizing: border-box; }
  /* The shell positions the Popit with ignore-parent-flow + alignment + margins. The browser
     translation uses absolute positioning, so anchor the surface at the root origin before
     the inline margins move it. This is the adapter's placement, not a product colour/shape. */
  .PopitSurface { position: absolute; left: 0; top: 0; }
  .LauncherBar, .Taskbar, .TaskbarRight, .TabStrip { display: flex; flex-direction: row;
    align-items: center; }
  /* The real sheet makes the strip flexible and keeps the right cluster in flow. The adapter
     must mirror that, or the browser witness measures a different taskbar than the game. */
  .TabStrip { flex: 1 1 auto; min-width: 0; }
  .TaskbarRight { position: relative; right: auto; top: auto; width: fit-content;
    flex: 0 0 auto; }
  .ShellTab, .WindowsButton, .LauncherButton, .SchemeButton { flex: 0 0 auto;
    box-sizing: border-box; }
  .Panel { box-sizing: border-box; }
  .Measure { position: absolute; left: -9999px; top: -9999px; }
"""


def gameless_shell_data() -> str:
    """The shell catalog with every game template removed.

    The browser witness is the gameless launcher/installer surface. It must not carry the
    generated game window list, a live-panel declaration, or the game layout catalog: those are
    files for a running client, and a sanity check that quietly embeds them is holding game
    templates it cannot draw. Only shell-owned windows, the launcher installs and the build
    record remain.
    """
    text = (ROOT / DATA_SCRIPT).read_text(encoding="utf-8", errors="replace")
    marker = "var SHELL ="
    start = text.index(marker) + len(marker)
    data = json.loads(text[start:].rstrip().rstrip(";"))

    def game_template(window: dict) -> bool:
        ident = str(window.get("id") or "")
        content = str(window.get("content") or "")
        return (ident.startswith("game-") or window.get("lane") == "game"
                or content.startswith("file://") or bool(window.get("panel")))

    windows = [window for window in data.get("windows", []) if not game_template(window)]
    ids = {str(window.get("id") or "") for window in windows}
    data["windows"] = windows
    data["tabs"] = [tab for tab in data.get("tabs", []) if tab in ids]
    data["bar"] = data.get("bar", "") if data.get("bar", "") in ids else ""
    data["pins"] = [pin for pin in data.get("pins", []) if pin in ids]
    data["filed"] = [row for row in data.get("filed", [])
                     if row.get("window") in ids and row.get("tab") in ids]
    # The game layout catalog is a template index. A gameless sanity check has no use for it.
    data["layouts"] = []
    for window in windows:
        if not isinstance(window.get("layers"), list):
            continue
        layers = []
        for layer in window["layers"]:
            if not isinstance(layer, dict):
                continue
            actions = [action for action in layer.get("actions", [])
                       if not action.get("window") or action.get("window") in ids]
            if actions:
                layer["actions"] = actions
                layers.append(layer)
        if layers:
            window["layers"] = layers
        else:
            window.pop("layers", None)

    # The package-envelope reading is the optional security proof. The generated game data
    # carries it; a stale generated file is measured here rather than trusted, so the browser
    # witness never reports a surface the generator did not read.
    import package_envelope

    if not data.get("envelopes"):
        data["envelopes"] = package_envelope.check_surfaces(ROOT)

    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return "var SHELL = " + payload.replace("</", "<\\/") + ";\n"


def translate_css(source: str) -> str:
    """Translate the Panorama layout properties a browser does not know.

    This changes no colour, size, border or selector. It only maps the flow vocabulary the game
    engine owns onto flexbox, and the visibility spelling.
    """
    css = source
    # Panorama's wrapping flows are not one CSS keyword. Without this translation a
    # `right-wrap` grid becomes block children: every Popit item takes a full row and the
    # tray balloons past the screen.
    css = re.sub(
        r"flow-children:\s*(right-wrap|left-wrap)\s*;",
        lambda m: ("display: flex; flex-direction: " +
                   ("row" if m.group(1) == "right-wrap" else "row-reverse") +
                   "; flex-wrap: wrap;"),
        css)
    css = re.sub(
        r"flow-children:\s*(down|up|left|right)\s*;",
        lambda match: "display: flex; flex-direction: "
        + {"down": "column", "up": "column-reverse", "left": "row", "right": "row"}[match.group(1)]
        + ";",
        css,
    )
    css = re.sub(r"width:\s*fill-parent-flow\(1\)\s*;", "flex: 1 1 auto; width: auto;", css)
    css = re.sub(r"height:\s*fill-parent-flow\(1\)\s*;", "flex: 1 1 auto; height: auto;", css)
    css = re.sub(r"width:\s*fit-children\s*;", "width: fit-content;", css)
    css = re.sub(r"height:\s*fit-children\s*;", "height: fit-content;", css)
    css = re.sub(r"visibility:\s*collapse\s*;", "display: none;", css)
    css = re.sub(r"overflow:\s*clip\s*;", "overflow: hidden;", css)
    css = re.sub(r"overflow:\s*squish\s+scroll\s*;", "overflow: auto;", css)
    css = re.sub(r"ignore-parent-flow:\s*true\s*;", "position: absolute;", css)
    # Panorama paints with `gradient( linear, from( C ), color-stop( p, C ), to( C ) )`; a browser
    # reads `linear-gradient`. Without this the bar's brass wash was dropped in the witness and the
    # strip rendered as flat ink, which is not the look the sheet declares.
    stop = re.compile(
        r"background-color:\s*gradient\(\s*linear\s*,\s*[\d.]+%\s+[\d.]+%\s*,\s*[\d.]+%\s+[\d.]+%\s*,(?P<stops>[^;]*)\)"
    )

    def to_linear(match):
        parts = []
        tokens = re.finditer(
            r"from\(\s*(#[0-9a-fA-F]{3,8})\s*\)|color-stop\(\s*([\d.]+)\s*,\s*(#[0-9a-fA-F]{3,8})\s*\)|to\(\s*(#[0-9a-fA-F]{3,8})\s*\)",
            match.group("stops"),
        )
        for token in tokens:
            if token.group(1):
                parts.append(token.group(1) + " 0%")
            elif token.group(3):
                parts.append(token.group(3) + " " + str(round(float(token.group(2)) * 100, 2)) + "%")
            elif token.group(4):
                parts.append(token.group(4) + " 100%")
        if not parts:
            return match.group(0)
        return "background-image: linear-gradient(180deg, " + ", ".join(parts) + ")"

    css = stop.sub(to_linear, css)
    return css


def script_tag(path: str) -> str:
    return "<script>\n" + (ROOT / path).read_text(encoding="utf-8", errors="replace") + "\n</script>\n"


def measurement_script() -> str:
    return r"""
<script>
(function () {
  function box(el) { var r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height }; }
  function fail(issues, text) { issues.push(text); }
  function reachable(el) {
    var r = box(el);
    var hit = document.elementFromPoint(r.x + r.w / 2, r.y + r.h / 2);
    return !!hit && (hit === el || el.contains(hit));
  }
  // Sample the final taskbar tabs while the preload hands off to them. A hard cut has no
  // sample below full opacity and no negative inline margin; the entrance curve has both.
  var tabMotion = { samples: 0, minOpacity: 1, sawOffset: false, settled: 0 };
  var motionTimer = window.setInterval(function () {
    var tabs = document.querySelectorAll('.TabStrip .ShellTab');
    if (!tabs.length) return;
    tabMotion.samples++;
    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      var opacity = parseFloat(getComputedStyle(tab).opacity);
      if (!isFinite(opacity)) opacity = 1;
      tabMotion.minOpacity = Math.min(tabMotion.minOpacity, opacity);
      var margin = parseFloat(tab.style.marginLeft || '0');
      if (margin < -0.5) tabMotion.sawOffset = true;
      if (opacity > 0.99 && Math.abs(margin) < 0.5) tabMotion.settled++;
    }
  }, 20);
  window.setTimeout(function () { window.clearInterval(motionTimer); }, 3700);
  function measure() {
    var issues = [], frames = [];
    var sandbox = globalThis.OpenlockSandbox || { errors: [], frames: () => [] };
    (sandbox.errors || []).forEach(function (text) { fail(issues, text); });
    // Refusal: this page is the gameless launcher/installer witness. A game window template, a
    // live-panel selector, a game layout entry or a game resource path means it is holding a
    // client surface it cannot draw. Name it instead of measuring a page that quietly carries
    // game files the user/dev/observer did not ask for.
    var shellData = globalThis.SHELL || {};
    // The optional package envelope: four surfaces, each signed or unsigned. A refused
    // envelope means a package declared its signature and did not hold; the installer witness
    // must fail by name rather than draw a package it cannot vouch for.
    var envelopes = shellData.envelopes || [];
    if (envelopes.length !== 4) {
      fail(issues, 'the installer witness read ' + envelopes.length +
        ' package envelope(s), expected 4');
    }
    var refusedEnvelopes = envelopes.filter(function (row) { return row.state === 'refused'; });
    if (refusedEnvelopes.length) {
      fail(issues, 'package envelope refused by name: ' + refusedEnvelopes[0].file +
        ' (' + ((refusedEnvelopes[0].refusals || [])[0] || {}).kind + ')');
    }
    // The installer build carries the game package streamer format even though the witness is
    // gameless: the format is code, the game's own windows and cells are data. A build without
    // the format cannot open a streamed game frame in the running client at all.
    var streamerFormat = "";
    try {
      streamerFormat = String(globalThis.OpenlockStreamPackage &&
        globalThis.OpenlockStreamPackage.format || "");
    } catch (e) { streamerFormat = ""; }
    if (streamerFormat !== 'openlock.game/05b2d815a8a5f1006596d6b0d9e0fa27') {
      fail(issues, 'the installer build does not carry the game package streamer format');
    }
    var leaked = (shellData.windows || []).filter(function (win) {
      var id = String(win.id || ""), content = String(win.content || "");
      return id.indexOf("game-") === 0 || win.lane === "game" ||
        content.indexOf("file://") === 0 || !!win.panel;
    });
    if (leaked.length) {
      fail(issues, 'browser sanity check still carries ' + leaked.length +
        ' game window template(s), e.g. ' + leaked[0].id);
    }
    if ((shellData.layouts || []).length) {
      fail(issues, 'browser sanity check still carries the game layout catalog (' +
        shellData.layouts.length + ' entries)');
    }
    // The refusal is by declaration, not by title: a frame whose id belongs to the game is a
    // game window whether the package baked it in or a runtime streamer produced it. The
    // browser witness never draws the client's own windows, so it never excuses one.
    var gameFrames = Array.prototype.slice.call(document.querySelectorAll('.WindowFrame')).filter(function (frame) {
      var ident = String(frame.id || '').replace(/^OpenlockFrame_/, '').replace(/_/g, '-');
      if (/^game-/.test(ident)) return true;
      var title = frame.querySelector('.WindowTitleLabel');
      var text = title ? (title.textContent || '') : '';
      return /^(Abilities|Minimap|Citadel)\b/i.test(text) || /citadelhud/i.test(text);
    });
    if (gameFrames.length) {
      fail(issues, 'browser sanity check drew ' + gameFrames.length + ' live-game window(s), e.g. ' +
        ((gameFrames[0] && gameFrames[0].id) || 'a game frame'));
    }
    var vw = window.innerWidth, vh = window.innerHeight;
    // A toast is a transient notice above every frame. It is not part of the window's geometry;
    // hide it only while hit-testing so a corner grip is measured against the frame, then restore
    // it. The toast itself stays visible in the rendered result.
    var toastStack = document.querySelector('.ToastStack');
    var toastVisibility = toastStack ? toastStack.style.visibility : '';
    if (toastStack) toastStack.style.visibility = 'hidden';
    var bars = document.querySelectorAll('.LauncherBar').length + document.querySelectorAll('.Taskbar').length;
    if (!bars) fail(issues, 'the launcher bar and taskbar are not drawn');
    // The taskbar is one row. The tab strip must end before the right cluster, not paint
    // underneath Dashboard, Windows, the build label or the clock. 4:3 is the pressure case.
    var taskbar = document.querySelector('.Taskbar');
    var tabStrip = document.querySelector('.TabStrip');
    var rightCluster = document.querySelector('.TaskbarRight');
    var taskbarReading = null;
    if (taskbar && tabStrip && rightCluster) {
      var ts = box(tabStrip), rc = box(rightCluster);
      taskbarReading = { stripLeft: Math.round(ts.x), stripRight: Math.round(ts.x + ts.w),
        rightLeft: Math.round(rc.x), rightRight: Math.round(rc.x + rc.w) };
      if (ts.x + ts.w > rc.x + 1) {
        fail(issues, 'taskbar tabs overlap the right cluster (' + Math.round(ts.x + ts.w) +
          ' > ' + Math.round(rc.x) + '); ' + JSON.stringify(taskbarReading));
      }
      if (rc.x + rc.w > vw + 1) fail(issues, 'taskbar right cluster leaves the viewport');
      var tabs = Array.prototype.slice.call(tabStrip.querySelectorAll('.ShellTab'));
      tabs.forEach(function (tab) {
        var tb = box(tab);
        // A tab beyond the strip edge is clipped by the strip, not painted under the right
        // cluster. Measure the visible portion so the check does not report off-strip overflow.
        var visibleRight = Math.min(tb.x + tb.w, ts.x + ts.w);
        if (tb.w > 0 && visibleRight > rc.x + 1) {
          fail(issues, 'taskbar tab "' + (tab.textContent || '').trim() +
            '" reaches under the right cluster');
        }
      });
      Array.prototype.slice.call(rightCluster.children).forEach(function (child) {
        var c = box(child);
        if (c.w > 0 && !reachable(child)) {
          fail(issues, 'taskbar right-cluster control "' + (child.textContent || '').trim() +
            '" is not pointer-reachable');
        }
      });
    } else {
      fail(issues, 'the taskbar strip or right cluster is missing');
    }
    var all = Array.prototype.slice.call(document.querySelectorAll('.WindowFrame')).filter(function (frame) {
      var style = getComputedStyle(frame);
      return style.visibility !== 'hidden' && style.display !== 'none' &&
        frame.getBoundingClientRect().width > 0;
    });
    if (!all.length) fail(issues, 'the shell created no visible window frame');
    all.forEach(function (frame) {
      var id = frame.id || 'frame';
      // Frames overlap by design; a lower layer is not reachable until it is focused. Hide the
      // other frames for this frame's hit-test, then restore them, so the check measures the
      // control's geometry rather than which sibling happens to be on top.
      var hidden = [];
      all.forEach(function (other) {
        if (other === frame) return;
        hidden.push([other, other.style.display]);
        other.style.display = 'none';
      });
      var f = box(frame);
      if (f.w < 120 || f.h < 80) fail(issues, id + ': frame is too small ' + Math.round(f.w) + 'x' + Math.round(f.h));
      if (f.x < -2 || f.y < -2 || f.x + f.w > vw + 2 || f.y + f.h > vh + 2) {
        fail(issues, id + ': frame leaves the viewport');
      }
      var title = frame.querySelector('.WindowTitle');
      if (!title) { fail(issues, id + ': no title strip'); return; }
      var t = box(title);
      // The pin is `pins/contour-pin.json` (model-forge), `surfaces.plate.title_px`: the start
      // window's plate is 36, cut from the corner band, and a compact HUD keeps its 16 px strip.
      var expected = frame.classList.contains('CompactHud') && !frame.classList.contains('Focused') ? 16 : 36;
      if (Math.abs(t.h - expected) > 1) fail(issues, id + ': title height ' + Math.round(t.h) + ' != ' + expected);
      var buttons = Array.prototype.slice.call(frame.querySelectorAll('.WindowButton'));
      if (buttons.length < 4) fail(issues, id + ': ' + buttons.length + ' window controls, expected at least 4');
      buttons.forEach(function (button) {
        var b = box(button);
        var narrow = frame.classList.contains('Narrow');
        var compact = frame.classList.contains('CompactHud');
        // `surfaces.plate.control_px`: the pin's plate carries 20x20 controls in the `.FormPopit`
        // form this build ships (the 26x22 this probe expected was any-form geometry read from the
        // reference at its own scale).
        var expectedW = narrow ? 8 : (compact ? 14 : 20);
        var expectedH = narrow ? 8 : (compact ? 14 : 20);
        if (Math.abs(b.w - expectedW) > 1 || Math.abs(b.h - expectedH) > 1) {
          fail(issues, id + ': control ' + (button.className || '?') + ' is ' +
            Math.round(b.w) + 'x' + Math.round(b.h) + ', expected ' + expectedW + 'x' + expectedH);
        }
        if (!reachable(button)) fail(issues, id + ': a control is not pointer-reachable');
        if (button.textContent.trim() !== '') fail(issues, id + ': a control contains a typed codepoint');
        if (!button.querySelector('.IconStroke, .IconFrame, .IconPinHead, .IconPinStem, .IconMoveBarH, .IconMoveBarV, .IconPopit')) {
          fail(issues, id + ': a control has no drawn shape');
        }
      });
      // `surfaces.plate.row_px` = 22: a one-line row is the pin's card, and a row that carries its
      // second line (the reference's meta line) is `surfaces.plate.card_px` = 43.2. The row band is
      // what the pin measures; a card is the same row with the meta line inside it.
      if (!frame.classList.contains('CompactHud')) {
        Array.prototype.slice.call(frame.querySelectorAll('.ViewRowBox')).forEach(function (row) {
          if (row.classList.contains('ViewHead')) return;
          // Only a row a reader can choose is the pin's card; an informational line takes the
          // height its text needs and is not a control.
          if (!row.querySelector('.ViewAction')) return;
          var r = box(row);
          var wants = row.classList.contains('HasMeta') ? 43.2 : 22;
          if (r.h > 0 && Math.abs(r.h - wants) > 1.5) {
            fail(issues, id + ': row "' + (row.textContent || '').trim().slice(0, 24) +
              '" is ' + Math.round(r.h) + ' high, expected ' + wants);
          }
        });
      }
      var grips = Array.prototype.slice.call(frame.querySelectorAll('.ResizeGrip')).filter(function (grip) {
        var style = getComputedStyle(grip);
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          box(grip).w > 0;
      });
      // Automatic HUD frames use the compact schema: the two top grips are collapsed and the
      // whole grip set retires at idle. That is deliberate chrome, not a missing handle. Only the
      // shell's own windows are required to keep all four grips reachable.
      if (!frame.classList.contains('CompactHud')) {
        if (grips.length !== 4) fail(issues, id + ': ' + grips.length + ' visible resize grips, expected 4');
        grips.forEach(function (grip) {
          var g = box(grip);
          if (g.w < 8 || g.h < 8) fail(issues, id + ': a resize grip is ' + Math.round(g.w) + 'x' + Math.round(g.h));
          if (!reachable(grip)) fail(issues, id + ': a resize grip is not pointer-reachable');
        });
      }
      frames.push({ id: id, w: Math.round(f.w), h: Math.round(f.h), title: Math.round(t.h),
        controls: buttons.length, grips: grips.length });
      hidden.forEach(function (entry) { entry[0].style.display = entry[1]; });
    });
    if (toastStack) toastStack.style.visibility = toastVisibility;
    // The installer/launcher witness proves the shell's own package surface: the addon package
    // window is drawn from a streamed XML tree and its Label/Button follow the pointer rule.
    var addonHosts = Array.prototype.slice.call(document.querySelectorAll('.AddonHost'));
    if (!addonHosts.length) {
      fail(issues, 'the addon package surface did not open');
    } else {
      var streamLabel = addonHosts[0].querySelector('.SandboxProofLabel');
      var streamButton = addonHosts[0].querySelector('.SandboxProofButton');
      if (!streamLabel || !streamButton) {
        fail(issues, 'the addon package surface has no label/button proof');
      } else {
        if (getComputedStyle(streamLabel).pointerEvents !== 'none') {
          fail(issues, 'a streamed XML Label is hit-testable');
        }
        if (getComputedStyle(streamButton).pointerEvents === 'none') {
          fail(issues, 'a streamed XML Button is not hit-testable');
        }
      }
    }
    // `bar_metrics start=93 startx=18`: the bar's Start cell is the pin's own measured width, and
    // it is the first thing the pointer meets on the left of the strip.
    var startCell = document.querySelector('.BarStart') || document.querySelector('.WindowsButton');
    if (!startCell) {
      fail(issues, 'the bar has no Start cell');
    } else {
      var sc = box(startCell);
      if (Math.abs(sc.w - 93) > 1) fail(issues, 'the Start cell is ' + Math.round(sc.w) + ' wide, expected 93');
      if (Math.abs(sc.x - 18) > 1) fail(issues, 'the Start cell starts at ' + Math.round(sc.x) + ', expected 18');
    }
    // A game window/cell stream is the running client's surface. The installer witness never
    // opens one, so a StreamedXml frame here means the sandbox booted a game package.
    var streamedFrames = Array.prototype.slice.call(document.querySelectorAll('.WindowFrame.StreamedXml'));
    if (streamedFrames.length) {
      fail(issues, 'browser sanity check opened ' + streamedFrames.length +
        ' streamed game surface(s), e.g. ' + (streamedFrames[0].id || 'a streamed frame'));
    }
    if (tabMotion.samples === 0) {
      fail(issues, 'the taskbar tabs were never sampled');
    } else if (tabMotion.minOpacity >= 0.99 && !tabMotion.sawOffset) {
      fail(issues, 'taskbar tabs cut in with no entrance motion');
    } else if (!tabMotion.settled) {
      fail(issues, 'taskbar tabs never settled at full opacity and normal margin');
    }
    // The wish list is the plan, not the verdicts: every other-game install the parser found is
    // read here from the same SHELL data the page drew from, so a gameless witness still shows
    // what the shell plans to load into another game without carrying one game template.
    var wishRows = (shellData.wishes || []).map(function (wish) {
      return { kind: wish.kind, state: wish.state, surface: wish.surface, plan: wish.plan };
    });
    var gameWishes = wishRows.filter(function (row) { return row.kind === 'game'; });
    var result = { state: issues.length ? 'fail' : 'pass', viewport: { w: vw, h: vh },
      frames: frames, bars: bars, taskbar: taskbarReading, taskbarMotion: tabMotion,
      addonPackages: addonHosts.length, streamedXml: streamedFrames.length,
      streamerFormat: streamerFormat,
      envelopes: envelopes.map(function (row) { return row.file + ':' + row.state; }),
      gameTemplates: leaked.length, gameLayouts: (shellData.layouts || []).length,
      wishes: { total: wishRows.length, game: gameWishes.slice(0, 9),
        refused: wishRows.filter(function (row) { return row.state === 'refused'; }).length },
      issues: issues.slice(0, 12),
      shellMessages: (globalThis.OpenlockSandbox && globalThis.OpenlockSandbox.messages || []).slice(-12) };
    document.documentElement.setAttribute('data-shell-draw', result.state);
    document.getElementById('shell-measure').textContent = JSON.stringify(result);
  }
  window.setTimeout(measure, 3800);
}());
</script>
"""


def write() -> Path:
    styles = "\n".join(
        (ROOT / path).read_text(encoding="utf-8", errors="replace")
        for path in STYLE_FILES
        if (ROOT / path).is_file()
    )
    layout = (ROOT / "clientaddon/panorama/layout/openlock_shell.xml").read_text(
        encoding="utf-8", errors="replace"
    )
    runtime = (ROOT / "tools/shell_sandbox_runtime.js").read_text(encoding="utf-8", errors="replace")
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    page = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Openlock shell sandbox</title>
<style>
__STYLES__
</style>
<style>
__ADAPTER__
</style>
</head>
<body>
<div id="Hud"><div id="ShellRoot" class="ShellRoot"></div></div>
<pre class="Measure" id="shell-measure" aria-hidden="true"></pre>
<script id="shell-layout-xml" type="text/plain">__LAYOUT__</script>
<script>
__RUNTIME__
</script>
__SCRIPTS__
<script>
  document.documentElement.setAttribute('data-shell-sandbox', '__GENERATED__');
</script>
__MEASUREMENT__
</body>
</html>
"""
    page = page.replace("__STYLES__", translate_css(styles))
    page = page.replace("__ADAPTER__", ADAPTER_CSS)
    page = page.replace("__LAYOUT__", layout)
    page = page.replace("__RUNTIME__", runtime)
    scripts = []
    for path in SCRIPT_FILES:
        if path == DATA_SCRIPT:
            scripts.append("<script>\n" + gameless_shell_data() + "</script>\n")
        else:
            scripts.append(script_tag(path))
    page = page.replace("__SCRIPTS__", "".join(scripts))
    page = page.replace("__GENERATED__", html.escape(generated))
    page = page.replace("__MEASUREMENT__", measurement_script())
    PAGE.parent.mkdir(parents=True, exist_ok=True)
    PAGE.write_text(page, encoding="utf-8")
    return PAGE


if __name__ == "__main__":
    print(f"wrote {write().relative_to(ROOT)}")

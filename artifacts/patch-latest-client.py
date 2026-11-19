from pathlib import Path

ROOT = Path(r"C:\Users\ala\Documents\openlock")

css_path = ROOT / "clientaddon" / "panorama" / "styles" / "openlock_shell.css"
raw = css_path.read_bytes()
text = raw.decode("utf-8")
nl = "\r\n" if b"\r\n" in raw else "\n"

old_header = (
    "/* Openlock shell: the window manager.\n"
    "   The palette is Deadlock's own warm parchment on a dark surface. Positions are absolute because\n"
    "   the package declares every window's geometry and the shell draws it where it was declared.\n"
    "   Pointer targets follow MD1's dense-pointer pair (40 dp target, 20 dp glyph) as the alpha shell\n"
    "   does; the shell is pointer-driven and never joins the game's gamepad focus graph. */"
).replace("\n", nl)
new_header = (
    "/* Openlock shell: the window manager.\n"
    "   The palette is Deadlock's own warm parchment on a dark surface. A panel that the package places\n"
    "   at a declared point leaves its parent's flow with ignore-parent-flow, which is Panorama's name\n"
    "   for the absolute placement the shell means; `position` is not a Panorama property and the\n"
    "   2026-11 client rejects both values. Pointer targets follow MD1's dense-pointer pair (40 dp\n"
    "   target, 20 dp glyph) as the alpha shell does; the shell is pointer-driven and never joins the\n"
    "   game's gamepad focus graph. */"
).replace("\n", nl)

assert text.count(old_header) == 1, "CSS header changed"
text = text.replace(old_header, new_header)

absolute = "    position: absolute;"
assert text.count(absolute) == 33, "expected 33 absolute declarations, found %d" % text.count(absolute)
text = text.replace(absolute, "    ignore-parent-flow: true;")

relative = "    position: relative;" + nl
assert text.count(relative) == 3, "expected 3 relative declarations, found %d" % text.count(relative)
text = text.replace(relative, "")

assert "position: absolute;" not in text
assert "position: relative;" not in text
css_path.write_bytes(text.encode("utf-8"))

js_path = ROOT / "clientaddon" / "panorama" / "scripts" / "openlock_shell.js"
js_raw = js_path.read_bytes()
js = js_raw.decode("utf-8")
js_nl = "\r\n" if b"\r\n" in js_raw else "\n"

old_js = (
    "            var key = \"popup:\" + (entry.panel.id || classesOf(entry.panel) || f).replace(/[^A-Za-z0-9_]/g, \"_\") +\n"
    "                \":\" + Math.round(natural.w) + \"x\" + Math.round(natural.h);\n"
    "            if (popupFramed[key] || dismissed[key]) continue;\n"
    "            popupFramed[key] = true;\n"
    "            var label = classesOf(entry.panel) || entry.panel.id || \"Popup\";\n"
    "            frameLive({ id: entry.panel.id || classesOf(entry.panel) || (\"popup_\" + f),"
).replace("\n", js_nl)
new_js = (
    "            // `id` is not guaranteed to be a string on the live client; one popup root returns a\n"
    "            // panel object here. Coerce before the key's replace, or the scan aborts on that one\n"
    "            // entry and every later popup in the same pass is skipped.\n"
    "            var popupName = String(entry.panel.id || classesOf(entry.panel) || f);\n"
    "            var key = \"popup:\" + popupName.replace(/[^A-Za-z0-9_]/g, \"_\") +\n"
    "                \":\" + Math.round(natural.w) + \"x\" + Math.round(natural.h);\n"
    "            if (popupFramed[key] || dismissed[key]) continue;\n"
    "            popupFramed[key] = true;\n"
    "            var label = classesOf(entry.panel) || popupName;\n"
    "            frameLive({ id: entry.panel.id || classesOf(entry.panel) || (\"popup_\" + f),"
).replace("\n", js_nl)

assert js.count(old_js) == 1, "popup scan block changed"
js = js.replace(old_js, new_js)
js_path.write_bytes(js.encode("utf-8"))

print("patched", css_path)
print("patched", js_path)
print("css newline", "CRLF" if nl == "\r\n" else "LF")
print("js newline", "CRLF" if js_nl == "\r\n" else "LF")

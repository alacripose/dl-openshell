// Stable identity for a split of a window the shell discovered.
//
// A declared window is named by the package, so its id is its identity. A discovered window is
// named by the game's own HUD: `live:<name>:<w>x<h>`, `popup:<name>:<w>x<h>`, `hud:<name>`. Those
// ids move when the mod renames a panel or the HUD rebuilds at another size, and a split whose
// cells are keyed to such an id orphans its cells across a reload. A split therefore gets a
// durable key derived from what the window is — its kind, its name and its class family, never its
// measured size — and the saved layout pins that key so the cells resolve after the id changes.
//
// A window with neither a name nor a class family cannot be pinned. That case keeps its refusal,
// and the refusal names why.
//
// Run: node .scratch/split-identity-test.js
var OpenlockSplit = (function () {
    "use strict";

    var SIZE_SUFFIX = /:\d+x\d+$/;
    var MAX_KEY = 64;

    function sanitize(value, limit) {
        var text = String(value == null ? "" : value).replace(/[^A-Za-z0-9_]/g, "_");
        text = text.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
        return text.substring(0, limit || 42);
    }

    // A discovered id is `<kind>:<name>:<w>x<h>` or `hud:<name>`. The kind and the name are the
    // durable half; the measured size is the half that changes.
    function partsOf(id) {
        var raw = String(id || "");
        var head = raw.replace(SIZE_SUFFIX, "");
        var bits = head.split(":");
        return {
            kind: sanitize(bits[0] || "", 12),
            name: sanitize(bits.length > 1 ? bits[1] : "", 48)
        };
    }

    function kindOf(win) {
        var id = String((win && win.id) || "");
        var bits = id.split(":");
        if (bits.length > 1 && /^(live|popup|hud|cell)$/.test(bits[0])) return bits[0];
        return "";
    }

    function isDiscovered(win) {
        if (!win) return false;
        if (win.discovered || win.live) return true;
        return !!kindOf(win);
    }

    // { key, why }. `key` is "" exactly when the window's identity cannot be pinned, and `why`
    // then says which marker is missing.
    function stableKey(win) {
        if (!win) return { key: "", why: "the window is not readable" };
        if (!isDiscovered(win)) {
            var declared = sanitize(win.id, MAX_KEY);
            return declared ? { key: declared, why: "" }
                : { key: "", why: "the window has no id" };
        }

        var bits = partsOf(win.id);
        var kind = kindOf(win) || "live";
        var name = sanitize(win.discoveredBase, 48) || bits.name;
        var cls = sanitize(win.discoveredClass, 42);
        var title = sanitize(win.title, 42);

        var label = name || cls || title;
        if (!label) {
            return {
                key: "",
                why: "its id carries no name and it declares no class or label to pin"
            };
        }
        if (/^(part\d*|panel_\d+|window_\d+)$/.test(label)) {
            // The discovery fallbacks (`panel_3`, `part2`) are positions, not identities.
            return { key: "", why: "its discovery name is a position, not an identity" };
        }
        var key = "split:" + kind + "_" + label;
        if (cls && cls !== label) key += "_" + cls;
        if (key.length > MAX_KEY) key = key.substring(0, MAX_KEY);
        return { key: key, why: "" };
    }

    function cellId(key, path) {
        return "cell:" + String(key || "") + ":" + String(path || "");
    }

    // One pinned source row per split key: what the window was when it was split.
    function sourceOf(win, key) {
        var bits = partsOf(win && win.id);
        return {
            key: String(key || ""),
            id: String((win && win.id) || ""),
            kind: kindOf(win) || bits.kind,
            name: sanitize(win && win.discoveredBase, 48) || bits.name,
            cls: sanitize(win && win.discoveredClass, 42),
            title: String((win && win.title) || "")
        };
    }

    function score(source, win) {
        if (!source || !win) return 0;
        var bits = partsOf(win.id);
        if (source.kind && bits.kind && source.kind !== bits.kind) return 0;
        var name = sanitize(win.discoveredBase, 48) || bits.name;
        var cls = sanitize(win.discoveredClass, 42);
        if (source.id && source.id === win.id) return 8;
        if (source.name && name && source.name === name) return 4;
        if (source.cls && cls && source.cls === cls) return 2;
        if (source.title && win.title && source.title === win.title) return 1;
        return 0;
    }

    // Map each pinned key to the window carrying it now. A source with no match is unresolved and
    // says why; its cells stay saved and nothing is dropped or guessed at.
    function resolve(sources, discovered) {
        var resolved = [];
        for (var i = 0; i < (sources || []).length; i++) {
            var source = sources[i];
            if (!source || !source.key) continue;
            var best = null;
            var bestScore = 0;
            for (var k = 0; k < (discovered || []).length; k++) {
                var win = discovered[k];
                var value = score(source, win);
                if (value > bestScore) { best = win; bestScore = value; }
            }
            resolved.push({
                key: source.key,
                id: best ? String(best.id || "") : "",
                source: source,
                why: best ? "" : "no discovered window carries its name or class after the reload"
            });
        }
        return resolved;
    }

    // The cells a resolved key owns, by their stored root. A cell whose root still matches keeps
    // its id, so its saved rect and theme still resolve.
    function cellsFor(cells, key) {
        var out = [];
        for (var i = 0; i < (cells || []).length; i++) {
            var cell = cells[i];
            if (!cell) continue;
            if (String(cell.cellRoot || "") === key) out.push(cell);
        }
        return out;
    }

    function pathOf(cell) {
        var path = String((cell && cell.cellPath) || "");
        if (path) return path;
        var id = String((cell && cell.id) || "");
        var at = id.lastIndexOf(":");
        return at >= 0 ? id.substring(at + 1) : "";
    }

    return {
        stableKey: stableKey,
        cellId: cellId,
        sourceOf: sourceOf,
        resolve: resolve,
        cellsFor: cellsFor,
        pathOf: pathOf,
        isDiscovered: isDiscovered,
        partsOf: partsOf
    };
}());

if (typeof globalThis !== "undefined") globalThis.OpenlockSplit = OpenlockSplit;

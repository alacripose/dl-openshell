// Openlock layout arbitration: the one owner of "who gets this space".
//
// The shell is an overlay, not a layout. Opening it used to leave every game panel where the
// game drew it, so the shell's bar and window chrome painted over the game's top bar, taskbar
// rows and cells. This module does the layout pass the shell was missing:
//
//   * it reserves the edge insets the shell occupies (the bar, plus the per-window chrome);
//   * every participant asks for a rect with `place()`, and gets back the rect it should draw;
//   * the first request while open records the participant's pre-shell rect;
//   * closing the shell returns every participant to that recorded rect;
//   * a participant that cannot fit is refused by name instead of being silently clipped.
//
// It deliberately holds no Panorama references. The shell measures the live tree and passes
// plain rectangles, so the same pass can run in the game, in the dashboard editor and in the
// headless harness. Keep the arithmetic here; call sites only ask for a placement.
//
// The name is `OpenlockLayoutPass`, not `OpenlockLayout`: the shell already exports
// `OpenlockLayout(path)` as the console command that mounts an arbitrary XML layout.
(function () {
    "use strict";

    var screenW = 1600;
    var screenH = 900;
    var insets = { top: 0, right: 0, bottom: 0, left: 0 };
    var open = false;
    var records = {};
    var refusals = [];
    var refusalKeys = {};

    function finite(value, fallback) {
        var n = Number(value);
        return isFinite(n) ? n : fallback;
    }

    function edge(value) {
        return Math.max(0, Math.round(finite(value, 0)));
    }

    function clamp(value, low, high) {
        return Math.max(low, Math.min(high, value));
    }

    function copyRect(rect) {
        var source = rect || {};
        return {
            x: finite(source.x, 0),
            y: finite(source.y, 0),
            w: Math.max(1, finite(source.w, 1)),
            h: Math.max(1, finite(source.h, 1))
        };
    }

    function sameRect(a, b) {
        return !!a && !!b &&
            Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 &&
            Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
    }

    function result(record) {
        return {
            x: record.placed.x,
            y: record.placed.y,
            w: record.placed.w,
            h: record.placed.h,
            dx: record.dx,
            dy: record.dy,
            // `first` is the session's first layout of this participant. The shell applies that
            // one in the same tick; later geometry changes are motion, not a layout.
            first: !!record.first,
            refused: record.refused,
            reason: record.reason
        };
    }

    // The shell bar and taskbar may be on any edge eventually (ticket #8). The pass already
    // accepts all four insets, so a side-docked bar changes one number, not every call site.
    function configure(next) {
        if (!next) return state();
        if (next.top !== undefined) insets.top = edge(next.top);
        if (next.right !== undefined) insets.right = edge(next.right);
        if (next.bottom !== undefined) insets.bottom = edge(next.bottom);
        if (next.left !== undefined) insets.left = edge(next.left);
        return state();
    }

    function setViewport(width, height) {
        var w = finite(width, 0);
        var h = finite(height, 0);
        if (w > 0) screenW = w;
        if (h > 0) screenH = h;
        return state();
    }

    function setOpen(value) {
        var want = !!value;
        if (want === open) return open;
        if (want) {
            // A new shell session starts from the game's current layout. Keeping stale records
            // would make a reopen restore the previous session's edges.
            records = {};
            refusals = [];
            refusalKeys = {};
        }
        open = want;
        return open;
    }

    function recordFor(id) {
        var key = String(id);
        var record = records[key];
        if (!record) {
            record = records[key] = {
                id: key,
                preShell: null,
                base: null,
                placed: null,
                dx: 0,
                dy: 0,
                extraTop: 0,
                first: false,
                refused: false,
                reason: ""
            };
        }
        return record;
    }

    function refusal(record, why) {
        record.refused = true;
        record.reason = why;
        if (refusalKeys[record.id]) return;
        refusalKeys[record.id] = true;
        refusals.push({ id: record.id, why: why });
    }

    // Ask where a participant should draw. `extraTop` is the chrome the participant needs above
    // its content (a shell window's title row, a compact HUD frame's strip); the pass reserves
    // the bar first, then that chrome. A refused participant keeps its own rect: it is better to
    // leave the game drawing its full-screen surface than to scale it into a hole.
    function place(id, rect, extraTop) {
        var base = copyRect(rect);
        var record = recordFor(id);
        if (!open) {
            if (record.base) {
                record.base = base;
                record.placed = base;
                record.dx = 0;
                record.dy = 0;
                record.first = false;
                record.refused = false;
                record.reason = "";
            }
            return {
                x: base.x, y: base.y, w: base.w, h: base.h,
                dx: 0, dy: 0, first: false, refused: false, reason: ""
            };
        }

        record.first = !record.preShell;
        if (record.first) record.preShell = base;
        record.base = base;
        record.extraTop = Math.max(0, finite(extraTop, 0));

        var left = insets.left;
        var top = insets.top + record.extraTop;
        var availableW = screenW - insets.left - insets.right;
        var availableH = screenH - top - insets.bottom;

        if (availableW < 1 || availableH < 1 || base.w > availableW || base.h > availableH) {
            record.placed = { x: base.x, y: base.y, w: base.w, h: base.h };
            record.dx = 0;
            record.dy = 0;
            record.first = false;
            refusal(record, "needs " + Math.round(base.w) + "×" + Math.round(base.h) +
                " in " + Math.round(Math.max(0, availableW)) + "×" +
                Math.round(Math.max(0, availableH)) + " after the shell reserves its edges");
            return result(record);
        }

        var x = clamp(base.x, left, left + availableW - base.w);
        var y = clamp(base.y, top, top + availableH - base.h);
        record.placed = { x: x, y: y, w: base.w, h: base.h };
        record.dx = x - base.x;
        record.dy = y - base.y;
        record.refused = false;
        record.reason = "";
        var answer = result(record);
        // Only the first answer of a session is a layout. Consume the flag here so the shell's
        // next poll is motion and can ease a HUD reflow instead of snapping it.
        record.first = false;
        return answer;
    }

    // A shell window is already measured in shell space: its y starts at the bar, not at the
    // game's top edge. It asks for the same arbitration (clamp inside the reserved area, record a
    // refusal) but the bar is not added a second time. This is the distinction that made a shell
    // window jump down by one bar height every time the layout pass was applied.
    function placeShell(id, rect) {
        var base = copyRect(rect);
        var record = recordFor(id);
        if (!open) {
            record.base = base;
            record.placed = base;
            record.dx = 0;
            record.dy = 0;
            record.first = false;
            record.refused = false;
            record.reason = "";
            return { x: base.x, y: base.y, w: base.w, h: base.h,
                dx: 0, dy: 0, first: false, refused: false, reason: "" };
        }

        record.first = !record.preShell;
        if (record.first) record.preShell = base;
        record.base = base;
        record.extraTop = 0;

        var left = insets.left;
        var top = insets.top;
        var availableW = screenW - left - insets.right;
        var availableH = screenH - top - insets.bottom;
        if (availableW < 1 || availableH < 1 || base.w > availableW || base.h > availableH) {
            record.placed = { x: base.x, y: base.y, w: base.w, h: base.h };
            record.dx = 0;
            record.dy = 0;
            record.first = false;
            refusal(record, "needs " + Math.round(base.w) + "×" + Math.round(base.h) +
                " in " + Math.round(Math.max(0, availableW)) + "×" +
                Math.round(Math.max(0, availableH)) + " after the shell reserves its edges");
            return result(record);
        }

        var x = clamp(base.x, left, left + availableW - base.w);
        var y = clamp(base.y, top, top + availableH - base.h);
        record.placed = { x: x, y: y, w: base.w, h: base.h };
        record.dx = x - base.x;
        record.dy = y - base.y;
        record.refused = false;
        record.reason = "";
        var answer = result(record);
        record.first = false;
        return answer;
    }

    // The pre-shell rect for one participant. A caller that wants to restore explicitly asks
    // here; the normal close path simply calls `place()` with the shell closed, which returns the
    // current base rect and leaves the participant where the game drew it.
    function restore(id) {
        var record = records[String(id)];
        if (!record) return null;
        var rect = record.preShell || record.base;
        if (!rect) return null;
        return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    }

    function snapshot() {
        var out = [];
        for (var id in records) {
            if (!records.hasOwnProperty(id)) continue;
            var record = records[id];
            out.push({
                id: record.id,
                base: record.base ? { x: record.base.x, y: record.base.y, w: record.base.w, h: record.base.h } : null,
                preShell: record.preShell ? { x: record.preShell.x, y: record.preShell.y, w: record.preShell.w, h: record.preShell.h } : null,
                placed: record.placed ? { x: record.placed.x, y: record.placed.y, w: record.placed.w, h: record.placed.h } : null,
                dx: record.dx,
                dy: record.dy,
                extraTop: record.extraTop,
                first: !!record.first,
                refused: record.refused,
                reason: record.reason
            });
        }
        return out;
    }

    function refusalList() {
        var out = [];
        for (var i = 0; i < refusals.length; i++) {
            out.push({ id: refusals[i].id, why: refusals[i].why });
        }
        return out;
    }

    // The shell consumes these into the runtime refusal list/toast path. Taking them keeps the
    // pass's list bounded and lets a harness prove the refusal was real, not just painted.
    function takeRefusals() {
        var out = refusalList();
        refusals = [];
        refusalKeys = {};
        return out;
    }

    function releaseAll() {
        var out = snapshot();
        records = {};
        refusals = [];
        refusalKeys = {};
        open = false;
        return out;
    }

    function state() {
        return {
            open: open,
            screenW: screenW,
            screenH: screenH,
            insets: { top: insets.top, right: insets.right, bottom: insets.bottom, left: insets.left }
        };
    }

    globalThis.OpenlockLayoutPass = {
        configure: configure,
        setViewport: setViewport,
        setOpen: setOpen,
        isOpen: function () { return open; },
        place: place,
        placeShell: placeShell,
        restore: restore,
        snapshot: snapshot,
        refusals: refusalList,
        takeRefusals: takeRefusals,
        releaseAll: releaseAll,
        state: state,
        sameRect: sameRect
    };
})();

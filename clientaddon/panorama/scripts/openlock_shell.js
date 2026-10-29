// Openlock shell: the window manager.
//
// Two kinds of window, one owner:
//
//   * a shell window draws its own content (docs, mods, settings, console, the live-panel
//     browser, the record views from the server);
//   * a game window frames a panel the game already built. The panel is **never reparented**.
//     `CitadelHudHeroShop` asserts its parent ("Failed to find parent shop, this is necessary!")
//     and a reparented component aborts the client, so the frame tracks the panel's real rect and
//     the panel itself is moved and scaled with a CSS transform. Its tree, parent and script
//     context are untouched.
//
// Every window's default position and scale comes from the package (`shell/alpha-shell/package.shspec`)
// and its generated data. Pins are the customization layer: a pinned window stays on screen when
// the shell is closed, which is exactly what the player keeps.
(function () {
    var root = $.GetContextPanel();
    var data = SHELL || {
        windows: [], tabs: [], filed: [], pins: [], refusals: [], layouts: [],
        build: {}, update: { available: false }
    };

    var launcherBar = root.FindChildTraverse("LauncherBar");
    var taskbar = root.FindChildTraverse("Taskbar");
    var strip = root.FindChildTraverse("TabStrip");
    var preloadStrip = root.FindChildTraverse("PreloadStrip");
    var preloadLabel = root.FindChildTraverse("PreloadLabel");
    var preloadModules = root.FindChildTraverse("PreloadModules");
    var preloadFill = root.FindChildTraverse("PreloadFill");
    var windowLayer = root.FindChildTraverse("WindowLayer");
    var panelLayer = root.FindChildTraverse("PanelLayer");
    var dropGrid = root.FindChildTraverse("DropGrid");
    var pointerProbe = root.FindChildTraverse("PointerProbe");
    var toastStack = root.FindChildTraverse("ToastStack");
    var updateModal = root.FindChildTraverse("UpdateModal");
    var clockLabel = root.FindChildTraverse("Clock");
    var versionLabel = root.FindChildTraverse("VersionLabel");
    var schemeLabel = root.FindChildTraverse("SchemeLabel");
    var launcherLabel = root.FindChildTraverse("LauncherLabel");
    var themes = data.themes || { default: "", order: [], schemes: [], extensions: [] };
    var currentScheme = "";
    // The idle/compact chrome is a behavior of the shell, not a grade gate. Echo the baked grade
    // beside the transition so the client's own console can show whether a grade suppressed it.
    var shellGrade = String((data.build && data.build.grade) || "dev");
    // The preloader warms each bar module before the player opens the shell. It owns the bar's
    // tab slot while it runs, so a scheduled render cannot replace the loading chips with tabs.
    var preloadActive = true;
    var preloadSeq = 0;
    var preloadStartedAt = 0;
    var preloadCompleted = 0;

    var WINDOWS_ID = "__windows";
    var WINDOWS_VIEW = {
        id: WINDOWS_ID,
        title: "Windows",
        content: "windows",
        lane: "shell",
        view: "windows",
        x: 16, y: 64, width: 640, height: 520,
        minWidth: 300, minHeight: 200,
        opacity: 930,
        "theme-role": "surface",
        pinnable: false
    };

    var TITLE_DP = 30;
    var META_DP = 17;
    var CHROME_DP = TITLE_DP + META_DP;
    var TASKBAR_DP = 40;       // the bar's top strip, including its margin
    var SHELL_TOP_DP = 46;     // first row a window's title may occupy
    var CELL_DP = 100;
    var screenW = 1600;
    var screenH = 900;

    var expanded = false;
    var activeTab = "";
    var activeId = "";
    var discoveredHud = false;
    var hiddenPanels = {};
    var bulkFramesEnabled = true;
    var hudStreamActive = false;
    var hudStreamNodes = [];
    var perfRefusalAdded = false;

    function notePerformanceRefusal(count) {
        if (perfRefusalAdded || count <= 700) return;
        perfRefusalAdded = true;
        data.refusals.push({
            file: "hud",
            line: 1,
            subject: "bulk framing",
            why: count + " visible panels would make bulk framing a performance risk; use the UI tree stream or disable it"
        });
    }

    globalThis.OpenlockDisableBulkFraming = function (disable) {
        bulkFramesEnabled = disable === undefined ? false : !disable;
        return bulkFramesEnabled;
    };
    var focused = "";
    var cursorFree = false;
    var zTop = 100;

    // Counters, not guesses: the line this logs every 30 s is the reading a performance change has
    // to move. writes are style assignments; skipped are the same value met again and not written.
    var perf = { polls: 0, applies: 0, writes: 0, skips: 0, scans: 0, fullScans: 0, cost: {} };
    var frameMs = 0;
    var frameClockAt = 0;
    var frameTickAt = 0;
    var frameTicks = 0;
    var reportedRefusals = {};
    var runtimeRefusals = [];

    var frames = {};      // id -> { frame, title, meta, body, refusal, win }
    var lastInteractionAt = Date.now();
    var maximized = {};   // id -> geometry before the maximize click
    var minimized = {};   // id -> chrome hidden, window still open on the bar
    var open = {};        // id -> true
    var pinned = {};      // id -> true
    var dismissed = {};   // id -> true: closed by the player, so auto-frame leaves it alone
    var geometry = {};    // id -> { x, y, w, h, init }
    var bound = {};       // id -> { panel, natural }
    var index = {};       // id -> window record

    for (var wi = 0; wi < data.windows.length; wi++) index[data.windows[wi].id] = data.windows[wi];
    for (var pi = 0; pi < data.pins.length; pi++) pinned[data.pins[pi]] = true;

    // --- small helpers -------------------------------------------------------

    function num(value) {
        var n = Number(value);
        return isFinite(n) ? n : 0;
    }

    function safeId(id) {
        return String(id).replace(/[^A-Za-z0-9_]/g, "_");
    }

    function clamp(value, low, high) {
        return Math.max(low, Math.min(high, value));
    }

    function measureScreen() {
        try {
            var w = num(root.actuallayoutwidth);
            var h = num(root.actuallayoutheight);
            if (w > 200) screenW = w;
            if (h > 200) screenH = h;
        } catch (e) {}
    }

    function windowById(id) {
        if (id === WINDOWS_ID) return WINDOWS_VIEW;
        return index[id] || null;
    }

    function isPanelWindow(win) {
        return !!(win && win.panelCandidates && win.panelCandidates.length);
    }

    function hudRoot() {
        // Panorama's absolute root answers FindChildTraverse but returns no children from any
        // ordinary parent, so a walk that starts there visits zero panels. The game HUD is the
        // ancestor named 'Hud' (CitadelHud); the live mount is a sibling of it under the window
        // root, the tools mount is inside it.
        var top = root;
        var depth = 0;
        while (top && depth < 30) {
            var id = "";
            try { id = top.id || ""; } catch (e) { id = ""; }
            var cls = classesOf(top);
            if (id === "Hud" || /citadelhud/i.test(cls)) return top;
            try {
                var found = top.FindChildTraverse("Hud");
                if (found && found !== root && !isShellPanel(found)) return found;
            } catch (e) {}
            var up = null;
            try { up = top.GetParent(); } catch (e) { break; }
            if (!up) break;
            top = up;
            depth++;
        }
        return root;
    }

    function isShellPanel(panel) {
        var p = panel;
        var depth = 0;
        // A descendant of the shell, or an ancestor that contains it (the mount host): neither is
        // a game window, and framing the host would put chrome around the shell itself.
        while (p && depth < 40) {
            if (p === root) return true;
            try { p = p.GetParent(); } catch (e) { return false; }
            depth++;
        }
        p = root;
        depth = 0;
        while (p && depth < 40) {
            if (p === panel) return true;
            try { p = p.GetParent(); } catch (e) { return false; }
            depth++;
        }
        return false;
    }

    function alive(panel) {
        if (!panel) return false;
        try {
            panel.GetChildCount();
            return true;
        } catch (e) {
            return false;
        }
    }

    function classesOf(panel) {
        try { return panel.GetAttributeString("class", "") || ""; } catch (e) { return ""; }
    }

    // A loading veil, fade cover or debug overlay is not a HUD window. Discovery used to put a
    // full-screen frame around LoadInFadeCover; these are the transient roots that must stay out
    // of the catalog and out of the bulk framing sweep.
    function isTransientHud(id, cls) {
        var text = (String(id || "") + " " + String(cls || "")).toLowerCase();
        return /(fadecover|fade_cover|loading|loadin|splash|vignette|grain|debug|tooltip|dev_overlay|contextmenu|cursor|dragdrop|drag_drop)/.test(text);
    }

    // A HUD surface is a control, not the transparent root that carries it. "Popup", "HUD",
    // "health", "minimap" and the rest are the names the game and the layout catalog actually
    // use; decorative panels (panel_0, plain Panel/Image leaves) are not windows.
    function isHudSurface(id, cls, inPopup) {
        if (inPopup) return true;
        var text = (String(id || "") + " " + String(cls || "")).toLowerCase();
        return /(hud|popup|modal|dialog|menu|health|shield|minimap|ability|abilities|shop|quickbuy|inventory|score|scoreboard|chat|damage|combat|party|top.?bar|status|portrait|item|gold|soul|level|quest|map|build|roster|timer|objective|teammate|player|sprint|cast|zip|buy|courier|ward|feed|hero|select|dashboard|screen|lobby|hideout|match)/.test(text);
    }

    function hasReadableName(id, cls) {
        if (id && !/^panel_\d+$/i.test(String(id))) return true;
        var classes = String(cls || "").split(" ");
        for (var i = 0; i < classes.length; i++) {
            var c = classes[i];
            if (c && !/^(panel|image|label|button)$/i.test(c)) return true;
        }
        return false;
    }

    // A full-screen wrapper is not the visible window. Deadlock's AbilitiesContainer and HUD
    // root are transparent parents; framing them produces a screen-sized frame around nothing.
    // Descend to the largest visible child that is not the whole screen before binding chrome.
    function surfaceTarget(panel) {
        var p = panel;
        var depth = 0;
        while (p && depth++ < 4) {
            var n = naturalOf(p);
            if (!n) return p;
            var area = n.w * n.h;
            if (area < screenW * screenH * 0.45) return p;

            var best = null;
            var bestArea = 0;
            var count = 0;
            try { count = p.GetChildCount(); } catch (e) { count = 0; }
            for (var i = 0; i < count; i++) {
                var child = null;
                try { child = p.GetChild(i); } catch (e) { child = null; }
                if (!child || !panelVisible(child)) continue;
                var cw = num(child.actuallayoutwidth);
                var ch = num(child.actuallayoutheight);
                var childArea = cw * ch;
                if (cw < 32 || ch < 24 || childArea >= area * 0.94) continue;
                if (childArea > bestArea) { bestArea = childArea; best = child; }
            }
            if (!best) return p;
            p = best;
        }
        return p;
    }

    function panelVisible(panel) {
        if (!panel) return false;
        try {
            if (panel.IsVisible && !panel.IsVisible()) return false;
        } catch (e) {}
        // A scoreboard or alternate HUD can be laid out and IsVisible while fully transparent.
        // Framing it would put chrome around a screen the player cannot see.
        try {
            if (typeof panel.GetOpacity === "function" && panel.GetOpacity() < 0.01) return false;
        } catch (e) {}
        try { return panel.visible !== false; } catch (e) { return true; }
    }

    function toastsAvailable() {
        return !!toastStack;
    }

    // --- schemes -------------------------------------------------------------
    // A scheme is a generated stylesheet block (openlock_schemes.css) plus one class on the shell
    // root. Switching is a class change, not a recolour of every panel, so the game keeps its frame
    // pacing while the palette moves.
    function schemeById(id) {
        for (var i = 0; i < themes.schemes.length; i++) {
            if (themes.schemes[i].id === id) return themes.schemes[i];
        }
        return null;
    }

    function schemeClass(id) {
        return "Scheme" + String(id).replace(/(^|[-_])([a-z])/g, function (_, lead, letter) {
            return letter.toUpperCase();
        });
    }

    function schemeHosts() {
        // The shell root paints shell chrome. The topmost ancestor is the game HUD root, so the
        // same scheme class also scopes rules that target real Deadlock elements. Both are class
        // changes only; no game panel is reparented or restyled inline.
        var hosts = [root];
        try {
            var top = hudRoot();
            if (top && top !== root) hosts.push(top);
        } catch (e) {}
        return hosts;
    }

    function applyScheme(id, announce) {
        var scheme = schemeById(id) || schemeById(themes.default) || themes.schemes[0];
        if (!scheme) return "";

        var hosts = schemeHosts();
        for (var h = 0; h < hosts.length; h++) {
            for (var i = 0; i < themes.schemes.length; i++) {
                try { hosts[h].RemoveClass(schemeClass(themes.schemes[i].id)); } catch (e) {}
            }
        }
        for (var k = 0; k < hosts.length; k++) {
            try { hosts[k].AddClass(schemeClass(scheme.id)); } catch (e) {
                $.Msg("[Openlock] scheme class REFUSED for '", scheme.id, "': ", String(e));
            }
        }

        currentScheme = scheme.id;
        if (schemeLabel) schemeLabel.text = String(scheme.id).charAt(0).toUpperCase();
        if (announce) {
            var ext = scheme.extensions ? scheme.extensions.length : 0;
            globalThis.OpenlockToast("Scheme", scheme.label + " applied" + (ext ? " · " + ext + " extension(s)" : ""), "", false);
        }
        return scheme.id;
    }

    globalThis.OpenlockScheme = function (id) {
        return applyScheme(String(id || "").toLowerCase(), true);
    };

    globalThis.OpenlockCycleScheme = function () {
        if (!themes.schemes.length) {
            globalThis.OpenlockToast("Scheme", "no scheme data in this build", "", true);
            return "";
        }
        var at = -1;
        for (var i = 0; i < themes.schemes.length; i++) {
            if (themes.schemes[i].id === currentScheme) { at = i; break; }
        }
        var next = themes.schemes[(at + 1) % themes.schemes.length];
        return applyScheme(next.id, true);
    };

    // --- toast / update ------------------------------------------------------

    globalThis.OpenlockToast = function (title, body, windowId, attention) {
        if (!toastsAvailable() || !title) return null;

        var t = $.CreatePanel("Panel", toastStack, "");
        t.AddClass("Toast");
        if (attention) t.AddClass("Attention");

        var h = $.CreatePanel("Label", t, "");
        h.AddClass("ToastTitle");
        h.text = title;

        if (body) {
            var b = $.CreatePanel("Label", t, "");
            b.AddClass("ToastBody");
            b.text = body;
        }

        if (windowId) {
            t.SetPanelEvent("onmouseactivate", function () { openWindow(windowId); });
        }

        $.Schedule(8, function () {
            try { t.DeleteAsync(0); } catch (e) {}
        });

        return t;
    };

    function quitForUpdate() {
        try {
            $.DispatchEvent("CitadelConCommand", "quit");
            $.Msg("[Openlock] update restart: quit dispatched");
        } catch (e) {
            $.Msg("[Openlock] update restart REFUSED: no quit command on this build: ", String(e));
        }
    }

    globalThis.OpenlockUpdateRestart = function () {
        if (updateModal) updateModal.style.visibility = "collapse";
        globalThis.OpenlockToast("Updating", "Closing the client; the new build starts next launch.", "", false);
        $.Schedule(2, quitForUpdate);
    };

    globalThis.OpenlockUpdateLater = function () {
        if (updateModal) updateModal.style.visibility = "collapse";
    };

    function startUpdateJob() {
        var update = data.update || {};
        if (!update.available) return;

        var left = update.countdown || 60;
        var label = root.FindChildTraverse("UpdateCountdown");

        globalThis.OpenlockToast(
            "Update ready",
            update.version ? ("version " + update.version) : "a new build is staged",
            "",
            true);

        if (updateModal) {
            var title = root.FindChildTraverse("UpdateTitle");
            var body = root.FindChildTraverse("UpdateBody");
            if (title) title.text = update.title || "Update ready";
            if (body) body.text = update.notes || "Restart the client to apply the new build.";
            updateModal.style.visibility = "visible";
        }

        function tick() {
            if (label) {
                label.text = update.autoRestart
                    ? ("restarting in " + left + "s")
                    : ("restart when convenient · " + left + "s");
            }
            if (left <= 0) {
                if (update.autoRestart) quitForUpdate();
                return;
            }
            left--;
            $.Schedule(1, tick);
        }

        tick();
    }

    // --- the bar -------------------------------------------------------------

    function addControl(parent, cls, label, onClick, press) {
        var p = $.CreatePanel("Panel", parent, "");
        p.AddClass(cls);
        p.hittest = true;
        p.hittestchildren = true;
        var l = $.CreatePanel("Label", p, "");
        l.text = label;
        // A label is decoration. Left hit-testable it sits over the panel that owns the handler
        // and swallows the click, which is exactly how the title-bar glyphs stopped working.
        l.hittest = false;
        if (cls === "ShellTab") l.AddClass("ShellTabLabel");
        // A title glyph is a press target, not a click target: on the reduced tools build the
        // activate event can be lost when the title's drag poll owns the pointer. Press is
        // immediate and works on both clients; tabs and menu rows keep the click path.
        p.SetPanelEvent(press ? "onmousedown" : "onmouseactivate", function () {
            lastInteractionAt = Date.now();
            onClick();
        });
        return p;
    }

    function addTab(windowId, label, extraClass) {
        var win = windowById(windowId);
        var text = label || (win && win.title) || windowId;
        var tab = addControl(strip, "ShellTab", text, function () { choose(windowId); });
        if (extraClass) tab.AddClass(extraClass);
        if (windowId === activeTab) tab.AddClass("Active");
        if (pinned[windowId]) tab.AddClass("Pinned");
        return tab;
    }

    function renderBar() {
        if (!strip) return;
        if (preloadActive) return;
        strip.RemoveAndDeleteChildren();
        var listed = {};

        var tabs = data.tabs || [];
        for (var i = 0; i < tabs.length; i++) { addTab(tabs[i]); listed[tabs[i]] = true; }

        if (data.bar) { addTab(data.bar); listed[data.bar] = true; }

        var filed = data.filed || [];
        for (var f = 0; f < filed.length; f++) {
            if (filed[f].tab !== activeTab) continue;
            var fw = windowById(filed[f].window);
            addTab(filed[f].window, "› " + ((fw && fw.title) || filed[f].window));
            listed[filed[f].window] = true;
        }

        var pins = data.pins || [];
        for (var p = 0; p < pins.length; p++) {
            if (pins[p] === activeTab) continue;
            var pw = windowById(pins[p]);
            addTab(pins[p], (pinned[pins[p]] ? "• " : "") + ((pw && pw.title) || pins[p]));
            listed[pins[p]] = true;
        }

        // Every open frame owns a taskbar entry, including a discovered panel and a minimized
        // window. Without this row a minimize from the title bar had no way back.
        for (var id in frames) {
            if (!frames.hasOwnProperty(id) || !open[id] || listed[id]) continue;
            var win = windowById(id);
            // A discovered HUD control still owns a frame and a Windows row, but forty of them
            // must not turn the bar into a second row. Minimized and focused ones stay in reach.
            if (win && win.live && !minimized[id] && focused !== id && !pinned[id]) continue;
            addTab(id, (minimized[id] ? "_ " : "") + ((win && win.title) || id));
            listed[id] = true;
        }

        if (versionLabel) {
            var build = data.build || {};
            versionLabel.text = build.label || (data.name + " " + data.version);
            versionLabel.style.visibility = "visible";
        }
    }

    function preloadList() {
        var ids = [];
        var tabs = data.tabs || [];
        for (var i = 0; i < tabs.length; i++) {
            if (windowById(tabs[i])) ids.push(tabs[i]);
        }
        if (ids.length) return ids;
        // A package with no declared tabs still has its first modules warmed in window order.
        for (var w = 0; w < (data.windows || []).length && ids.length < 6; w++) {
            if (!data.windows[w].live) ids.push(data.windows[w].id);
        }
        return ids;
    }

    function preloadChip(id, index, total) {
        var win = windowById(id);
        var chip = $.CreatePanel("Panel", preloadModules, "");
        chip.AddClass("PreloadModule");
        chip.hittest = false;
        chip.hittestchildren = false;
        var label = $.CreatePanel("Label", chip, "");
        label.AddClass("PreloadModuleLabel");
        label.text = (win && win.title) || id;
        label.hittest = false;
        // Ease the chip in from the left rather than popping it. The old Panorama parser has no
        // transitions, so this is a short scheduled curve on opacity and margin.
        var step = 0;
        var steps = 7;
        chip.style.opacity = "0";
        function easeIn() {
            step++;
            chip.style.opacity = String(step / steps);
            chip.style.marginLeft = Math.round(-6 + (6 * step) / steps) + "px";
            if (step < steps) $.Schedule(0.018, easeIn);
        }
        $.Schedule(0.01, easeIn);
        return chip;
    }

    function fadePreloadBar() {
        var opacity = 1;
        function tick() {
            opacity -= 0.1;
            if (taskbar) {
                taskbar.style.opacity = String(Math.max(0, opacity));
                if (opacity <= 0 && !expanded && !preloadActive) {
                    taskbar.style.visibility = "collapse";
                    taskbar.style.opacity = "1";
                }
            }
            if (opacity > 0 && !expanded && !preloadActive) $.Schedule(0.03, tick);
        }
        $.Schedule(0.03, tick);
    }

    function startPreload() {
        var ids = preloadList();
        preloadActive = true;
        preloadSeq++;
        preloadStartedAt = Date.now();
        preloadCompleted = 0;
        if (!preloadStrip || !preloadModules || !ids.length) {
            preloadActive = false;
            if (preloadStrip) preloadStrip.style.visibility = "collapse";
            if (strip) strip.style.visibility = "visible";
            renderBar();
            return;
        }

        if (strip) strip.style.visibility = "collapse";
        preloadStrip.style.visibility = "visible";
        preloadModules.RemoveAndDeleteChildren();
        if (taskbar) {
            taskbar.style.visibility = "visible";
            taskbar.style.opacity = "1";
        }
        if (preloadLabel) preloadLabel.text = "preloading 0/" + ids.length;
        if (preloadFill) preloadFill.style.width = "0%";
        var token = preloadSeq;
        var index = 0;

        function next() {
            if (token !== preloadSeq || !preloadActive) return;
            if (index >= ids.length) { finishPreload(token); return; }
            var id = ids[index];
            var chip = preloadChip(id, index, ids.length);
            chip.AddClass("Loading");
            var at = index;
            $.Schedule(0.28, function () {
                if (token !== preloadSeq || !preloadActive) return;
                var win = windowById(id);
                var ok = false;
                try {
                    if (win) {
                        createFrame(win);
                        ok = !!frames[id];
                    }
                } catch (e) {
                    $.Msg("[Openlock] preload REFUSED '", id, "': ", String(e));
                }
                chip.RemoveClass("Loading");
                chip.AddClass(ok ? "Ready" : "Refused");
                preloadCompleted = at + 1;
                if (preloadLabel) preloadLabel.text = "preloaded " + preloadCompleted + "/" + ids.length;
                if (preloadFill) preloadFill.style.width = Math.round((preloadCompleted / ids.length) * 100) + "%";
                $.Msg("[Openlock] preload: ", id, " ", ok ? "ready" : "refused", " (",
                    preloadCompleted, "/", ids.length, ")");
                index++;
                next();
            });
        }

        next();
    }

    function finishPreload(token) {
        if (token !== preloadSeq) return;
        preloadActive = false;
        if (strip) strip.style.visibility = "visible";
        if (preloadStrip) preloadStrip.style.visibility = "collapse";
        renderBar();
        $.Msg("[Openlock] preload done: ", preloadCompleted, " module(s) in ",
            Date.now() - preloadStartedAt, " ms");
        if (expanded) {
            if (taskbar) { taskbar.style.visibility = "visible"; taskbar.style.opacity = "1"; }
            render();
        } else {
            fadePreloadBar();
        }
    }

    function skipPreload() {
        if (!preloadActive) return;
        preloadActive = false;
        preloadSeq++;
        var ids = preloadList();
        for (var i = 0; i < ids.length; i++) {
            var win = windowById(ids[i]);
            if (!win || frames[ids[i]]) continue;
            try { createFrame(win); } catch (e) { $.Msg("[Openlock] preload REFUSED '", ids[i], "': ", String(e)); }
        }
        if (preloadStrip) preloadStrip.style.visibility = "collapse";
        if (strip) strip.style.visibility = "visible";
        if (taskbar) taskbar.style.opacity = "1";
        renderBar();
        $.Msg("[Openlock] preload skipped: the shell was opened before all modules were warm");
    }

    function choose(id) {
        activeTab = id;
        showTaskbar();
        openWindow(id);
    }

    // --- geometry ------------------------------------------------------------

    function ensureGeometry(win) {
        var g = geometry[win.id];
        if (!g) {
            g = {
                x: num(win.x) || 16,
                y: num(win.y) || 64,
                w: num(win.width) || 480,
                h: num(win.height) || 440,
                init: false
            };
            geometry[win.id] = g;
        }
        return g;
    }

    function setRect(record, x, y, w, h) {
        var frame = record.frame;
        var key = Math.round(x) + "|" + Math.round(y) + "|" + Math.round(w) + "|" + Math.round(h);
        // The pointer-rect probe reads the same box the frame occupies. Panorama's mouseover is
        // not delivered reliably to an ancestor that is not itself hit-testable, so an idle HUD
        // frame is restored from its rectangle rather than from an event on a transparent child.
        record.rect = { x: x, y: y, w: w, h: h };
        if (record.rectKey === key) {
            perf.skips++;
            return;
        }
        record.rectKey = key;
        frame.style.marginLeft = Math.round(x) + "px";
        frame.style.marginTop = Math.round(y) + "px";
        frame.style.width = Math.max(48, Math.round(w)) + "px";
        frame.style.height = Math.max(TITLE_DP, Math.round(h)) + "px";
        perf.writes += 4;
    }

    function setFrameVisible(record, visible) {
        var want = visible ? "visible" : "collapse";
        if (record.lastVisible === want) {
            perf.skips++;
            return;
        }
        record.lastVisible = want;
        record.frame.style.visibility = want;
        perf.writes++;
    }

    function setChildVisibility(record, name, panel, visible) {
        var cache = name + "Visible";
        var want = visible ? "visible" : "collapse";
        if (record[cache] === want) {
            perf.skips++;
            return;
        }
        record[cache] = want;
        panel.style.visibility = want;
        perf.writes++;
    }

    // A top-row HUD element (the game's own top bar is the common one) must not have its chrome
    // clipped by the shell bar. Rather than jumping the panel down by the missing pixels, keep
    // the player's geometry and ease a display offset onto the panel and its frame. The offset is
    // zero again as soon as the window is dragged clear, so a layout save still stores the point
    // the player chose.
    function startShiftAnimation(id) {
        var record = frames[id];
        if (!record || record.shiftAnim) return;
        record.shiftAnim = true;
        var last = Date.now();

        function tick() {
            var f = frames[id];
            var win = windowById(id);
            if (!f || !win || !expanded) {
                if (f) f.shiftAnim = false;
                return;
            }
            var now = Date.now();
            var dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
            last = now;
            var target = num(f.targetShiftY) || 0;
            var current = num(f.shiftY) || 0;
            var next = current + (target - current) * Math.min(1, dt * 14);
            if (Math.abs(target - next) < 0.5) next = target;
            f.shiftY = next;
            applyWindow(win);
            if (Math.abs(target - next) >= 0.5) $.Schedule(0.016, tick);
            else f.shiftAnim = false;
        }
        $.Schedule(0.016, tick);
    }

    // A game panel is not reparented. `natural` is its own rect before the shell touches it; the
    // transform's centre-based scale correction keeps the frame's top-left on the declared point
    // without depending on the panel's transform-origin.
    function applyPanelRect(win, record, g) {
        var b = bound[win.id];
        if (!b) {
            setRect(record, g.x, g.y, num(win.width) || 480, num(win.height) || 440);
            return false;
        }
        if (pinned[win.id]) enforcePinnedVisibility(win.id);

        // The HUD moves and resizes while a match runs (the top bar pushes down when the shell
        // opens, the ability panel appears, the health bar rebuilds). A rect sampled once at bind
        // is how chrome ended up around empty space. Re-sample twice a second; the frame follows
        // the pixels the player sees, not the layout from the moment the window was framed.
        var sampled = Date.now();
        if (!b.sampledAt || sampled - b.sampledAt > 500) {
            var fresh = naturalOf(b.panel);
            if (fresh) b.natural = fresh;
            b.content = contentBounds(b.panel) || b.natural;
            b.sampledAt = sampled;
        }

        var nat = b.natural;
        if (!g.init) {
            // A scaled window is placed at the schema's point; a 1:1 window starts where the game
            // already drew it, so a HUD element is not yanked across the screen on first bind.
            if (win.panelScale && win.panelScale !== 1) {
                g.x = num(win.x) || 16;
                g.y = num(win.y) || 64;
                g.w = Math.max(120, Math.round(nat.w * win.panelScale));
            } else {
                g.x = nat.x;
                g.y = nat.y;
                g.w = Math.max(80, nat.w);
            }
            g.h = Math.round(nat.h * (g.w / nat.w));
            g.init = true;
        }

        // Keep a grab area on screen when a window was dragged past the right or bottom edge.
        g.x = clamp(g.x, 4, Math.max(4, screenW - 160));
        g.y = clamp(g.y, 0, Math.max(0, screenH - 80));

        // The title bar is drawn above the content. A compact HUD title is 16 dp; a shell window
        // carries the full title and meta. If the content is in the shell bar's row, ease the
        // whole window down until the chrome fits; the panel follows the frame, so its own
        // controls remain where the player can see them.
        var chrome = (win.autoFrame || win.discovered) ? 16 : CHROME_DP;
        var dockTop = SHELL_TOP_DP + chrome;
        // A live HUD panel is never shifted for chrome. Moving the game's own abilities/top-bar
        // container made the game re-layout it on the next frame, which is the flicker between
        // two positions; the chrome now yields to the panel instead.
        var needShift = framePanel ? 0 : Math.max(0, dockTop - g.y);
        if (record.shiftY === undefined) record.shiftY = 0;
        record.targetShiftY = needShift;
        if (Math.abs(record.shiftY - needShift) > 0.5) startShiftAnimation(win.id);

        var scale = clamp(g.w / nat.w, 0.08, 4);
        var dispX = g.x;
        var dispY = g.y + (num(record.shiftY) || 0);
        var dispW = nat.w * scale;
        var dispH = nat.h * scale;
        var tx = dispX - nat.x - (nat.w - nat.w * scale) / 2;
        var ty = dispY - nat.y - (nat.h - nat.h * scale) / 2;

        var transform = "translate3d(" + tx + "px," + ty + "px,0px) scale3d(" +
            scale + "," + scale + ",1)";
        if (b.lastTransform === transform) {
            perf.skips++;
        } else {
            b.lastTransform = transform;
            try {
                b.panel.style.transform = transform;
                perf.writes++;
            } catch (e) {
                $.Msg("[Openlock] shell transform REFUSED for '", win.id, "': ", String(e));
            }
        }

        // The chrome is drawn around the content the player can actually see, then clipped
        // against the screen. The panel's transparent reserve stays untouched; only the frame
        // and title follow the visible rectangle.
        var content = b.content || { x: nat.x, y: nat.y, w: nat.w, h: nat.h };
        var contentLeft = dispX + (content.x - nat.x) * scale;
        var contentTop = dispY + (content.y - nat.y) * scale;
        var contentW = content.w * scale;
        var contentH = content.h * scale;
        var left = Math.max(0, contentLeft);
        var top = Math.max(0, contentTop);
        var right = Math.min(screenW, contentLeft + contentW);
        var bottom = Math.min(screenH, contentTop + contentH);
        if (right - left < 24 || bottom - top < 20) {
            setFrameVisible(record, false);
            return false;
        }
        setFrameVisible(record, expanded && !minimized[win.id]);
        var titleTop = Math.max(0, top - chrome);
        record.frame.SetHasClass("Narrow", (right - left) < 260);
        setRect(record, left, titleTop, right - left, bottom - titleTop);
        return true;
    }

    // A real clock, never a guessed one. Panorama exposes performance.now on current V8 builds;
    // Date.now is a 1 ms fallback and the readout says so instead of pretending to be precise.
    var clockIsPrecise = typeof performance !== "undefined" && performance && typeof performance.now === "function";
    function nowMs() {
        try {
            if (clockIsPrecise) return performance.now();
        } catch (e) {}
        return Date.now();
    }

    function noteWindowCost(id, started) {
        var elapsed = Math.max(0, nowMs() - started);
        if (!perf.cost[id]) perf.cost[id] = { total: 0, samples: 0 };
        perf.cost[id].total += elapsed;
        perf.cost[id].samples++;
    }

    function updateCost(f, id) {
        if (!f || !f.cost) return;
        var cost = perf.cost[id] || { total: 0, samples: 0 };
        var own = cost.samples ? (cost.total / cost.samples) : 0;
        // ui = the measured interval between two engine UI frames (frameTick); own = the mean
        // apply cost this window paid. Both are measurements, not a spinner.
        var ui = frameMs ? frameMs.toFixed(1) : "--";
        var text = ui + " · " + (clockIsPrecise ? own.toFixed(2) : own.toFixed(0)) + " ms";
        if (f.lastCost === text) return;
        f.lastCost = text;
        f.cost.text = text;
    }

    // A real frame interval: Game.GetFrameTime/GetFPS when the client exposes it, otherwise the
    // scheduler cadence. This never fabricates a number from a spinner.
    function sampleFrameMs() {
        var owners = [];
        try { if (typeof Game !== "undefined") owners.push(Game); } catch (e) {}
        try { if (typeof GameUI !== "undefined") owners.push(GameUI); } catch (e) {}
        try { if (typeof $ !== "undefined") owners.push($); } catch (e) {}
        for (var i = 0; i < owners.length; i++) {
            var owner = owners[i];
            try {
                if (owner.GetFrameTime) {
                    var t = Number(owner.GetFrameTime());
                    if (isFinite(t) && t > 0) return t > 1 ? t : t * 1000;
                }
            } catch (e) {}
            try {
                if (owner.GetFPS) {
                    var fps = Number(owner.GetFPS());
                    if (isFinite(fps) && fps > 0) return 1000 / fps;
                }
            } catch (e) {}
        }
        try {
            if (typeof Game !== "undefined" && Game.GetConVar) {
                var frame = Number(Game.GetConVar("host_frametime"));
                if (isFinite(frame) && frame > 0) return frame > 1 ? frame : frame * 1000;
            }
        } catch (e) {}
        return 0;
    }

    // A safe capability probe. Enumerating the native GameUI/Game objects with Object.keys is
    // what took the previous build down at boot; typeof never touches the host object's own
    // property table.
    function apiProbe() {
        var bits = [];
        try {
            if (typeof GameUI === "undefined") {
                bits.push("GameUI:none");
            } else {
                bits.push("cursor:" + (typeof GameUI.GetCursorPosition === "function" ? "yes" : "no"));
                bits.push("down:" + (typeof GameUI.IsMouseDown === "function" ? "yes" : "no"));
            }
        } catch (e) {
            bits.push("GameUI:error");
        }
        try {
            bits.push("frame:" + (typeof Game !== "undefined" && typeof Game.GetFrameTime === "function" ? "api" : "none"));
        } catch (e) {
            bits.push("frame:error");
        }
        try {
            bits.push("$cursor:" + (typeof $ !== "undefined" && typeof $.GetCursorPosition === "function" ? "yes" : "no"));
        } catch (e) {
            bits.push("$cursor:error");
        }
        bits.push("clock:" + (clockIsPrecise ? "perf" : "date"));
        return bits.join(" ");
    }

    // Diagnostic shape of an event's arguments. Panels deliver events but the docs do not say
    // whether mousemove/mousedown carry the pointer; this prints exactly what arrives.
    function probeArgs(args) {
        if (args === undefined || args === null) return "null";
        var out = "n" + args.length;
        for (var i = 0; i < args.length && i < 2; i++) {
            var a = args[i];
            out += " " + (typeof a);
            if (a && typeof a === "object") {
                var keys = ["x", "y", "cursorX", "cursorY", "mouseX", "mouseY"];
                for (var k = 0; k < keys.length; k++) {
                    if (a[keys[k]] !== undefined) out += " " + keys[k] + "=" + Math.round(Number(a[keys[k]]));
                }
            } else if (typeof a === "number") {
                out += "=" + Math.round(a);
            }
        }
        return out;
    }

    // The engine's UI frame interval, measured between two scheduled callbacks. This is the
    // only real frame cadence a Panorama addon can observe; it is shown as "ui" beside each
    // window's own measured apply cost.
    function frameTick() {
        // The interval only matters while chrome is on screen. Collapsed: one wake a second,
        // no per-frame callback added to the game's own loop.
        if (!expanded) {
            frameTickAt = 0;
            frameMs = 0;
            $.Schedule(1, frameTick);
            return;
        }
        var at = nowMs();
        if (frameTickAt) {
            var delta = at - frameTickAt;
            if (delta > 0 && delta < 250) {
                frameMs = frameMs ? (frameMs * 0.85 + delta * 0.15) : delta;
            }
        }
        frameTickAt = at;
        frameTicks++;
        $.Schedule(0.001, frameTick);
    }

    function easeInOut(t) {
        return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    }

    // Panorama rejects CSS transitions with a cubic-bezier function, so the fallback is eased
    // here. The title strip shrinks from 16 dp to 10 dp and fades while the compact controls
    // fade out; the next pointer interaction runs the same curve back to the expanded state.
    function paintCompact(f) {
        if (!f || !f.titleBar) return;
        // The compact schema belongs to automatic HUD windows only. A shell window keeps its
        // full title height even when hover runs the restore path.
        if (!f.win || !(f.win.autoFrame || f.win.discovered)) return;
        var e = easeInOut(clamp(num(f.idleMix) || 0, 0, 1));
        // The frame is the 1 px outline and the corner grips: those are the only parts that go
        // away at idle. The chrome stays on screen as a compact black-and-white strip, with its
        // controls and its native-size performance readout. The title text is the one label that
        // is suppressed at this scale; the strip itself remains a solid line. Hovering scales
        // the controls back to full size and restores the normal title on the same ease curve.
        f.titleBar.style.height = (16 - 2 * e) + "px";
        f.titleBar.style.opacity = "1";
        var scale = 1 - 0.1 * e;
        try { f.frame.style.opacity = String(num(f.baseOpacity) || 1); } catch (err) {}
        try { f.title.style.opacity = String(1 - e); } catch (err) {}
        try { f.title.style.transform = "scale3d(" + scale + "," + scale + ",1)"; } catch (err) {}
        try { f.title.style.visibility = e > 0.92 ? "collapse" : "visible"; } catch (err) {}
        var buttons = f.buttons || [];
        for (var i = 0; i < buttons.length; i++) {
            try { buttons[i].style.opacity = "1"; } catch (err) {}
            try { buttons[i].style.transform = "scale3d(" + scale + "," + scale + ",1)"; } catch (err) {}
        }
        var cost = f.cost || null;
        if (cost) {
            try {
                // Real pixels, not a miniature: the performance readout keeps its native size.
                cost.style.opacity = "1";
                cost.style.fontSize = "10px";
            } catch (err) {}
        }
        try { f.frame.SetHasClass("IdleCompact", e > 0.5); } catch (err) {}
    }

    function animateCompact(f, target) {
        if (!f || !f.win || !(f.win.autoFrame || f.win.discovered)) return;
        if (f.idleAnim) {
            f.idleTarget = target;
            return;
        }
        f.idleAnim = true;
        f.idleTarget = target;
        var last = Date.now();
        function tick() {
            var now = Date.now();
            var dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
            last = now;
            var current = num(f.idleMix) || 0;
            var step = dt / 0.32;
            if (current < f.idleTarget) current = Math.min(f.idleTarget, current + step);
            else current = Math.max(f.idleTarget, current - step);
            f.idleMix = current;
            paintCompact(f);
            if (Math.abs(current - f.idleTarget) > 0.001) $.Schedule(0.016, tick);
            else f.idleAnim = false;
        }
        tick();
    }

    function restoreChrome(id) {
        lastInteractionAt = Date.now();
        var f = frames[id];
        if (!f) return;
        f.lastActiveAt = lastInteractionAt;
        // Hover must put the full chrome back before the next frame, not after an animation that
        // the older client can miss. Reset the mix outright so the title text and outline return
        // together; the ease is for going idle, not for coming back.
        f.idleMix = 0;
        f.idleTarget = 0;
        f.idleAnim = false;
        f.loggedIdle = false;
        try { f.frame.RemoveClass("IdleCompact"); } catch (e) {}
        paintCompact(f);
    }

    // A per-window hover state, because this client exposes no cursor position at all:
    // `$.MousePosition` is undefined, `GameUI` is absent and `$.GetCursorPosition` is undefined,
    // which is why the pointer-rectangle probe alone can never restore a window here. The bound
    // game panel is hit-tested by the client itself, so its own mouseover is the dependable
    // trigger; the frame covers a shell-drawn window. A short hold after mouseout absorbs the
    // out-then-over pair fired while moving from a window body onto its title bar.
    function enterFrame(id, source) {
        var f = frames[id];
        if (!f) return;
        lastInteractionAt = Date.now();
        if (!f.hovered) $.Msg("[Openlock] chrome hover: ", id, " over via ", source || "panel");
        f.hovered = true;
        f.hoverEnteredAt = Date.now();
        f.hoveredUntil = 0;
        f.lastActiveAt = f.hoverEnteredAt;
        restoreChrome(id);
    }

    function leaveFrame(id, source) {
        var f = frames[id];
        if (!f) return;
        var now = Date.now();
        // Moving from a window body onto its title bar (or between title children) delivers the
        // out before the next over on this client. A page that just entered must not be cleared
        // by a stale out around the same pixel.
        if ((num(f.hoverEnteredAt) || 0) > 0 && now - f.hoverEnteredAt < 80) {
            f.hoveredUntil = now + 450;
            return;
        }
        if (f.hovered) $.Msg("[Openlock] chrome hover: ", id, " out via ", source || "panel");
        f.hovered = false;
        f.hoveredUntil = now + 450;
    }

    function hoveredByPointer(f, now) {
        if (!f) return false;
        if (f.hovered) return true;
        if ((num(f.hoveredUntil) || 0) > now) return true;
        return pointerInsideFrame(f);
    }

    // The live panel stays in the game's tree, so this is the only hover target that covers the
    // pixels the player sees without swallowing the panel's own clicks. A shell-drawn window is
    // bound through its frame below.
    function bindFrameHover(id, panel) {
        if (!panel) return;
        try {
            panel.SetPanelEvent("onmouseover", function () { enterFrame(id, "panel"); });
            panel.SetPanelEvent("onmouseout", function () { leaveFrame(id, "panel"); });
            $.Msg("[Openlock] chrome hover bound: ", id, " via panel");
        } catch (e) {
            $.Msg("[Openlock] chrome hover REFUSED for '", id, "': ", String(e));
        }
    }

    // The window body can be transparent (a live game panel) and the frame is not hit-testable on
    // that path, so a mouseover on the chrome is not a dependable restore trigger. The pointer
    // rectangle is the fallback for clients that expose a cursor; hover state is the live path.
    function pointerInsideFrame(f) {
        if (!f || !f.rect || !expanded) return false;
        var at = cursorPoint();
        if (!at) return false;
        var r = f.rect;
        return at.x >= r.x && at.x <= r.x + r.w && at.y >= r.y && at.y <= r.y + r.h;
    }

    function updateCompactChrome() {
        var now = Date.now();
        for (var id in frames) {
            if (!frames.hasOwnProperty(id)) continue;
            var f = frames[id];
            if (!f || !f.win || !(f.win.autoFrame || f.win.discovered)) continue;
            var hovered = hoveredByPointer(f, now);
            // Each window owns its own idle clock. A hover on one window must not keep every
            // other window's chrome expanded, and leaving this window must not reset the others.
            if (hovered) f.lastActiveAt = now;
            var idle = !pointerDrag && !hovered && (now - (num(f.lastActiveAt) || 0)) > 3200;
            if (idle && !f.loggedIdle) {
                f.loggedIdle = true;
                $.Msg("[Openlock] chrome idle: ", id, " grade=", shellGrade);
            } else if (!idle && f.loggedIdle) {
                f.loggedIdle = false;
                $.Msg("[Openlock] chrome restore: ", id, " grade=", shellGrade);
            }
            f.frame.SetHasClass("IdleCompact", idle);
            var target = idle ? 1 : 0;
            if (Math.abs((num(f.idleMix) || 0) - target) > 0.001 || f.idleTarget !== target) {
                animateCompact(f, target);
            }
        }
    }

    function frameClock() {
        frameClockAt = Date.now();
        if (!frameTicks) {
            var sampled = sampleFrameMs();
            if (sampled > 0) frameMs = sampled;
        }
        if (pointerProbe) {
            var p = cursorPoint();
            pointerProbe.text = "ptr " + (p ? (Math.round(p.x) + "," + Math.round(p.y)) : "NONE") +
                " | ev " + lastPointerEvent + " | " + apiProbe();
        }
        updateCompactChrome();
        // A hover has to be noticed before the next second ticks, or the controls feel dead.
        // When the shell is closed there is no chrome to restore, so keep the idle wake at 1 s.
        $.Schedule(expanded ? 0.1 : 1, frameClock);
    }

    function applyWindow(win) {
        var f = frames[win.id];
        if (!f) return;
        perf.applies++;
        var started = Date.now();

        var g = ensureGeometry(win);
        var framePanel = isPanelWindow(win);
        // The frame is the shell's chrome: it exists only while the bar is open. A pinned game
        // window keeps its placement (the transform on the live panel) while the chrome is gone,
        // which is what the player keeps when the shell is closed.
        setFrameVisible(f, expanded && !minimized[win.id]);
        // A panel window's frame is transparent and sits above the live panel. It must not take
        // the pointer over the panel: only its title bar and grip are interactive.
        f.frame.hittest = !!expanded && !framePanel;
        f.frame.hittestchildren = true;
        f.frame.SetHasClass("Pinned", !!pinned[win.id]);
        f.frame.SetHasClass("ShellClosed", !expanded);
        f.frame.SetHasClass("Focused", focused === win.id);
        f.frame.SetHasClass("PanelWindow", isPanelWindow(win));

        if (!expanded) {
            if (framePanel && pinned[win.id]) {
                // Keep the pinned element where the player put it, with no chrome over the game.
                if (ensureBound(win)) applyPanelRect(win, f, g);
            } else {
                releasePanel(win.id);
            }
            updateCost(f, win.id);
            return;
        }

        if (framePanel) {
            var resolved = ensureBound(win);
            // A pinned window whose game panel is not on screen draws nothing: an empty frame
            // around nothing is worse than the game's own HUD. Poll re-shows it when the panel
            // appears. A window the player just opened shows a compact refusal instead of a
            // screen-sized hole.
            if (!resolved && f.auto) {
                // An auto-framed window follows its game screen: when the shop or the map closes,
                // the chrome goes away rather than sitting there as a refusal.
                setFrameVisible(f, false);
                return;
            }
            if (!resolved) {
                setRect(f, g.x, g.y, 360, CHROME_DP + 34);
                f.meta.text = (win.panelCandidates[0].name || win.panelCandidates[0].kind) + "  ·  not on screen";
                f.refusal.text = "This game panel is not on screen right now. Open it in the game and the window will frame it.";
                setChildVisibility(f, "refusal", f.refusal, true);
                setChildVisibility(f, "body", f.body, false);
                f.frame.style.backgroundColor = "transparent";
                updateCost(f, win.id);
                return;
            }
            var ok = applyPanelRect(win, f, g);
            noteWindowCost(win.id, started);
            f.meta.text = (win.panelCandidates[0].name || win.panelCandidates[0].kind) +
                (ok ? "  ·  scale " + Math.round((g.w / bound[win.id].natural.w) * 100) + "%" : "  ·  not on screen");
            setChildVisibility(f, "refusal", f.refusal, !ok);
            setChildVisibility(f, "body", f.body, false);
            f.frame.style.backgroundColor = "transparent";
            updateCost(f, win.id);
            return;
        }

        g.w = clamp(g.w, num(win.minWidth) || 240, screenW);
        g.h = clamp(g.h, num(win.minHeight) || 160, screenH);
        g.x = clamp(g.x, 0, Math.max(0, screenW - 160));
        g.y = clamp(g.y, SHELL_TOP_DP, Math.max(SHELL_TOP_DP, screenH - 80));
        setRect(f, g.x, g.y, g.w, g.h);

        var opacity = String(clamp((num(win.opacity) || 930) / 1000, 0.2, 1));
        if (f.lastOpacity !== opacity) {
            f.lastOpacity = opacity;
            f.baseOpacity = Number(opacity);
            f.frame.style.opacity = opacity;
            perf.writes++;
        } else {
            perf.skips++;
        }
        // The frame's colour is the active scheme's (openlock_schemes.css), never an inline copy.
        setChildVisibility(f, "body", f.body, true);
        setChildVisibility(f, "refusal", f.refusal, false);
        noteWindowCost(win.id, started);
        f.meta.text = win.content + "  ·  " + Math.round(g.x) + " " + Math.round(g.y) + "  " +
            Math.round(g.w) + "×" + Math.round(g.h) + "  ·  " + (win.lane || "shell");
        updateCost(f, win.id);
    }

    // --- live panels ---------------------------------------------------------

    function findInHud(candidate) {
        var top = hudRoot();
        if (!top) return null;

        if (candidate.kind === "ref") {
            return alive(candidate.panel) ? candidate.panel : null;
        }

        if (candidate.kind === "id") {
            var found = null;
            try { found = top.FindChildTraverse(candidate.name); } catch (e) {}
            if (found && !isShellPanel(found)) return found;
            return null;
        }

        // Class search: the game builds most HUD components without an id. A token search is the
        // fallback for a component whose class the build changed: it matches the id or any class
        // containing the token and prefers a class match, then the largest panel (the container,
        // not one of its rows).
        var token = candidate.kind === "token" ? String(candidate.name).toLowerCase() : "";
        var stack = [top];
        var guard = 0;
        var best = null;
        var bestScore = -1;

        while (stack.length && guard++ < 6000) {
            var p = stack.pop();
            if (!p || p === root) continue;

            if (token) {
                var idText = "";
                try { idText = String(p.id || ""); } catch (e) {}
                var classText = classesOf(p);
                var haystack = (idText + " " + classText).toLowerCase();
                if (haystack.indexOf(token) >= 0) {
                    var area = num(p.actuallayoutwidth) * num(p.actuallayoutheight);
                    if (area >= 400) {
                        var score = area;
                        if (classText.toLowerCase().indexOf(token) >= 0) score += 100000000;
                        if (score > bestScore) {
                            bestScore = score;
                            best = p;
                        }
                    }
                }
            } else {
                var has = false;
                try { has = p.HasClass(candidate.name); } catch (e) {}
                if (has) return p;
            }

            var count = 0;
            try { count = p.GetChildCount(); } catch (e) { count = 0; }
            for (var i = count - 1; i >= 0; i--) {
                var child = null;
                try { child = p.GetChild(i); } catch (e) { child = null; }
                if (child) stack.push(child);
            }
        }
        return token ? best : null;
    }

    function naturalOf(panel) {
        // A hidden shop or map still has a layout size; framing it would draw chrome around
        // nothing and transform a screen the game is not showing.
        if (!panelVisible(panel)) return null;
        var w = num(panel.actuallayoutwidth);
        var h = num(panel.actuallayoutheight);
        if (w < 8 || h < 8) return null;

        var x = 0;
        var y = 0;
        try {
            var pos = panel.GetPositionWithinWindow();
            if (pos) {
                x = num(pos.x !== undefined ? pos.x : pos[0]);
                y = num(pos.y !== undefined ? pos.y : pos[1]);
            }
        } catch (e) {}

        return { x: x, y: y, w: w, h: h };
    }

    // Deadlock HUD containers reserve large transparent rectangles for fade/position math. The
    // AbilitiesContainer, for example, is a full-width 400 dp panel whose actual buttons are a
    // few hundred pixels at the bottom. Framing the container drew chrome around empty space.
    // Union the rectangles of its visible leaf descendants instead, with short labels clipped to
    // their text width; that is the part of the panel the player can actually see.
    // A HUD branch can be laid out and IsVisible while an ancestor fades it to zero. Reading the
    // opacity chain is what keeps a scoreboard card out of the top bar's content rectangle.
    function ancestorPaints(panel, stop) {
        var p = panel;
        var depth = 0;
        while (p && p !== stop && depth++ < 12) {
            try { if (p.IsVisible && !p.IsVisible()) return false; } catch (e) {}
            try {
                if (typeof p.GetOpacity === "function" && p.GetOpacity() < 0.01) return false;
            } catch (e) {}
            try {
                var style = p.style;
                if (style && style.opacity !== undefined && style.opacity !== null && style.opacity !== "") {
                    var value = parseFloat(String(style.opacity));
                    if (!isNaN(value) && value < 0.01) return false;
                }
            } catch (e) {}
            try { p = p.GetParent(); } catch (e) { return true; }
        }
        return true;
    }

    function contentBounds(panel) {
        var whole = naturalOf(panel);
        if (!whole) return null;

        var left = 1e9, top = 1e9, right = -1e9, bottom = -1e9;
        var found = false;
        var stack = [panel];
        var visited = 0;

        while (stack.length && visited++ < 700) {
            var p = stack.pop();
            var count = 0;
            try { count = p.GetChildCount(); } catch (e) { continue; }

            var visibleChildren = 0;
            for (var i = 0; i < count; i++) {
                var child = null;
                try { child = p.GetChild(i); } catch (e) { child = null; }
                if (child && panelVisible(child)) {
                    visibleChildren++;
                    stack.push(child);
                }
            }
            if (visibleChildren > 0) continue;
            if (p === panel) continue;
            if (!ancestorPaints(p, panel)) continue;

            var n = naturalOf(p);
            if (!n || n.w < 8 || n.h < 8) continue;

            // A full-screen transparent image or fade cover is not the content of the window.
            if (n.w > screenW * 0.85 && n.h > screenH * 0.85) continue;

            var x = n.x;
            var y = n.y;
            var w = n.w;
            var h = n.h;
            var text = null;
            try { text = p.text; } catch (e) { text = null; }
            if (typeof text === "string") {
                if (!text.replace(/\s+/g, "")) continue;
                // A Label reports its parent's assigned width, not the width of its glyphs.
                w = Math.min(w, Math.max(12, text.length * 7 + 8));
            }

            found = true;
            if (x < left) left = x;
            if (y < top) top = y;
            if (x + w > right) right = x + w;
            if (y + h > bottom) bottom = y + h;
        }

        if (!found) return whole;
        return {
            x: Math.max(whole.x, left),
            y: Math.max(whole.y, top),
            w: Math.max(8, Math.min(whole.x + whole.w, right) - Math.max(whole.x, left)),
            h: Math.max(8, Math.min(whole.y + whole.h, bottom) - Math.max(whole.y, top))
        };
    }

    function overlapsFramedContent(rect, id) {
        if (!rect) return false;
        var area = rect.w * rect.h;
        for (var key in bound) {
            if (!bound.hasOwnProperty(key) || key === id) continue;
            var b = bound[key];
            if (!b || !b.content) continue;
            var other = b.content;
            var w = Math.min(rect.x + rect.w, other.x + other.w) - Math.max(rect.x, other.x);
            var h = Math.min(rect.y + rect.h, other.y + other.h) - Math.max(rect.y, other.y);
            if (w <= 0 || h <= 0) continue;
            var overlap = w * h;
            var otherArea = other.w * other.h;
            if (overlap > Math.min(area, otherArea) * 0.35) return true;
        }
        return false;
    }

    function ownedByAnother(panel, id) {
        for (var key in bound) {
            if (!bound.hasOwnProperty(key) || key === id) continue;
            if (bound[key] && bound[key].panel === panel) return true;
        }
        return false;
    }

    function ensureBound(win) {
        if (bound[win.id] && alive(bound[win.id].panel)) return bound[win.id];

        bound[win.id] = null;
        var candidates = win.panelCandidates || [];
        for (var i = 0; i < candidates.length; i++) {
            var panel = findInHud(candidates[i]);
            if (!panel) continue;
            // HUD controls can sit inside a transparent full-screen container; a declared screen
            // (shop, map, hero select) is the window itself and must keep its full rect.
            if (win["theme-role"] === "hud") panel = surfaceTarget(panel);
            // One panel, one window: two chrome frames on the same element would fight over its
            // transform and the last one drawn would win.
            if (ownedByAnother(panel, win.id)) continue;
            var natural = naturalOf(panel);
            if (!natural) continue;
            var content = contentBounds(panel) || natural;
            bound[win.id] = { panel: panel, natural: natural, content: content };
            bindFrameHover(win.id, panel);
            $.Msg("[Openlock] shell framed '", win.id, "' → ",
                candidates[i].name || candidates[i].kind, " ", Math.round(natural.w), "×",
                Math.round(natural.h), " content ", Math.round(content.w), "×", Math.round(content.h));
            return bound[win.id];
        }
        return null;
    }

    function releasePanel(id) {
        var record = frames[id];
        if (record) {
            record.shiftY = undefined;
            record.targetShiftY = 0;
            record.shiftAnim = false;
        }
        var b = bound[id];
        if (!b) return;
        // Put the game's panel back where it belongs. The player's placement is geometry and is
        // kept, so reopening the window returns to the same place. A pinned panel that was forced
        // visible gives the game its own collapse state back when it is unpinned or closed.
        try { b.panel.style.transform = ""; } catch (e) {}
        if (b.forcedChain) {
            for (var i = 0; i < b.forcedChain.length; i++) {
                try { b.forcedChain[i].panel.style.visibility = b.forcedChain[i].visibility; } catch (e) {}
            }
            b.forcedChain = null;
        }
        if (b.forcedTarget) {
            try { b.panel.style.opacity = b.forcedTarget.opacity; } catch (e) {}
            b.forcedTarget = null;
        }
        bound[id] = null;
    }

    // A pinned live window is a promise to keep the game panel on screen. Deadlock collapses
    // panels (the minimap in a menu, the shop in a match); while pinned, override that chain and
    // restore every inline value on unpin. This is deliberately scoped to the pinned frame.
    function enforcePinnedVisibility(id) {
        var b = bound[id];
        if (!b || !b.panel || !pinned[id]) return;
        try {
            if (!b.forcedChain) b.forcedChain = [];
            var chain = b.forcedChain;
            var p = b.panel;
            var depth = 0;
            while (p && p !== root && depth++ < 12) {
                var already = false;
                for (var i = 0; i < chain.length; i++) if (chain[i].panel === p) { already = true; break; }
                if (!already) {
                    var prior = "";
                    try { prior = p.style.visibility || ""; } catch (e) { prior = ""; }
                    chain.push({ panel: p, visibility: prior });
                }
                try { p.style.visibility = "visible"; } catch (e) {}
                try { p = p.GetParent(); } catch (e) { break; }
            }
            if (!b.forcedTarget) {
                var opacity = "";
                try { opacity = b.panel.style.opacity || ""; } catch (e) { opacity = ""; }
                b.forcedTarget = { opacity: opacity };
            }
            b.panel.style.opacity = "1";
        } catch (e) {
            $.Msg("[Openlock] pin visibility REFUSED for '", id, "': ", String(e));
        }
    }

    function scanLivePanels() {
        var top = hudRoot();
        var out = [];
        if (!top) return out;

        var stack = [top];
        var guard = 0;
        var seen = {};

        while (stack.length && guard++ < 8000) {
            var p = stack.pop();
            if (!p || p === root) continue;

            var id = "";
            try { id = p.id || ""; } catch (e) { id = ""; }
            var w = num(p.actuallayoutwidth);
            var h = num(p.actuallayoutheight);
            var visible = true;
            try { visible = p.IsVisible ? p.IsVisible() : true; } catch (e) { visible = true; }

            var skipId = id.indexOf("DWHost_") === 0 || id.indexOf("Openlock") === 0 || id === "Hud" || isShellPanel(p);
            if (!skipId && visible && w >= 24 && h >= 18) {
                var x = 0;
                var y = 0;
                try {
                    var pos = p.GetPositionWithinWindow();
                    if (pos) {
                        x = num(pos.x !== undefined ? pos.x : pos[0]);
                        y = num(pos.y !== undefined ? pos.y : pos[1]);
                    }
                } catch (e) {}

                var cls = classesOf(p);
                var key = id + "|" + cls + "|" + Math.round(w) + "x" + Math.round(h) + "|" + Math.round(x) + "," + Math.round(y);
                if (!seen[key]) {
                    seen[key] = 1;
                    out.push({
                        id: id,
                        cls: cls,
                        panel: p,
                        x: x,
                        y: y,
                        w: w,
                        h: h
                    });
                }
            }

            var count = 0;
            try { count = p.GetChildCount(); } catch (e) { count = 0; }
            for (var i = count - 1; i >= 0; i--) {
                var child = null;
                try { child = p.GetChild(i); } catch (e) { child = null; }
                if (child) stack.push(child);
            }
        }

        out.sort(function (a, b) { return (b.w * b.h) - (a.w * a.h); });
        return out.slice(0, 120);
    }

    function frameLive(entry) {
        var base = entry.id || entry.cls || "panel";
        var id = (entry.inPopup ? "popup:" : "live:") + base.replace(/[^A-Za-z0-9_]/g, "_") + ":" +
            Math.round(entry.w) + "x" + Math.round(entry.h);
        var win = index[id];
        if (!win) {
            win = {
                id: id,
                live: true,
                title: entry.title || base,
                content: "live",
                lane: "game",
                x: entry.x,
                y: entry.y,
                width: entry.w,
                height: entry.h,
                minWidth: 80,
                minHeight: 60,
                opacity: 930,
                "theme-role": "hud",
                pinnable: true,
                panelCandidates: [{ kind: "ref", panel: entry.panel }]
            };
            data.windows.push(win);
            index[id] = win;
        } else {
            win.panelCandidates = [{ kind: "ref", panel: entry.panel }];
        }

        geometry[id] = {
            x: entry.x,
            y: entry.y,
            w: entry.w,
            h: entry.h,
            init: true
        };
        bound[id] = { panel: entry.panel, natural: { x: entry.x, y: entry.y, w: entry.w, h: entry.h } };
        openWindow(id);
        globalThis.OpenlockToast("Window framed", base + " · " + Math.round(entry.w) + "×" + Math.round(entry.h), id, false);
    }

    // --- discovery -----------------------------------------------------------
    // The package names the windows it knows; the rest of the app's windows are discovered from
    // the live HUD itself. The HUD root's children are the game's top-level windows, so a new
    // screen, a renamed class or another Source 2 app needs no package row to get chrome.
    function hudPanelName(panel, index) {
        var id = "";
        try { id = panel.id || ""; } catch (e) { id = ""; }
        if (id) return id;
        var cls = classesOf(panel).split(" ")[0];
        return cls || ("panel_" + index);
    }

    // Every visible HUD surface, not only the direct children of one container. Deadlock nests
    // the top bar, health and ability readouts inside full-screen HUD containers; a direct-child
    // sweep framed the minimap and ability panel but never reached those. Walk bounded branches,
    // stop at the first panel that is a surface in its own right, and descend only through the
    // containers that are too large to be a window.
    function hudWindowCandidates() {
        var container = hudRoot();
        if (!container) return [];

        var found = [];
        var visited = 0;
        function walk(parent, depth) {
            if (!parent || visited > 900 || depth > 7) return;
            var count = 0;
            try { count = parent.GetChildCount(); } catch (e) { return; }

            for (var i = 0; i < count; i++) {
                var child = null;
                try { child = parent.GetChild(i); } catch (e) { child = null; }
                if (!child || child === root || isShellPanel(child) || !panelVisible(child)) continue;
                visited++;

                var id = "";
                try { id = child.id || ""; } catch (e) { id = ""; }
                var cls = classesOf(child);
                if (isTransientHud(id, cls)) continue;

                var w = num(child.actuallayoutwidth);
                var h = num(child.actuallayoutheight);
                // A HUD window is a region with room for a title bar. Icons, team-score
                // counters and reticles are controls inside a region, not windows of their own.
                if (w < 80 || h < 40) continue;
                var area = w * h;
                var text = (id + " " + cls).toLowerCase();
                // TopBar is the transparent wrapper around the real top-bar controls. Framing the
                // wrapper drew a 500 dp black rectangle; descend and frame the controls.
                if (/(^|\s)topbar(\s|$)/.test(text) && area > screenW * screenH * 0.2) {
                    walk(child, depth + 1);
                    continue;
                }
                var screenish = /(select|dashboard|screen|lobby|hideout|match|hero)/.test(text);
                // A HUD window is a region the player reads, not an effect drawn over it. The
                // reticle, damage radar, cast/clip warnings and chat feed are controls inside a
                // region; framing each one produced a wall of overlapping title bars.
                var windowish = /(top.?bar|hudtopbar|teamscore|health|shield|ability|abilities|minimap|soul|gold|level|shop|inventory|quickbuy|objective|courier|portrait|stash|roster|timer|status|score|map)/.test(text);
                var effect = /(crosshair|reticle|damage|radar|clip|cast|zipline|aura|modifier|feed|chat|ping|backer|playercontents|objectives|levelup|level_rewards|notice|announce|tooltip|fade|loading)/.test(text);
                var named = windowish && !effect && hasReadableName(id, cls) && isHudSurface(id, cls, false);

                // A full-screen screen is one window; do not carve its contents into chrome.
                if (named && screenish && area > screenW * screenH * 0.45) {
                    found.push(child);
                    continue;
                }

                // A surface gets one frame. Its own children are its content, not more windows.
                if (named && area <= screenW * screenH * 0.45) {
                    found.push(child);
                    $.Msg("[Openlock] hud surface '", id || cls, "' ", Math.round(w), "×", Math.round(h));
                    continue;
                }

                // A large or unnamed container carries the surfaces below it.
                if (depth < 7) walk(child, depth + 1);
            }
        }

        walk(container, 0);
        $.Msg("[Openlock] hud walk: ", found.length, " surface(s) of ", visited, " panel(s) visited");
        return found;
    }

    // A panel the package already declares belongs to that window, whether or not the window has
    // been opened yet. Discovery runs before the first theme pass, so "not bound yet" is not
    // "unclaimed": without this check a pinned window and a discovered one would both transform
    // the same panel and the last one drawn would win.
    function isDeclaredPanel(panel) {
        var id = "";
        try { id = panel.id || ""; } catch (e) { id = ""; }
        var classes = classesOf(panel).split(" ");
        var haystack = (id + " " + classes.join(" ")).toLowerCase();

        for (var i = 0; i < data.windows.length; i++) {
            var win = data.windows[i];
            if (win.discovered) continue;
            // A declared window only owns its panel when it is hot (the poll will frame it) or
            // already bound/open. Skipping every declared candidate suppressed discovery for the
            // whole HUD, which is why top-level panels had no chrome at all.
            if (!AUTO_FRAME_IDS[win.id] && !open[win.id] && !bound[win.id]) continue;
            var cands = win.panelCandidates || [];
            for (var j = 0; j < cands.length; j++) {
                var c = cands[j];
                if (c.kind === "id" && id === c.name) return true;
                if (c.kind === "class" && classes.indexOf(c.name) >= 0) return true;
                // A token is a fallback for binding, not proof of ownership. "abilities" also
                // occurs in health_and_abilities_container, and treating that as the declared
                // ability window left the health bar and upgrade panel with no chrome at all.
                if (c.kind === "token" && (id === c.name || classes.indexOf(c.name) >= 0)) return true;
            }
        }
        return false;
    }

    // Only these surfaces are retried by the poll. The package declares every Deadlock layout,
    // but walking the HUD for all 341 of them every two seconds was the periodic freeze: eight
    // hot surfaces are cheap, and everything else is framed by discovery or opened on demand.
    var AUTO_FRAME_IDS = {
        inventory: 1, trees: 1, "map-plan": 1, minimap: 1,
        abilities: 1, quickbuy: 1, "combat-log": 1, "game-settings": 1,
        "hero-select": 1, "game-hud_escape_menu": 1
    };
    var autoRetryAt = {};
    var hudAutoFramed = false;

    function panelInside(parent, child) {
        var p = child;
        var depth = 0;
        while (p && depth++ < 40) {
            if (p === parent) return true;
            try { p = p.GetParent(); } catch (e) { return false; }
        }
        return false;
    }

    function panelAlreadyFramed(panel) {
        for (var id in bound) {
            if (!bound.hasOwnProperty(id) || !bound[id]) continue;
            var framed = bound[id].panel;
            if (!framed) continue;
            if (panelInside(framed, panel) || panelInside(panel, framed)) return true;
        }
        return false;
    }

    // The catalog has 340 named game windows. Framing all of them at once would put chrome around
    // every child row; frame the largest visible ones once, and let the UI tree/console open the
    // rest on demand. The scan is chunked and yields every 48 nodes, so a large HUD cannot stall a
    // frame; it is one-shot per expanded shell, never part of the poll.
    function streamHudPanels(done) {
        if (hudStreamActive) return;
        hudStreamActive = true;
        hudStreamNodes = [];
        var queue = [{ panel: hudRoot(), inPopup: false }];
        var seen = {};
        var guard = 0;

        function step() {
            var budget = 48;
            while (queue.length && budget-- > 0) {
                var item = queue.pop();
                var p = item && item.panel;
                if (!p || p === root || guard++ > 12000) continue;
                var id = "";
                try { id = p.id || ""; } catch (e) { id = ""; }
                var w = num(p.actuallayoutwidth);
                var h = num(p.actuallayoutheight);
                var visible = true;
                try { visible = p.IsVisible ? p.IsVisible() : true; } catch (e) { visible = true; }
                var skip = id.indexOf("DWHost_") === 0 || id.indexOf("Openlock") === 0 || id === "Hud" || isShellPanel(p);
                var cls = classesOf(p);
                var popupText = (id + " " + cls).toLowerCase();
                var popupOwn = /(popup|modal|dialog)/.test(popupText);
                var inPopup = item.inPopup || popupOwn;
                if (!skip && visible && w >= 24 && h >= 18 && !isTransientHud(id, cls)) {
                    var x = 0, y = 0;
                    try {
                        var pos = p.GetPositionWithinWindow();
                        if (pos) {
                            x = num(pos.x !== undefined ? pos.x : pos[0]);
                            y = num(pos.y !== undefined ? pos.y : pos[1]);
                        }
                    } catch (e) {}
                    var key = id + "|" + cls + "|" + Math.round(w) + "x" + Math.round(h) + "|" + Math.round(x) + "," + Math.round(y);
                    if (!seen[key]) {
                        seen[key] = 1;
                        var entry = { id: id, cls: cls, panel: p, x: x, y: y, w: w, h: h,
                            depth: item.depth || 0, inPopup: inPopup, popupOwn: popupOwn, kids: 0 };
                        hudStreamNodes.push(entry);
                        if (item.parent) item.parent.kids++;
                        item.entry = entry;
                    }
                }
                var count = 0;
                try { count = p.GetChildCount(); } catch (e) { count = 0; }
                for (var i = count - 1; i >= 0; i--) {
                    var child = null;
                    try { child = p.GetChild(i); } catch (e) { child = null; }
                    if (child) queue.push({ panel: child, inPopup: inPopup,
                        depth: (item.depth || 0) + 1, parent: item.entry || item.parent });
                }
            }
            if (queue.length) { $.Schedule(0.05, step); return; }
            hudStreamActive = false;

            var screenArea = Math.max(1, screenW * screenH);
            var surfaces = [];
            for (var n = 0; n < hudStreamNodes.length; n++) {
                var entry = hudStreamNodes[n];
                // Only the popup root is a window; its backgrounds and rows are contents.
                if (entry.inPopup && !entry.popupOwn) continue;
                if (!entry.inPopup && !isHudSurface(entry.id, entry.cls, false)) continue;
                if (!entry.inPopup && !hasReadableName(entry.id, entry.cls)) continue;
                var area = entry.w * entry.h;
                var screenish = /(select|dashboard|screen|lobby|hideout|match|shop|hero)/.test(
                    (entry.id + " " + entry.cls).toLowerCase());
                // Transparent roots (HUD, PopupManager, AbilitiesContainer, the old panel_0
                // wrappers) own several visible children. The child surfaces are the windows. A
                // named full-screen screen is the exception: its chrome is the screen's chrome.
                if (entry.kids >= 2 && area > screenArea * 0.04 && !entry.inPopup && !screenish) continue;
                if (area > screenArea * 0.92 && !entry.inPopup && !screenish) continue;
                surfaces.push(entry);
            }

            // Larger real elements first, but never let a wrapper starve its children: wrappers
            // are already gone, and this sort is only for a stable ordering of actual controls.
            surfaces.sort(function (a, b) { return (b.w * b.h) - (a.w * a.h); });
            // Keep the preview bounded; 240 measured nodes is enough for the tree and the frames.
            hudStreamNodes = hudStreamNodes.slice(0, 240);
            done(surfaces);
        }
        step();
    }

    // Framing is asynchronous: four chrome builds per tick keeps the game rendering while the
    // HUD sweep adds twenty-odd windows. The old synchronous loop is what froze the client.
    function frameLargestFrom(nodes, limit, done) {
        if (!bulkFramesEnabled) { if (done) done(0); return 0; }
        var at = 0;
        var framed = 0;
        function step() {
            var budget = 4;
            while (at < nodes.length && framed < limit && budget-- > 0) {
                var entry = nodes[at++];
                if (entry.w * entry.h < 900) continue;
                var target = entry.panel;
                if (!/(select|dashboard|screen|lobby|hideout|match|shop|hero)/.test(
                    (entry.id + " " + entry.cls).toLowerCase())) target = surfaceTarget(entry.panel);
                if (target !== entry.panel) {
                    var natural = naturalOf(target);
                    if (!natural) continue;
                    entry = { id: target.id || entry.id, cls: classesOf(target) || entry.cls,
                        panel: target, x: natural.x, y: natural.y, w: natural.w, h: natural.h,
                        inPopup: entry.inPopup };
                }
                if (panelAlreadyFramed(entry.panel)) continue;
                frameLive(entry);
                framed++;
            }
            if (at < nodes.length && framed < limit) { $.Schedule(0.04, step); return; }
            if (done) done(framed);
        }
        step();
        return framed;
    }

    function frameLargestHud(limit) {
        streamHudPanels(function (nodes) {
            notePerformanceRefusal(nodes.length);
            if (nodes.length > 700) {
                globalThis.OpenlockToast("Performance guard",
                    nodes.length + " HUD panels; bulk framing limited to the largest " + limit, "", true);
            }
            frameLargestFrom(nodes, Math.min(limit, 32));
        });
    }

    // Popups are created and destroyed while the shell is open; they are not in the one-shot HUD
    // sweep. Cache the manager and re-read only its direct children, which is cheap enough for
    // the existing idle poll. Each visible popup gets its own frame and its own close button.
    var popupRoot = null;
    var popupFindAt = 0;
    var popupFramed = {};

    function scanPopups() {
        if (!expanded || !bulkFramesEnabled) return;
        var now = Date.now();
        if (!popupRoot || !alive(popupRoot)) {
            if (now - popupFindAt < 8000) return;
            popupFindAt = now;
            popupRoot = findInHud({ kind: "id", name: "PopupManager" }) ||
                findInHud({ kind: "class", name: "PopupManager" });
        }
        if (!popupRoot) return;

        // Popups are nested under their manager by a wrapper or two. Walk a bounded depth and
        // frame the matching visible surface itself, not the transparent manager or wrapper.
        var found = [];
        var queue = [{ panel: popupRoot, depth: 0 }];
        while (queue.length) {
            var item = queue.shift();
            var p = item.panel;
            if (!p || item.depth > 4 || isShellPanel(p)) continue;
            var w = num(p.actuallayoutwidth);
            var h = num(p.actuallayoutheight);
            var cls = classesOf(p);
            var id = p.id || "";
            var text = (id + " " + cls).toLowerCase();
            if (item.depth > 0 && panelVisible(p) && w >= 80 && h >= 48 &&
                !/(popupmanager|popuproot)/.test(text) &&
                /(popup|dialog|modal|damage|report|settings|menu|build|shop|party|announce|toast|survey)/.test(text)) {
                found.push({ panel: p, x: 0, y: 0, w: w, h: h, id: id, cls: cls });
            }
            var count = 0;
            try { count = p.GetChildCount(); } catch (e) { count = 0; }
            for (var i = 0; i < count; i++) {
                var child = null;
                try { child = p.GetChild(i); } catch (e) { child = null; }
                if (child) queue.push({ panel: child, depth: item.depth + 1 });
            }
        }

        found.sort(function (a, b) { return (b.w * b.h) - (a.w * a.h); });
        var framed = 0;
        for (var f = 0; f < found.length && framed < 6; f++) {
            var entry = found[f];
            entry.panel = surfaceTarget(entry.panel);
            var natural = naturalOf(entry.panel);
            if (!natural) continue;
            if (panelAlreadyFramed(entry.panel)) continue;
            var key = "popup:" + (entry.panel.id || classesOf(entry.panel) || f).replace(/[^A-Za-z0-9_]/g, "_") +
                ":" + Math.round(natural.w) + "x" + Math.round(natural.h);
            if (popupFramed[key] || dismissed[key]) continue;
            popupFramed[key] = true;
            var label = classesOf(entry.panel) || entry.panel.id || "Popup";
            frameLive({ id: entry.panel.id || classesOf(entry.panel) || ("popup_" + f),
                cls: classesOf(entry.panel), panel: entry.panel,
                x: natural.x, y: natural.y, w: natural.w, h: natural.h, inPopup: true,
                title: "Popup · " + String(label).split(" ")[0] });
            framed++;
        }
    }

    // The first open used to build every top-level HUD frame in one click. Discovery is still a
    // one-shot pass, but it is now deferred and yields between frames: the shell paints, then the
    // largest twelve panels acquire chrome over the next few ticks. This is the click-to-open
    // hang, not a rendering cost.
    var discoveringHud = false;
    var hudDiscoverAt = 0;

    function discoverHudWindows() {
        if (discoveringHud) return;
        discoveringHud = true;
        hudDiscoverAt = Date.now();
        var candidates = hudWindowCandidates();
        candidates.sort(function (a, b) {
            return (num(b.actuallayoutwidth) * num(b.actuallayoutheight)) -
                (num(a.actuallayoutwidth) * num(a.actuallayoutheight));
        });
        candidates = candidates.filter(function (panel) {
            var id = hudPanelName(panel, 0);
            var cls = classesOf(panel);
            var area = num(panel.actuallayoutwidth) * num(panel.actuallayoutheight);
            var screenish = /(select|dashboard|screen|lobby|hideout|match|hero)/.test(
                (id + " " + cls).toLowerCase());
            if (area > screenW * screenH * 0.45 && !screenish) return false;
            return hasReadableName(id, cls) && isHudSurface(id, cls, false) &&
                !isTransientHud(id, cls);
        }).slice(0, 40);
        var at = 0;

        function step() {
            if (!expanded || at >= candidates.length) {
                discoveringHud = false;
                hudDiscoverAt = Date.now();
                return;
            }
            var panel = candidates[at];
            var ordinal = at;
            at++;

            if (!isDeclaredPanel(panel) && !ownedByAnother(panel, "") &&
                !panelAlreadyFramed(panel) &&
                !isTransientHud(hudPanelName(panel, ordinal), classesOf(panel))) {
                var key = "hud:" + hudPanelName(panel, ordinal).replace(/[^A-Za-z0-9_]/g, "_");
                var nat = naturalOf(panel);
                var content = nat ? contentBounds(panel) : null;
                if (content && overlapsFramedContent(content, key)) {
                    $.Schedule(0.02, step);
                    return;
                }
                if (nat && !index[key] && !dismissed[key]) {
                    var win = {
                        id: key,
                        live: true,
                        title: hudPanelName(panel, ordinal),
                        content: "live",
                        lane: "game",
                        x: nat.x,
                        y: nat.y,
                        width: nat.w,
                        height: nat.h,
                        minWidth: 80,
                        minHeight: 60,
                        opacity: 930,
                        "theme-role": "hud",
                        pinnable: true,
                        autoFrame: true,
                        discovered: true,
                        panelCandidates: [{ kind: "ref", panel: panel }]
                    };

                    data.windows.push(win);
                    index[key] = win;
                    geometry[key] = { x: nat.x, y: nat.y, w: nat.w, h: nat.h, init: true };
                    bound[key] = { panel: panel, natural: nat };

                    var f = createFrame(win);
                    f.auto = true;
                    open[key] = true;
                    applyWindow(win);
                }
            }

            if (at < candidates.length) $.Schedule(0.02, step);
            else {
                discoveringHud = false;
                hudDiscoverAt = Date.now();
            }
        }
        step();
    }

    // --- frames --------------------------------------------------------------

    var contextMenu = null;
    var contextDismiss = null;
    var contextRect = null;
    var contextWatch = 0;

    function closeContextMenu() {
        contextWatch++;
        contextRect = null;
        if (contextMenu) { try { contextMenu.DeleteAsync(0); } catch (e) {} }
        if (contextDismiss) { try { contextDismiss.DeleteAsync(0); } catch (e) {} }
        contextMenu = null;
        contextDismiss = null;
        hideDwell();
    }

    function watchContextMenu() {
        if (!contextMenu || !contextRect) return;
        var token = contextWatch;
        $.Schedule(0.15, function () {
            if (token !== contextWatch || !contextMenu || !contextRect) return;
            var at = cursorPoint();
            var r = contextRect;
            if (at && (at.x < r.x - 24 || at.x > r.x + r.w + 24 ||
                at.y < r.y - 24 || at.y > r.y + r.h + 24)) {
                closeContextMenu();
                return;
            }
            watchContextMenu();
        });
    }

    function contextAction(menu, label, fn) {
        var item = actionXd(menu, label, function () {
            closeContextMenu();
            fn();
        });
        return item;
    }

    function showContextMenu(win, x, y) {
        closeContextMenu();
        if (!win) return;
        hideDwell();

        // A full-screen dismiss surface sits just under the menu: a click anywhere outside a
        // menu row lands here and closes it. Menu rows are above it, so selecting one does not.
        contextDismiss = $.CreatePanel("Panel", root, "OpenlockContextDismiss");
        contextDismiss.AddClass("ContextDismiss");
        contextDismiss.SetPanelEvent("onmouseactivate", function () { closeContextMenu(); });

        var left = Math.max(8, Math.min(screenW - 190, x));
        // Open below the title bar, not on top of it. The menu is its own layer above every
        // window; the title stays visible and the menu cannot sit under a frame's own chrome.
        var top = Math.max(SHELL_TOP_DP, Math.min(screenH - 280, y));
        contextMenu = $.CreatePanel("Panel", root, "OpenlockContextMenu");
        contextMenu.AddClass("ContextMenu");
        contextMenu.style.marginLeft = left + "px";
        contextMenu.style.marginTop = top + "px";

        var title = $.CreatePanel("Label", contextMenu, "");
        title.AddClass("ContextTitle");
        title.text = win.title || win.id;

        contextAction(contextMenu, "Open", function () { openWindow(win.id); });
        contextAction(contextMenu, "Minimize", function () { minimizeWindow(win.id); });
        contextAction(contextMenu, pinned[win.id] ? "Unpin" : "Pin", function () { togglePin(win.id); });
        if (isPanelWindow(win)) contextAction(contextMenu, "Launch layout", function () {
            var path = layoutForWindow(win);
            if (path) openLayout(path);
            else globalThis.OpenlockToast("Layout refused", win.title + " has no mounted layout", "", true);
        });
        contextAction(contextMenu, "Inspect in UI tree", function () {
            uiSelected = win.id;
            uiCss.selector = "";
            openWindow("uitree");
        });
        contextAction(contextMenu, "Close", function () { closeWindow(win.id); });

        // The layout is not measured until the next frame; use a conservative record now and let
        // the watch retire the menu as soon as the pointer leaves that box.
        contextRect = { x: left, y: top, w: 180, h: 280 };
        contextWatch++;
        watchContextMenu();
    }

    var dwellPanel = null;
    var dwellToken = 0;

    function hideDwell() {
        dwellToken++;
        if (!dwellPanel) return;
        try { dwellPanel.DeleteAsync(0); } catch (e) {}
        dwellPanel = null;
    }

    // Win32-style pointer tooltip: it appears beside the cursor, not at the window corner, and
    // every interactive window element binds its own title/body. It never takes hit testing, so
    // the control under the pointer stays clickable while the tooltip is up.
    function dwellAt(titleText, bodyText, anchor) {
        hideDwell();
        var token = dwellToken;
        $.Schedule(0.28, function () {
            if (token !== dwellToken) return;
            var at = cursorPoint();
            if (!at && anchor) {
                // No pointer API on this build: anchor to the control itself, not to a fixed
                // corner. The tip then still explains the thing the pointer is over.
                try {
                    var pos = anchor.GetPositionWithinWindow();
                    var px = num(pos.x !== undefined ? pos.x : pos[0]);
                    var py = num(pos.y !== undefined ? pos.y : pos[1]);
                    var pw = num(anchor.actuallayoutwidth);
                    var ph = num(anchor.actuallayoutheight);
                    at = { x: px + pw / 2, y: py + ph + 8 };
                } catch (e) {}
            }
            var x = at ? at.x + 14 : 320;
            var y = at ? at.y + 18 : 180;
            dwellPanel = $.CreatePanel("Panel", root, "OpenlockDwell");
            dwellPanel.AddClass("DwellInfo");
            dwellPanel.hittest = false;
            dwellPanel.hittestchildren = false;
            dwellPanel.style.marginLeft = Math.max(8, Math.min(screenW - 280, x)) + "px";
            dwellPanel.style.marginTop = Math.max(SHELL_TOP_DP, Math.min(screenH - 90, y)) + "px";
            var title = $.CreatePanel("Label", dwellPanel, "");
            title.AddClass("DwellTitle");
            title.text = titleText;
            if (bodyText) {
                var body = $.CreatePanel("Label", dwellPanel, "");
                body.AddClass("DwellBody");
                body.text = bodyText;
            }
        });
    }

    // `winId` keeps the window's hover alive on the same elements that own the tooltip. The
    // tooltip used to overwrite the title bar's restore handler, which is why hovering the bar
    // never brought the chrome back on this client.
    function bindDwell(panel, titleText, bodyText, winId) {
        if (!panel) return;
        panel.SetPanelEvent("onmouseover", function () {
            if (winId) enterFrame(winId, "dwell");
            dwellAt(titleText, bodyText, panel);
        });
        panel.SetPanelEvent("onmouseout", function () {
            hideDwell();
            if (winId) leaveFrame(winId, "dwell");
        });
    }

    function showDwell(win) {
        if (!win) return;
        var detail = (win.id || "") + "  ·  " + (win.lane || "shell") + "  ·  " + (win.content || "");
        dwellAt(win.title || win.id, detail);
    }

    function refuseFeature(title, why) {
        $.Msg("[Openlock] REFUSED " + title + ": " + why);
        var key = title + "|" + why;
        if (reportedRefusals[key]) return;
        reportedRefusals[key] = true;
        runtimeRefusals.push({ file: "client", subject: title, why: why });
        if (runtimeRefusals.length > 40) runtimeRefusals.shift();
        globalThis.OpenlockToast(title, why, "", true);
    }

    function titleButton(parent, icon, onClick, winId) {
        // Move is a drag handle; the rest act on press. A press is also what the pointer probe
        // records, so a refused control is visible in the log instead of silently doing nothing.
        var b = addControl(parent, "WindowButton", "", onClick, icon !== "Move");
        var i = $.CreatePanel("Panel", b, "");
        i.AddClass("WindowIcon");
        i.AddClass("Icon" + icon);
        // The icon is a child of the button, not a second target. It must never take the press.
        i.hittest = false;
        i.hittestchildren = false;

        // Real Unicode controls from Arial Unicode MS, which the client already ships as
        // vgui/fonts/arialuni.ttf. These are not drawn codepoints guessed from a system font.
        var glyph = "";
        if (icon === "Minimize") glyph = "−";
        else if (icon === "Maximize") glyph = "□";
        else if (icon === "Close") glyph = "×";

        if (glyph) {
            var label = $.CreatePanel("Label", i, "");
            label.AddClass("WindowGlyph");
            label.text = glyph;
            label.hittest = false;
            b.glyph = label;
        } else if (icon === "Pin") {
            var head = $.CreatePanel("Panel", i, "");
            head.AddClass("IconPinHead");
            var stem = $.CreatePanel("Panel", i, "");
            stem.AddClass("IconPinStem");
        } else if (icon === "Move") {
            var h = $.CreatePanel("Panel", i, "");
            h.AddClass("IconMoveBarH");
            var v = $.CreatePanel("Panel", i, "");
            v.AddClass("IconMoveBarV");
            var tips = ["Up", "Down", "Left", "Right"];
            for (var t = 0; t < tips.length; t++) {
                var tip = $.CreatePanel("Panel", i, "");
                tip.AddClass("IconMoveTip");
                tip.AddClass("MoveTip" + tips[t]);
            }
        }

        if (!b || b.hittest === false) {
            refuseFeature("Window control refused", icon + " has no hit-testable button; the title bar would swallow the click");
        }

        var help = {
            Move: ["Move window", "Drag to reposition. Capture follows the pointer without snapping to a grid."],
            Minimize: ["Minimize", "Hide this window's chrome; its tab stays on the bar."],
            Maximize: ["Maximize / restore", "Fill the working area; click again to return to the saved rectangle."],
            Pin: ["Pin", "Keep this window visible while the shell is closed."],
            Close: ["Close", "Collapse the framed game panel, or close this shell window."]
        }[icon];
        if (help) bindDwell(b, help[0], help[1], winId);
        return b;
    }

    function toggleMaximize(id) {
        $.Msg("[Openlock] maximize press: ", id);
        var win = windowById(id);
        var f = frames[id];
        if (!win || !f) {
            refuseFeature("Maximize refused", "no frame owns window '" + id + "'");
            return;
        }

        measureScreen();
        var g = ensureGeometry(win);
        var restore = maximized[id];
        if (restore) {
            g.x = restore.x;
            g.y = restore.y;
            g.w = restore.w;
            g.h = restore.h;
            delete maximized[id];
        } else {
            maximized[id] = { x: g.x, y: g.y, w: g.w, h: g.h };
            g.x = 12;
            g.y = SHELL_TOP_DP + 8;
            g.w = Math.max(240, screenW - 24);
            g.h = Math.max(160, screenH - g.y - 12);
        }
        g.init = true;
        if (f.maxButton) {
            f.maxButton.SetHasClass("Maximized", !!maximized[id]);
            if (f.maxButton.glyph) f.maxButton.glyph.text = maximized[id] ? "▣" : "□";
        }
        applyWindow(win);
        send("layout", id + " " + Math.round(g.x) + " " + Math.round(g.y) + " " +
            Math.round(g.w) + " " + Math.round(g.h));
    }


    function createFrame(win) {
        if (frames[win.id]) return frames[win.id];

        var isPanel = isPanelWindow(win);
        var frame = $.CreatePanel("Panel", isPanel ? panelLayer : windowLayer,
            "OpenlockFrame_" + safeId(win.id));
        frame.AddClass("WindowFrame");
        if (isPanel) frame.AddClass("PanelWindow");
        if (win["theme-role"] === "hud") frame.AddClass("HudRole");
        // Automatically drawn HUD windows get the compact schema: no frame outline, black square
        // controls and white glyphs. After a few idle seconds only the outline and grips go away;
        // the chrome strip stays readable. The pointer-rect probe restores it on hover.
        if (win.autoFrame || win.discovered) frame.AddClass("CompactHud");
        frame.SetPanelEvent("onmouseover", function () { enterFrame(win.id, "frame"); });
        frame.SetPanelEvent("onmouseout", function () { leaveFrame(win.id, "frame"); });
        frame.SetPanelEvent("onmousedown", function () { restoreChrome(win.id); });
        frame.style.visibility = "collapse";
        // The local record below carries the cache; createFrame returns after it is built.

        var title = $.CreatePanel("Panel", frame, "");
        title.AddClass("WindowTitle");

        // The drag target is a strip behind the glyphs, not the title panel itself. A handler on
        // the title also caught presses meant for minimize/maximize/pin/close, so every glyph
        // started a drag. Only empty title space (and the move glyph) now begins one.
        var dragStrip = $.CreatePanel("Panel", title, "");
        dragStrip.AddClass("WindowDrag");
        dragStrip.hittest = true;
        dragStrip.hittestchildren = false;

        var titleLabel = $.CreatePanel("Label", title, "");
        titleLabel.AddClass("WindowTitleLabel");
        titleLabel.text = win.title || win.id;
        titleLabel.hittest = false;
        title.hittest = true;

        var spacer = $.CreatePanel("Panel", title, "");
        spacer.AddClass("WindowSpacer");
        // The spacer fills the empty title area. Without this it swallows the mousedown and the
        // title never begins a drag; Panorama events do not bubble to the parent.
        spacer.hittest = false;

        // Real readings rather than a spinner: the game's current frame interval and this
        // frame's own apply cost, refreshed whenever the window geometry is applied.
        var costLabel = $.CreatePanel("Label", title, "");
        costLabel.AddClass("WindowCost");
        costLabel.hittest = false;
        costLabel.text = "-- ms";

        // Standard window chrome, drawn with panels: minimize, maximize/restore, pin, close.
        // The client font has no coverage for the usual Unicode title-bar glyphs, so each icon is
        // a small shape instead of a typed codepoint.
        var moveButton = titleButton(title, "Move", function () { focusWindow(win.id); }, win.id);
        makeDraggable(moveButton, win.id, "move");
        var minButton = titleButton(title, "Minimize", function () { minimizeWindow(win.id); }, win.id);
        var maxButton = titleButton(title, "Maximize", function () { toggleMaximize(win.id); }, win.id);
        var pinButton = titleButton(title, "Pin", function () { togglePin(win.id); }, win.id);
        if (pinned[win.id]) pinButton.AddClass("PinOn");
        var closeButton = titleButton(title, "Close", function () { closeWindow(win.id); }, win.id);
        // Keep the last glyph clear of the northeast resize grip. The title's own layout does not
        // know the grip's width; this class is the reservation that does.
        if (closeButton) closeButton.AddClass("WindowClose");

        title.SetPanelEvent("onmouseactivate", function () { focusWindow(win.id); });
        bindDwell(title, win.title || win.id, "Frame  ·  drag the title bar or the four-arrow handle to move; right-click for actions", win.id);
        bindDwell(dragStrip, win.title || win.id, "Frame  ·  drag the title bar or the four-arrow handle to move; right-click for actions", win.id);
        bindDwell(titleLabel, win.title || win.id, "Frame  ·  " + (win.id || "") + "  ·  " + (win.content || "live"), win.id);
        title.SetPanelEvent("oncontextmenu", function () {
            var g = ensureGeometry(win);
            showContextMenu(win, g.x + 12, g.y + 6);
        });
        makeDraggable(dragStrip, win.id, "move");

        var meta = $.CreatePanel("Panel", frame, "");
        meta.AddClass("WindowMeta");
        var metaLabel = $.CreatePanel("Label", meta, "");
        metaLabel.AddClass("WindowMetaLabel");

        var body = $.CreatePanel("Panel", frame, "");
        body.AddClass("WindowBody");

        var refusal = $.CreatePanel("Label", frame, "");
        refusal.AddClass("WindowRefusal");
        refusal.style.visibility = "collapse";

        // All four corners are grips. Each one pins the opposite corner while it resizes, so a
        // northwest drag grows the window up and left instead of only moving its right edge.
        var grips = [];
        var gripSpecs = [["NW", "resize-nw"], ["NE", "resize-ne"], ["SW", "resize-sw"], ["SE", "resize-se"]];
        for (var gi = 0; gi < gripSpecs.length; gi++) {
            var grip = $.CreatePanel("Panel", frame, "");
            grip.AddClass("ResizeGrip");
            grip.AddClass("Grip" + gripSpecs[gi][0]);
            bindDwell(grip, "Resize " + gripSpecs[gi][0],
                "Drag this corner. Shell windows resize freely; game panels scale from their own width.", win.id);
            makeDraggable(grip, win.id, gripSpecs[gi][1]);
            grips.push(grip);
        }

        var record = {
            frame: frame,
            title: titleLabel,
            titleBar: title,
            buttons: [moveButton, minButton, maxButton, pinButton, closeButton],
            meta: metaLabel,
            cost: costLabel,
            body: body,
            refusal: refusal,
            grips: grips,
            minButton: minButton,
            maxButton: maxButton,
            pinButton: pinButton,
            win: win,
            lastVisible: "collapse",
            bodyVisible: "collapse",
            refusalVisible: "collapse"
        };
        record.lastActiveAt = Date.now();
        frames[win.id] = record;
        $.Msg("[Openlock] chrome frame: ", win.id, " controls=", record.buttons.length,
            " grips=", record.grips.length, " compact=", !!(win.autoFrame || win.discovered),
            " grade=", shellGrade);
        if (win.autoFrame || win.discovered) {
            record.idleMix = 0;
            paintCompact(record);
        }
        return record;
    }

    function focusWindow(id) {
        focused = id;
        zTop += 1;
        var f = frames[id];
        if (f) {
            try { f.frame.style.zIndex = String(zTop); } catch (e) {}
            for (var key in frames) {
                if (!frames.hasOwnProperty(key)) continue;
                frames[key].frame.SetHasClass("Focused", key === id);
            }
        }
    }

    function openWindow(id) {
        var win = windowById(id);
        if (!win) {
            $.Msg("[Openlock] shell open REFUSED: no window '", id, "'");
            return;
        }

        var hidden = hiddenPanels[id];
        if (hidden) {
            try { hidden.style.visibility = "visible"; } catch (e) {}
            delete hiddenPanels[id];
        }

        expanded = true;
        activeId = id;
        open[id] = true;
        delete dismissed[id];
        delete minimized[id];
        freeCursor(true);

        var f = createFrame(win);
        setFrameVisible(f, true);

        if (!isPanelWindow(win)) renderOwn(win, f.body);

        render();
        focusWindow(id);
        send("view", id);
    }

    // --- arbitrary Panorama layouts -----------------------------------------
    // The package declares the windows the shell ships, but the client mounts hundreds more
    // layouts. The console and OpenlockLayout() can load any of them into an ordinary shell
    // window with the same title bar, pin, dock and close controls.
    var layoutSeq = 0;

    function layoutFont(path) {
        var name = String(path || "").replace(/\\/g, "/");
        name = name.substring(name.lastIndexOf("/") + 1);
        return name.replace(/\.vxml_c$/i, "").replace(/\.xml$/i, "") || "Layout";
    }

    function normalizeLayoutPath(text) {
        var path = String(text || "").trim().replace(/\\/g, "/");
        if (!path) return "";
        if (path.indexOf("file://") === 0) {
            var root = "file://{resources}/";
            if (path.indexOf(root) !== 0) return "";
            path = path.substring(root.length);
        }
        if (path.indexOf("..") >= 0) return "";
        if (path.charAt(0) === "/") path = path.substring(1);
        if (path.indexOf("/") < 0) path = "panorama/layout/" + path;
        path = path.replace(/\.vxml_c$/i, ".xml");
        if (!/\.xml$/i.test(path)) path += ".xml";
        return "file://{resources}/" + path;
    }

    function findLayout(text) {
        var query = String(text || "").trim().replace(/\\/g, "/").toLowerCase();
        if (!query) return "";
        var layouts = data.layouts || [];
        var i;
        for (i = 0; i < layouts.length; i++) {
            if (layouts[i].toLowerCase() === query) return layouts[i];
        }
        for (i = 0; i < layouts.length; i++) {
            if (layoutFont(layouts[i]).toLowerCase() === query) return layouts[i];
        }
        for (i = 0; i < layouts.length; i++) {
            if (layouts[i].toLowerCase().indexOf(query) >= 0) return layouts[i];
        }
        return "";
    }

    function openLayout(text) {
        var path = normalizeLayoutPath(text);
        if (!path) {
            globalThis.OpenlockToast("Layout refused", "not a mounted Panorama layout: " + text, "", true);
            return "";
        }

        var id = "__layout_" + (++layoutSeq);
        var win = {
            id: id,
            title: layoutFont(path),
            content: "layout",
            lane: "layout",
            view: "layout",
            layoutPath: path,
            x: 120, y: 120, width: 640, height: 440,
            minWidth: 240, minHeight: 160,
            opacity: 930,
            "theme-role": "surface",
            pinnable: true
        };
        index[id] = win;
        var hidden = hiddenPanels[id];
        if (hidden) {
            try { hidden.style.visibility = "visible"; } catch (e) {}
            delete hiddenPanels[id];
        }

        expanded = true;
        activeId = id;
        open[id] = true;
        delete dismissed[id];
        delete minimized[id];
        freeCursor(true);

        var f = createFrame(win);
        setFrameVisible(f, true);
        renderOwn(win, f.body);
        render();
        focusWindow(id);
        return id;
    }

    globalThis.OpenlockLayout = function (path) {
        return openLayout(String(path || ""));
    };

    // Every declared game window is opened by the shell when its screen comes on screen: the
    // shop when the player opens the shop, the map when the map is open, the minimap and ability
    // bar when the HUD builds them. Only declared panel windows take part; a closed screen is not
    // a frame, and a window the player closed is left closed.
    function autoFrameOpen() {
        var now = Date.now();
        for (var i = 0; i < data.windows.length; i++) {
            var win = data.windows[i];
            if (!AUTO_FRAME_IDS[win.id]) continue;
            if (!win.autoFrame || open[win.id] || dismissed[win.id] || hiddenPanels[win.id]) continue;
            // A closed shop or map is not on screen. Retrying its class lookup every two seconds
            // walks most of the HUD for nothing, so each surface gets one attempt per interval.
            if (autoRetryAt[win.id] && now - autoRetryAt[win.id] < 6000) continue;
            autoRetryAt[win.id] = now;
            if (!ensureBound(win)) continue;
            var f = createFrame(win);
            f.auto = true;
            open[win.id] = true;
            applyWindow(win);
        }
    }

    function closeWindow(id) {
        $.Msg("[Openlock] close press: ", id);
        var f = frames[id];
        var b = bound[id];
        // Closing a frame around a live game panel collapses that panel, not only its chrome.
        // The panel is remembered so reopening the window restores it.
        releasePanel(id);
        if (b && b.panel) {
            try { b.panel.style.visibility = "collapse"; hiddenPanels[id] = b.panel; } catch (e) {}
        }
        delete open[id];
        dismissed[id] = true;
        if (f) {
            try { f.frame.DeleteAsync(0); } catch (e) {}
            delete frames[id];
        }
        if (pinned[id]) {
            pinned[id] = false;
            delete pinned[id];
        }
        delete geometry[id];
        if (focused === id) focused = "";
        delete maximized[id];
        delete minimized[id];
        renderBar();
        render();
    }

    function togglePin(id) {
        if (pinned[id]) {
            delete pinned[id];
            var b = bound[id];
            if (b && b.forcedChain) {
                for (var i = 0; i < b.forcedChain.length; i++) {
                    try { b.forcedChain[i].panel.style.visibility = b.forcedChain[i].visibility; } catch (e) {}
                }
                b.forcedChain = null;
            }
            if (b && b.forcedTarget) {
                try { b.panel.style.opacity = b.forcedTarget.opacity; } catch (e) {}
                b.forcedTarget = null;
            }
        } else {
            pinned[id] = true;
            enforcePinnedVisibility(id);
        }

        var f = frames[id];
        if (f && f.pinButton) f.pinButton.SetHasClass("PinOn", !!pinned[id]);

        globalThis.OpenlockToast(
            pinned[id] ? "Pinned" : "Unpinned",
            (windowById(id) && windowById(id).title ? windowById(id).title : id) +
                (pinned[id] ? " stays while the shell is closed" : " leaves with the shell"),
            "",
            false);

        render();
    }

    // --- show / hide ---------------------------------------------------------

    // The bar is chrome, not a second game HUD. When the pointer has not touched it or a window
    // for a few seconds it fades out and gives the top row back to the game; hovering the
    // launcher brings it back. The frames own the longer idle curve below.
    var taskbarHiding = false;

    function showTaskbar() {
        if (!taskbar) return;
        taskbarHiding = false;
        taskbar.style.opacity = "1";
        taskbar.style.visibility = "visible";
    }

    function hideTaskbar() {
        if (!taskbar || preloadActive || !expanded || taskbarHiding) return;
        taskbarHiding = true;
        taskbar.style.opacity = "0";
        $.Schedule(0.25, function () {
            if (!taskbarHiding) return;
            taskbarHiding = false;
            if (!preloadActive && expanded) taskbar.style.visibility = "collapse";
        });
    }

    function render() {
        if (launcherBar) launcherBar.style.visibility = "visible";
        if (taskbar) taskbar.style.visibility = (expanded || preloadActive) ? "visible" : "collapse";

        // Opening the shell materializes the pinned live windows. They are the customization
        // layer: once pinned, they keep their placement while the shell is closed.
        if (expanded) {
            for (var pid in pinned) {
                if (!pinned.hasOwnProperty(pid) || open[pid]) continue;
                var pinWin = index[pid];
                if (!pinWin || !isPanelWindow(pinWin)) continue;
                createFrame(pinWin);
                open[pid] = true;
            }
            // Hot live panels are retried by the poll, not by every render. Discovery frames the
            // visible HUD once; the sweep is chunked and frames a few controls per tick.
            if (!discoveredHud) {
                discoveredHud = true;
                $.Schedule(0.1, discoverHudWindows);
                // The 8000-node HUD sweep is opt-in now: it reads layout size on every node and
                // that forced layout is what froze the client on the first open. Discovery and
                // the popup scan still frame the visible surfaces; the full sweep is the
                // explicit Scan action in the UI tree.
                $.Schedule(1.2, scanPopups);
                if (!hudAutoFramed) {
                    hudAutoFramed = true;
                    $.Schedule(0.3, autoFrameOpen);
                }
            }
        }

        for (var id in frames) {
            if (!frames.hasOwnProperty(id)) continue;
            applyWindow(frames[id].win);
        }
        renderBar();
    }

    // Restore is local and deterministic: every window returns to the geometry the active package
    // declares (or to the live panel's own rect), maximized and minimized state clears, and the
    // current scheme is re-applied. It does not silently reopen windows the player closed.
    function restoreUiLayout() {
        pointerDrag = null;
        for (var gid in geometry) if (geometry.hasOwnProperty(gid)) delete geometry[gid];
        for (var mid in maximized) if (maximized.hasOwnProperty(mid)) delete maximized[mid];
        for (var nid in minimized) if (minimized.hasOwnProperty(nid)) delete minimized[nid];

        for (var id in frames) {
            if (!frames.hasOwnProperty(id)) continue;
            var f = frames[id];
            if (!f || !f.win) continue;
            setFrameVisible(f, true);
            applyWindow(f.win);
            if (pinned[id]) enforcePinnedVisibility(id);
        }            applyScheme(currentScheme || themes.default, false);
        renderBar();
        globalThis.OpenlockToast("Layout restored",
            "geometry reset to the active scheme · " + currentScheme, "", false);
    }

    globalThis.OpenlockRestoreLayout = restoreUiLayout;

    globalThis.OpenlockToggle = function () {
        skipPreload();
        expanded = !expanded;
        if (expanded) showTaskbar();
        freeCursor(expanded);
        if (expanded && !activeId) activeId = data.tabs.length ? data.tabs[0] : WINDOWS_ID;
        render();
    };

    globalThis.OpenlockCollapse = function () {
        expanded = false;
        freeCursor(false);
        render();
    };

    // The fixed button in the bar's right cluster. The strip clips on purpose when a HUD sweep
    // adds dozens of frames; this is the always-visible index into all of them.
    globalThis.OpenlockWindows = function () {
        expanded = true;
        freeCursor(true);
        choose(WINDOWS_ID);
        render();
    };

    function freeCursor(want) {
        if (want === cursorFree) return;
        cursorFree = want;
        try {
            $.DispatchEvent("CitadelConCommand", "hud_free_cursor " + (want ? "1" : "-1"));
        } catch (e) {
            $.Msg("[Openlock] shell cursor dispatch failed: ", String(e));
        }
    }

    function send(eventName, arg) {
        try {
            $.DispatchEvent("CitadelConCommand",
                "dw_ui openlock-shell|" + eventName + (arg === undefined ? "" : ":" + arg));
        } catch (e) {
            $.Msg("[Openlock] shell send failed: ", String(e));
        }
    }

    // --- pointer move / resize -----------------------------------------------

    function minimizeWindow(id) {
        $.Msg("[Openlock] minimize press: ", id);
        var f = frames[id];
        if (!f) {
            refuseFeature("Minimize refused", "no frame owns window '" + id + "'");
            return;
        }
        minimized[id] = true;
        setFrameVisible(f, false);
        renderBar();
    }

    // The pointer is polled on drag. Both the Panorama root and GameUI are probed because the
    // reduced CSDK 10 client (the host installer shell) exposes only $.MousePosition.
    var pointerDrag = null;

    function cursorPoint() {
        var p = null;
        try {
            if (typeof $ !== "undefined" && $.MousePosition) {
                p = typeof $.MousePosition === "function" ? $.MousePosition() : $.MousePosition;
            }
        } catch (e) {}
        if (!p) {
            try {
                if (typeof GameUI !== "undefined" && GameUI.GetCursorPosition) p = GameUI.GetCursorPosition();
            } catch (e) {}
        }
        if (!p) {
            try {
                if (typeof $ !== "undefined" && $.GetCursorPosition) p = $.GetCursorPosition();
            } catch (e) {}
        }
        if (!p) {
            try {
                if (typeof Game !== "undefined" && Game.GetCursorPosition) p = Game.GetCursorPosition();
            } catch (e) {}
        }
        if (!p) {
            if (lastMousePoint && Date.now() - lastMouseAt < 2000) {
                return { x: lastMousePoint.x, y: lastMousePoint.y };
            }
            return null;
        }
        var x = p.x !== undefined ? p.x : (p[0] !== undefined ? p[0] : (p.position && p.position.x));
        var y = p.y !== undefined ? p.y : (p[1] !== undefined ? p[1] : (p.position && p.position.y));
        if (x === undefined || y === undefined) return null;
        x = num(x);
        y = num(y);
        // Some Panorama builds return a normalized cursor; the tooltip and drag math need pixels.
        if (Math.abs(x) <= 1 && Math.abs(y) <= 1) {
            x *= screenW;
            y *= screenH;
        }
        return { x: x, y: y };
    }

    function pointerHeld() {
        try {
            if (typeof GameUI !== "undefined" && GameUI.IsMouseDown) {
                var down = GameUI.IsMouseDown(0);
                if (down === undefined) down = GameUI.IsMouseDown();
                return !!down;
            }
        } catch (e) {}
        try {
            if (typeof Game !== "undefined" && Game.IsMouseDown) return !!Game.IsMouseDown();
        } catch (e) {}
        return null;
    }

    var lastPointerEvent = "none";
    // The reduced CSDK 10 client exposes no cursor API. Its panel events do carry the pointer on
    // mousemove, so the last event position is kept as the fallback for drag and hover.
    var lastMousePoint = null;
    var lastMouseAt = 0;

    // The engine does not deliver a mousemove stream to Panorama panels, but it does expose the
    // cursor and the button state. One scheduled poll reads both; the delta since mousedown is
    // written straight into the window's geometry. No capture panel, no grid, no cell snapping.
    function pollPointerDrag() {
        if (!pointerDrag) return;
        if (Date.now() - pointerDrag.at > 20000) {
            endPointerDrag(true);
            return;
        }

        // IsMouseDown is authoritative only after it has reported a press. On a build where the
        // method exists but always reports false, the onmouseup binding is the release path and
        // the first poll must not cancel the drag.
        var held = pointerHeld();
        if (held === true) pointerDrag.heldSeen = true;
        if (pointerDrag.heldSeen && held === false) {
            endPointerDrag(true);
            return;
        }

        var win = windowById(pointerDrag.id);
        var at = cursorPoint();
        if (!win || !at) {
            endPointerDrag(false);
            return;
        }

        var g = ensureGeometry(win);
        var dx = at.x - pointerDrag.startX;
        var dy = at.y - pointerDrag.startY;
        lastPointerEvent = "poll " + Math.round(dx) + "," + Math.round(dy);
        if (pointerDrag.mode.indexOf("resize") === 0) {
            var west = pointerDrag.mode.indexOf("w") >= 0;
            var north = pointerDrag.mode.indexOf("n") >= 0;
            var panelWindow = isPanelWindow(win);
            var width = clamp(pointerDrag.w + (west ? -dx : dx), num(win.minWidth) || 160, screenW);
            var height = clamp(pointerDrag.h + (north ? -dy : dy), num(win.minHeight) || 120, screenH);
            if (west) g.x = clamp(pointerDrag.x + (pointerDrag.w - width), 0, Math.max(0, screenW - 160));
            if (north && !panelWindow) g.y = clamp(pointerDrag.y + (pointerDrag.h - height), SHELL_TOP_DP, Math.max(SHELL_TOP_DP, screenH - 80));
            g.w = width;
            if (!panelWindow) g.h = height;
        } else {
            g.x = clamp(pointerDrag.x + dx, 4, Math.max(4, screenW - 160));
            g.y = clamp(pointerDrag.y + dy, SHELL_TOP_DP, Math.max(SHELL_TOP_DP, screenH - 80));
        }
        g.init = true;
        applyWindow(win);
        $.Schedule(0.016, pollPointerDrag);
    }

    // A Panorama panel does not deliver a stream of mousemove events. GameUI does expose the
    // cursor position and button state, so a drag is a bounded poll: mousedown captures the
    // start point, a scheduled tick reads the pointer and writes the new rectangle, and release
    // ends it. No grid, no engine drop target, no cell snapping.
    function pointFromEventArgs(args) {
        if (!args || !args.length) return null;
        for (var i = 0; i < args.length && i < 4; i++) {
            var value = args[i];
            if (!value) continue;
            if (typeof value === "number" && typeof args[i + 1] === "number") {
                return { x: num(value), y: num(args[i + 1]) };
            }
            if (typeof value !== "object") continue;
            var keys = (["x", "y", "cursorX", "cursorY", "mouseX", "mouseY", "position"]);
            for (var k = 0; k < keys.length; k++) {
                if (value[keys[k]] !== undefined) {
                    var point = value[keys[k]];
                    if (point && point.x !== undefined && point.y !== undefined) {
                        return { x: num(point.x), y: num(point.y) };
                    }
                    if (k === 0 && value.y !== undefined) return { x: num(value.x), y: num(value.y) };
                    if (k === 1 && value.x !== undefined) return { x: num(value.x), y: num(value.y) };
                }
            }
        }
        return null;
    }

    function recordPointer(args) {
        var at = pointFromEventArgs(args);
        if (!at) return null;
        lastMousePoint = at;
        lastMouseAt = Date.now();
        return at;
    }

    function beginPointerDrag(id, mode, eventArgs) {
        var win = windowById(id);
        lastPointerEvent = "down " + mode;
        if (!win) { endPointerDrag(false); return; }
        enterFrame(id, "drag");
        var at = pointFromEventArgs(eventArgs) || cursorPoint();
        if (!at) {
            var probe = "$:" + (typeof $) +
                " MousePosition:" + (typeof $ !== "undefined" ? typeof $.MousePosition : "absent") +
                " GameUI:" + (typeof GameUI !== "undefined" ? typeof GameUI.GetCursorPosition : "absent") +
                " GetCursorPosition:" + (typeof $ !== "undefined" ? typeof $.GetCursorPosition : "absent");
            try {
                var raw = (typeof $.MousePosition === "function") ? $.MousePosition() : $.MousePosition;
                probe += " raw:" + (raw === null ? "null" : typeof raw) +
                    " x:" + (raw && raw.x !== undefined ? typeof raw.x : "absent") +
                    " y:" + (raw && raw.y !== undefined ? typeof raw.y : "absent");
                if (raw && raw.x !== undefined) probe += " value:" + String(raw.x) + "," + String(raw.y);
            } catch (rawError) {
                probe += " raw-threw:" + String(rawError);
            }
            $.Msg("[Openlock] drag cursor probes: ", probe);
            refuseFeature("Drag refused",
                "no cursor API returned a position on this client (" + probe + ")");
            return;
        }
        var g = ensureGeometry(win);
        pointerDrag = {
            id: id,
            mode: mode,
            startX: at.x,
            startY: at.y,
            x: g.x,
            y: g.y,
            w: g.w,
            h: g.h,
            at: Date.now(),
            heldSeen: false
        };
        hideGrid();
        var startedFrame = frames[id];
        if (startedFrame && startedFrame.cost) startedFrame.cost.text = "drag";
        $.Schedule(0.016, pollPointerDrag);
    }

    function endPointerDrag(commit) {
        if (!pointerDrag) return;
        lastPointerEvent = "up ";
        var id = pointerDrag.id;
        pointerDrag = null;
        var win = windowById(id);
        if (!win || !commit) return;
        var g = ensureGeometry(win);
        applyWindow(win);
        send("layout", id + " " + Math.round(g.x) + " " + Math.round(g.y) + " " +
            Math.round(g.w) + " " + Math.round(g.h));
    }

    function makeDraggable(panel, id, mode) {
        if (!panel) return;
        try {
            // onmousedown starts the poll. SetDraggable is deliberately NOT called: it hands the
            // panel to the engine's drag-and-drop layer, which is where the 100 dp cell snap came
            // from, and it does not deliver a JS drag event this build can use.
            panel.SetPanelEvent("onmousedown", function () {
                $.Msg("[Openlock] mousedown args: ", probeArgs(arguments));
                beginPointerDrag(id, mode, arguments);
            });
            panel.SetPanelEvent("onmouseup", function () { endPointerDrag(true); });
            // A mousemove over the chrome is the CSDK10 restore path: that client has no cursor
            // probe, so onmouseover alone can be missed while the title is shrinking.
            panel.SetPanelEvent("onmousemove", function () {
                recordPointer(arguments);
                if (!pointerDrag) enterFrame(id, "move");
            });
        } catch (e) {
            refuseFeature("Drag refused", "the engine rejected the drag binding: " + String(e));
        }
    }

    function showGrid(id, mode) {
        measureScreen();
        dragId = id;
        dragMode = mode;
        buildGrid();
        if (dropGrid) dropGrid.style.visibility = "visible";
        freeCursor(true);
    }

    var dragId = "";
    var dragMode = "";

    function hideGrid() {
        dragId = "";
        dragMode = "";
        if (dropGrid) dropGrid.style.visibility = "collapse";
    }

    var gridBuilt = false;
    var gridCols = 0;
    var gridRows = 0;

    function buildGrid() {
        if (!dropGrid) return;

        var cols = Math.ceil(screenW / CELL_DP);
        var rows = Math.ceil(screenH / CELL_DP);
        // The grid is a fixed screen of cells: build it once and reuse it. Rebuilding 150 panels
        // on every drag start was a visible hitch, and nothing about the cells changes. Only a
        // resized screen changes the count.
        if (gridBuilt && cols === gridCols && rows === gridRows) return;
        gridBuilt = true;
        gridCols = cols;
        gridRows = rows;
        dropGrid.RemoveAndDeleteChildren();
        for (var r = 0; r < rows; r++) {
            for (var c = 0; c < cols; c++) {
                (function (col, row) {
                    var cell = $.CreatePanel("Panel", dropGrid, "");
                    cell.AddClass("DropCell");
                    cell.style.marginLeft = (col * CELL_DP) + "px";
                    cell.style.marginTop = (row * CELL_DP) + "px";
                    cell.SetPanelEvent("onmouseactivate", function () { dropAt(col, row); });
                    cell.SetPanelEvent("onDragDrop", function () { dropAt(col, row); });
                })(c, r);
            }
        }
    }

    function dropAt(col, row) {
        var win = windowById(dragId);
        if (!win) { hideGrid(); return; }

        var g = ensureGeometry(win);
        var left = col * CELL_DP;
        var top = row * CELL_DP;

        if (dragMode === "move") {
            g.x = left;
            g.y = top + (isPanelWindow(win) ? CHROME_DP : 0);
        } else {
            g.w = Math.max(num(win.minWidth) || 160, (col + 1) * CELL_DP - g.x);
            if (!isPanelWindow(win)) g.h = Math.max(num(win.minHeight) || 120, (row + 1) * CELL_DP - g.y);
        }

        g.init = true;
        hideGrid();
        applyWindow(win);
        send("layout", win.id + " " + Math.round(g.x) + " " + Math.round(g.y) + " " +
            Math.round(g.w) + " " + Math.round(g.h));
    }

    // --- shell views ---------------------------------------------------------

    function rowXd(body, text, cls) {
        var l = $.CreatePanel("Label", body, "");
        l.AddClass(cls || "ViewLine");
        l.AddClass("ViewRow");
        l.text = text;
        return l;
    }

    function headingXd(body, text) { rowXd(body, text, "ViewHeading"); }

    function actionXd(body, text, fn) {
        var b = addControl(body, "ViewAction", text, fn);
        return b;
    }

    function payloadLines() {
        var text = "";
        try { text = attr("body", ""); } catch (e) {}
        if (!text) return [];
        return String(text).split("\n");
    }

    function attr(name, dflt) {
        var h = host();
        if (!h || !h.GetAttributeString) return dflt || "";
        try { return h.GetAttributeString("dwv_" + name, dflt || ""); } catch (e) { return dflt || ""; }
    }

    function host() {
        var p = root;
        var depth = 0;
        while (p && depth < 30) {
            var id = "";
            try { id = p.id || ""; } catch (e) {}
            if (id.indexOf("DWHost_") === 0) return p;
            try { p = p.GetParent(); } catch (e) { break; }
            depth++;
        }
        return null;
    }

    function connected() {
        var h = host();
        if (!h || !h.GetAttributeString) return false;
        try { return h.GetAttributeString("dw_live", "0") === "1"; } catch (e) { return false; }
    }

    function inList(list, id) {
        if (!list) return false;
        for (var i = 0; i < list.length; i++) if (list[i] === id) return true;
        return false;
    }

    function listedWindow(id) {
        if (data.bar === id) return true;
        if (inList(data.tabs, id) || inList(data.pins, id)) return true;
        for (var i = 0; i < data.filed.length; i++) {
            if (data.filed[i].window === id) return true;
        }
        return false;
    }

    // A declared window that names a live panel can be hooked by hand. If the game has not built
    // that panel (the minimap in the hideout, the shop outside a match), the same action launches
    // the best matching mounted layout as an ordinary shell window. That keeps every entry in the
    // 341-window catalog reachable instead of ending at a hook-refused toast.
    function layoutForWindow(win) {
        if (!win) return "";
        if (win.layoutPath) return win.layoutPath;
        if (win.content && String(win.content).indexOf("file://") === 0) return String(win.content);
        var names = [win.id, win.title];
        var cands = win.panelCandidates || [];
        for (var i = 0; i < cands.length; i++) if (cands[i].name) names.push(cands[i].name);
        for (var n = 0; n < names.length; n++) {
            var path = findLayout(names[n]);
            if (path) return "file://{resources}/" + path;
        }
        return "";
    }

    function hookWindow(id) {
        var win = windowById(id);
        if (!win) return false;
        if (!isPanelWindow(win)) {
            openWindow(id);
            return true;
        }

        if (bound[id] && (!alive(bound[id].panel) || !panelVisible(bound[id].panel))) bound[id] = null;
        if (!ensureBound(win)) {
            var layout = layoutForWindow(win);
            if (layout) {
                var opened = openLayout(layout);
                if (opened) {
                    globalThis.OpenlockToast("Layout launched", win.title + " is not live; opened " +
                        layoutFont(layout) + " instead", opened, false);
                    return true;
                }
            }
            var f = createFrame(win);
            f.auto = false;
            open[id] = true;
            delete dismissed[id];
            applyWindow(win);
            globalThis.OpenlockToast("Hook refused", win.title + " is not on screen and has no mounted layout", "", true);
            return false;
        }

        var frame = createFrame(win);
        frame.auto = false;
        open[id] = true;
        delete dismissed[id];
        delete minimized[id];
        applyWindow(win);
        globalThis.OpenlockToast("Hooked", win.title + " is framed", "", false);
        return true;
    }

    function renderTools(body) {
        var state = data.buildState || {};
        var stages = state.stages || [];

        headingXd(body, "last VPK build");
        if (stages.length) {
            rowXd(body, "stage " + (state.stage || "unknown") + "  ·  " + (state.finishedAt || "no timestamp"), "ViewMuted");
            for (var s = 0; s < stages.length; s++) {
                var stage = stages[s];
                var detail = "";
                if (stage.resources) detail = "  ·  " + stage.resources + " resource(s)";
                if (stage.bytes) detail += "  ·  " + Math.round(stage.bytes / 1024) + " KiB";
                rowXd(body, (stage.ok ? "[x] " : "[ ] ") + stage.name + detail, stage.ok ? "ViewLine" : "ViewMuted");
            }
        } else {
            rowXd(body, "no build record yet — the next install writes shell/alpha-shell/build.json", "ViewMuted");
        }

        if (state.vpk) {
            headingXd(body, "vpk");
            rowXd(body, state.vpk + (state.vpkBytes ? "  ·  " + Math.round(state.vpkBytes / 1024) + " KiB" : ""));
            if (state.resources) rowXd(body, state.resources + " compiled resource(s)", "ViewMuted");
            if (state.path) rowXd(body, state.path, "ViewMuted");
        }

        headingXd(body, "update");
        var update = data.update || {};
        if (update.available) {
            rowXd(body, (update.version || "staged") + "  ·  " + (update.title || "Update ready"));
            if (update.notes) rowXd(body, update.notes, "ViewMuted");
            rowXd(body, "countdown " + (update.countdown || 0) + "s  ·  " +
                (update.autoRestart ? "auto restart" : "manual restart"), "ViewMuted");
        } else {
            rowXd(body, "no update staged", "ViewMuted");
            rowXd(body, "tools/stage_update.py --version <v> --notes <text>", "ViewMuted");
        }

        headingXd(body, "tools");
        var tools = data.tools || [];
        for (var t = 0; t < tools.length; t++) {
            rowXd(body, tools[t].name + (tools[t].exists ? "  present" : "  missing") + "  ·  " + tools[t].path,
                tools[t].exists ? "ViewLine" : "ViewMuted");
        }

        headingXd(body, "game and tools installs on this machine");
        var installs = data.installs || [];
        if (!installs.length) {
            rowXd(body, "no other install carries a Deadlock gameinfo", "ViewMuted");
        }
        for (var i = 0; i < installs.length; i++) {
            var install = installs[i];
            var shellText = install.shell === "mounted" ? "shell mounted"
                : install.shell === "installed, not mounted" ? "shell installed, not mounted"
                : "shell not installed";
            var sizeText = install.vpkBytes ? "  ·  " + Math.round(install.vpkBytes / 1024) + " KiB" : "";
            rowXd(body, install.kind + "  " + install.path, install.shell === "not installed" ? "ViewMuted" : "ViewLine");
            rowXd(body, "    " + shellText + sizeText +
                "  ·  " + install.toolsPresent + "/" + install.toolsTotal + " tools" +
                (install.version ? "  ·  " + install.version : ""),
                install.shell === "not installed" ? "ViewMuted" : "ViewLine");
        }
    }

    // --- UI tree and customization ------------------------------------------
    // A folder view over the declared catalog, not a flat 340-row dump. The selected element
    // gets geometry fields and a live CSS rule form; rules are also shown as the `.theme` line
    // that would make them permanent.
    var uiFolder = "shell";
    var uiSelected = "";
    var customRules = [];
    var uiCss = { selector: "", property: "background-color", value: "#33B5E5" };

    function uiFolders() {
        var shell = 0, hud = 0, game = 0, layouts = (data.layouts || []).length;
        for (var i = 0; i < data.windows.length; i++) {
            var win = data.windows[i];
            if (win.lane === "shell" || win.view || win.id === WINDOWS_ID) shell++;
            else if (win["theme-role"] === "hud") hud++;
            else if (win.panelCandidates) game++;
        }
        return [
            { id: "shell", label: "Shell windows", count: shell },
            { id: "hud", label: "HUD elements", count: hud },
            { id: "game", label: "Game screens", count: game },
            { id: "layouts", label: "Panorama layouts", count: layouts }
        ];
    }

    function uiFolderWindows(folder) {
        var out = [];
        for (var i = 0; i < data.windows.length; i++) {
            var win = data.windows[i];
            if (folder === "shell" && (win.lane === "shell" || win.view || win.id === WINDOWS_ID)) out.push(win);
            else if (folder === "hud" && win["theme-role"] === "hud") out.push(win);
            else if (folder === "game" && win.panelCandidates && win["theme-role"] !== "hud") out.push(win);
        }
        return out;
    }

    function uiField(body, label, value, submit) {
        var row = $.CreatePanel("Panel", body, "");
        row.AddClass("UiField");
        var l = $.CreatePanel("Label", row, "");
        l.AddClass("UiFieldLabel");
        l.text = label;
        var e = $.CreatePanel("TextEntry", row, "");
        e.AddClass("ConsoleEntry");
        e.AddClass("UiFieldEntry");
        e.text = String(value);
        e.SetPanelEvent("oninputsubmit", function () { submit(e.text); });
        actionXd(row, "Apply", function () { submit(e.text); });
    }

    function cssStyleProperty(name) {
        var map = {
            "background-color": "backgroundColor",
            "border-color": "borderColor",
            "border-top-color": "borderTopColor",
            "border-bottom-color": "borderBottomColor",
            "border-left-color": "borderLeftColor",
            "border-right-color": "borderRightColor",
            "wash-color": "washColor"
        };
        return map[name] || name;
    }

    function applyCssRule(selector, property, value) {
        var token = String(selector || "").trim().replace(/^[.#]/, "");
        property = String(property || "").trim();
        value = String(value || "").trim();
        var allowed = ["background-color", "border-color", "border-top-color", "border-bottom-color", "border-left-color", "border-right-color", "color", "opacity", "wash-color", "width", "height"];
        if (!token || !property || !value) {
            globalThis.OpenlockToast("CSS refused", "selector, property and value are all required", "", true);
            return 0;
        }
        if (allowed.indexOf(property) < 0) {
            globalThis.OpenlockToast("CSS refused", property + " is not an allowed runtime property", "", true);
            return 0;
        }

        var live = hudStreamNodes;
        if (!live.length) {
            globalThis.OpenlockToast("CSS deferred", "measuring the HUD tree; apply the rule again when the stream finishes", "", true);
            streamHudPanels(function () {});
            return 0;
        }
        var count = 0;
        for (var i = 0; i < live.length; i++) {
            var entry = live[i];
            var classes = String(entry.cls || "").split(" ");
            if (String(entry.id || "") !== token && classes.indexOf(token) < 0) continue;
            try {
                entry.panel.style[cssStyleProperty(property)] = value;
                count++;
            } catch (e) {}
        }
        customRules.push({ selector: selector, property: property, value: value, hits: count });
        globalThis.OpenlockToast("CSS applied", selector + " " + property + ": " + value + "  ·  " + count + " panel(s)", "", count === 0);
        return count;
    }

    function schemeRuleLines(win) {
        var lines = [];
        var scheme = schemeById(currentScheme);
        if (!scheme) return lines;
        var names = [];
        if (win.id) names.push(win.id.toLowerCase());
        if (win.panelCandidates) {
            for (var i = 0; i < win.panelCandidates.length; i++) {
                var c = win.panelCandidates[i];
                if (c.name) names.push(String(c.name).toLowerCase());
            }
        }
        var rules = scheme.rules || [];
        for (var r = 0; r < rules.length; r++) {
            var selector = String(rules[r].selector || "").toLowerCase();
            var hit = false;
            for (var n = 0; n < names.length; n++) if (selector.indexOf(names[n]) >= 0) { hit = true; break; }
            if (hit) lines.push("rule\t" + rules[r].selector + "\t" + rules[r].property + "\t" + (rules[r].value || ("role:" + rules[r].role)));
        }
        return lines;
    }

    function renderUiTree(body, page) {
        headingXd(body, "folders");
        var folders = uiFolders();
        for (var f = 0; f < folders.length; f++) {
            (function (folder) {
                actionXd(body, (uiFolder === folder.id ? "[open] " : "[folder] ") + folder.label + "  ·  " + folder.count,
                    function () { uiFolder = folder.id; renderOwn(page, body); });
            })(folders[f]);
        }

        headingXd(body, "hud stream");
        rowXd(body, hudStreamActive
            ? "scanning… " + hudStreamNodes.length + " panels so far"
            : hudStreamNodes.length + " panels measured  ·  bulk framing " + (bulkFramesEnabled ? "on" : "off"),
            "ViewMuted");
        actionXd(body, hudStreamActive ? "Scanning…" : "Measure HUD tree", function () {
            if (hudStreamActive) return;
            streamHudPanels(function (nodes) {
                notePerformanceRefusal(nodes.length);
                if (nodes.length > 700) {
                    globalThis.OpenlockToast("Performance guard",
                        nodes.length + " HUD panels; bulk framing is limited", "", true);
                }
                if (bulkFramesEnabled) frameLargestFrom(nodes, 16);
                if (frames[page.id]) renderOwn(page, body);
            });
        });
        actionXd(body, bulkFramesEnabled ? "Disable bulk framing" : "Enable bulk framing", function () {
            bulkFramesEnabled = !bulkFramesEnabled;
            globalThis.OpenlockToast("Performance",
                bulkFramesEnabled ? "bulk framing enabled" : "bulk framing disabled", "", !bulkFramesEnabled);
            renderOwn(page, body);
        });

        var selected = windowById(uiSelected);
        if (selected) {
            headingXd(body, "selected: " + (selected.title || selected.id));
            rowXd(selected.id + "  ·  " + (selected.lane || "shell") + "  ·  " + (selected.content || ""), "ViewMuted");
            var actions = $.CreatePanel("Panel", body, "");
            actions.AddClass("UiActions");
            actionXd(actions, "Open", function () { openWindow(selected.id); });
            if (isPanelWindow(selected)) {
                actionXd(actions, "Hook", function () { hookWindow(selected.id); });
                actionXd(actions, "Launch layout", function () {
                    var path = layoutForWindow(selected);
                    if (path) openLayout(path);
                    else globalThis.OpenlockToast("Layout refused", selected.title + " has no mounted layout", "", true);
                });
            }
            actionXd(actions, "Pin", function () { togglePin(selected.id); });
            actionXd(actions, "Close", function () { closeWindow(selected.id); });

            var g = ensureGeometry(selected);
            headingXd(body, "schema geometry");
            uiField(body, "x", Math.round(g.x), function (v) { g.x = parseInt(v, 10) || g.x; g.init = true; applyWindow(selected); });
            uiField(body, "y", Math.round(g.y), function (v) { g.y = parseInt(v, 10) || g.y; g.init = true; applyWindow(selected); });
            uiField(body, "width", Math.round(g.w), function (v) { g.w = Math.max(80, parseInt(v, 10) || g.w); applyWindow(selected); });
            uiField(body, "height", Math.round(g.h), function (v) { g.h = Math.max(60, parseInt(v, 10) || g.h); applyWindow(selected); });

            headingXd(body, "css on live game elements");
            var candidate = selected.panelCandidates && selected.panelCandidates[0] ? selected.panelCandidates[0].name : selected.id;
            if (!uiCss.selector) uiCss.selector = "." + candidate;
            uiField(body, "selector", uiCss.selector, function (v) { uiCss.selector = v; });
            uiField(body, "property", uiCss.property, function (v) { uiCss.property = v; });
            uiField(body, "value", uiCss.value, function (v) { uiCss.value = v; });
            actionXd(body, "Apply CSS rule", function () { applyCssRule(uiCss.selector, uiCss.property, uiCss.value); });
            rowXd(body, "Runtime only. Persist it as: rule\\t" + uiCss.selector + "\\t" + uiCss.property + "\\t" + uiCss.value, "ViewMuted");

            var themed = schemeRuleLines(selected);
            headingXd(body, "active scheme rules for this element");
            if (!themed.length) rowXd(body, "none; the active scheme leaves this element at the game default", "ViewMuted");
            for (var t = 0; t < themed.length; t++) rowXd(body, themed[t], "ViewMuted");
        }

        if (customRules.length) {
            headingXd(body, "session css rules");
            for (var c = 0; c < customRules.length; c++) {
                rowXd(customRules[c].selector + "  " + customRules[c].property + ": " + customRules[c].value + "  ·  " + customRules[c].hits + " hit(s)", "ViewMuted");
            }
        }

        headingXd(body, "folder: " + uiFolder);
        if (uiFolder === "layouts") {
            var layouts = data.layouts || [];
            for (var l = 0; l < layouts.length && l < 80; l++) {
                (function (path) {
                    actionXd(body, layoutFont(path) + "  ·  " + path, function () { openLayout(path); });
                })(layouts[l]);
            }
            if (layouts.length > 80) rowXd(body, "console can open the other " + (layouts.length - 80) + " layouts by name", "ViewMuted");
            return;
        }

        if (uiFolder === "hud" && hudStreamNodes.length) {
            headingXd(body, "measured live panels (" + hudStreamNodes.length + ")");
            for (var h = 0; h < hudStreamNodes.length && h < 40; h++) {
                (function (entry) {
                    var label = (entry.id || entry.cls || "panel") + "  ·  " +
                        Math.round(entry.w) + "x" + Math.round(entry.h);
                    actionXd(body, "Frame  " + label, function () { frameLive(entry); });
                    actionXd(body, "Disable  " + label, function () {
                        try {
                            entry.panel.style.visibility = "collapse";
                            globalThis.OpenlockToast("Disabled", label, "", false);
                        } catch (e) {}
                    });
                })(hudStreamNodes[h]);
            }
        }

        var items = uiFolderWindows(uiFolder);
        for (var i = 0; i < items.length && i < 100; i++) {
            (function (win) {
                var framed = !!open[win.id];
                var item = actionXd(body, (framed ? "[framed] " : "[ ] ") + (win.title || win.id) + "  ·  " + win.id,
                    function () { uiSelected = win.id; uiCss.selector = ""; renderOwn(page, body); });
                item.SetPanelEvent("oncontextmenu", function () { showContextMenu(win, 320, 180); });
                bindDwell(item, win.title || win.id, (win.id || "") + "  ·  " + (win.lane || "shell") + "  ·  " + (win.content || ""));
            })(items[i]);
        }
        if (items.length > 100) rowXd(body, (items.length - 100) + " more; narrow the folder or use the console", "ViewMuted");
    }

    function findDeclaredWindow(text) {
        var query = String(text || "").trim();
        if (!query) return null;
        var direct = windowById(query);
        if (direct) return direct;
        var lower = query.toLowerCase();
        var i;
        for (i = 0; i < data.windows.length; i++) {
            var win = data.windows[i];
            if (String(win.id || "").toLowerCase() === lower ||
                String(win.title || "").toLowerCase() === lower ||
                String(win.content || "").toLowerCase() === lower ||
                String(win.view || "").toLowerCase() === lower) return win;
        }
        for (i = 0; i < data.windows.length; i++) {
            var loose = data.windows[i];
            if (String(loose.id || "").toLowerCase().indexOf(lower) >= 0 ||
                String(loose.title || "").toLowerCase().indexOf(lower) >= 0) return loose;
        }
        return null;
    }

    // The console is the escape hatch: it opens a declared window by id/title, or any layout the
    // installed game actually carries. `layout <name>` skips the declared-window lookup when a
    // name exists in both catalogs.
    function runConsole(text) {
        var raw = String(text || "").trim();
        if (!raw) {
            globalThis.OpenlockToast("Console", "type a window id, title or layout name", "", true);
            return "";
        }

        var lower = raw.toLowerCase();
        var layoutOnly = false;
        if (lower.indexOf("layout ") === 0) {
            raw = raw.substring(7).trim();
            layoutOnly = true;
        } else if (lower.indexOf("open ") === 0) {
            raw = raw.substring(5).trim();
        }
        if (!raw) {
            globalThis.OpenlockToast("Console", "nothing after the command", "", true);
            return "";
        }

        if (!layoutOnly) {
            var declared = findDeclaredWindow(raw);
            if (declared) {
                openWindow(declared.id);
                globalThis.OpenlockToast("Console", "opened " + (declared.title || declared.id), declared.id, false);
                return declared.id;
            }
        }

        var layout = findLayout(raw);
        if (layout) {
            var id = openLayout(layout);
            if (id) globalThis.OpenlockToast("Layout", "opened " + layoutFont(layout), id, false);
            return id;
        }

        var direct = normalizeLayoutPath(raw);
        if (direct) {
            var directId = openLayout(direct);
            if (directId) globalThis.OpenlockToast("Layout", "opened " + layoutFont(direct), directId, false);
            return directId;
        }

        globalThis.OpenlockToast("Console", "no declared window or mounted layout matches '" + raw + "'", "", true);
        return "";
    }

    globalThis.OpenlockConsole = function (text) {
        return runConsole(String(text || ""));
    };

    function renderOwn(win, body) {
        body.RemoveAndDeleteChildren();

        if (win.id === WINDOWS_ID || win.view === "windows") {
            renderWindowBrowser(body);
            return;
        }

        if (win.view === "ui-tree") {
            renderUiTree(body, win);
            return;
        }

        var kind = win.view || win.content;

        if (kind === "layout") {
            headingXd(body, "panorama layout");
            rowXd(body, win.layoutPath, "ViewMuted");
            var layoutHost = $.CreatePanel("Panel", body, "");
            layoutHost.AddClass("LayoutHost");
            try {
                layoutHost.BLoadLayout(win.layoutPath, false, false);
            } catch (e) {
                globalThis.OpenlockToast("Layout refused", String(e), "", true);
            }
            return;
        }

        if (kind === "refusals" || kind === "table") {
            headingXd(body, ((data.refusals.length || 0) + runtimeRefusals.length) + " refusal(s)");
            for (var r = 0; r < data.refusals.length; r++) {
                var x = data.refusals[r];
                rowXd(body, x.file + ":" + x.line + "  " + x.subject + " — " + x.why, "ViewMuted");
            }
            for (var rr = 0; rr < runtimeRefusals.length; rr++) {
                var rx = runtimeRefusals[rr];
                rowXd(body, rx.file + "  " + rx.subject + " — " + rx.why, "ViewMuted");
            }
            return;
        }

        if (kind === "settings") {
            headingXd(body, "scheme");
            if (!themes.schemes.length) {
                rowXd(body, "no schemes in this build", "ViewMuted");
            }
            for (var sc = 0; sc < themes.schemes.length; sc++) {
                (function (scheme) {
                    var ext = scheme.extensions ? scheme.extensions.length : 0;
                    actionXd(
                        body,
                        (scheme.id === currentScheme ? "● " : "○ ") + scheme.label +
                            (ext ? "  ·  " + ext + " extension(s)" : "") + "  ·  " + scheme.source,
                        function () {
                            applyScheme(scheme.id, true);
                            renderOwn(win, body);
                        });
                })(themes.schemes[sc]);
            }

            var extensions = themes.extensions || [];
            headingXd(body, "scheme extensions (load order)");
            if (!extensions.length) {
                rowXd(body, "none mounted; a mod can add panorama/schemes/<name>.theme", "ViewMuted");
            }
            for (var ex = 0; ex < extensions.length; ex++) {
                var row = extensions[ex];
                rowXd((row.base || "?") + "  ←  " + row.label + "  ·  order " + row.loadOrder +
                    "  ·  " + row.source, "ViewMuted");
            }

            var build = data.build || {};
            headingXd(body, "this build");
            rowXd(body, (data.name || "openlock") + " " + (data.version || ""));
            rowXd(body, "commit " + (build.commit || "no git metadata") + (build.dirty ? " (dirty)" : ""), "ViewMuted");
            rowXd(body, "branch " + (build.branch || "no git metadata"), "ViewMuted");
            rowXd(body, "game " + (build.gameVersion || "unknown"), "ViewMuted");

            headingXd(body, "the layout is a schema");
            rowXd(body, "Windows, tabs and pins come from shell/alpha-shell/package.shspec. Changing a geometry row changes the default; M and the corner grip change this session.", "ViewMuted");
            rowXd(body, data.windows.length + " declared windows · " + data.tabs.length + " tabs · " + data.pins.length + " pins", "ViewMuted");
            actionXd(body, "Restore UI layout  ·  " + (currentScheme || themes.default), restoreUiLayout);

            headingXd(body, "input");
            var pointerAt = cursorPoint();
            var held = pointerHeld();
            rowXd(body, "pointer " + (pointerAt ? (Math.round(pointerAt.x) + ", " + Math.round(pointerAt.y)) : "unavailable") +
                "  ·  mouse " + (held === null ? "unavailable" : (held ? "down" : "up")) +
                "  ·  GameUI " + (typeof GameUI !== "undefined" ? "present" : "absent"), "ViewMuted");

            headingXd(body, "server");
            rowXd(body, connected() ? "connected" : "not connected — showing the declared package only", "ViewMuted");
            actionXd(body, "Reconcile", function () { send("steady"); });
            actionXd(body, "Restore hero baselines", function () { send("restore"); });
            actionXd(body, "Mode on/off", function () { send("mode"); });
            return;
        }

        if (kind === "mods") {
            headingXd(body, "mounted games (search paths)");
            rowXd(body, "baked from " + (data.searchPathsSource || "the build's gameinfo.gi"), "ViewMuted");
            var mounts = data.searchPaths || [];
            if (!mounts.length) rowXd(body, "no gameinfo search paths baked into this build", "ViewMuted");
            for (var s = 0; s < mounts.length; s++) {
                rowXd(body, mounts[s].kind + "  " + mounts[s].path + "  [" + mounts[s].mounts + "]",
                    mounts[s].mounts === "empty" || mounts[s].mounts === "missing" ? "ViewMuted" : "ViewLine");
            }

            headingXd(body, "mounted scheme extensions");
            var mountedSchemes = themes.extensions || [];
            if (!mountedSchemes.length) {
                rowXd(body, "none mounted; themes under panorama/schemes are read from the search paths above", "ViewMuted");
            }
            for (var m = 0; m < mountedSchemes.length; m++) {
                rowXd(mountedSchemes[m].base + "  ←  " + mountedSchemes[m].label + "  ·  order " +
                    mountedSchemes[m].loadOrder + "  ·  " + mountedSchemes[m].source, "ViewMuted");
            }

            headingXd(body, "tools");
            var tools = data.tools || [];
            for (var t = 0; t < tools.length; t++) {
                rowXd(body, tools[t].name + (tools[t].exists ? "  present" : "  missing") + "  ·  " + tools[t].path,
                    tools[t].exists ? "ViewLine" : "ViewMuted");
            }
            return;
        }

        if (kind === "tools") {
            renderTools(body);
            return;
        }

        if (kind === "console") {
            headingXd(body, "open any window");
            rowXd(body, "Type a window id/title, or a Deadlock layout such as citadel_hud_hero_shop. Enter opens it.", "ViewMuted");
            var consoleRow = $.CreatePanel("Panel", body, "");
            consoleRow.AddClass("ConsoleRow");
            var consoleEntry = $.CreatePanel("TextEntry", consoleRow, "");
            consoleEntry.AddClass("ConsoleEntry");
            consoleEntry.SetPanelEvent("oninputsubmit", function () { runConsole(consoleEntry.text); });
            actionXd(consoleRow, "Open", function () { runConsole(consoleEntry.text); });

            headingXd(body, data.windows.length + " declared windows  ·  " + (data.layouts ? data.layouts.length : 0) + " game layouts");
            rowXd(body, "window: id, title, content or view; layout: file name or path", "ViewMuted");
            var shown = 0;
            for (var w = 0; w < data.windows.length && shown < 12; w++, shown++) {
                (function (entry) {
                    actionXd(body, entry.title + "  ·  " + entry.id, function () { openWindow(entry.id); });
                })(data.windows[w]);
            }

            var layouts = data.layouts || [];
            headingXd(body, layouts.length + " layouts from the game archive");
            if (!layouts.length) rowXd(body, "no layout catalog in this build", "ViewMuted");
            for (var l = 0; l < layouts.length && l < 24; l++) {
                (function (path) {
                    actionXd(body, layoutFont(path) + "  ·  " + path, function () { openLayout(path); });
                })(layouts[l]);
            }
            if (layouts.length > 24) rowXd(body, "type to open any of the other " + (layouts.length - 24), "ViewMuted");
            return;
        }

        if (kind === "api-viewer") {
            headingXd(body, "openlock shell");
            rowXd(body, "layout: openlock_shell.xml");
            rowXd(body, "data: openlock_shell_data.js (generated from package.shspec)");
            rowXd(body, "live panels: framed, never reparented");
            if (!connected()) rowXd(body, "server: not connected", "ViewMuted");
            return;
        }

        var lines = payloadLines();
        if (lines.length) {
            for (var i = 0; i < lines.length; i++) {
                if (!lines[i]) continue;
                if (lines[i].charAt(0) === "#") headingXd(body, lines[i].substring(1));
                else rowXd(body, lines[i]);
            }
            return;
        }

        rowXd(body, connected()
            ? "no payload from the server yet"
            : "this view has no local source while the server is disconnected", "ViewMuted");
    }

    function renderWindowBrowser(body) {
        var live = hudStreamNodes;
        if (!live.length && !hudStreamActive) {
            streamHudPanels(function () {
                var f = frames[WINDOWS_ID];
                if (f && activeId === WINDOWS_ID) renderOwn(f.win, f.body);
            });
        }

        headingXd(body, "live under the HUD (" + (hudStreamActive ? "streaming…" : live.length) + ")");
        if (hudStreamActive) {
            rowXd(body, "the panel tree is streamed in bounded chunks; this list fills without blocking a frame", "ViewMuted");
        } else if (!live.length) {
            rowXd(body, "no live panels found; open a game screen and this list fills", "ViewMuted");
        }
        for (var i = 0; i < live.length; i++) {
            (function (entry) {
                var label = (entry.id || "panel") + "  ·  " + Math.round(entry.w) + "×" + Math.round(entry.h);
                if (entry.cls) label += "  ·  " + entry.cls;
                actionXd(body, label, function () { frameLive(entry); });
            })(live[i]);
        }

        var hooks = [];
        for (var h = 0; h < data.windows.length; h++) {
            var hw = data.windows[h];
            if (!isPanelWindow(hw)) continue;
            if (!listedWindow(hw.id) && !hw.autoFrame) continue;
            hooks.push(hw);
        }
        headingXd(body, "declared hooks (" + hooks.length + ")");
        if (!hooks.length) rowXd(body, "this package declares no live-panel windows", "ViewMuted");
        for (var k = 0; k < hooks.length; k++) {
            (function (win) {
                var b = bound[win.id];
                var isBound = !!b && alive(b.panel) && panelVisible(b.panel);
                var candidate = (win.panelCandidates[0].name || win.panelCandidates[0].kind);
                var label = (isBound ? "● " : "○ ") + win.title + "  →  " + candidate +
                    (isBound ? "  ·  scale " + Math.round((bound[win.id].natural.w ? 1 : 1) * 100) + "%" : "  ·  not on screen");
                actionXd(body, label, function () {
                    if (hookWindow(win.id)) renderWindowBrowser(body);
                });
            })(hooks[k]);
        }

        headingXd(body, "declared shell windows");
        for (var w = 0; w < data.windows.length; w++) {
            if (isPanelWindow(data.windows[w])) continue;
            (function (entry) {
                actionXd(body, entry.title + "  ·  " + (entry.view || entry.content || entry.id),
                    function () { openWindow(entry.id); });
            })(data.windows[w]);
        }
    }

    function startClock() {
        function tick() {
            if (clockLabel) {
                try {
                    var now = new Date();
                    var h = now.getHours();
                    var m = now.getMinutes();
                    clockLabel.text = (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
                } catch (e) {
                    clockLabel.text = "--:--";
                }
            }
            $.Schedule(10, tick);
        }
        tick();
    }

    // --- server poll ---------------------------------------------------------

    var lastSig = "";
    var pollCount = 0;
    function poll() {
        pollCount++;
        var want = attr("active", "");
        var sig = want + "|" + attr("view", "") + "|" + attr("refusal", "") + "|" + attr("body", "").length;

        if (want && windowById(want) && (want !== activeId || sig !== lastSig)) {
            lastSig = sig;
            openWindow(want);
        } else if (sig !== lastSig && activeId) {
            lastSig = sig;
            var f = frames[activeId];
            if (f && !isPanelWindow(f.win)) renderOwn(f.win, f.body);
        }

        // A framed panel can be destroyed and rebuilt by the game (the shop does this on every
        // open). Re-binding is the only reaction; a missing panel is a refusal in the window.
        // An unbound frame is retried at a slower cadence: the class search walks the HUD, and a
        // window waiting for a shop that is closed must not walk it twice a second.
        for (var id in frames) {
            if (!frames.hasOwnProperty(id)) continue;
            var win = frames[id].win;
            if (!isPanelWindow(win)) continue;
            if (bound[id] && (!alive(bound[id].panel) || (!panelVisible(bound[id].panel) && !pinned[id]))) releasePanel(id);
            if (!bound[id] && (pollCount % 4) !== 0) continue;
            applyWindow(win);
        }

        // Screens that came on screen after the shell opened (shop, map, escape menu) join the
        // layout while the shell is open. The check is every other second, not every poll.
        // Only the small autoFrame set is retried here.
        if (expanded && (pollCount % 4) === 0) autoFrameOpen();
        if (expanded && (pollCount % 4) === 2) scanPopups();

        // HUD panels are added and removed by the game while a match runs (the health bar moves,
        // the ability bar appears, the top bar rebuilds). Re-run the bounded surface walk every
        // few seconds so chrome follows what is actually visible, not only what existed at open.
        if (expanded && (pollCount % 8) === 4 && !discoveringHud &&
            Date.now() - hudDiscoverAt > 4000) {
            discoverHudWindows();
        }

        if (expanded && !preloadActive && Date.now() - lastInteractionAt > 5000) hideTaskbar();

        $.Schedule(0.5, poll);
    }

    // --- boot ----------------------------------------------------------------

    function setLauncherName() {
        var name = "";
        try {
            if (typeof Steam !== "undefined" && Steam.GetPersonaName) name = String(Steam.GetPersonaName() || "");
        } catch (e) {
            $.Msg("[Openlock] Steam persona unavailable: ", String(e));
        }
        if (!name) {
            try {
                if (typeof Game !== "undefined" && Game.GetSteamPersonaName) name = String(Game.GetSteamPersonaName() || "");
            } catch (e) {}
        }
        if (!name) name = String(data.steamName || "");
        if (launcherLabel) launcherLabel.text = name || "Openlock";
    }

    // A click or leaving the shell retires the pointer tooltip. The context menu has its own
    // dismiss layer, so this is only the tooltip lifetime.
    try {
        root.SetPanelEvent("onmouseactivate", hideDwell);
        root.SetPanelEvent("onmouseout", hideDwell);
    } catch (e) {
        $.Msg("[Openlock] tooltip lifetime REFUSED: ", String(e));
    }

    // The launcher is hit-testable and always on screen, so it is the safest panel to learn what
    // this build's event system actually delivers before wiring a drag to it again.
    try {
        if (taskbar) {
            taskbar.hittest = true;
            taskbar.hittestchildren = true;
            taskbar.SetPanelEvent("onmouseover", function () {
                lastInteractionAt = Date.now();
                showTaskbar();
            });
            taskbar.SetPanelEvent("onmousemove", function () {
                lastInteractionAt = Date.now();
                showTaskbar();
            });
        }
        if (launcherBar) {
            launcherBar.SetPanelEvent("onmouseover", function () {
                lastPointerEvent = "over";
                lastInteractionAt = Date.now();
                showTaskbar();
            });
            launcherBar.SetPanelEvent("onmousemove", function () { lastPointerEvent = "mov " + probeArgs(arguments); });
            launcherBar.SetPanelEvent("onmousedown", function () { lastPointerEvent = "down " + probeArgs(arguments); });
        }
    } catch (e) {
        lastPointerEvent = "bind-error";
    }

    measureScreen();
    frameTick();
    frameClock();
    setLauncherName();
    $.Schedule(2.0, setLauncherName);
    applyScheme(themes.default, false);
    renderBar();
    startPreload();
    startClock();

    // The version notice is the shell telling the player what it read from the install: the
    // package, the git build it was generated from, and the game build in steam.inf.
    $.Schedule(1.2, function () {
        var build = data.build || {};
        var line = [];
        if (build.commit) line.push(build.commit + (build.dirty ? " (dirty)" : ""));
        if (build.gameVersion) line.push("game " + build.gameVersion);
        if (currentScheme) line.push("scheme " + currentScheme);
        if (!build.commit) line.push("no git metadata");
        if (build.generatedAt) line.push(build.generatedAt);
        globalThis.OpenlockToast(
            "Openlock " + (build.version ? "v" + build.version : (data.version || "")),
            line.join("  ·  ") || "layout package loaded",
            "",
            false);
        $.Msg("[Openlock] shell ready: ", (data.name || "openlock"), " ", (data.version || ""),
            " commit=", (build.commit || "unknown"), " game=", (build.gameVersion || "unknown"),
            " windows=", data.windows.length, " refusals=", data.refusals.length,
            " grade=", shellGrade, " chrome=idle3.2s");
    });

    $.Schedule(1.5, startUpdateJob);

    // The live-panel inventory in one log line: a build that renames a HUD component is diagnosed
    // from this line instead of from a guess in the package.
    // The live-panel inventory is streamed from the UI tree now, not a synchronous 8000-node
    // walk at boot. A large HUD must never hold the first frame.

    render();
    poll();
})();

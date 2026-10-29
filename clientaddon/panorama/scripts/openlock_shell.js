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
    var windowLayer = root.FindChildTraverse("WindowLayer");
    var panelLayer = root.FindChildTraverse("PanelLayer");
    var dropGrid = root.FindChildTraverse("DropGrid");
    var toastStack = root.FindChildTraverse("ToastStack");
    var updateModal = root.FindChildTraverse("UpdateModal");
    var buildStrip = root.FindChildTraverse("BuildStrip");
    var buildStageLabel = root.FindChildTraverse("BuildStage");
    var buildDetailLabel = root.FindChildTraverse("BuildDetail");
    var clockLabel = root.FindChildTraverse("Clock");
    var versionLabel = root.FindChildTraverse("VersionLabel");
    var schemeLabel = root.FindChildTraverse("SchemeLabel");
    var launcherLabel = root.FindChildTraverse("LauncherLabel");
    var themes = data.themes || { default: "", order: [], schemes: [], extensions: [] };
    var currentScheme = "";
    var currentGrade = "dev";
    // The launcher shows the Steam persona on this machine. dl-openshell is only the fallback for
    // a client that cannot expose a persona, never a build-time player name.
    var shellDisplayName = "dl-openshell";
    var observerXmlPanels = {};
    var observerXmlAt = 0;
    var savedProfiles = {};
    var layoutPayload = "";
    var layoutRequest = "";
    var layoutNoticesSeen = {};
    var liveBuild = null;
    var liveBuildRaw = "";
    var liveUpdate = null;
    var liveUpdateRaw = "";
    var liveStatusWarned = {};
    var addonPayload = "";

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
    var frameTickAt = -1;
    var reportedRefusals = {};

    var frames = {};      // id -> { frame, title, meta, body, refusal, win }
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
        var top = root;
        var depth = 0;
        while (top && depth < 30) {
            var up = null;
            try { up = top.GetParent(); } catch (e) { break; }
            if (!up) break;
            top = up;
            depth++;
        }
        return top;
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
            if (panel.IsVisible) return !!panel.IsVisible();
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
    // The installer chooses the grade once. Dev keeps every declared window and addon reachable;
    // observer removes the shell's own chrome so a recording shows only the game and any XML
    // surfaces an addon sends; player keeps the saved layout scheme available at startup.
    function setGrade(grade) {
        var value = String(grade || "").toLowerCase();
        if (value !== "observer" && value !== "player") value = "dev";
        currentGrade = value;
        try {
            root.RemoveClass("GradeDev");
            root.RemoveClass("GradeObserver");
            root.RemoveClass("GradePlayer");
            root.AddClass(value === "observer" ? "GradeObserver" : value === "player" ? "GradePlayer" : "GradeDev");
        } catch (e) {}
        $.Msg("[dl-openshell] grade: ", currentGrade);
    }

    function gradeFromRecords() {
        if (liveBuild && liveBuild.grade) return liveBuild.grade;
        if (data.build && data.build.grade) return data.build.grade;
        return "dev";
    }

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
                $.Msg("[dl-openshell] scheme class REFUSED for '", scheme.id, "': ", String(e));
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
        var applied = applyScheme(String(id || "").toLowerCase(), true);
        if (applied) applySavedLayoutFor(applied, true);
        return applied;
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
        var applied = applyScheme(next.id, true);
        if (applied) applySavedLayoutFor(applied, true);
        return applied;
    };

    // --- toast / update ------------------------------------------------------

    globalThis.OpenlockToast = function (title, body, windowId, attention) {
        if (!toastsAvailable() || !title) return null;

        var t = $.CreatePanel("Panel", toastStack, "");
        t.AddClass("Toast");
        if (attention) t.AddClass("Attention");
        // A notice is not a control surface. Only a toast that names a window needs a hit target;
        // every other toast must pass the pointer through to the game's own top-right menu.
        try { t.hittest = !!windowId; } catch (e) {}

        var h = $.CreatePanel("Label", t, "");
        h.AddClass("ToastTitle");
        h.text = title;
        try { h.hittest = false; } catch (e) {}

        if (body) {
            var b = $.CreatePanel("Label", t, "");
            b.AddClass("ToastBody");
            b.text = body;
            try { b.hittest = false; } catch (e) {}
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
            $.Msg("[dl-openshell] update restart: quit dispatched");
        } catch (e) {
            $.Msg("[dl-openshell] update restart REFUSED: no quit command on this build: ", String(e));
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

    function addControl(parent, cls, label, onClick) {
        var p = $.CreatePanel("Panel", parent, "");
        p.AddClass(cls);
        var l = $.CreatePanel("Label", p, "");
        l.text = label;
        if (cls === "ShellTab") l.AddClass("ShellTabLabel");
        p.SetPanelEvent("onmouseactivate", onClick);
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

    function choose(id) {
        activeTab = id;
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
        if (record.rectKey === key) {
            perf.skips++;
            return;
        }
        record.rectKey = key;
        frame.style.marginLeft = Math.round(x) + "px";
        frame.style.marginTop = Math.round(y) + "px";
        frame.style.width = Math.max(120, Math.round(w)) + "px";
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

        // The chrome is drawn above the content; keep it on screen for a HUD element that lives
        // at the very top or left edge (the minimap is at 10,10 in the stock layout), and keep a
        // grab area on screen when a window was dragged past the right or bottom edge.
        g.x = clamp(g.x, 4, Math.max(4, screenW - 160));
        // The title bar is drawn CHROME_DP above the content. Keep it below the taskbar instead
        // of letting the bar slice through the top-row HUD frames.
        g.y = clamp(g.y, SHELL_TOP_DP + CHROME_DP, Math.max(SHELL_TOP_DP + CHROME_DP, screenH - 80));

        g.w = clamp(g.w, num(win.minWidth) || 160, screenW);
        g.h = clamp(g.h, num(win.minHeight) || 120, screenH);

        // A live game panel is scaled into the frame, not the frame around the panel. Two
        // independent factors are what let a corner change height: the old single `scale` was
        // derived from width alone, and the frame height was then recomputed from the panel's
        // natural aspect, so any height delta was thrown away and a north drag left a fixed top
        // edge. g.h is now the authority on both axes.
        var sx = clamp(g.w / nat.w, 0.08, 4);
        var sy = clamp(g.h / nat.h, 0.08, 4);
        var tx = g.x - nat.x - (nat.w - nat.w * sx) / 2;
        var ty = g.y - nat.y - (nat.h - nat.h * sy) / 2;

        var transform = "translate3d(" + tx + "px," + ty + "px,0px) scale3d(" +
            sx + "," + sy + ",1)";
        if (b.lastTransform === transform) {
            perf.skips++;
        } else {
            b.lastTransform = transform;
            try {
                b.panel.style.transform = transform;
                perf.writes++;
            } catch (e) {
                $.Msg("[dl-openshell] shell transform REFUSED for '", win.id, "': ", String(e));
            }
        }

        setRect(record, g.x, g.y - CHROME_DP, g.w, g.h + CHROME_DP);
        return true;
    }

    // Deadlock exposes no performance.now and no GameUI. $.FrameTime() is the engine's frame
    // timestamp (seconds since Panorama started); its deltas are the only sub-millisecond frame
    // clock here. Per-window work is measured with Date.now, which is a 1 ms clock, so the label
    // shows "<1 ms" rather than inventing precision.
    function engineNowMs() {
        try {
            if (typeof $ !== "undefined" && typeof $.FrameTime === "function") {
                var t = Number($.FrameTime());
                if (isFinite(t)) return t * 1000;
            }
        } catch (e) {}
        return -1;
    }

    function noteWindowCost(id, started) {
        // Force this frame's layout once so the measurement covers the style writes and the
        // layout they cause, not just the JS property assignments.
        var f = frames[id];
        if (f && f.frame) {
            try { var flush = f.frame.actuallayoutwidth; if (flush < 0) $.Msg("[dl-openshell] layout read negative"); } catch (e) {}
        }
        var b = bound[id];
        if (b && b.panel) {
            // Read the live panel too: the frame read flushes the chrome, but the transform on the
            // game panel is what a panel window's resize costs, so its layout must be forced here.
            try { var panelFlush = b.panel.actuallayoutwidth; if (panelFlush < 0) $.Msg("[dl-openshell] panel layout read negative"); } catch (e) {}
        }
        var elapsed = Math.max(0, Date.now() - started);
        if (!perf.cost[id]) perf.cost[id] = { total: 0, max: 0, avg: 0, samples: 0 };
        var cost = perf.cost[id];
        cost.total += elapsed;
        if (elapsed > cost.max) cost.max = elapsed;
        // Date.now is the only sub-frame clock this client exposes, so the average is honest at
        // 1 ms resolution; values below one tick are shown as "<1" rather than invented.
        cost.avg = cost.samples ? (cost.avg * 0.8 + elapsed * 0.2) : elapsed;
        cost.samples++;
    }

    function updateCost(f, id) {
        if (!f || !f.cost) return;
        var cost = perf.cost[id] || { total: 0, max: 0, avg: 0, samples: 0 };
        var own = cost.samples ? cost.avg : 0;
        // win = this window's sampled apply + forced layout; frame = measured UI frame interval.
        var label = own >= 0.95 ? own.toFixed(1) : "<1";
        var ui = frameMs > 0 ? frameMs.toFixed(1) : "--";
        var text = "win " + label + " ms · frame " + ui + " ms";
        if (f.lastCost === text) return;
        f.lastCost = text;
        f.cost.text = text;
    }

    // The frame interval changes even when a window is idle, so the readout is refreshed twice a
    // second from the same measurements instead of freezing at its last apply.
    function refreshCosts() {
        if (expanded) {
            for (var id in frames) {
                if (frames[id] && frames[id].cost) updateCost(frames[id], id);
            }
        }
        $.Schedule(0.5, refreshCosts);
    }

    // The engine's frame interval, measured from $.FrameTime deltas. Without that API the
    // Date.now fallback is still a real (1 ms) scheduler interval, never a guessed FPS.
    function frameTick() {
        if (!expanded) {
            frameTickAt = -1;
            frameMs = 0;
            $.Schedule(1, frameTick);
            return;
        }
        var at = engineNowMs();
        if (at < 0) at = Date.now();
        if (frameTickAt >= 0) {
            var delta = at - frameTickAt;
            if (delta > 0 && delta < 250) {
                frameMs = frameMs ? (frameMs * 0.85 + delta * 0.15) : delta;
            }
        }
        frameTickAt = at;
        $.Schedule(0.001, frameTick);
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
            var nat = bound[win.id] && bound[win.id].natural;
            f.meta.text = (win.panelCandidates[0].name || win.panelCandidates[0].kind) +
                (ok && nat ? "  ·  scale " + Math.round((g.w / nat.w) * 100) + "%×" +
                    Math.round((g.h / nat.h) * 100) + "%" : "  ·  not on screen");
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
            bound[win.id] = { panel: panel, natural: natural };
            $.Msg("[dl-openshell] shell framed '", win.id, "' → ",
                candidates[i].name || candidates[i].kind, " ", Math.round(natural.w), "×",
                Math.round(natural.h));
            return bound[win.id];
        }
        return null;
    }

    function releasePanel(id) {
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
            $.Msg("[dl-openshell] pin visibility REFUSED for '", id, "': ", String(e));
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

    function hudWindowCandidates() {
        var container = hudRoot();
        if (!container) return [];

        for (var depth = 0; depth < 3; depth++) {
            var kids = [];
            var count = 0;
            try { count = container.GetChildCount(); } catch (e) { count = 0; }

            // A full-screen game screen is a window in its own right, even when it contains a
            // tree of child panels. Hero select, the hideout dashboard and the shop are screens;
            // the transparent HUD root is not. Only a screen-named container is promoted here.
            var containerId = "";
            try { containerId = container.id || ""; } catch (e) { containerId = ""; }
            var containerCls = classesOf(container);
            var containerText = (containerId + " " + containerCls).toLowerCase();
            var containerArea = num(container.actuallayoutwidth) * num(container.actuallayoutheight);
            if (container !== root && panelVisible(container) &&
                hasReadableName(containerId, containerCls) &&
                isHudSurface(containerId, containerCls, false) &&
                /(select|dashboard|screen|lobby|hideout|match|hero)/.test(containerText) &&
                containerArea > screenW * screenH * 0.5) {
                kids.push(container);
                return kids;
            }

            for (var i = 0; i < count; i++) {
                var child = null;
                try { child = container.GetChild(i); } catch (e) { child = null; }
                if (!child || isShellPanel(child) || !panelVisible(child)) continue;
                if (num(child.actuallayoutwidth) * num(child.actuallayoutheight) < 900) continue;
                kids.push(child);
            }

            if (kids.length >= 3) return kids;

            // An app with one full-screen HUD container needs one level of descent before its
            // windows are the children; stop when there is nothing larger to descend into.
            var big = null;
            var bigArea = 0;
            for (var k = 0; k < kids.length; k++) {
                var area = num(kids[k].actuallayoutwidth) * num(kids[k].actuallayoutheight);
                if (area > bigArea) { bigArea = area; big = kids[k]; }
            }
            if (!big) return kids;
            container = big;
        }
        return [];
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
                if (c.kind === "token" && haystack.indexOf(c.name) >= 0) return true;
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
    function discoverHudWindows() {
        var candidates = hudWindowCandidates();
        candidates.sort(function (a, b) {
            return (num(b.actuallayoutwidth) * num(b.actuallayoutheight)) -
                (num(a.actuallayoutwidth) * num(a.actuallayoutheight));
        });
        // Every named top-level surface, not an arbitrary twelve. Wrappers are skipped here too;
        // the stream below is what finds the controls inside them.
        candidates = candidates.filter(function (panel) {
            var id = hudPanelName(panel, 0);
            var cls = classesOf(panel);
            var area = num(panel.actuallayoutwidth) * num(panel.actuallayoutheight);
            var screenish = /(select|dashboard|screen|lobby|hideout|match|hero)/.test(
                (id + " " + cls).toLowerCase());
            // Full-screen managers and HUD roots are containers, not windows. A full-screen
            // screen (hero select, dashboard) is the window; its chrome is the screen's chrome.
            if (area > screenW * screenH * 0.45 && !screenish) return false;
            return hasReadableName(id, cls) && isHudSurface(id, cls, false) &&
                !isTransientHud(id, cls);
        }).slice(0, 32);
        var at = 0;

        function step() {
            if (!expanded || at >= candidates.length) return;
            var panel = candidates[at];
            var ordinal = at;
            at++;

            if (!isDeclaredPanel(panel) && !ownedByAnother(panel, "") &&
                !isTransientHud(hudPanelName(panel, ordinal), classesOf(panel))) {
                var key = "hud:" + hudPanelName(panel, ordinal).replace(/[^A-Za-z0-9_]/g, "_");
                var nat = naturalOf(panel);
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

        // A full-screen dismiss surface sits just under the menu: a click anywhere outside a
        // menu row lands here and closes it. Menu rows are above it, so selecting one does not.
        contextDismiss = $.CreatePanel("Panel", root, "OpenlockContextDismiss");
        contextDismiss.AddClass("ContextDismiss");
        contextDismiss.SetPanelEvent("onmouseactivate", function () { closeContextMenu(); });

        var left = Math.max(8, Math.min(screenW - 190, x));
        var top = Math.max(SHELL_TOP_DP, Math.min(screenH - 240, y));
        contextMenu = $.CreatePanel("Panel", root, "OpenlockContextMenu");
        contextMenu.AddClass("ContextMenu");
        contextMenu.style.marginLeft = left + "px";
        contextMenu.style.marginTop = top + "px";

        var title = $.CreatePanel("Label", contextMenu, "");
        title.AddClass("ContextTitle");
        title.text = win.title || win.id;

        contextAction(contextMenu, "Open", function () { openWindow(win.id); });
        if (hasControl(win, "minimize"))
            contextAction(contextMenu, "Minimize", function () { minimizeWindow(win.id); });
        if (hasControl(win, "pin"))
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
        if (hasControl(win, "close"))
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

    function bindDwell(panel, titleText, bodyText) {
        if (!panel) return;
        panel.SetPanelEvent("onmouseover", function () { dwellAt(titleText, bodyText, panel); });
        panel.SetPanelEvent("onmouseout", hideDwell);
    }

    function showDwell(win) {
        if (!win) return;
        var detail = (win.id || "") + "  ·  " + (win.lane || "shell") + "  ·  " + (win.content || "");
        dwellAt(win.title || win.id, detail);
    }

    function refuseFeature(title, why) {
        $.Msg("[dl-openshell] REFUSED " + title + ": " + why);
        var key = title + "|" + why;
        if (reportedRefusals[key]) return;
        reportedRefusals[key] = true;
        globalThis.OpenlockToast(title, why, "", true);
    }

    function titleButton(parent, icon, onClick) {
        var b = addControl(parent, "WindowButton", "", onClick);
        var i = $.CreatePanel("Panel", b, "");
        i.AddClass("WindowIcon");
        i.AddClass("Icon" + icon);

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

        var help = {
            Move: ["Move window", "Drag to reposition. Capture follows the pointer without snapping to a grid."],
            Minimize: ["Minimize", "Hide this window's chrome; its tab stays on the bar."],
            Maximize: ["Maximize / restore", "Fill the working area; click again to return to the saved rectangle."],
            Pin: ["Pin", "Keep this window visible while the shell is closed."],
            Close: ["Close", "Collapse the framed game panel, or close this shell window."]
        }[icon];
        if (help) bindDwell(b, help[0], help[1]);
        return b;
    }

    function toggleMaximize(id) {
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
        sendLayout();
    }


    // The package declares a window's title-bar controls (pin/minimize/maximize/close) in the
    // same record as its geometry. A package compiled before controls were projected has no
    // list at all, and keeps the old full chrome; an explicit empty list means the layout
    // declared no title bar, so no control is invented for it.
    function hasControl(win, kind) {
        if (!win || win.controls === undefined) return true;
        for (var i = 0; i < win.controls.length; i++) {
            if (win.controls[i] && win.controls[i].kind === kind) return true;
        }
        return false;
    }

    function createFrame(win) {
        if (frames[win.id]) return frames[win.id];

        var isPanel = isPanelWindow(win);
        var frame = $.CreatePanel("Panel", isPanel ? panelLayer : windowLayer,
            "OpenlockFrame_" + safeId(win.id));
        frame.AddClass("WindowFrame");
        if (isPanel) frame.AddClass("PanelWindow");
        if (win["theme-role"] === "hud") frame.AddClass("HudRole");
        frame.style.visibility = "collapse";
        // The local record below carries the cache; createFrame returns after it is built.

        var title = $.CreatePanel("Panel", frame, "");
        title.AddClass("WindowTitle");

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
        var moveButton = titleButton(title, "Move", function () { focusWindow(win.id); });
        makeDraggable(moveButton, win.id, "move");
        var minButton = hasControl(win, "minimize")
            ? titleButton(title, "Minimize", function () { minimizeWindow(win.id); }) : null;
        var maxButton = hasControl(win, "maximize")
            ? titleButton(title, "Maximize", function () { toggleMaximize(win.id); }) : null;
        var pinButton = hasControl(win, "pin")
            ? titleButton(title, "Pin", function () { togglePin(win.id); }) : null;
        if (pinButton && pinned[win.id]) pinButton.AddClass("PinOn");
        // The close button's right margin is wider than the others so the northeast grip has a
        // clear corner: the grip is 22 dp and the close button would otherwise sit on top of it.
        var closeButton = hasControl(win, "close")
            ? titleButton(title, "Close", function () { closeWindow(win.id); }) : null;
        if (closeButton) closeButton.AddClass("WindowClose");

        title.SetPanelEvent("onmouseactivate", function () { focusWindow(win.id); });
        bindDwell(title, win.title || win.id, "Frame  ·  drag the title bar or the four-arrow handle to move; right-click for actions");
        bindDwell(titleLabel, win.title || win.id, "Frame  ·  " + (win.id || "") + "  ·  " + (win.content || "live"));
        title.SetPanelEvent("oncontextmenu", function () {
            var g = ensureGeometry(win);
            showContextMenu(win, g.x + 8, g.y - CHROME_DP + 8);
        });
        makeDraggable(title, win.id, "move");

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
            grip.hittest = true;
            bindDwell(grip, "Resize " + gripSpecs[gi][0],
                "Drag this corner. Shell windows resize freely; a live game panel scales into the new rect.");
            makeDraggable(grip, win.id, gripSpecs[gi][1]);
            grips.push(grip);
        }

        var record = {
            frame: frame,
            title: titleLabel,
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
        frames[win.id] = record;
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
            $.Msg("[dl-openshell] shell open REFUSED: no window '", id, "'");
            return;
        }

        // In observer grade the shell's windows are not drawn. A package XML surface is the
        // exception: it is what an addon or a remote operator sends to show live stats, and it
        // belongs in the toast stack rather than in window chrome.
        if (currentGrade === "observer") {
            if (win.layoutPath) showObserverXml(win);
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

    // Observer XML is a toast-shaped host for a package's delivered layout. It keeps the layout's
    // own controls and scripts, so a remote sender can put live stats or external links there;
    // the close affordance belongs to the shell so the XML cannot trap the observer.
    function showObserverXml(win) {
        if (!toastStack || !win || !win.layoutPath) return;
        if (observerXmlPanels[win.id]) return;

        var panel = $.CreatePanel("Panel", toastStack, "OpenlockObserverXml_" + safeId(win.id));
        panel.AddClass("Toast");
        panel.AddClass("ObserverXmlToast");
        try {
            panel.SetAttributeString("dw_observer_id", win.id);
            panel.SetAttributeString("dw_observer_title", win.title || win.addonName || "Observer");
            panel.SetAttributeString("dw_observer_data", observerXmlData(win));
        } catch (e) {}

        var title = $.CreatePanel("Label", panel, "");
        title.AddClass("ToastTitle");
        title.text = win.title || win.addonName || "Observer";

        var close = $.CreatePanel("Panel", panel, "");
        close.AddClass("ObserverXmlClose");
        close.SetPanelEvent("onmouseactivate", function () {
            try { panel.DeleteAsync(0); } catch (e) {}
            delete observerXmlPanels[win.id];
        });
        var closeLabel = $.CreatePanel("Label", close, "");
        closeLabel.text = "×";

        var host = $.CreatePanel("Panel", panel, "");
        host.AddClass("ObserverXmlHost");
        try {
            host.SetAttributeString("dw_observer_id", win.id);
            host.SetAttributeString("dw_observer_data", observerXmlData(win));
        } catch (e) {}
        try {
            host.BLoadLayout(win.layoutPath, false, false);
        } catch (e) {
            var refusal = $.CreatePanel("Label", panel, "");
            refusal.AddClass("ToastBody");
            refusal.text = "Observer XML refused: " + String(e);
            $.Msg("[dl-openshell] observer XML REFUSED ", win.layoutPath, ": ", String(e));
        }

        observerXmlPanels[win.id] = { panel: panel, host: host };
        updateObserverXml(true);
    }

    // An observer XML is deliberately not a second data API: the toast carries the same live
    // records the Tools view reads, on an attribute the layout can read from its parent. A layout
    // that wants extra external information keeps its own controls and links; this only makes the
    // shell's live state reachable from the delivered XML.
    function observerXmlData(win) {
        var build = liveBuild || data.build || {};
        var payload = {
            format: "openlock.observer/1",
            id: win && win.id ? win.id : "",
            title: win && (win.title || win.addonName) ? (win.title || win.addonName) : "Observer",
            build: build,
            update: liveUpdate || data.update || { available: false },
            packages: (data.addonPackages || []).length,
            windows: (data.windows || []).length,
            connected: connected(),
            observedAt: new Date().toISOString ? new Date().toISOString() : ""
        };
        try { return JSON.stringify(payload); } catch (e) { return ""; }
    }

    function updateObserverXml(force) {
        var now = Date.now();
        if (!force && now - observerXmlAt < 2000) return;
        observerXmlAt = now;

        for (var id in observerXmlPanels) {
            if (!observerXmlPanels.hasOwnProperty(id)) continue;
            var record = observerXmlPanels[id];
            var win = windowById(id);
            var dataText = observerXmlData(win);
            try { record.panel.SetAttributeString("dw_observer_data", dataText); } catch (e) {}
            try { record.host.SetAttributeString("dw_observer_data", dataText); } catch (e) {}
        }
    }

    // The server bridge, a console, or an addon can read the live record for one observer
    // surface without duplicating the Tools view's parsing.
    globalThis.OpenlockObserverData = function (id) {
        var win = windowById(String(id || ""));
        return win ? observerXmlData(win) : "";
    };

    // The server bridge or a console can address an observer surface by window id.
    globalThis.OpenlockObserverXml = function (id) {
        var win = windowById(String(id || ""));
        if (win && win.layoutPath) showObserverXml(win);
    };

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
        if (currentGrade === "observer") return;
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

    function render() {
        if (launcherBar) launcherBar.style.visibility = "visible";
        if (taskbar) taskbar.style.visibility = expanded ? "visible" : "collapse";

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

    function layoutScheme() {
        return String(currentScheme || themes.default || "default").toLowerCase();
    }

    // The server receives one complete snapshot so a save replaces the previous profile rather
    // than leaving a stale row for a window that was closed. Only known windows are sent; the
    // profile loader ignores ids that no longer exist in the build and says so.
    //
    // Rows are joined with '@', not ';': the payload travels through CitadelConCommand, and a
    // semicolon there starts a second console command, truncating the snapshot at the scheme.
    function layoutEntries() {
        var parts = [];
        for (var id in geometry) {
            if (!geometry.hasOwnProperty(id) || !index[id]) continue;
            var g = geometry[id];
            if (!g) continue;
            var x = Math.round(num(g.x));
            var y = Math.round(num(g.y));
            var w = Math.round(num(g.w));
            var h = Math.round(num(g.h));
            if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) continue;
            if (String(id).indexOf(",") >= 0 || String(id).indexOf("@") >= 0) continue;
            parts.push(id + "," + x + "," + y + "," + w + "," + h);
        }
        return parts.join("@");
    }

    function sendLayout() {
        var entries = layoutEntries();
        if (!entries) return false;
        sendArgs("layout", layoutScheme() + "@" + entries);
        return true;
    }

    function saveUiLayout() {
        if (sendLayout()) {
            globalThis.OpenlockToast("Layout save", "sent · " + layoutScheme(), "", false);
            return true;
        }

        globalThis.OpenlockToast("Layout not saved", "no open window geometry to write", "", true);
        return false;
    }

    function loadUiLayout() {
        sendArgs("layout-load", layoutScheme());
        $.Schedule(0.5, function () { syncLayoutProfiles(true); });
    }

    function resetKnownGeometry() {
        pointerDrag = null;
        for (var gid in index) if (index.hasOwnProperty(gid)) delete geometry[gid];
        for (var mid in maximized) if (maximized.hasOwnProperty(mid)) delete maximized[mid];
        for (var nid in minimized) if (minimized.hasOwnProperty(nid)) delete minimized[nid];
    }

    function drawGeometry() {
        for (var id in frames) {
            if (!frames.hasOwnProperty(id)) continue;
            var f = frames[id];
            if (!f || !f.win) continue;
            applyWindow(f.win);
            if (pinned[id]) enforcePinnedVisibility(id);
        }
        renderBar();
    }

    function showPackageDefaults() {
        resetKnownGeometry();
        drawGeometry();
    }

    // Restore is local and deterministic: every window returns to the geometry the active package
    // declares (or to the live panel's own rect), maximized and minimized state clears, and the
    // current scheme is re-applied. It does not silently reopen windows the player closed.
    function restoreUiLayout() {
        resetKnownGeometry();
        for (var id in frames) {
            if (!frames.hasOwnProperty(id)) continue;
            var f = frames[id];
            if (f) setFrameVisible(f, true);
        }
        applyScheme(currentScheme || themes.default, false);
        drawGeometry();
        globalThis.OpenlockToast("Layout restored",
            "geometry reset to the active scheme · " + layoutScheme(), "", false);
    }

    // Reset-to-defaults is a local reset plus a request to remove the saved profile. Otherwise
    // the next boot would load the profile the player just asked to discard.
    function resetUiLayout() {
        restoreUiLayout();
        sendArgs("layout-reset", layoutScheme());
    }

    function applySavedLayoutFor(scheme, announce) {
        var key = String(scheme || "").toLowerCase();
        var profile = savedProfiles[key];
        if (!profile) return false;

        resetKnownGeometry();
        var known = 0;
        var ignored = 0;
        for (var wid in profile) {
            if (!profile.hasOwnProperty(wid)) continue;
            if (!index[wid]) {
                ignored++;
                continue;
            }

            var r = profile[wid] || {};
            var x = num(r.x);
            var y = num(r.y);
            var w = num(r.w);
            var h = num(r.h);
            if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)
                || Math.abs(x) > 20000 || Math.abs(y) > 20000
                || w < 120 || h < 64) {
                ignored++;
                continue;
            }

            geometry[wid] = { x: x, y: y, w: w, h: h, init: true };
            known++;
        }

        drawGeometry();
        if (ignored) {
            var note = "layout profile ignored " + ignored + " window(s) that no longer exist or are invalid";
            $.Msg("[dl-openshell] " + note + " scheme=" + key);
            if (announce) globalThis.OpenlockToast("Layout profile", note, "", true);
        }
        $.Msg("[dl-openshell] layout profile applied scheme=", key, " windows=", known, " ignored=", ignored);
        sendArgs("layout-applied", key + "|" + known + "|" + ignored);
        if (announce && known) {
            globalThis.OpenlockToast("Layout loaded", key + " · " + known + " window(s)", "", false);
        }
        return true;
    }

    // The server publishes a JSON payload through the host attribute. Reading it here, instead of
    // on a fixed timer around the UI buttons, is what makes the saved profile available at boot
    // even when the addon was mounted before this script started.
    function syncLayoutProfiles(force) {
        var raw = "";
        try { raw = attr("layout", ""); } catch (e) { raw = ""; }
        if (!raw || (!force && raw === layoutPayload)) return;
        layoutPayload = raw;

        var payload = null;
        try { payload = JSON.parse(raw); } catch (e) {
            $.Msg("[dl-openshell] layout payload unreadable: ", String(e));
            if (!layoutNoticesSeen.payload) {
                layoutNoticesSeen.payload = true;
                globalThis.OpenlockToast("Layout profile", "payload unreadable; package defaults remain", "", true);
            }
            return;
        }

        if (!payload || payload.format !== "openlock.layouts/1") {
            $.Msg("[dl-openshell] layout payload ignored: unknown format");
            return;
        }

        savedProfiles = payload.profiles || {};
        var notices = payload.notices || [];
        for (var i = 0; i < notices.length; i++) {
            var text = String(notices[i]);
            if (!text || layoutNoticesSeen[text]) continue;
            layoutNoticesSeen[text] = true;
            $.Msg("[dl-openshell] layout notice: ", text);
            globalThis.OpenlockToast("Layout profile", text, "", true);
        }

        applySavedLayoutFor(layoutScheme(), true);
    }

    globalThis.OpenlockRestoreLayout = resetUiLayout;
    globalThis.OpenlockSaveLayout = saveUiLayout;
    globalThis.OpenlockLoadLayout = loadUiLayout;

    globalThis.OpenlockToggle = function () {
        expanded = !expanded;
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
            $.Msg("[dl-openshell] shell cursor dispatch failed: ", String(e));
        }
    }

    function send(eventName, arg) {
        try {
            $.DispatchEvent("CitadelConCommand",
                "dw_ui openlock-shell|" + eventName + (arg === undefined ? "" : ":" + arg));
        } catch (e) {
            $.Msg("[dl-openshell] shell send failed: ", String(e));
        }
    }

    // Events with a payload use the documented pipe-separated form, so the server receives the
    // payload as one argument instead of folding it into the event name.
    function sendArgs(eventName, arg) {
        try {
            $.DispatchEvent("CitadelConCommand",
                "dw_ui openlock-shell|" + eventName + "|" + String(arg === undefined ? "" : arg));
        } catch (e) {
            $.Msg("[dl-openshell] shell send failed: ", String(e));
        }
    }

    // --- pointer move / resize -----------------------------------------------

    function minimizeWindow(id) {
        var f = frames[id];
        if (!f) {
            refuseFeature("Minimize refused", "no frame owns window '" + id + "'");
            return;
        }
        minimized[id] = true;
        setFrameVisible(f, false);
        renderBar();
    }

    // The drag path does not need this (it is event-driven). Dwell placement and the context
    // menu's follow test use it when a client exposes one; Deadlock does not.
    // Deadlock does not expose GameUI, but the Panorama root does expose MousePosition(): "the
    // position of the mouse in the parent window" (Panorama Javascript API). That is the engine's
    // own pointer, not an event argument, so it works while a button is held. The other three are
    // kept as feature-checked fallbacks for builds that rename or drop the root function.
    var cursorApi = "none";
    var cursorFailure = "";
    var cursorDetail = "";
    var cursorScaleDetail = "";

    // The engine cursor's coordinate space is undocumented in the addon API. Measure the shell
    // first and classify the reading against it: a fractional 0..1 pair is normalized, a pair
    // inside the root is already root-local, and a pair inside Game.GetScreenWidth/Height is a
    // render-pixel position that must be scaled into the root. A pair outside both is not guessed
    // at: it is a scale mismatch and the drag refuses rather than moving the window by the wrong
    // amount.
    function renderSize() {
        try {
            if (typeof Game !== "undefined" && Game) {
                var pairs = [["GetScreenWidth", "GetScreenHeight"], ["GetRenderWidth", "GetRenderHeight"]];
                for (var i = 0; i < pairs.length; i++) {
                    var getW = Game[pairs[i][0]];
                    var getH = Game[pairs[i][1]];
                    if (typeof getW !== "function" || typeof getH !== "function") continue;
                    var w = Number(getW.call(Game));
                    var h = Number(getH.call(Game));
                    if (isFinite(w) && isFinite(h) && w > 200 && h > 200) {
                        return { w: w, h: h, source: "Game." + pairs[i][0] };
                    }
                }
            }
        } catch (e) {}
        return { w: screenW, h: screenH, source: "root layout" };
    }

    function normalizeCursor(x, y) {
        measureScreen();
        var ref = renderSize();
        var sx = ref.w > 200 ? screenW / ref.w : 1;
        var sy = ref.h > 200 ? screenH / ref.h : 1;

        // A fractional pair in 0..1 can only be normalized. Integer 0/1 stay root pixels: the
        // two interpretations differ by at most the top-left corner at that scale.
        var fractional = (x % 1 !== 0) || (y % 1 !== 0);
        if (fractional && x >= 0 && x <= 1 && y >= 0 && y <= 1) {
            return { x: clamp(x * screenW, 0, screenW), y: clamp(y * screenH, 0, screenH),
                mode: "normalized", ref: ref };
        }

        // Root-local is the common case. The measured shell size, not a hard-coded 1600x900,
        // decides whether the pair fits.
        if (x >= -2 && y >= -2 && x <= screenW + 2 && y <= screenH + 2) {
            return { x: clamp(x, 0, screenW), y: clamp(y, 0, screenH), mode: "root", ref: ref };
        }

        // Without a render-size reference there is nothing to normalize against. Refuse instead of
        // silently clamping an out-of-frame reading to the edge, which would look like a cursor
        // that stopped following the pointer.
        if (ref.source === "root layout") {
            cursorScaleDetail = "the cursor read " + x + "," + y + ", outside the shell " + screenW + "×" + screenH +
                ", and this client exposes no render-size API (Game.GetScreenWidth/GetRenderWidth) to normalize it";
            return null;
        }

        // Render pixels: only usable if both axes need the same scale. Different X and Y factors
        // mean the reference frame and the shell are not the same aspect; a 1:1 drag is impossible
        // without guessing, so say so.
        var halfW = ref.w * 0.5;
        var halfH = ref.h * 0.5;
        if (ref.w > 200 && ref.h > 200 &&
            x >= -halfW && y >= -halfH && x <= ref.w + halfW && y <= ref.h + halfH) {
            if (Math.abs(sx - sy) > 0.02 * Math.max(1, Math.abs(sx), Math.abs(sy))) {
                cursorScaleDetail = "the engine frame is " + ref.w + "×" + ref.h + " (" + ref.source +
                    ") and the shell measures " + screenW + "×" + screenH +
                    ", which need different X and Y scales (" + sx.toFixed(3) + " vs " + sy.toFixed(3) + ")";
                return null;
            }
            return { x: clamp(x * sx, 0, screenW), y: clamp(y * sy, 0, screenH),
                mode: "scaled", ref: ref };
        }

        cursorScaleDetail = "the cursor read " + x + "," + y + ", outside the shell " + screenW + "×" + screenH +
            " and the engine frame " + ref.w + "×" + ref.h + " (" + ref.source + ")";
        return null;
    }

    function cursorPoint() {
        cursorFailure = "";
        cursorDetail = "";
        cursorScaleDetail = "";
        var p = null;
        var api = "";
        var tried = [];
        try {
            if (typeof $ !== "undefined" && typeof $.MousePosition === "function") {
                tried.push("$.MousePosition");
                p = $.MousePosition();
                if (p !== null && p !== undefined) api = "$.MousePosition";
            }
        } catch (e) {}
        if (!p) {
            try {
                if (typeof GameUI !== "undefined" && GameUI.GetCursorPosition) {
                    tried.push("GameUI.GetCursorPosition");
                    p = GameUI.GetCursorPosition();
                    if (p !== null && p !== undefined) api = "GameUI.GetCursorPosition";
                }
            } catch (e) {}
        }
        if (!p) {
            try {
                if (typeof $ !== "undefined" && $.GetCursorPosition) {
                    tried.push("$.GetCursorPosition");
                    p = $.GetCursorPosition();
                    if (p !== null && p !== undefined) api = "$.GetCursorPosition";
                }
            } catch (e) {}
        }
        if (!p) {
            try {
                if (typeof Game !== "undefined" && Game.GetCursorPosition) {
                    tried.push("Game.GetCursorPosition");
                    p = Game.GetCursorPosition();
                    if (p !== null && p !== undefined) api = "Game.GetCursorPosition";
                }
            } catch (e) {}
        }
        if (!p || !api) {
            cursorApi = "none";
            cursorFailure = "api";
            cursorDetail = tried.length
                ? tried.join(", ") + " returned no position"
                : "this client exposes no mouse-position function ($.MousePosition, GameUI.GetCursorPosition, $.GetCursorPosition, Game.GetCursorPosition)";
            return null;
        }
        cursorApi = api;

        var x;
        var y;
        if (typeof p === "string") {
            // Some builds serialize the pair ("x y" / "x,y"); numbers are the only useful part.
            var parts = p.match(/-?\d+(?:\.\d+)?/g);
            if (!parts || parts.length < 2) {
                cursorFailure = "api";
                cursorDetail = api + " returned an unreadable string";
                return null;
            }
            x = Number(parts[0]);
            y = Number(parts[1]);
        } else {
            x = p.x !== undefined ? p.x : (p[0] !== undefined ? p[0] : (p.position && p.position.x));
            y = p.y !== undefined ? p.y : (p[1] !== undefined ? p[1] : (p.position && p.position.y));
        }
        if (x === undefined || y === undefined) {
            cursorFailure = "api";
            cursorDetail = api + " returned no coordinate pair";
            return null;
        }
        x = num(x);
        y = num(y);
        if (!isFinite(x) || !isFinite(y)) {
            cursorFailure = "api";
            cursorDetail = api + " returned a non-numeric position";
            return null;
        }

        var at = normalizeCursor(x, y);
        if (!at) {
            cursorFailure = "scale";
            cursorDetail = cursorScaleDetail;
            return null;
        }
        at.source = "engine";
        at.raw = { x: x, y: y };
        return at;
    }

    // The drag is driven by the engine's own cursor (cursorPoint), polled every frame while the
    // button is held. Panel mouse events are only the start/release signals and a coordinate
    // fallback: a build that does not deliver MousePosition still gets a refusal, never a window
    // that silently snaps back to its starting cell.
    var pointerDrag = null;
    var dragCapture = null;
    var dragGeneration = 0;

    function eventPoint(args) {
        if (!args) return null;
        for (var i = 0; i < args.length; i++) {
            var arg = args[i];
            if (arg && typeof arg === "object") {
                var candidates = [arg, arg.position, arg.cursor, arg.mouse, arg.data];
                for (var c = 0; c < candidates.length; c++) {
                    var p = candidates[c];
                    if (!p || typeof p !== "object") continue;
                    var x = p.x !== undefined ? p.x : (p.cursorX !== undefined ? p.cursorX : (p.mouseX !== undefined ? p.mouseX : p[0]));
                    var y = p.y !== undefined ? p.y : (p.cursorY !== undefined ? p.cursorY : (p.mouseY !== undefined ? p.mouseY : p[1]));
                    if (x !== undefined && y !== undefined && isFinite(Number(x)) && isFinite(Number(y))) {
                        return { x: num(x), y: num(y) };
                    }
                }
            }
            if (typeof arg === "number" && i + 1 < args.length && typeof args[i + 1] === "number") {
                return { x: num(arg), y: num(args[i + 1]) };
            }
        }
        return null;
    }

    // A full-screen capture for the duration of a drag. It is what makes the release reliable:
    // the pointer can leave the 30 dp title bar or the corner grip, and the mouseup still lands
    // here instead of on the game under the shell.
    function createDragCapture() {
        if (dragCapture) return;
        try {
            dragCapture = $.CreatePanel("Panel", root, "OpenlockDragCapture");
            dragCapture.AddClass("DragCapture");
            dragCapture.hittest = true;
            dragCapture.hittestchildren = false;
            dragCapture.SetPanelEvent("onmousemove", function () { movePointerDrag(arguments); });
            dragCapture.SetPanelEvent("onmouseup", function () { endPointerDrag(true); });
        } catch (e) {
            dragCapture = null;
            $.Msg("[dl-openshell] drag capture unavailable: ", String(e));
        }
    }

    function dropDragCapture() {
        if (!dragCapture) return;
        var panel = dragCapture;
        dragCapture = null;
        try { panel.hittest = false; } catch (e) {}
        try { panel.DeleteAsync(0); } catch (e) {}
    }

    function beginPointerDrag(id, mode, args) {
        var win = windowById(id);
        if (!win) { endPointerDrag(false); return; }
        if (pointerDrag) endPointerDrag(false);
        measureScreen();
        dragGeneration++;
        var at = cursorPoint();
        var press = eventPoint(args);
        if (!at && cursorFailure === "scale") {
            refuseFeature("Drag refused — scale mismatch", cursorDetail);
            return;
        }
        var g = ensureGeometry(win);
        pointerDrag = {
            generation: dragGeneration,
            id: id,
            mode: mode,
            startX: at ? at.x : null,
            startY: at ? at.y : null,
            anchorSource: at ? "engine" : "",
            press: press,
            x: g.x,
            y: g.y,
            w: g.w,
            h: g.h,
            moved: false,
            downAt: Date.now(),
            at: Date.now()
        };
        hideGrid();
        var f = frames[id];
        if (f && f.cost) f.cost.text = "drag";
        createDragCapture();
        $.Schedule(0.016, pollPointerDrag);
    }

    // The engine cursor, read once per UI frame. This is the same pointer the game uses for aim,
    // so it is live while the button is held; no per-move event or drop grid is needed.
    function pollPointerDrag() {
        if (!pointerDrag) return;
        var generation = pointerDrag.generation;
        var at = cursorPoint();
        if (at) applyPointer(at, "engine");
        else if (cursorFailure === "scale") {
            var scaleWhy = cursorDetail;
            endPointerDrag(false);
            refuseFeature("Drag refused — scale mismatch", scaleWhy);
            return;
        }
        if (!pointerDrag || pointerDrag.generation !== generation) return;
        if (Date.now() - pointerDrag.at > 30000) { endPointerDrag(true); return; }
        $.Schedule(0.016, pollPointerDrag);
    }

    function applyPointer(at, source) {
        if (!pointerDrag) return;
        if (pointerDrag.startX === null) {
            // Anchor on the first reading that arrives after the capture exists. In particular the
            // mousedown's title-panel coordinates are not used: they are in a different space from
            // a capture move, and using them is the anchor-space jump this build had.
            pointerDrag.startX = at.x;
            pointerDrag.startY = at.y;
            pointerDrag.anchorSource = source;
            pointerDrag.at = Date.now();
            return;
        }
        if (source !== pointerDrag.anchorSource) {
            var mismatch = pointerDrag;
            endPointerDrag(false);
            refuseFeature("Drag refused — anchor-space mismatch",
                "the anchor was read in " + mismatch.anchorSource + "-space at " +
                Math.round(mismatch.startX) + "," + Math.round(mismatch.startY) +
                " but the next move arrived in " + source + "-space at " +
                Math.round(at.x) + "," + Math.round(at.y) +
                "; mixing the two would move the window by the panel offset");
            return;
        }

        var win = windowById(pointerDrag.id);
        if (!win) { endPointerDrag(false); return; }
        var dx = at.x - pointerDrag.startX;
        var dy = at.y - pointerDrag.startY;
        if (dx === 0 && dy === 0) {
            pointerDrag.at = Date.now();
            return;
        }

        var g = ensureGeometry(win);
        if (pointerDrag.mode.indexOf("resize") === 0) {
            var west = pointerDrag.mode.indexOf("w") >= 0;
            var north = pointerDrag.mode.indexOf("n") >= 0;
            var width = clamp(pointerDrag.w + (west ? -dx : dx), num(win.minWidth) || 160, screenW);
            var height = clamp(pointerDrag.h + (north ? -dy : dy), num(win.minHeight) || 120, screenH);
            if (west) g.x = clamp(pointerDrag.x + (pointerDrag.w - width), 0, Math.max(0, screenW - 160));
            // A panel frame's title is CHROME_DP above its content, so its content top can be a
            // little lower than a shell frame's; both edges move so a north drag keeps the bottom
            // fixed. This applies to live game panels too; the panel is scaled to the new height.
            var minY = isPanelWindow(win) ? SHELL_TOP_DP + CHROME_DP : SHELL_TOP_DP;
            if (north) g.y = clamp(pointerDrag.y + (pointerDrag.h - height), minY, Math.max(minY, screenH - 80));
            g.w = width;
            g.h = height;
        } else {
            g.x = clamp(pointerDrag.x + dx, 4, Math.max(4, screenW - 160));
            g.y = clamp(pointerDrag.y + dy, SHELL_TOP_DP, Math.max(SHELL_TOP_DP, screenH - 80));
        }
        pointerDrag.moved = true;
        pointerDrag.at = Date.now();
        g.init = true;
        applyWindow(win);
    }

    // Event coordinates are a fallback for a build where MousePosition is absent. They are only
    // used for a capture-space move, never for the press anchor, so the first delta cannot jump by
    // the title bar's screen offset.
    function movePointerDrag(args) {
        if (!pointerDrag) return;
        var at = cursorPoint();
        if (at) { applyPointer(at, "engine"); return; }
        if (cursorFailure === "scale") {
            var scaleWhy = cursorDetail;
            endPointerDrag(false);
            refuseFeature("Drag refused — scale mismatch", scaleWhy);
            return;
        }
        var ev = eventPoint(args);
        if (ev) applyPointer(ev, "event");
    }

    function endPointerDrag(commit) {
        if (!pointerDrag) return;
        var drag = pointerDrag;
        pointerDrag = null;
        dragGeneration++;
        dropDragCapture();
        var win = windowById(drag.id);
        if (!win) return;
        if (!commit) { applyWindow(win); return; }
        var g = ensureGeometry(win);
        applyWindow(win);
        sendLayout();

        // A press that produced neither a cursor nor a single move is a drag this client cannot
        // serve. Name which of the three spaces failed, so the player's one-line report is enough:
        // no usable cursor API; a cursor we cannot map onto the measured shell; or a press anchor
        // in title-panel space with moves in capture space.
        if (!drag.moved && drag.startX === null && Date.now() - drag.downAt > 250) {
            if (drag.press) {
                refuseFeature("Drag refused — anchor-space mismatch",
                    "the press arrived at " + Math.round(drag.press.x) + "," + Math.round(drag.press.y) +
                    " in the title panel's space, no engine cursor was available to convert it, and no capture-space move arrived; using it directly would jump the window by the panel offset");
            } else {
                refuseFeature("Drag refused — API absent",
                    "no window can follow the cursor: " + cursorDetail);
            }
        }
    }

    function makeDraggable(panel, id, mode) {
        if (!panel) return;
        try {
            panel.SetPanelEvent("onmousedown", function () { beginPointerDrag(id, mode, arguments); });
            panel.SetPanelEvent("onmouseup", function () { endPointerDrag(true); });
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
        sendLayout();
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
            // A launcher client can keep the shell under its standalone anchor while a
            // server-mounted wrapper bridges dwv_* attributes onto that anchor. The wrapper
            // marks the anchor with dw_live so it is distinguishable from any other generic
            // HUD panel by the same name.
            if (id === "OpenlockStandaloneHost") {
                try {
                    if (p.GetAttributeString && p.GetAttributeString("dw_live", "") !== "") return p;
                } catch (e) {}
            }
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

    function formatBytes(value) {
        var bytes = Number(value) || 0;
        if (bytes <= 0) return "0 B";
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KiB";
        return (bytes / (1024 * 1024)).toFixed(2) + " MiB";
    }

    function renderBuildStrip() {
        if (!buildStrip) return;

        var state = liveBuild;
        var phase = state ? String(state.state || (state.stage === "installed" ? "ok" : "running")) : "";
        var running = phase === "running";
        var failed = phase === "failed";

        buildStrip.SetHasClass("Running", running);
        buildStrip.SetHasClass("Failed", failed);
        if (!running && !failed) return;

        if (buildStageLabel) {
            buildStageLabel.text = (failed ? "build failed · " : "building · ") +
                String(state.stage || "unknown");
        }
        if (buildDetailLabel) {
            var bits = [];
            if (state.resources) bits.push(state.resources + " resource(s)");
            if (state.vpkBytes) bits.push(formatBytes(state.vpkBytes));
            if (state.message) bits.push(String(state.message));
            if (state.updatedAt) bits.push(String(state.updatedAt));
            buildDetailLabel.text = bits.join("  ·  ");
        }
    }

    function refreshOpenWindow(id) {
        var f = frames[id];
        if (f && open[id] && f.win) renderOwn(f.win, f.body);
    }

    function refreshOpenTools() {
        refreshOpenWindow("tools");
    }

    // A Deadworks addon ships its windows as real shploingus packages (SHPKG002/SHPKG003), either
    // as .shpkg files or inside a VPK. The server discovers those frames, verifies their digest,
    // and sends the validated window records here. The shell does not read archives or invent a
    // layout path: it mounts the content kind and controls the package declared.
    function syncAddons(force) {
        var raw = attr("addons", "");
        if (!force && raw === addonPayload) return;
        addonPayload = raw;
        if (!raw) return;

        var payload = null;
        try { payload = JSON.parse(raw); } catch (e) {
            if (!liveStatusWarned.addons) {
                liveStatusWarned.addons = true;
                $.Msg("[dl-openshell] addon payload unreadable: ", String(e));
            }
            return;
        }

        if (!payload || payload.format !== "openlock.addons/2") {
            $.Msg("[dl-openshell] addon payload ignored: unknown format");
            return;
        }

        data.addonPackages = payload.packages || [];
        var windows = payload.windows || [];
        var added = 0;
        for (var i = 0; i < windows.length; i++) {
            var win = windows[i];
            if (!win || !win.id || index[win.id]) continue;
            data.windows.push(win);
            index[win.id] = win;
            added++;
        }

        if (added) {
            $.Msg("[dl-openshell] addon windows merged: ", added, " from ", data.addonPackages.length, " package(s)");
            refreshOpenWindow("mods");
            refreshOpenWindow("__windows");
            updateObserverXml(true);
        }
    }

    // The server bridge copies the installer's records onto the shell host as dwv_build and
    // dwv_update. An empty attribute is not an error: it means no live producer, and the window
    // then says plainly that it is showing the record baked at pack time.
    function syncLiveStatus(force) {
        var raw = attr("build", "");
        if (force || raw !== liveBuildRaw) {
            liveBuildRaw = raw;
            liveBuild = null;
            if (raw) {
                try { liveBuild = JSON.parse(raw); } catch (e) {
                    if (!liveStatusWarned.build) {
                        liveStatusWarned.build = true;
                        $.Msg("[dl-openshell] build record unreadable: ", String(e));
                    }
                }
            }
            renderBuildStrip();
            refreshOpenTools();
            setGrade(gradeFromRecords());
        }

        var updateRaw = attr("update", "");
        if (force || updateRaw !== liveUpdateRaw) {
            liveUpdateRaw = updateRaw;
            liveUpdate = null;
            if (updateRaw) {
                try { liveUpdate = JSON.parse(updateRaw); } catch (e) {
                    if (!liveStatusWarned.update) {
                        liveStatusWarned.update = true;
                        $.Msg("[dl-openshell] update record unreadable: ", String(e));
                    }
                }
            }
            refreshOpenTools();
        }

        updateObserverXml();
    }

    function currentUpdate() {
        return liveUpdate || data.update || {};
    }

    function renderTools(body) {
        var state = liveBuild || data.buildState || {};
        var stages = state.stages || [];
        var phase = state.state || (state.stage === "installed" ? "ok" : "unknown");

        headingXd(body, "last VPK build");
        rowXd(body, (liveBuild ? "live" : "baked") + "  ·  stage " + (state.stage || "unknown") +
            "  ·  " + (state.state || "unknown") + "  ·  " +
            (state.updatedAt || state.finishedAt || "no timestamp"), liveBuild ? "ViewLine" : "ViewMuted");
        if (!liveBuild) {
            rowXd(body, "no live producer on this shell; the rows below are the last record baked at pack time", "ViewMuted");
        }
        if (state.message) rowXd(body, state.message, "ViewMuted");
        if (state.error) rowXd(body, state.error, "ViewMuted");

        if (stages.length) {
            for (var s = 0; s < stages.length; s++) {
                var stage = stages[s];
                var ok = stage.ok === true || stage.state === "ok";
                var detail = "";
                if (stage.resources) detail = "  ·  " + stage.resources + " resource(s)";
                if (stage.bytes) detail += "  ·  " + formatBytes(stage.bytes);
                if (stage.state) detail += "  ·  " + stage.state;
                if (stage.startedAt) detail += "  ·  " + stage.startedAt +
                    (stage.finishedAt ? " → " + stage.finishedAt : "");
                rowXd(body, (ok ? "[x] " : stage.state === "failed" ? "[!] " : "[ ] ") +
                    stage.name + detail, ok ? "ViewLine" : "ViewMuted");
            }
        } else if (!state.message) {
            rowXd(body, "no build record yet — the next install writes build.json beside the game", "ViewMuted");
        }

        if (state.vpk) {
            headingXd(body, "vpk");
            rowXd(body, state.vpk + "  ·  " + formatBytes(state.vpkBytes));
            if (state.resources) rowXd(body, state.resources + " compiled resource(s)", "ViewMuted");
            if (state.path) rowXd(body, state.path, "ViewMuted");
        }

        headingXd(body, "update");
        var update = currentUpdate();
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

    // A package layout is drawn from its node tree, not BLoadLayout. This is the port of the
    // original client-side DOM path: every panel is created with $.CreatePanel, so hittest and
    // hittestchildren are ours to set and a control cannot be swallowed by a pointer-transparent
    // host. A package mounted as a VPK still uses BLoadLayout only when it shipped no source XML.
    var liveTags = {
        Panel: true, Label: true, Button: true, Image: true, TextEntry: true,
        ProgressBar: true, Slider: true, DropDown: true
    };

    function liveStyleKey(name) {
        var parts = String(name || "").split("-");
        var key = parts[0] || "";
        for (var i = 1; i < parts.length; i++) {
            key += parts[i].charAt(0).toUpperCase() + parts[i].substring(1);
        }
        return key;
    }

    function buildLiveNode(parent, node, depth, addon) {
        if (!parent || !node || depth > 24) return null;
        var tag = liveTags[node.tag] ? node.tag : "Panel";
        var panel = null;
        try {
            panel = $.CreatePanel(tag, parent, node.id || "");
        } catch (e) {
            try { panel = $.CreatePanel("Panel", parent, ""); } catch (e2) { return null; }
        }
        if (!panel) return null;

        var classes = String(node.class || "").split(/\s+/);
        for (var c = 0; c < classes.length; c++) {
            if (classes[c]) {
                try { panel.AddClass(classes[c]); } catch (e) {}
            }
        }

        if (node.text !== undefined && node.text !== null && node.text !== "") {
            try {
                if (tag === "Label" || tag === "Button") panel.text = String(node.text);
                else panel.SetAttributeString("text", String(node.text));
            } catch (e) {}
        }

        var attrs = node.attrs || {};
        for (var key in attrs) {
            if (!attrs.hasOwnProperty(key)) continue;
            var value = String(attrs[key]);
            try {
                if (key === "src" && typeof panel.SetImage === "function") panel.SetImage(value);
                else if (key === "enabled") panel.enabled = value !== "false";
                else if (key === "visible") panel.style.visibility = value === "false" ? "collapse" : "visible";
                else panel.SetAttributeString(key, value);
            } catch (e) {}
        }

        var styles = node.styles || {};
        for (var prop in styles) {
            if (!styles.hasOwnProperty(prop)) continue;
            try { panel.style[liveStyleKey(prop)] = String(styles[prop]); } catch (e) {}
        }

        // The old DOM path set these itself. A Label or Image that takes the pointer hides the
        // button or row behind it; a Panel that ignores the pointer makes every child dead.
        var pointer = tag !== "Label" && tag !== "Image" && tag !== "ProgressBar";
        panel.hittest = pointer;
        panel.hittestchildren = true;

        var children = node.children || [];
        for (var i = 0; i < children.length; i++) {
            buildLiveNode(panel, children[i], depth + 1, addon);
        }
        return panel;
    }

    function renderLiveTree(host, win) {
        var tree = win.liveTree || [];
        if (!tree.length) return false;
        for (var i = 0; i < tree.length; i++) {
            buildLiveNode(host, tree[i], 0, win.addon || "");
        }
        return true;
    }

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
            headingXd(body, (data.refusals.length || 0) + " refusal(s)");
            for (var r = 0; r < data.refusals.length; r++) {
                var x = data.refusals[r];
                rowXd(body, x.file + ":" + x.line + "  " + x.subject + " — " + x.why, "ViewMuted");
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
                            if (!applySavedLayoutFor(scheme.id, true)) {
                                showPackageDefaults();
                                globalThis.OpenlockToast("Layout",
                                    "no saved layout for " + scheme.id + "; package defaults", "", false);
                            }
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
            rowXd(body, "Windows, tabs and pins come from shell/alpha-shell/package.shspec. Changing a geometry row changes the default; M and the corner grip change this window, and Save writes the active scheme's profile.", "ViewMuted");
            rowXd(body, data.windows.length + " declared windows · " + data.tabs.length + " tabs · " + data.pins.length + " pins", "ViewMuted");
            actionXd(body, "Save UI layout  ·  " + layoutScheme(), saveUiLayout);
            actionXd(body, "Load saved layout  ·  " + layoutScheme(), loadUiLayout);
            actionXd(body, "Reset to package defaults  ·  " + layoutScheme(), resetUiLayout);

            headingXd(body, "input");
            // This build exposes no cursor-position API (GameUI is absent). Drag is carried by
            // the panel mouse events; this line states what is available instead of faking a
            // pointer coordinate.
            rowXd(body, "drag the title bar to move · drag a corner grip to resize · cursor coordinates unavailable in this client", "ViewMuted");

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

            headingXd(body, "deadworks addon windows");
            var addonPackages = data.addonPackages || [];
            if (!addonPackages.length) {
                rowXd(body, "no shploingus package (.shpkg) is mounted", "ViewMuted");
            }
            for (var ap = 0; ap < addonPackages.length; ap++) {
                (function (pkg) {
                    rowXd(body, (pkg.id || "?") + "  " + (pkg.version || "") + "  ·  " + (pkg.archive || ""), "ViewLine");
                    var ids = pkg.windowIds || [];
                    for (var iw = 0; iw < ids.length; iw++) {
                        var addonWin = windowById(ids[iw]);
                        if (!addonWin) continue;
                        actionXd(body, "Open  " + (addonWin.title || addonWin.id), function () { openWindow(addonWin.id); });
                    }
                    var refusals = pkg.refusals || [];
                    for (var ir = 0; ir < refusals.length; ir++) {
                        rowXd(body, "REFUSED " + refusals[ir].file + ":" + refusals[ir].line + "  " +
                            refusals[ir].subject + " — " + refusals[ir].why, "ViewMuted");
                    }
                })(addonPackages[ap]);
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

        if (kind === "addon-layout") {
            var addonHost = $.CreatePanel("Panel", body, "");
            addonHost.AddClass("LayoutHost");
            addonHost.hittest = true;
            addonHost.hittestchildren = true;

            if (renderLiveTree(addonHost, win)) return;

            if (!win.layoutPath) {
                rowXd(body, "the package declares no delivered layout for this window", "ViewMuted");
                return;
            }

            // Compiled-only packages keep the mounted-resource path. Source XML packages take the
            // DOM path above, where every control owns its pointer surface.
            try {
                addonHost.BLoadLayout(win.layoutPath, false, false);
            } catch (e) {
                globalThis.OpenlockToast("Addon layout refused", String(e), "", true);
            }
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
                    (isBound ? "  ·  live" : "  ·  not on screen");
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
        syncLiveStatus(false);
        var request = attr("layoutrequest", "");
        if (request && request !== layoutRequest) {
            layoutRequest = request;
            if (request.indexOf("save:") === 0) saveUiLayout();
        }
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

        if ((pollCount % 4) === 0) syncAddons(false);

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
        // Only the small autoFrame set is retried here. HUD discovery is a one-shot sweep on
        // open (or the explicit Scan action), never part of the 2s poll.
        if ((pollCount % 4) === 0) syncLayoutProfiles(false);
        if (expanded && (pollCount % 4) === 0) autoFrameOpen();
        if (expanded && (pollCount % 4) === 2) scanPopups();

        $.Schedule(0.5, poll);
    }

    // --- boot ----------------------------------------------------------------

    function setLauncherName() {
        var name = "";
        try {
            if (typeof Steam !== "undefined" && Steam.GetPersonaName) name = String(Steam.GetPersonaName() || "");
        } catch (e) {
            $.Msg("[dl-openshell] Steam persona unavailable: ", String(e));
        }
        if (!name) {
            try {
                if (typeof Game !== "undefined" && Game.GetSteamPersonaName) name = String(Game.GetSteamPersonaName() || "");
            } catch (e) {}
        }
        // Never fall back to a value baked at build time: that value belongs to the builder, not
        // to whoever is running this install. If Steam is unavailable, show the shell name.
        shellDisplayName = name || "dl-openshell";
        if (launcherLabel) launcherLabel.text = shellDisplayName;
    }

    // A click or leaving the shell retires the pointer tooltip. The context menu has its own
    // dismiss layer, so this is only the tooltip lifetime.
    try {
        root.SetPanelEvent("onmouseactivate", hideDwell);
        root.SetPanelEvent("onmouseout", hideDwell);
    } catch (e) {
        $.Msg("[dl-openshell] tooltip lifetime REFUSED: ", String(e));
    }

    // Panel events route up the parent chain. The root therefore keeps a drag alive while the
    // pointer is over any shell chrome and catches the release even outside the title bar.
    try {
        root.SetPanelEvent("onmousemove", function () { if (pointerDrag) movePointerDrag(arguments); });
        root.SetPanelEvent("onmouseup", function () { if (pointerDrag) endPointerDrag(true); });
    } catch (e) {
        $.Msg("[dl-openshell] drag capture REFUSED: ", String(e));
    }

    measureScreen();
    frameTick();
    refreshCosts();

    // One line in console.log records which pointer source this client actually exposes. It is a
    // report, not synthesized input: nothing here moves the cursor or opens anything.
    (function () {
        var at = cursorPoint();
        $.Msg("[dl-openshell] pointer api: ", cursorApi, " at ",
            at ? (Math.round(at.x) + "," + Math.round(at.y)) : "unavailable",
            " screen ", Math.round(screenW), "x", Math.round(screenH),
            " frameTime ", (engineNowMs() >= 0 ? "yes" : "no"));
    })();

    setLauncherName();
    $.Schedule(2.0, setLauncherName);
    setGrade(gradeFromRecords());
    applyScheme(themes.default, false);
    syncLayoutProfiles(true);
    syncLiveStatus(true);
    syncAddons(true);
    $.Schedule(0.6, function () { syncLayoutProfiles(true); syncLiveStatus(true); syncAddons(true); });
    renderBar();
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
            shellDisplayName + " " + (build.version ? "v" + build.version : (data.version || "")),
            line.join("  ·  ") || "layout package loaded",
            "",
            false);
        $.Msg("[dl-openshell] shell ready: ", (data.name || "openlock"), " ", (data.version || ""),
            " commit=", (build.commit || "unknown"), " game=", (build.gameVersion || "unknown"),
            " windows=", data.windows.length, " refusals=", data.refusals.length);
    });

    $.Schedule(1.5, startUpdateJob);

    // The live-panel inventory in one log line: a build that renames a HUD component is diagnosed
    // from this line instead of from a guess in the package.
    // The live-panel inventory is streamed from the UI tree now, not a synchronous 8000-node
    // walk at boot. A large HUD must never hold the first frame.

    render();
    poll();
})();

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
    var formLabel = root.FindChildTraverse("FormLabel");
    var launcherLabel = root.FindChildTraverse("LauncherLabel");
    var themes = data.themes || { default: "", defaultForm: "", order: [], schemes: [], forms: [], extensions: [] };
    var currentScheme = "";
    var currentForm = themes.defaultForm || "";
    var currentRenderer = "generic";
    // The idle/compact chrome is a behavior of the shell, not a grade gate. Echo the baked grade
    // beside the transition so the client's own console can show whether a grade suppressed it.
    var shellGrade = String((data.build && data.build.grade) || "dev");
    // The preloader warms each bar module before the player opens the shell. It owns the bar's
    // tab slot while it runs, so a scheduled render cannot replace the loading chips with tabs.
    var preloadActive = true;
    var preloadSeq = 0;
    var preloadStartedAt = 0;
    var preloadCompleted = 0;

    var REPO_URL = "https://github.com/alacripose/dl-openshell";
    var LANDING_URL = "https://alacripose.github.io/dl-openshell/";
    var WINDOWS_ID = "__windows";
    // The shell's own dashboard. The game's Citadel dashboard is a full screen in the tools
    // client, but in the release build it is reachable only through the pause menu, so the shell
    // cannot depend on it. This window is drawn by the shell, opens over whatever the game has on
    // screen — in release that is the pause menu's blurred world — and carries the shell's menu
    // and the Popit surface layout editor.
    var DASHBOARD_ID = "__dashboard";
    var DASHBOARD_VIEW = {
        id: DASHBOARD_ID,
        title: "Dashboard",
        content: "dashboard",
        lane: "shell",
        view: "dashboard",
        x: 96, y: 96, width: 640, height: 560,
        minWidth: 380, minHeight: 240,
        opacity: 960,
        "theme-role": "surface",
        pinnable: false
    };
    // The Popit surface's arrangement, edited on the dashboard and saved in the layout profile
    // beside the window rectangles. openlock_popit.js owns the legal range and clamps this copy.
    var popitLayout = { columns: 4, width: 356, frame: "lbp3", mode: "create", order: [] };
    function defaultPopitLayout() {
        return { columns: 4, width: 356, frame: "lbp3", mode: "create", order: [] };
    }
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
    var perf = {
        polls: 0, applies: 0, writes: 0, skips: 0, scans: 0, fullScans: 0, cost: {},
        // The performance window reads these three; they are bounded so the measurement can
        // never become the reason a frame is late. 64 log lines and 72 frame samples.
        samples: [], log: [], startedAt: Date.now()
    };

    function logPerf(kind, text) {
        var line = { at: Date.now(), kind: String(kind || "info"), text: String(text || "") };
        perf.log.push(line);
        if (perf.log.length > 64) perf.log.shift();
        if (line.kind === "warn" || line.kind === "refusal") {
            $.Msg("[Openlock] perf ", line.kind, ": ", line.text);
        }
        return line;
    }

    // The audio module is loaded before this script. A missing module or a client build without
    // PlayUISoundEvent is a silent shell, not a broken one.
    function cue(name) {
        return globalThis.OpenlockCue ? globalThis.OpenlockCue(name) : "";
    }

    function samplePerf(frame) {
        perf.samples.push(Math.max(0, Number(frame) || 0));
        if (perf.samples.length > 72) perf.samples.shift();
    }

    var perfSlowAt = 0;
    function noteSlowApply(id, elapsed) {
        // One line per window per two seconds: a 12 ms outlier on every apply would fill the log
        // with the same reading and hide the event that caused it.
        if (elapsed < 8) return;
        var now = Date.now();
        if (now - perfSlowAt < 2000) return;
        perfSlowAt = now;
        logPerf("warn", "apply " + id + " " + elapsed.toFixed(1) + " ms");
    }
    var frameMs = 0;
    var frameClockAt = 0;
    var frameTickAt = 0;
    var frameTicks = 0;
    var frameSampleAt = 0;
    var perfSummaryAt = 0;
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
    // findInHud is the shell's most expensive lookup: a class candidate that is absent walks the
    // whole HUD. A successful lookup is kept while the panel is alive, and the search itself now
    // prunes hidden branches, which is the bulk of the tree during a match.
    var findCache = {};
    var perfFindAt = 0;
    // The walk can enumerate ids but not this client's panel classes: the "class" attribute is
    // empty and HasClass is the only exposure. The index is therefore id-based, which is what the
    // successful minimap/quickbuy/ability lookups use. A class lookup that misses is remembered
    // for a while so a closed shop is not re-swept every six seconds.
    var hudIdIndex = {};          // visible panel id (lower) -> panel, for token matches
    var hudIndexAt = 0;
    var hudTrackedTokens = {};
    var findMissAt = {};
    var perfFailAt = {};
    // Per-scheme palette edits, kept out of the generated sheet: the sheet owns defaults, this
    // owns the player's current choice. Switching back to a scheme restores its edits.
    var paletteEdits = {};      // scheme id -> { role: #RRGGBBAA }
    var paletteWrites = [];     // { panel, prop, prev } inline writes, restorable
    var paletteDirty = true;
    // Per-window experimental skin: the actual Deadlock elements are painted inline, which is
    // the only way to override the game's own stylesheet without editing its layouts.
    var liveSkin = {};          // window id -> { on: true, writes: [] }
    // A composite game panel (AbilitiesContainer and friends) is one window to the host but many
    // drawables to the player. A split records the component windows so each cell can be framed,
    // moved, themed and saved on its own. The parent keeps its package row and tab.
    var splitCells = {};        // parent id -> [{ id, key, panel, label }]
    var themedPanels = [];      // { panel, writes, label, cellId } inline scheme paint on a cell
    var layoutProfiles = {};    // scheme -> { window id: { x, y, w, h } }
    var layoutNotices = [];
    var layoutExportPath = "";
    var lastLayoutRaw = "";
    var lastLayoutRequest = "";
    var lastLayoutExport = "";
    var layoutLoadedFor = "";
    var layoutRetries = {};

    for (var wi = 0; wi < data.windows.length; wi++) index[data.windows[wi].id] = data.windows[wi];
    for (var pi = 0; pi < data.pins.length; pi++) pinned[data.pins[pi]] = true;
    for (var tc = 0; tc < data.windows.length; tc++) {
        var tcands = data.windows[tc].panelCandidates || [];
        for (var tck = 0; tck < tcands.length; tck++) {
            var tcc = tcands[tck];
            if (tcc.kind === "token") hudTrackedTokens[String(tcc.name).toLowerCase()] = true;
        }
    }

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
        if (id === DASHBOARD_ID) return DASHBOARD_VIEW;
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
                var csize = layoutSize(child);
                if (!csize) continue;
                var cw = csize.w;
                var ch = csize.h;
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

    // A form is the chrome language (geometry, borders, glyph shape), not a palette. Both
    // classes live on the same hosts, so a scheme can be composed with any form. Keep this
    // transformation identical to scheme_class() in tools/gen_shell_theme.py.
    function formClass(id) {
        return "Form" + String(id || "").replace(/(^|[-_])([a-z])/g, function (_, lead, letter) {
            return letter.toUpperCase();
        });
    }

    function rendererClass(id) {
        return "Renderer" + String(id || "generic").replace(/(^|[-_])([a-z])/g, function (_, lead, letter) {
            return letter.toUpperCase();
        });
    }

    function formById(id) {
        var forms = themes.forms || [];
        for (var i = 0; i < forms.length; i++) {
            if (forms[i].id === id) return forms[i];
        }
        return null;
    }

    // The form asks for a surface renderer; the port advertises whether it is present. A package
    // built without the Popit port still renders every window through the generic path.
    function rendererFor(form) {
        if (!form) return "generic";
        if (form.renderer === "popit" && themes.renderers && themes.renderers.popit &&
            themes.renderers.popit.available) return "popit";
        return "generic";
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

    // Palette and shape are two selectors, not one scheme. This function changes colour only:
    // every `.Scheme*` class is removed, the chosen palette is added, and no `.Form*` class is
    // touched. A player can run Popit colours on the Deadlock form, or Deadlock colours on the
    // Popit form, without either choice overwriting the other.
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
        paletteDirty = true;
        applyPalettePaint();
        refreshLiveSkins();
        refreshThemedPanels();
        // Profiles are per scheme. Switching palette restores that scheme's saved arrangement
        // when the host has already published it; a profile that arrives later is applied by the
        // poll. A scheme with no profile clears the marker so switching back restores it again.
        if (layoutProfiles[scheme.id]) {
            if (layoutLoadedFor !== scheme.id) applyLayoutProfile(scheme.id, false);
        } else {
            layoutLoadedFor = "";
        }
        if (schemeLabel) schemeLabel.text = String(scheme.id).charAt(0).toUpperCase();
        if (announce) {
            var ext = scheme.extensions ? scheme.extensions.length : 0;
            logPerf("info", "palette " + scheme.id);
            cue("place");
            globalThis.OpenlockToast("Palette", scheme.label +
                (ext ? " · " + ext + " extension(s)" : ""), "", false);
        }
        return scheme.id;
    }

    function applyForm(id, announce) {
        var form = formById(id) || formById(themes.defaultForm) || (themes.forms && themes.forms[0]);
        if (!form) return "";

        var hosts = schemeHosts();
        var allForms = themes.forms || [];
        for (var h = 0; h < hosts.length; h++) {
            for (var i = 0; i < allForms.length; i++) {
                try { hosts[h].RemoveClass(formClass(allForms[i].id)); } catch (e) {}
            }
            try { hosts[h].RemoveClass("RendererPopit"); } catch (e) {}
            try { hosts[h].RemoveClass("RendererGeneric"); } catch (e) {}
        }
        var renderer = rendererFor(form);
        for (var k = 0; k < hosts.length; k++) {
            try { hosts[k].AddClass(formClass(form.id)); } catch (e) {
                $.Msg("[Openlock] form class REFUSED for '", form.id, "': ", String(e));
            }
            try { hosts[k].AddClass(rendererClass(renderer)); } catch (e) {}
        }

        currentForm = form.id;
        currentRenderer = renderer;
        if (formLabel) formLabel.text = String(form.id).charAt(0).toUpperCase();
        if (announce) {
            logPerf("info", "shape " + form.id + " / " + renderer);
            cue("place");
            globalThis.OpenlockToast("Shape", form.label + " · " + renderer + " renderer", "", false);
        }
        return form.id;
    }

    globalThis.OpenlockScheme = function (id) {
        return applyScheme(String(id || "").toLowerCase(), true);
    };

    globalThis.OpenlockForm = function (id) {
        return applyForm(String(id || "").toLowerCase(), true);
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

    globalThis.OpenlockCycleForm = function () {
        var forms = themes.forms || [];
        if (!forms.length) {
            globalThis.OpenlockToast("Shape", "no form schema in this build", "", true);
            return "";
        }
        var at = -1;
        for (var i = 0; i < forms.length; i++) {
            if (forms[i].id === currentForm) { at = i; break; }
        }
        var next = forms[(at + 1) % forms.length];
        return applyForm(next.id, true);
    };

    // --- palette and live-panel skin ----------------------------------------
    // The .theme schema is the source of truth. This editor changes one role at a time and writes
    // the result inline, so a player can see the change without regenerating the stylesheet. The
    // Export action prints a complete .theme document that can be dropped into a package.
    function paletteEditsFor(scheme) {
        return scheme ? (paletteEdits[scheme.id] || (paletteEdits[scheme.id] = {})) : {};
    }

    function paletteValue(scheme, role) {
        if (!scheme || !role) return "";
        var edits = paletteEdits[scheme.id];
        if (edits && edits[role]) return edits[role];
        return (scheme.roles && scheme.roles[role]) || "";
    }

    function styleProp(name) {
        var map = {
            "background-color": "backgroundColor",
            "border-color": "borderColor",
            "border-bottom-color": "borderBottomColor",
            "border-top-color": "borderTopColor",
            "border-left-color": "borderLeftColor",
            "border-right-color": "borderRightColor"
        };
        return map[name] || String(name).replace(/-([a-z])/g, function (_, c) {
            return c.toUpperCase();
        });
    }

    function simpleSelector(entry) {
        var selector = entry && entry.selector ? String(entry.selector) : "";
        if (selector.length < 2 || selector.charAt(0) !== ".") return "";
        return /^[A-Za-z0-9_]+$/.test(selector.substring(1)) ? selector.substring(1) : "";
    }

    function hasClass(panel, name) {
        try { return !!(panel && name && panel.HasClass(name)); } catch (e) { return false; }
    }

    // One write owner: every inline change is recorded with the value it replaced. Restoring in
    // reverse is what keeps a window's own style intact after a scheme or palette change.
    function writeStyle(records, panel, prop, value) {
        if (!panel || !prop || value === undefined || value === null || value === "") return false;
        var key = styleProp(prop);
        var prior = "";
        try { prior = panel.style[key] === undefined ? "" : panel.style[key]; } catch (e) { return false; }
        for (var i = 0; i < records.length; i++) {
            if (records[i].panel === panel && records[i].key === key) {
                records[i].value = value;
                try { panel.style[key] = value; } catch (e) { return false; }
                return true;
            }
        }
        records.push({ panel: panel, key: key, prev: prior, value: value });
        try { panel.style[key] = value; } catch (e) { return false; }
        return true;
    }

    function restoreStyles(records) {
        if (!records) return;
        for (var i = records.length - 1; i >= 0; i--) {
            try { records[i].panel.style[records[i].key] = records[i].prev; } catch (e) {}
        }
        records.length = 0;
    }

    function eachPanel(top, visit) {
        var stack = [top];
        var guard = 0;
        while (stack.length && guard++ < 1200) {
            var panel = stack.pop();
            if (!panel) continue;
            if (visit(panel) === false) continue;
            var count = 0;
            try { count = panel.GetChildCount(); } catch (e) { count = 0; }
            for (var i = count - 1; i >= 0; i--) {
                try { stack.push(panel.GetChild(i)); } catch (e) {}
            }
        }
    }

    function applyPalettePaint() {
        restoreStyles(paletteWrites);
        paletteDirty = false;
        var scheme = schemeById(currentScheme);
        if (!scheme) return;
        var edits = paletteEdits[scheme.id];
        if (!edits) return;
        var active = false;
        for (var role in edits) { if (edits.hasOwnProperty(role)) { active = true; break; } }
        if (!active) return;

        var paint = scheme.paint || [];
        eachPanel(root, function (panel) {
            for (var i = 0; i < paint.length; i++) {
                var entry = paint[i];
                if (!edits[entry.role]) continue;
                var cls = simpleSelector(entry);
                if (!cls || !hasClass(panel, cls)) continue;
                // A framed game panel stays transparent; the live element is painted by its own
                // experimental skin, not by the shell's frame.
                if (entry.property === "background-color" && hasClass(panel, "PanelWindow")) continue;
                writeStyle(paletteWrites, panel, entry.property, paletteValue(scheme, entry.role));
            }
            return true;
        });
    }

    function importThemeText(scheme) {
        var lines = ["shploingus.theme/1", "theme\t" + scheme.id];
        lines.push("\tlabel\t" + (scheme.label || scheme.id));
        lines.push("\tsource\t" + (scheme.source || "openlock palette editor"));
        // Shape lives in forms/<id>.form; a palette export never carries geometry.
        // Every .theme must carry the full required set, not just the editable subset.
        var required = ["body", "panel", "title", "meta", "border", "borderStrong",
            "ink", "muted", "accent", "alert", "alertBody"];
        for (var i = 0; i < required.length; i++) {
            lines.push("\t" + required[i] + "\t" + paletteValue(scheme, required[i]));
        }
        var rules = scheme.rules || [];
        for (var r = 0; r < rules.length; r++) {
            var value = rules[r].role ? "role:" + rules[r].role : rules[r].value;
            if (value) lines.push("\trule\t" + rules[r].selector + "\t" + rules[r].property + "\t" + value);
        }
        return lines.join("\n");
    }

    function cyclePalette(scheme, entry) {
        var steps = entry.steps || [];
        if (!steps.length) return;
        var current = String(paletteValue(scheme, entry.slot) || "").toUpperCase();
        var at = -1;
        for (var i = 0; i < steps.length; i++) {
            if (String(steps[i]).toUpperCase() === current) { at = i; break; }
        }
        var next = steps[(at + 1) % steps.length];
        paletteEditsFor(scheme)[entry.slot] = next;
        paletteDirty = true;
        applyPalettePaint();
        refreshLiveSkins();
        refreshThemedPanels();
        logPerf("info", "palette " + scheme.id + " " + entry.slot + " -> " + next);
    }

    function resetPalette(scheme) {
        delete paletteEdits[scheme.id];
        paletteDirty = true;
        applyPalettePaint();
        refreshLiveSkins();
        refreshThemedPanels();
        logPerf("info", "palette " + scheme.id + " reset to schema");
    }

    function clearLiveSkin(id) {
        var skin = liveSkin[id];
        if (!skin) return;
        restoreStyles(skin.writes);
        delete liveSkin[id];
    }

    // --- per-cell scheme paint ----------------------------------------------
    // The window skin matches the scheme's rules against classes. A cell is addressed directly:
    // the Picker knows which panel the player touched, so the palette can be written on that
    // drawable even when the game's own class names do not appear in any .theme rule. Shape is
    // still owned by the form: .ThemedCell radius comes from the active .form, so switching
    // shape restyles every themed cell without the palette re-coupling to geometry.
    function themedRecordFor(panel) {
        for (var i = 0; i < themedPanels.length; i++) {
            if (themedPanels[i].panel === panel) return themedPanels[i];
        }
        return null;
    }

    function paintThemedPanel(record) {
        if (!record || !record.panel || !alive(record.panel)) return false;
        var scheme = schemeById(currentScheme);
        if (!scheme) return false;
        restoreStyles(record.writes);
        record.writes = [];
        var panel = record.panel;
        var isText = false;
        try { isText = typeof panel.text === "string" && !!panel.text; } catch (e) { isText = false; }
        // A Label carries text ink only; a panel carries the surface and its edge. Painting a
        // background behind a label would turn every picked stat into a coloured slab.
        if (isText) {
            writeStyle(record.writes, panel, "color", paletteValue(scheme, "ink"));
        } else {
            writeStyle(record.writes, panel, "background-color", paletteValue(scheme, "panel"));
            writeStyle(record.writes, panel, "border-color", paletteValue(scheme, "borderStrong"));
        }
        try { panel.AddClass("ThemedCell"); } catch (e) {}
        return true;
    }

    function isThemedPanel(panel) {
        return !!themedRecordFor(panel);
    }

    function themePanel(panel, label) {
        if (!panel || !alive(panel)) return false;
        var record = themedRecordFor(panel);
        if (!record) {
            record = { panel: panel, writes: [], label: label || "cell" };
            themedPanels.push(record);
        }
        paintThemedPanel(record);
        // A split cell keeps the intent, not only the inline writes: the HUD rebuilds its panels
        // on shop and map transitions, and a new panel has none of the old inline values.
        var owner = windowForPanel(panel);
        if (owner && owner.cellWindow) owner.themed = true;
        logPerf("info", "cell theme: " + (label || "cell") + " with " + currentScheme);
        return true;
    }

    function clearPanelTheme(panel) {
        var record = themedRecordFor(panel);
        if (!record) return false;
        restoreStyles(record.writes);
        try { panel.RemoveClass("ThemedCell"); } catch (e) {}
        var owner = windowForPanel(panel);
        if (owner && owner.cellWindow) owner.themed = false;
        for (var i = 0; i < themedPanels.length; i++) {
            if (themedPanels[i] === record) { themedPanels.splice(i, 1); break; }
        }
        return true;
    }

    function refreshThemedPanels() {
        for (var i = themedPanels.length - 1; i >= 0; i--) {
            var record = themedPanels[i];
            if (!record.panel || !alive(record.panel)) {
                themedPanels.splice(i, 1);
                continue;
            }
            paintThemedPanel(record);
        }
    }

    function togglePanelTheme(panel, label) {
        if (!panel || !alive(panel)) return false;
        if (isThemedPanel(panel)) {
            clearPanelTheme(panel);
            globalThis.OpenlockToast("Cell theme", "Restored " + (label || "the element") + " to the game's rendering.", "", false);
            return false;
        }
        if (!themePanel(panel, label)) return false;
        globalThis.OpenlockToast("Cell theme",
            "Painted " + (label || "the element") + " with " + currentScheme + " and the " + currentForm + " shape.",
            "", false);
        return true;
    }

    function applyLiveSkin(win) {
        clearLiveSkin(win.id);
        var b = bound[win.id];
        if (!b || !b.panel || !alive(b.panel)) return false;
        var scheme = schemeById(currentScheme);
        if (!scheme) return false;

        var writes = [];
        var panel = b.panel;

        // A Panorama cell is an actual drawable, not a layout slot. Walk the live subtree and
        // paint only drawables whose classes the scheme names. The window's container is not
        // painted: a full-width transparent HUD container would become a solid slab over the
        // game, which is exactly the mistake this path exists to avoid.
        var cells = 0;
        var paint = scheme.paint || [];
        eachPanel(panel, function (node) {
            if (!panelVisible(node)) return true;
            if (num(node.actuallayoutwidth) < 4 || num(node.actuallayoutheight) < 4) return true;
            for (var i = 0; i < paint.length; i++) {
                var entry = paint[i];
                var cls = simpleSelector(entry);
                if (!cls || !hasClass(node, cls)) continue;
                if (writeStyle(writes, node, entry.property, paletteValue(scheme, entry.role))) cells++;
            }
            return true;
        });

        liveSkin[win.id] = { on: true, writes: writes, panel: panel, cells: cells };
        return true;
    }

    function refreshLiveSkins() {
        var ids = [];
        for (var id in liveSkin) {
            if (liveSkin.hasOwnProperty(id) && liveSkin[id].on) ids.push(id);
        }
        for (var i = 0; i < ids.length; i++) {
            var win = windowById(ids[i]);
            if (win) applyLiveSkin(win);
        }
    }

    function toggleLiveSkin(win) {
        if (!win || !isPanelWindow(win)) return;
        if (liveSkin[win.id] && liveSkin[win.id].on) {
            clearLiveSkin(win.id);
            logPerf("info", "live skin off: " + win.id);
            globalThis.OpenlockToast("Live skin", "Restored " + (win.title || win.id) + " to the game's rendering.", "", false);
            return;
        }
        if (applyLiveSkin(win)) {
            var cells = (liveSkin[win.id] && liveSkin[win.id].cells) || 0;
            logPerf("info", "live skin on: " + win.id + " with " + currentScheme + " (" + cells + " cell(s))");
            globalThis.OpenlockToast("Live skin (experimental)",
                "Painted " + (win.title || win.id) + " with " + currentScheme + " · " + cells +
                " drawable cell(s). The game's own rules are overridden for this panel only.", "", false);
        } else {
            globalThis.OpenlockToast("Live skin refused",
                "The panel is not on screen; open it in the game first.", "", true);
        }
    }

    // --- toast / update ------------------------------------------------------

    globalThis.OpenlockToast = function (title, body, windowId, attention) {
        if (!toastsAvailable() || !title) return null;

        var t = $.CreatePanel("Panel", toastStack, "");
        t.AddClass("Toast");
        if (attention) t.AddClass("Attention");
        // The toast is created after the shell layout is mounted, so its class sheet is not the
        // only thing keeping it legible. Inline the surface and text colours the same way the
        // observer host is inlined; a missing class sheet must not turn a notice into an
        // invisible black-on-black panel.
        try {
            toastStack.style.width = "300px";
            t.style.width = "100%";
            t.style.padding = "7px 10px";
            t.style.backgroundColor = "#1a140df2";
            t.style.border = "1px solid #8a6f42";
            t.style.borderLeft = "3px solid #e0b56a";
        } catch (e) {}

        var h = $.CreatePanel("Label", t, "");
        h.AddClass("ToastTitle");
        h.text = title;
        try { h.style.color = "#f4e6c8"; h.style.fontSize = "12px"; h.style.fontWeight = "bold"; } catch (e) {}

        if (body) {
            var b = $.CreatePanel("Label", t, "");
            b.AddClass("ToastBody");
            b.text = body;
            try { b.style.color = "#c9b89c"; b.style.fontSize = "11px"; } catch (e) {}
        }

        if (windowId) {
            t.SetPanelEvent("onmouseactivate", function () { openWindow(windowId); });
        }

        $.Schedule(8, function () {
            try { t.DeleteAsync(0); } catch (e) {}
        });

        return t;
    };

    // An observer notice is a toast that can also carry a live XML surface. The package path is
    // the same one a mounted addon uses; the toast owns the panel, so closing it removes the
    // surface without touching the game's HUD.
    function showObserver(payload) {
        if (!payload || (!payload.title && !payload.body && !payload.layout && !(payload.tree && payload.tree.length))) return;
        try {
            $.Msg("[Openlock] observer toast: ", payload.title || "notice", " tree=",
                payload.tree ? payload.tree.length : 0, " layout=", payload.layout ? "yes" : "no");
        } catch (e) {}
        var t = globalThis.OpenlockToast(
            payload.title || "Observer", payload.body || "", payload.window || "", !!payload.attention);
        if (!t) return;
        cue("notify");
        logPerf("info", "observer " + (payload.title || "notice"));
        if ((payload.tree && payload.tree.length) || payload.layout) {
            t.AddClass("ObserverXmlToast");
            var surface = $.CreatePanel("Panel", t, "");
            surface.AddClass("ObserverXmlHost");
            if (payload.tree && payload.tree.length && globalThis.OpenlockDelivery) {
                globalThis.OpenlockDelivery.renderTree(surface, payload.tree, "observer:" + Date.now());
            } else if (payload.layout) {
                try {
                    surface.BLoadLayout(String(payload.layout), false, false);
                } catch (e) {
                    refuseFeature("Observer XML refused", String(e));
                }
            }
            var close = $.CreatePanel("Panel", t, "");
            close.AddClass("ObserverXmlClose");
            close.SetPanelEvent("onmouseactivate", function () {
                try { t.DeleteAsync(0); } catch (e) {}
            });
            var x = $.CreatePanel("Label", close, "");
            x.text = "×";
            x.hittest = false;
        }
    }

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
        // A title glyph must work on both clients. The shipping client dispatches activate after
        // a press; the reduced tools client can lose that event while the title's drag poll owns
        // the pointer. Bind both, with a short guard so one press does not run the action twice.
        var firedAt = 0;
        function fire() {
            var now = Date.now();
            if (press && now - firedAt < 250) return;
            firedAt = now;
            lastInteractionAt = now;
            onClick();
        }
        if (press) {
            p.SetPanelEvent("onmousedown", fire);
            p.SetPanelEvent("onmouseactivate", fire);
        } else {
            p.SetPanelEvent("onmouseactivate", fire);
        }
        return p;
    }

    function addTab(windowId, label, extraClass) {
        var win = windowById(windowId);
        var text = label || (win && win.title) || windowId;
        var tab = addControl(strip, "ShellTab", text, function () { choose(windowId); });
        if (extraClass) tab.AddClass(extraClass);
        if (windowId === activeTab) tab.AddClass("Active");
        if (pinned[windowId]) tab.AddClass("Pinned");
        if (win) {
            bindDwell(tab, (win.title || windowId),
                "Taskbar entry. Left-click opens it; right-click for window actions.", windowId);
            tab.SetPanelEvent("oncontextmenu", function () {
                var at = null;
                try {
                    var pos = tab.GetPositionWithinWindow();
                    if (pos) at = { x: num(pos.x !== undefined ? pos.x : pos[0]),
                        y: num(pos.y !== undefined ? pos.y : pos[1]) };
                } catch (e) {
                    at = null;
                }
                showContextMenu(win, at ? at.x : 12, at ? at.y + 26 : SHELL_TOP_DP);
            });
        }
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

        // A split container has cells instead of a frame. Its tab stays the way back to the
        // whole set; the cells themselves are listed only when focused, pinned or minimized so
        // six ability cells do not turn the bar into a second row.
        for (var splitId in splitCells) {
            if (!splitCells.hasOwnProperty(splitId) || !open[splitId] || listed[splitId]) continue;
            var splitWin = windowById(splitId);
            addTab(splitId, "[" + splitCells[splitId].length + "] " + ((splitWin && splitWin.title) || splitId));
            listed[splitId] = true;
        }

        // Every open frame owns a taskbar entry, including a discovered panel and a minimized
        // window. Without this row a minimize from the title bar had no way back.
        for (var id in frames) {
            if (!frames.hasOwnProperty(id) || !open[id] || listed[id]) continue;
            var win = windowById(id);
            // A discovered HUD control still owns a frame and a Windows row, but forty of them
            // must not turn the bar into a second row. Minimized and focused ones stay in reach.
            if (win && (win.live || win.cellWindow) && !minimized[id] && focused !== id && !pinned[id]) continue;
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
                // Panorama rejects scientific notation in inline opacity; a float that has
                // decayed to 1e-16 is not "0" to its parser either.
                var shown = Math.max(0, opacity);
                taskbar.style.opacity = shown < 0.001 ? "0" : shown.toFixed(2);
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
                        // A preloaded frame is warmed, not opened. Binding it with the full class
                        // sweep at shell open was the 150-270 ms stall; it binds cheaply until
                        // the player selects it.
                        if (frames[id]) frames[id].preloaded = true;
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

    // A class written with the value it already has still invalidates style and hit-testing on
    // this client. The poll re-applies every live window twice a second, so each of those writes
    // is skipped unless the state actually changed.
    function setFrameClass(record, name, want) {
        var cache = record.frameClasses || (record.frameClasses = {});
        if (cache[name] === want) {
            perf.skips++;
            return;
        }
        cache[name] = want;
        record.frame.SetHasClass(name, want);
        perf.writes++;
    }

    function setMetaText(record, text) {
        if (record.lastMeta === text) {
            perf.skips++;
            return;
        }
        record.lastMeta = text;
        record.meta.text = text;
        perf.writes++;
    }

    function setFrameBackground(record, colour) {
        if (record.lastBackground === colour) {
            perf.skips++;
            return;
        }
        record.lastBackground = colour;
        record.frame.style.backgroundColor = colour;
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
            var previous = b.sampledRect || b.natural;
            var fresh = naturalOf(b.panel);
            if (fresh) b.natural = fresh;
            var kids = childCountOf(b.panel);
            var structural = b.childCount !== undefined && b.childCount !== kids;
            var moved = !b.content || !previous || !fresh ||
                Math.abs(fresh.x - previous.x) > 0.5 || Math.abs(fresh.y - previous.y) > 0.5 ||
                Math.abs(fresh.w - previous.w) > 0.5 || Math.abs(fresh.h - previous.h) > 0.5;
            // An idle HUD panel keeps its rect and its children, so its content rectangle is
            // still valid. A pure move (the HUD slides without resizing) carries the measured
            // rectangle with it; nothing is re-walked. A resize or a child change queues the
            // chunked measurement, which never blocks a frame.
            var sameSize = fresh && previous &&
                Math.abs(fresh.w - previous.w) < 1 && Math.abs(fresh.h - previous.h) < 1;
            if (fresh && b.contentMeasured && b.content && sameSize) {
                b.content = {
                    x: b.content.x + (fresh.x - previous.x),
                    y: b.content.y + (fresh.y - previous.y),
                    w: b.content.w,
                    h: b.content.h
                };
            } else if (moved || structural) {
                var cached = cachedContent(b.panel, b.natural, kids);
                if (cached) {
                    b.content = cached;
                    b.contentMeasured = true;
                } else {
                    b.contentMeasured = false;
                    b.content = b.natural;
                    queueContentScan(win.id);
                }
                b.sampledRect = { x: b.natural.x, y: b.natural.y, w: b.natural.w, h: b.natural.h };
            }
            b.childCount = kids;
            b.sampledAt = sampled;
        }

        var nat = b.natural;
        // A frame the player has not placed is a frame around whatever the game is drawing, so it
        // follows the panel: when the HUD reflows, the window moves with it. Pinning a window does
        // not place it — only a drag, a resize, a nudge or a loaded profile does, and those set
        // `g.userSet`. Without this, a HUD panel that moved after its first sample was pushed back
        // to that sample on every poll, which is the window that walked around on its own.
        var follows = !g.userSet && !splitCells[win.id] &&
            (win.autoFrame || win.discovered || win["theme-role"] === "hud");
        if (!g.init || follows) {
            // A scaled window is placed at the schema's point; a 1:1 window starts where the game
            // already drew it, so a HUD element is not yanked across the screen on first bind.
            if (!follows && win.panelScale && win.panelScale !== 1) {
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
        // The clamp is the shell's own adjustment, not a placement: a window that followed the
        // game into the edge keeps following it.

        // The title bar is drawn above the content. A compact HUD title is 16 dp; a shell window
        // carries the full title and meta. If the content is in the shell bar's row, ease the
        // whole window down until the chrome fits; the panel follows the frame, so its own
        // controls remain where the player can see them.
        var chrome = (win.autoFrame || win.discovered) ? 16 : CHROME_DP;
        var dockTop = SHELL_TOP_DP + chrome;
        // A live HUD panel is never shifted for chrome. Moving the game's own abilities/top-bar
        // container made the game re-layout it on the next frame, which is the flicker between
        // two positions; the chrome now yields to the panel instead.
        // This path only draws chrome around a live game panel. It is never shifted for the
        // shell's title row: the panel belongs to the game and the chrome yields to it.
        var needShift = 0;
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
        setFrameClass(record, "Narrow", (right - left) < 260);
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
        if (!perf.cost[id]) perf.cost[id] = { total: 0, samples: 0, last: 0, max: 0 };
        perf.cost[id].total += elapsed;
        perf.cost[id].samples++;
        perf.cost[id].last = elapsed;
        perf.cost[id].max = Math.max(perf.cost[id].max || 0, elapsed);
        noteSlowApply(id, elapsed);
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

    function noteFailure(label, error) {
        var now = Date.now();
        if (perfFailAt[label] && now - perfFailAt[label] < 5000) return;
        perfFailAt[label] = now;
        logPerf("warn", label + " refused: " + String(error));
    }

    function noteSlowFrame() {
        if (frameMs > 24 && Date.now() - perfSlowAt > 5000) {
            perfSlowAt = Date.now();
            logPerf("warn", "ui frame " + frameMs.toFixed(1) + " ms");
        }
    }

    // The engine's UI frame interval, shown as "ui" beside each window's own apply cost. A 1 ms
    // schedule is the only way to observe the interval, so it runs only while the Performance
    // window is the active reading. Everywhere else one sample a second comes from the client's
    // own frame API: the shell must not add a callback to every frame just to draw a number.
    function frameTick() {
        if (!expanded) {
            frameTickAt = 0;
            frameTicks = 0;
            frameSampleAt = 0;
            frameMs = 0;
            $.Schedule(1, frameTick);
            return;
        }
        if (activeId !== "performance") {
            frameTickAt = 0;
            frameTicks = 0;
            frameSampleAt = 0;
            var sampled = sampleFrameMs();
            if (sampled > 0) {
                frameMs = frameMs ? (frameMs * 0.85 + sampled * 0.15) : sampled;
                samplePerf(frameMs);
                noteSlowFrame();
            }
            logPerfSummary();
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
        if (!frameSampleAt) frameSampleAt = at;
        // One bar per second, measured by time rather than by a 60-tick assumption: a 30 fps
        // client would otherwise produce a bar every two seconds.
        if (frameMs && at - frameSampleAt >= 1000) {
            frameSampleAt = at;
            samplePerf(frameMs);
            noteSlowFrame();
            logPerfSummary();
        }
        $.Schedule(0.001, frameTick);
    }

    // One checkable reading every 30 s while the shell is open. The Performance window shows
    // this live; the log keeps the same number so a before/after comparison survives the session.
    function logPerfSummary() {
        var now = Date.now();
        if (!expanded || !perf.samples.length || now - perfSummaryAt < 30000) return;
        perfSummaryAt = now;
        var sum = 0, peak = 0, over = 0;
        for (var i = 0; i < perf.samples.length; i++) {
            var v = perf.samples[i];
            sum += v;
            if (v > peak) peak = v;
            if (v > 16.7) over++;
        }
        var mean = sum / perf.samples.length;
        $.Msg("[Openlock] perf summary: ui mean ", mean.toFixed(1), " ms  peak ", peak.toFixed(1),
            " ms  over 16.7 ms ", Math.round((over / perf.samples.length) * 100), "%  samples ",
            perf.samples.length, "  polls ", perf.polls, "  applies ", perf.applies,
            "  full scans ", perf.fullScans);
    }

    function easeInOut(t) {
        return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    }

    // Panorama rejects CSS transitions with a cubic-bezier function, so the fallback is eased
    // here. The title strip shrinks from 16 dp to 10 dp and fades while the compact controls
    // fade out; the next pointer interaction runs the same curve back to the expanded state.
    function clearCompactChrome(f) {
        // Clearing the inline values, rather than writing the full sizes here, lets the
        // stylesheet own the expanded schema. The Focused rules then restore the 30 dp title and
        // the 26 dp controls that a newly opened shell window uses.
        try { f.titleBar.style.height = ""; } catch (e) {}
        try { f.titleBar.style.opacity = ""; } catch (e) {}
        try { f.title.style.opacity = ""; } catch (e) {}
        try { f.title.style.transform = ""; } catch (e) {}
        try { f.title.style.visibility = ""; } catch (e) {}
        var buttons = f.buttons || [];
        for (var i = 0; i < buttons.length; i++) {
            try { buttons[i].style.opacity = ""; } catch (e) {}
            try { buttons[i].style.transform = ""; } catch (e) {}
        }
        var cost = f.cost || null;
        if (cost) {
            try { cost.style.opacity = ""; } catch (e) {}
            try { cost.style.fontSize = ""; } catch (e) {}
        }
        try { f.frame.RemoveClass("IdleCompact"); } catch (e) {}
    }

    function paintCompact(f) {
        if (!f || !f.titleBar) return;
        // The compact schema belongs to automatic HUD windows only. A shell window keeps its
        // full title height even when hover runs the restore path.
        if (!f.win || !(f.win.autoFrame || f.win.discovered)) return;
        // Focus is the promotion point: a focused HUD window uses the same full chrome as a
        // window the shell opens itself. Clearing the compact inline overrides hands the title
        // strip and its controls back to the Focused rules in openlock_shell.css.
        if (focused === f.win.id) {
            // Focus pins the expanded schema. Reset the idle curve here so moving focus away
            // starts from the full chrome and waits out the normal idle interval instead of
            // collapsing on the same tick.
            f.idleMix = 0;
            f.idleTarget = 0;
            f.idleCompact = false;
            clearCompactChrome(f);
            return;
        }
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
            // A focused window is actively in use even when the pointer is elsewhere. It keeps
            // the full chrome schema; focus moving away is what lets the compact schema return.
            var active = hovered || focused === id;
            // Each window owns its own idle clock. A hover on one window must not keep every
            // other window's chrome expanded, and leaving this window must not reset the others.
            if (active) f.lastActiveAt = now;
            var idle = !pointerDrag && !active && (now - (num(f.lastActiveAt) || 0)) > 3200;
            if (idle && !f.loggedIdle) {
                f.loggedIdle = true;
                $.Msg("[Openlock] chrome idle: ", id, " grade=", shellGrade);
            } else if (!idle && f.loggedIdle) {
                f.loggedIdle = false;
                $.Msg("[Openlock] chrome restore: ", id, " grade=", shellGrade);
            }
            // SetHasClass on an unchanged class still invalidates the frame's style and hit-test
            // tree, which is what re-fired mouseover/mouseout on an idle window every tick.
            if (f.idleCompact !== idle) {
                f.idleCompact = idle;
                f.frame.SetHasClass("IdleCompact", idle);
            }
            var target = idle ? 1 : 0;
            if (Math.abs((num(f.idleMix) || 0) - target) > 0.001 || f.idleTarget !== target) {
                animateCompact(f, target);
            }
        }
    }

    function frameClock() {
        frameClockAt = Date.now();
        if (pointerProbe) {
            var p = cursorPoint();
            pointerProbe.text = "ptr " + (p ? (Math.round(p.x) + "," + Math.round(p.y)) : "NONE") +
                " | ev " + lastPointerEvent + " | " + apiProbe();
        }
        updateCompactChrome();
        // New windows and scheme changes mark the palette dirty; repainting here coalesces a
        // burst of opens into one traversal instead of restyling every panel on every apply.
        if (paletteDirty) applyPalettePaint();
        // A hover has to be noticed before the next second ticks, or the controls feel dead.
        // When the shell is closed there is no chrome to restore, so keep the idle wake at 1 s.
        $.Schedule(expanded ? 0.1 : 1, frameClock);
    }

    function applyWindow(win) {
        var f = frames[win.id];
        if (!f) return;
        // The container's own frame is replaced by its cells. Keep the binding (the cells are its
        // children) but draw no chrome around the whole container.
        if (splitCells[win.id] && splitCells[win.id].length) {
            setFrameVisible(f, false);
            return;
        }
        perf.applies++;
        var started = nowMs();

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
        setFrameClass(f, "Pinned", !!pinned[win.id]);
        setFrameClass(f, "ShellClosed", !expanded);
        setFrameClass(f, "Focused", focused === win.id);
        setFrameClass(f, "PanelWindow", !!framePanel);

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
            // A warmed or automatic frame binds cheaply: id/token lookups and the discovery id
            // index, never a whole-HUD class sweep. Choosing the window clears `preloaded`, so a
            // player who asks for it explicitly still gets the exhaustive bind.
            var resolved = ensureBound(win, !!f.auto || !!f.preloaded);
            // A pinned window whose game panel is not on screen draws nothing: an empty frame
            // around nothing is worse than the game's own HUD. Poll re-shows it when the panel
            // appears. A window the player just opened shows a compact refusal instead of a
            // screen-sized hole.
            if (!resolved && (f.auto || pinned[win.id])) {
                // A window that follows its game screen — the shop, the map, a pinned HUD element —
                // draws nothing while the game is not drawing that panel. The presence came from
                // the panel tree, not from the package: on the dashboard none of these exist, and
                // a card saying so is the shell assuming elements that are not there.
                setFrameVisible(f, false);
                return;
            }
            if (!resolved) {
                setRect(f, g.x, g.y, 360, CHROME_DP + 34);
                setMetaText(f, (win.panelCandidates[0].name || win.panelCandidates[0].kind) + "  ·  not on screen");
                f.refusal.text = "This game panel is not on screen right now. Open it in the game and the window will frame it.";
                setChildVisibility(f, "refusal", f.refusal, true);
                setChildVisibility(f, "body", f.body, false);
                setFrameBackground(f, "transparent");
                updateCost(f, win.id);
                return;
            }
            var ok = applyPanelRect(win, f, g);
            // A themed cell survives the game rebuilding its panel: the player asked for that
            // element painted, not for one particular native panel object.
            if (win.cellWindow && win.themed && bound[win.id] && !isThemedPanel(bound[win.id].panel)) {
                themePanel(bound[win.id].panel, win.title || win.id);
            }
            // A skin belongs to the element it was written on. If the game rebuilt the panel, the
            // old writes are gone with it and the new one is painted once, not on every poll.
            var skin = liveSkin[win.id];
            if (skin && skin.on && skin.panel !== bound[win.id].panel) applyLiveSkin(win);
            noteWindowCost(win.id, started);
            setMetaText(f, (win.panelCandidates[0].name || win.panelCandidates[0].kind) +
                (ok ? "  ·  scale " + Math.round((g.w / bound[win.id].natural.w) * 100) + "%" : "  ·  not on screen"));
            setChildVisibility(f, "refusal", f.refusal, !ok);
            setChildVisibility(f, "body", f.body, false);
            setFrameBackground(f, "transparent");
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
        setMetaText(f, win.content + "  ·  " + Math.round(g.x) + " " + Math.round(g.y) + "  " +
            Math.round(g.w) + "×" + Math.round(g.h) + "  ·  " + (win.lane || "shell"));
        updateCost(f, win.id);
    }

    // --- live panels ---------------------------------------------------------

    function findInHud(candidate, cheap) {
        var top = hudRoot();
        if (!top) return null;

        if (candidate.kind === "ref") {
            return alive(candidate.panel) ? candidate.panel : null;
        }

        var cacheKey = candidate.kind + ":" + candidate.name;
        var cached = findCache[cacheKey];
        if (cached && alive(cached) && panelVisible(cached)) return cached;
        // A class candidate is usually also the panel's id. The discovery index is one lookup,
        // while the class sweep below reads every visible HUD panel; consult it first.
        if (candidate.kind === "class") {
            var indexHit = hudIdIndex[String(candidate.name).toLowerCase()];
            if (indexHit && !isShellPanel(indexHit) && alive(indexHit) && panelVisible(indexHit)) {
                findCache[cacheKey] = indexHit;
                return indexHit;
            }
        }
        // autoFrame retries a closed shop or map every few seconds. Probing a class that is not on
        // screen is the expensive path, so the retry asks for a cheap lookup; discovery frames a
        // surface when it actually becomes visible.
        if (cheap && candidate.kind === "class") return null;
        var missKey = candidate.kind + ":" + candidate.name;
        if (findMissAt[missKey] && Date.now() - findMissAt[missKey] < 30000) return null;
        var findStarted = nowMs();

        if (candidate.kind === "id") {
            var found = null;
            try { found = top.FindChildTraverse(candidate.name); } catch (e) {}
            if (found && !isShellPanel(found)) {
                findCache[cacheKey] = found;
                return found;
            }
            return null;
        }

        // Most Panorama HUD panels use the class name as their id too. Trying the id traversal
        // first turns a common class hit into an O(depth) lookup instead of a whole-HUD sweep.
        if (candidate.kind === "class") {
            var byId = null;
            try { byId = top.FindChildTraverse(candidate.name); } catch (e) {}
            // FindChildTraverse returns a host value on some builds; calling a panel method on it
            // threw out of the whole bind and turned every apply into a refusal log line.
            if (byId && !isShellPanel(byId) && panelVisible(byId) &&
                typeof byId.HasClass === "function" && byId.HasClass(candidate.name)) {
                findCache[cacheKey] = byId;
                return byId;
            }
        }

        // Class search: the game builds most HUD components without an id. A token search is the
        // fallback for a component whose class the build changed: it matches the id or any class
        // containing the token and prefers a class match, then the largest panel (the container,
        // not one of its rows).
        var token = candidate.kind === "token" ? String(candidate.name).toLowerCase() : "";
        if (token) {
            // The ids this HUD uses are the candidate words with the usual prefixes. Trying those
            // traversals is depth-bounded and avoids both the sweep and an index miss on a name
            // that is present but spelled with a prefix.
            var base = String(candidate.name);
            var cap = base.charAt(0).toUpperCase() + base.slice(1);
            var variants = [base, cap, "Hud" + cap, "CitadelHud" + cap];
            for (var vi = 0; vi < variants.length; vi++) {
                var vp = null;
                try { vp = top.FindChildTraverse(variants[vi]); } catch (e) { vp = null; }
                if (vp && !isShellPanel(vp) && panelVisible(vp)) {
                    findCache[cacheKey] = vp;
                    return vp;
                }
            }

            var tokenMatch = null;
            var tokenScore = -1;
            for (var ikey in hudIdIndex) {
                if (!hudIdIndex.hasOwnProperty(ikey) || ikey.indexOf(token) < 0) continue;
                var ip = hudIdIndex[ikey];
                if (!ip || !alive(ip) || !panelVisible(ip)) continue;
                var iscore = layoutArea(ip);
                if (iscore > tokenScore) { tokenScore = iscore; tokenMatch = ip; }
            }
            if (tokenMatch) {
                findCache[cacheKey] = tokenMatch;
                return tokenMatch;
            }
            // An automatic bind (preload, pinned materialization, auto-frame retry) must not walk
            // the whole HUD for a fuzzy token. It gets the index and the id variants above; once
            // discovery has rebuilt the index the next poll finds the panel without a sweep.
            if (cheap) return null;
            if (hudTrackedTokens[token] && hudIndexAt && Date.now() - hudIndexAt < 5000) return null;
        }
        var stack = [top];
        var guard = 0;
        var best = null;
        var bestScore = -1;

        while (stack.length) {
            var p = stack.pop();
            if (!p || p === root) continue;
            // A hidden branch cannot be framed (naturalOf refuses it later), and on this HUD it
            // is most of the tree: walking its thousands of children for a class that is not
            // there is what made the first live-panel bind take most of a second.
            if (!panelVisible(p)) continue;
            if (guard++ > 6000) break;

            if (token) {
                var idText = "";
                try { idText = String(p.id || ""); } catch (e) {}
                var classText = classesOf(p);
                var haystack = (idText + " " + classText).toLowerCase();
                if (haystack.indexOf(token) >= 0) {
                    var area = layoutArea(p);
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
        var result = token ? best : null;
        if (result) findCache[cacheKey] = result;
        else findMissAt[missKey] = Date.now();
        var findElapsed = nowMs() - findStarted;
        if (findElapsed > 8 && Date.now() - perfFindAt > 2000) {
            perfFindAt = Date.now();
            logPerf("warn", "find " + cacheKey + " " + findElapsed.toFixed(1) + " ms  guard " + guard);
        }
        return result;
    }

    // measureOf reads a panel's rect without a visibility check. contentBounds already carries
    // the visibility/opacity state down its own traversal, so re-reading it per leaf is a second
    // native call per node for an answer it already has.
    function measureOf(panel) {
        var size = layoutSize(panel);
        if (!size) return null;
        var w = size.w;
        var h = size.h;
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

    function naturalOf(panel) {
        // A hidden shop or map still has a layout size; framing it would draw chrome around
        // nothing and transform a screen the game is not showing.
        if (!panelVisible(panel)) return null;
        return measureOf(panel);
    }

    function childCountOf(panel) {
        try { return panel.GetChildCount(); } catch (e) { return -1; }
    }

    // Panorama throws "Underlying panel is deleted!" on any property read after the game tears a
    // panel down. The HUD rebuilds while the shell polls it, so every layout read is guarded and
    // a dead panel is skipped rather than allowed to kill the shell's poll loop.
    function layoutSize(panel) {
        if (!panel) return null;
        try {
            return { w: num(panel.actuallayoutwidth), h: num(panel.actuallayoutheight) };
        } catch (e) {
            return null;
        }
    }

    function layoutArea(panel) {
        var size = layoutSize(panel);
        return size ? size.w * size.h : 0;
    }

    // Deadlock HUD containers reserve large transparent rectangles for fade/position math. The
    // AbilitiesContainer, for example, is a full-width 400 dp panel whose actual buttons are a
    // few hundred pixels at the bottom. Framing the container drew chrome around empty space.
    // Union the rectangles of its visible leaf descendants instead, with short labels clipped to
    // their text width; that is the part of the panel the player can actually see.
    // A HUD branch can be laid out and IsVisible while an ancestor fades it to zero. Reading the
    // opacity chain is what keeps a scoreboard card out of the top bar's content rectangle.
    function paintsAt(panel) {
        try {
            if (typeof panel.GetOpacity === "function" && panel.GetOpacity() < 0.01) return false;
        } catch (e) {}
        try {
            var style = panel.style;
            if (style && style.opacity !== undefined && style.opacity !== null && style.opacity !== "") {
                var value = parseFloat(String(style.opacity));
                if (!isNaN(value) && value < 0.01) return false;
            }
        } catch (e) {}
        return true;
    }

    // Content bounds is the expensive part of framing: it reads several native properties on
    // every node of a subtree that can reach 700 panels, which measured 100-330 ms on the UI
    // thread for one window and was paid again on every bind and every HUD move. The same walk
    // now runs in ~4 ms slices, and the answer is cached per panel shape so an idle HUD is never
    // walked twice. Frames draw with their natural rect first and refine when the slice finishes.
    var contentCache = {};      // panelKey -> { rect, at }
    var contentJobs = [];       // window ids whose content is being measured
    var contentPumping = false;
    var contentCacheCount = 0;

    function contentPanelKey(panel, natural, kids) {
        var id = "";
        try { id = panel.id || ""; } catch (e) { return ""; }
        if (!id) return "";
        return id + "|" + Math.round(natural.w) + "x" + Math.round(natural.h) + "|" + kids;
    }

    function cachedContent(panel, natural, kids) {
        var key = contentPanelKey(panel, natural, kids);
        if (!key) return null;
        var hit = contentCache[key];
        if (!hit) return null;
        // A panel can rebuild its children without changing its id or its rect (a shop page, a
        // scoreboard row). Five seconds follows that and still leaves an idle panel untouched.
        if (Date.now() - hit.at > 5000) return null;
        return { x: hit.rect.x, y: hit.rect.y, w: hit.rect.w, h: hit.rect.h };
    }

    function rememberContent(panel, natural, kids, rect) {
        var key = contentPanelKey(panel, natural, kids);
        if (!key) return;
        if (!contentCache[key]) contentCacheCount++;
        contentCache[key] = { rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h }, at: Date.now() };
        if (contentCacheCount > 128) {
            contentCache = {};
            contentCacheCount = 0;
            contentCache[key] = { rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h }, at: Date.now() };
            contentCacheCount = 1;
        }
    }

    function queueContentScan(id) {
        var b = bound[id];
        if (!b || !b.panel || b.contentJob) return;
        var kids = b.childCount;
        if (kids === undefined) { kids = childCountOf(b.panel); b.childCount = kids; }
        var cached = cachedContent(b.panel, b.natural, kids);
        if (cached) {
            b.content = cached;
            b.contentMeasured = true;
            return;
        }
        b.content = b.content || b.natural;
        b.contentJob = {
            panel: b.panel,
            natural: { x: b.natural.x, y: b.natural.y, w: b.natural.w, h: b.natural.h },
            kids: kids,
            stack: [b.panel],
            visited: 0,
            left: 1e9, top: 1e9, right: -1e9, bottom: -1e9,
            found: false
        };
        contentJobs.push(id);
        contentPump();
    }

    function contentScanNode(job) {
        var p = job.stack.pop();
        if (!p) return;
        job.visited++;
        var count = 0;
        try { count = p.GetChildCount(); } catch (e) { return; }

        var visibleChildren = 0;
        for (var i = 0; i < count; i++) {
            var child = null;
            try { child = p.GetChild(i); } catch (e) { child = null; }
            // Visibility and opacity are checked once, on the way down, instead of walking
            // twelve ancestors again for every leaf the traversal reaches.
            if (child && panelVisible(child) && paintsAt(child)) {
                visibleChildren++;
                job.stack.push(child);
            }
        }
        if (visibleChildren > 0) return;
        if (p === job.panel) return;

        var n = measureOf(p);
        if (!n || n.w < 8 || n.h < 8) return;

        // A full-screen transparent image or fade cover is not the content of the window.
        if (n.w > screenW * 0.85 && n.h > screenH * 0.85) return;

        var x = n.x;
        var y = n.y;
        var w = n.w;
        var h = n.h;
        var text = null;
        try { text = p.text; } catch (e) { text = null; }
        if (typeof text === "string") {
            if (!text.replace(/\s+/g, "")) return;
            // A Label reports its parent's assigned width, not the width of its glyphs.
            w = Math.min(w, Math.max(12, text.length * 7 + 8));
        }

        job.found = true;
        if (x < job.left) job.left = x;
        if (y < job.top) job.top = y;
        if (x + w > job.right) job.right = x + w;
        if (y + h > job.bottom) job.bottom = y + h;
    }

    function finishContentScan(job) {
        var whole = job.natural;
        if (!job.found) return { x: whole.x, y: whole.y, w: whole.w, h: whole.h };
        return {
            x: Math.max(whole.x, job.left),
            y: Math.max(whole.y, job.top),
            w: Math.max(8, Math.min(whole.x + whole.w, job.right) - Math.max(whole.x, job.left)),
            h: Math.max(8, Math.min(whole.y + whole.h, job.bottom) - Math.max(whole.y, job.top))
        };
    }

    function contentPump() {
        if (contentPumping) return;
        if (!contentJobs.length) return;
        contentPumping = true;
        var started = nowMs();
        while (contentJobs.length && nowMs() - started < 4) {
            var id = contentJobs[0];
            var b = bound[id];
            var job = b && b.contentJob;
            if (!b || !job) { contentJobs.shift(); continue; }
            // One node at a time: a node with many children can already cost a few native
            // round-trips, so the slice budget is checked after each one rather than per batch.
            contentScanNode(job);
            if (job.stack.length && job.visited < 700) continue;
            contentJobs.shift();
            b.contentJob = null;
            var content = finishContentScan(job);
            rememberContent(job.panel, job.natural, job.kids, content);
            if (bound[id] !== b) continue;
            b.content = content;
            b.contentMeasured = true;
            var win = windowById(id);
            if (win && frames[id]) {
                try { applyWindow(win); } catch (e) { noteFailure("content apply", e); }
            }
        }
        contentPumping = false;
        if (contentJobs.length) $.Schedule(0.016, contentPump);
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

    function ensureBound(win, cheap) {
        if (bound[win.id] && alive(bound[win.id].panel)) return bound[win.id];

        bound[win.id] = null;
        var candidates = win.panelCandidates || [];
        for (var i = 0; i < candidates.length; i++) {
            var panel = findInHud(candidates[i], cheap);
            if (!panel) continue;
            // HUD controls can sit inside a transparent full-screen container; a declared screen
            // (shop, map, hero select) is the window itself and must keep its full rect.
            if (win["theme-role"] === "hud") panel = surfaceTarget(panel);
            // One panel, one window: two chrome frames on the same element would fight over its
            // transform and the last one drawn would win.
            if (ownedByAnother(panel, win.id)) continue;
            var natural = naturalOf(panel);
            if (!natural) continue;
            var kids = childCountOf(panel);
            var content = cachedContent(panel, natural, kids);
            // The frame draws with the panel's own rect immediately; the chunked scan refines it
            // to the visible content once it has a few milliseconds to spend, so binding ten
            // windows can no longer hold the UI thread for seconds.
            bound[win.id] = {
                panel: panel, natural: natural, content: content || natural,
                contentMeasured: !!content, childCount: kids,
                sampledAt: Date.now(), sampledRect: { x: natural.x, y: natural.y, w: natural.w, h: natural.h }
            };
            bindFrameHover(win.id, panel);
            queueContentScan(win.id);
            $.Msg("[Openlock] shell framed '", win.id, "' → ",
                candidates[i].name || candidates[i].kind, " ", Math.round(natural.w), "×",
                Math.round(natural.h), " content ", Math.round(bound[win.id].content.w), "×",
                Math.round(bound[win.id].content.h), content ? "" : " (measuring)");
            return bound[win.id];
        }
        return null;
    }

    function releasePanel(id) {
        clearLiveSkin(id);
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
            var size = layoutSize(p);
            if (!size) continue;
            var w = size.w;
            var h = size.h;
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

    // --- component cells -----------------------------------------------------
    // A live window can be one panel with many drawables inside it (AbilitiesContainer is the
    // clearest example: health, shield, four slots and their labels share one transparent root).
    // Splitting replaces the one screen-sized frame with a frame per visible component. The game
    // panel is never reparented or rebuilt; each cell frame binds the child that already draws.
    function cellIdFor(rootId, path) {
        return "cell:" + rootId + ":" + path;
    }

    // Cells created before nested splits existed carry only the old `cell:<parent>:<key>` id.
    // Derive the root and path from that id so such a cell can still be split without a reload.
    function cellRootAndPath(win) {
        if (!win) return { root: "", path: "" };
        if (win.cellRoot) return { root: win.cellRoot, path: win.cellPath || "" };
        var id = String(win.id || "");
        if (id.indexOf("cell:") === 0) {
            var rest = id.substring(5);
            var at = rest.indexOf(":");
            if (at > 0) return { root: rest.substring(0, at), path: rest.substring(at + 1) };
        }
        return { root: id, path: "" };
    }

    function componentParts(panel) {
        var out = [];
        function walk(p, level) {
            var count = childCountOf(p);
            if (count < 0) return;
            var parentSize = layoutSize(p);
            for (var i = 0; i < count; i++) {
                var child = null;
                try { child = p.GetChild(i); } catch (e) { child = null; }
                if (!child || isShellPanel(child) || !panelVisible(child)) continue;
                var rect = naturalOf(child);
                if (!rect || rect.w < 12 || rect.h < 12) continue;
                // A full-size transparent wrapper is a container, not a component. Descend through
                // it (at most three levels) and split its real children instead.
                var wrapper = parentSize && level < 3 && childCountOf(child) > 0 &&
                    rect.w >= parentSize.w * 0.92 && rect.h >= parentSize.h * 0.92;
                // A full-width row is a layout band, not a component: the ability slots and the
                // item slots both live inside bands. Descend through those bands so the frame
                // lands on the slot, not around the empty space between them.
                var band = parentSize && level < 3 && childCountOf(child) > 1 &&
                    rect.w >= parentSize.w * 0.92 && rect.h <= parentSize.h * 0.65;
                var screenRoot = rect.w >= screenW * 0.9 && rect.h >= screenH * 0.9;
                if (wrapper || band || screenRoot) { walk(child, level + 1); continue; }
                out.push({ panel: child, rect: rect });
            }
        }
        walk(panel, 0);
        out.sort(function (a, b) {
            if (Math.abs(a.rect.y - b.rect.y) > 8) return a.rect.y - b.rect.y;
            return a.rect.x - b.rect.x;
        });
        return out.slice(0, 14);
    }

    function partKey(panel, at, used) {
        var raw = "";
        try { raw = String(panel.id || ""); } catch (e) { raw = ""; }
        if (!raw) raw = String(classesOf(panel).split(" ")[0] || "");
        raw = raw.replace(/[^A-Za-z0-9_]/g, "_").substring(0, 42);
        if (!raw) raw = "part" + at;
        var key = raw;
        var n = 2;
        while (used[key]) { key = raw + "_" + n; n++; }
        used[key] = 1;
        return key;
    }

    function splitWindow(win) {
        if (!win || !isPanelWindow(win)) return false;
        if (splitCells[win.id] && splitCells[win.id].length) return true;
        // A cell can be split again. Its children stay under the declared root and carry the
        // parent path, so the id survives a reload and the saved profile can rebuild the tree.
        // Colon ids on a non-cell (discovered `live:` / `popup:` windows) encode their measured
        // size and are not stable across a HUD rebuild; only a declared window is nameable.
        if (!win.cellWindow && String(win.id).indexOf(":") >= 0) {
            globalThis.OpenlockToast("Split refused",
                "Only a declared window can be split; this one is discovered and its id changes with the HUD.", "", true);
            return false;
        }
        var b = bound[win.id] || ensureBound(win);
        if (!b || !b.panel) {
            globalThis.OpenlockToast("Split refused", "The live panel is not on screen yet.", "", true);
            return false;
        }
        var parts = componentParts(b.panel);
        if (parts.length < 2) {
            globalThis.OpenlockToast("Split refused",
                (win.title || win.id) + " is already one component; there is nothing to separate.", "", true);
            return false;
        }

        var coords = win.cellWindow ? cellRootAndPath(win) : { root: win.id, path: "" };
        var rootId = coords.root;
        var basePath = coords.path;
        var used = {};
        var cells = [];
        for (var i = 0; i < parts.length; i++) {
            var part = parts[i];
            var key = partKey(part.panel, i, used);
            var path = basePath ? basePath + ":" + key : key;
            var cellId = cellIdFor(rootId, path);
            if (cellId.length > 192) {
                globalThis.OpenlockToast("Split refused",
                    "The component path exceeds the layout id limit; split the parent instead.", "", true);
                return false;
            }
            var label = key;
            var cell = index[cellId];
            if (!cell) {
                cell = {
                    id: cellId,
                    title: (win.title || win.id) + " · " + label,
                    content: "cell",
                    lane: "game",
                    "theme-role": "hud",
                    cellWindow: true,
                    cellRoot: rootId,
                    cellPath: path,
                    cellParent: win.id,
                    cellKey: key,
                    panelCandidates: [{ kind: "ref", panel: part.panel }],
                    x: part.rect.x,
                    y: part.rect.y,
                    width: part.rect.w,
                    height: part.rect.h,
                    minWidth: 24,
                    minHeight: 16,
                    opacity: 930,
                    pinnable: true,
                    layers: []
                };
                index[cellId] = cell;
                data.windows.push(cell);
            } else {
                cell.panelCandidates = [{ kind: "ref", panel: part.panel }];
                cell.cellRoot = rootId;
                cell.cellPath = path;
                cell.cellParent = win.id;
                cell.cellKey = key;
                cell.title = (win.title || win.id) + " · " + label;
            }
            cells.push({ id: cellId, key: key, panel: part.panel, label: label });
        }

        splitCells[win.id] = cells;
        win.split = true;
        if (frames[win.id]) setFrameVisible(frames[win.id], false);
        for (var c = 0; c < cells.length; c++) openWindow(cells[c].id, true);
        renderBar();
        render();
        logPerf("info", "split " + win.id + " into " + cells.length + " cell(s)");
        globalThis.OpenlockToast("Cells separated",
            (win.title || win.id) + " → " + cells.length + " component(s). Each cell can be moved, themed and saved.",
            "", false);
        return true;
    }

    function openSplitCells(id) {
        var cells = splitCells[id];
        if (!cells || !cells.length) return false;
        for (var i = 0; i < cells.length; i++) openWindow(cells[i].id, true);
        return true;
    }

    // A split container has no frame of its own. Focus belongs to the first leaf, not to a
    // hidden parent, so a restored layout reports the same active surface the player left.
    function firstLeafId(id) {
        var guard = 0;
        while (splitCells[id] && splitCells[id].length && guard++ < 24) id = splitCells[id][0].id;
        return id;
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
        if (!container) {
            hudIdIndex = {};
            hudIndexAt = 0;
            return [];
        }
        var started = nowMs();

        hudIdIndex = {};
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
                if (id) hudIdIndex[id.toLowerCase()] = child;
                if (isTransientHud(id, cls)) continue;

                var size = layoutSize(child);
                if (!size) continue;
                var w = size.w;
                var h = size.h;
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
        hudIndexAt = Date.now();
        var walkMs = nowMs() - started;
        if (found.length || walkMs > 4) {
            $.Msg("[Openlock] hud walk: ", found.length, " surface(s) of ", visited,
                " panel(s) visited  ", walkMs.toFixed(1), " ms  ids ", Object.keys(hudIdIndex).length);
        }
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
                perf.scans++;
                var id = "";
                try { id = p.id || ""; } catch (e) { id = ""; }
                var size = layoutSize(p);
                if (!size) continue;
                var w = size.w;
                var h = size.h;
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
            // The class fallback walked ~1400 HUD panels every 8 s whenever this client's
            // PopupManager is anonymous. The manager carries the id in every observed build, and
            // a missing one is a feature that does not exist here, not a reason to sweep.
            popupRoot = findInHud({ kind: "id", name: "PopupManager" });
        }
        if (!popupRoot) return;

        // Popups are nested under their manager by a wrapper or two. Walk a bounded depth and
        // frame the matching visible surface itself, not the transparent manager or wrapper.
        var found = [];
        var queue = [{ panel: popupRoot, depth: 0 }];
        var guard = 0;
        while (queue.length && guard++ < 240) {
            var item = queue.shift();
            var p = item.panel;
            if (!p || item.depth > 4 || isShellPanel(p)) continue;
            var size = layoutSize(p);
            if (!size) continue;
            var w = size.w;
            var h = size.h;
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
    var hudScanSig = "";

    // A cheap shape of the HUD: the identity and visibility of the panels directly under the HUD
    // root, with transient surfaces excluded so a chat line or damage number cannot trigger a
    // scan. A full walk only pays off when this changes; the old code walked 130-170 panels every
    // four seconds while the HUD was idle and then framed nothing new.
    function hudStructureSignature(container) {
        var parts = [];
        var count = 0;
        try { count = container.GetChildCount(); } catch (e) { return ""; }
        parts.push(count);
        for (var i = 0; i < count; i++) {
            var child = null;
            try { child = container.GetChild(i); } catch (e) { child = null; }
            if (!child || isShellPanel(child)) continue;
            var id = "";
            try { id = child.id || ""; } catch (e) { id = ""; }
            var cls = classesOf(child);
            if (isTransientHud(id, cls)) continue;
            parts.push((panelVisible(child) ? "v" : "h") + id + "/" + String(cls).split(" ")[0]);
        }
        return parts.join(":");
    }

    function discoverHudWindows() {
        if (discoveringHud) return;
        var container = hudRoot();
        var sig = container ? hudStructureSignature(container) : "";
        // An idle HUD has the same top-level shape from scan to scan. Walking it every 3.5 s
        // only to reach the same surfaces was the periodic cost the poll was paying; the walk
        // now runs when the shape changes, and the declared hot windows are still retried by
        // autoFrameOpen with cheap lookups.
        if (sig && sig === hudScanSig) {
            hudDiscoverAt = Date.now();
            hudIndexAt = Date.now();
            return;
        }
        var candidates = hudWindowCandidates();
        hudScanSig = sig;
        findCache = {};
        findMissAt = {};
        discoveringHud = true;
        perf.fullScans++;
        hudDiscoverAt = Date.now();
        candidates.sort(function (a, b) { return layoutArea(b) - layoutArea(a); });
        candidates = candidates.filter(function (panel) {
            var id = hudPanelName(panel, 0);
            var cls = classesOf(panel);
            var area = layoutArea(panel);
            var screenish = /(select|dashboard|screen|lobby|hideout|match|hero)/.test(
                (id + " " + cls).toLowerCase());
            if (area > screenW * screenH * 0.45 && !screenish) return false;
            return hasReadableName(id, cls) && isHudSurface(id, cls, false) &&
                !isTransientHud(id, cls);
        }).slice(0, 40);
        var at = 0;

        function step() {
            try {
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
                // A cached content rect is exact; without one the panel's own rect is the
                // conservative answer. Looking for the subtree's leaves here was a 100-300 ms
                // synchronous walk per candidate, which is what stalled the UI at shell open.
                var content = nat ? cachedContent(panel, nat, childCountOf(panel)) : null;
                if (overlapsFramedContent(content || nat, key)) {
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
                    bound[key] = {
                        panel: panel, natural: nat, content: content || nat,
                        contentMeasured: !!content, childCount: childCountOf(panel),
                        sampledAt: Date.now(), sampledRect: { x: nat.x, y: nat.y, w: nat.w, h: nat.h }
                    };

                    var f = createFrame(win);
                    f.auto = true;
                    open[key] = true;
                    applyWindow(win);
                    queueContentScan(key);
                }
            }

            if (at < candidates.length) $.Schedule(0.02, step);
            else {
                discoveringHud = false;
                hudDiscoverAt = Date.now();
            }
            } catch (e) {
                discoveringHud = false;
                hudIndexAt = 0;
                noteFailure("hud scan", e);
            }
        }
        try { step(); } catch (e) { discoveringHud = false; noteFailure("hud scan", e); }
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

    // --- popit contextual tool surface ---------------------------------------
    // The package declares the tools; the shell owns the window geometry, the open-window
    // rectangles and the action route. The surface itself is openlock_popit.js: version frame,
    // Deadlock-art icon tiles, hover/selection and the overlap refusal live in that module.
    function closePopit() {
        if (globalThis.OpenlockPopit) globalThis.OpenlockPopit.close();
    }

    function runPopitAction(win, action) {
        closePopit();
        // A skin action is package-declared like every other layer action, but it is a local
        // surface change: the live panel is painted inline, not sent to the server.
        if (action.id === "skin") {
            toggleLiveSkin(win);
            cue("place");
            return;
        }
        if (action.window && windowById(action.window)) openWindow(action.window);
        else cue("place");
        send("layer", win.id + ":" + action.id);
        logPerf("info", "popit " + win.id + "/" + action.id);
        globalThis.OpenlockToast("Popit", win.title + "  ·  " + action.label, "", false);
    }

    function showPopit(win) {
        closePopit();
        var layer = win.layers && win.layers[0];
        if (!layer && isPanelWindow(win)) {
            // A live panel has no package layer unless one was declared. The Popit surface still
            // exists for it: its one action skins the actual drawable cells inside that panel.
            layer = {
                title: "Popit surface",
                surface: "grid",
                hint: "Theme the actual drawable cells in this window; the game keeps its layout.",
                actions: [{ id: "skin", label: "Theme drawable cells" }]
            };
        }
        if (!layer) {
            refuseFeature("Popit refused", "this window declares no tool layer");
            return;
        }
        if (!globalThis.OpenlockPopit || typeof globalThis.OpenlockPopit.show !== "function") {
            refuseFeature("Popit refused", "the surface module is not in this build");
            return;
        }

        cue("select");
        var g = ensureGeometry(win);
        measureScreen();
        var openRects = [];
        for (var id in open) {
            if (!open.hasOwnProperty(id) || id === win.id || minimized[id]) continue;
            var other = geometry[id];
            if (!other) continue;
            openRects.push({
                id: id,
                title: (windowById(id) || {}).title || id,
                x: other.x, y: other.y, w: other.w, h: other.h
            });
        }

        var result = globalThis.OpenlockPopit.show({
            root: root,
            window: { id: win.id, title: win.title || win.id },
            geometry: { x: g.x, y: g.y, w: g.w, h: g.h },
            screen: { w: screenW, h: screenH, top: SHELL_TOP_DP },
            openRects: openRects,
            form: currentForm,
            layer: layer,
            actions: layer.actions || [],
            onAction: function (action) { runPopitAction(win, action); },
            onRefusal: function (title, why) { refuseFeature(title, why); },
            onHover: function (panel, label, body) {
                try { dwellAt(label, body, panel); } catch (e) {}
                try { enterFrame(win.id, "dwell"); } catch (e) {}
            },
            onHoverEnd: function () {
                hideDwell();
                try { leaveFrame(win.id, "dwell"); } catch (e) {}
            }
        });
        if (result && result.ok) logPerf("info", "popit open " + win.id + " " + result.frame);
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
        if (win.layers && win.layers.length) {
            contextAction(contextMenu, win.layers[0].title || "Tools", function () { showPopit(win); });
        }
        contextAction(contextMenu, "Minimize", function () { minimizeWindow(win.id); });
        contextAction(contextMenu, maximized[win.id] ? "Restore" : "Maximize", function () { toggleMaximize(win.id); });
        contextAction(contextMenu, pinned[win.id] ? "Unpin" : "Pin", function () { togglePin(win.id); });
        if (isPanelWindow(win)) contextAction(contextMenu, "Launch layout", function () {
            var path = layoutForWindow(win);
            if (path) openLayout(path);
            else globalThis.OpenlockToast("Layout refused", win.title + " has no declared layout", "", true);
        });
        if (isPanelWindow(win)) contextAction(contextMenu,
            (liveSkin[win.id] && liveSkin[win.id].on ? "Remove live skin" : "Theme live panel (experimental)"),
            function () { toggleLiveSkin(win); });
        if (isPanelWindow(win) && !(splitCells[win.id] && splitCells[win.id].length)) {
            contextAction(contextMenu, "Split into cells", function () { splitWindow(win); });
        }
        if (win.cellWindow) {
            var cellPanel = (bound[win.id] && bound[win.id].panel) ||
                (win.panelCandidates && win.panelCandidates[0] && win.panelCandidates[0].panel) || null;
            contextAction(contextMenu,
                (cellPanel && isThemedPanel(cellPanel) ? "Stop theming this cell" : "Theme this cell"),
                function () { togglePanelTheme(cellPanel, win.title || win.id); });
        }
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
        // Every refusal also enters the performance ring, so the Refusals window and the
        // performance log cannot disagree about what the shell refused.
        logPerf("refusal", title + " — " + why);
        cue("refuse");
        globalThis.OpenlockToast(title, why, "", true);
    }

    function titleButton(parent, icon, onClick, winId) {
        // Move is a drag handle; the rest act on press. A press is also what the pointer probe
        // records, so a refused control is visible in the log instead of silently doing nothing.
        // Every control prints its own line, which is how the installed-build proof distinguishes
        // a dead glyph from a window that refused the action.
        var b = addControl(parent, "WindowButton", "", function () {
            $.Msg("[Openlock] window control ", icon, ": ", winId);
            onClick();
        }, icon !== "Move");
        if (icon === "Popit") {
            b.AddClass("WindowPopit");
            var dots = $.CreatePanel("Panel", b, "");
            dots.AddClass("IconPopit");
            dots.hittest = false;
            dots.hittestchildren = false;
            for (var d = 0; d < 3; d++) {
                var dot = $.CreatePanel("Panel", dots, "");
                dot.AddClass("IconPopitDot");
                dot.hittest = false;
            }
            if (!b || b.hittest === false) {
                refuseFeature("Window control refused", "Popit has no hit-testable button; the title bar would swallow the click");
            }
            bindDwell(b, "Tools", "Open this window's declared tool layer. Actions are sent to the server.", winId);
            return b;
        }
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
            Popit: ["Tools", "Open this window's declared contextual tool layer."],
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
        g.userSet = true;
        if (f.maxButton) {
            f.maxButton.SetHasClass("Maximized", !!maximized[id]);
            if (f.maxButton.glyph) f.maxButton.glyph.text = maximized[id] ? "▣" : "□";
        }
        applyWindow(win);
        // Geometry is client state until the player presses Save layout. The old per-move send
        // used a format the host no longer accepts and was logged as a refused save.
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
        // The Popit tool surface is a window control, not a second title-bar hit area: the
        // button presses, the surface opens, and the title bar still only drags from empty space.
        var popitButton = null;
        if ((win.layers && win.layers.length) || isPanelWindow(win)) {
            popitButton = titleButton(title, "Popit", function () { showPopit(win); }, win.id);
        }
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

        paletteDirty = true;
        var record = {
            frame: frame,
            title: titleLabel,
            titleBar: title,
            buttons: [moveButton, popitButton, minButton, maxButton, pinButton, closeButton],
            meta: metaLabel,
            cost: costLabel,
            body: body,
            refusal: refusal,
            grips: grips,
            minButton: minButton,
            maxButton: maxButton,
            pinButton: pinButton,
            popitButton: popitButton,
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
            record.idleCompact = false;
            paintCompact(record);
        }
        return record;
    }

    function focusWindow(id) {
        focused = id;
        zTop += 1;
        var f = frames[id];
        if (f) {
            f.lastActiveAt = Date.now();
            try { f.frame.style.zIndex = String(zTop); } catch (e) {}
            for (var key in frames) {
                if (!frames.hasOwnProperty(key)) continue;
                frames[key].frame.SetHasClass("Focused", key === id);
                // Focus changes which chrome schema a compact frame uses. Repaint both the new
                // and the previous frame now; waiting for the idle clock left a focused window
                // in the small schema and the unfocused one in the big schema.
                paintCompact(frames[key]);
            }
        }
    }

    function openWindow(id, quiet) {
        var win = windowById(id);
        if (!win) {
            $.Msg("[Openlock] shell open REFUSED: no window '", id, "'");
            return;
        }

        // A split window has no frame of its own; opening it opens its component cells. The
        // parent tab remains the way back to the whole set.
        if (splitCells[id] && splitCells[id].length) {
            expanded = true;
            hudScanSig = "";
            open[id] = true;
            delete dismissed[id];
            delete minimized[id];
            freeCursor(true);
            openSplitCells(id);
            activeId = firstLeafId(splitCells[id][0].id);
            renderBar();
            render();
            focusWindow(activeId);
            if (!quiet) cue("select");
            return;
        }

        var hidden = hiddenPanels[id];
        if (hidden) {
            try { hidden.style.visibility = "visible"; } catch (e) {}
            delete hiddenPanels[id];
        }

        expanded = true;
        hudScanSig = "";
        activeId = id;
        open[id] = true;
        delete dismissed[id];
        delete minimized[id];
        freeCursor(true);

        var f = createFrame(win);
        f.preloaded = false;
        setFrameVisible(f, true);
        paletteDirty = true;

        if (!isPanelWindow(win)) renderOwn(win, f.body);

        render();
        focusWindow(id);
        send("view", id);
        if (!quiet) cue("select");
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
        // {resources} already resolves to the panorama/ tree. A generator path such as
        // panorama/layout/citadel_hero_grid.xml must drop its first segment: BLoadLayout with
        // file://{resources}/panorama/layout/... asserts "Couldn't get layout file" (2), which is
        // exactly what hero select hit. Bare names are resources-relative layout names.
        if (path.indexOf("panorama/") === 0) path = path.substring("panorama/".length);
        if (path.indexOf("/") < 0) path = "layout/" + path;
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
        hudScanSig = "";
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
            if (!ensureBound(win, true)) continue;
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
        var closing = windowById(id);
        var closingCell = !!(closing && closing.cellWindow);

        // Closing a split container closes its cells and stops drawing the container; it must
        // not collapse the game panel, because the cells are children of it. Each cell's own
        // close path is the normal one below.
        if (splitCells[id] && splitCells[id].length) {
            var cells = splitCells[id];
            delete splitCells[id];
            if (closing) closing.split = false;
            for (var sc = 0; sc < cells.length; sc++) closeWindow(cells[sc].id);
            delete open[id];
            dismissed[id] = true;
            if (frames[id]) { try { frames[id].frame.DeleteAsync(0); } catch (e) {} delete frames[id]; }
            if (focused === id) focused = "";
            renderBar();
            render();
            return;
        }

        // Closing a frame around a live game panel collapses that panel, not only its chrome.
        // The panel is remembered so reopening the window restores it. A split cell is a
        // component of a panel that is still in use: removing its chrome must not erase the
        // game's own ability icon from the HUD.
        releasePanel(id);
        if (!closingCell && b && b.panel) {
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

    function togglePin(id, quiet) {
        // Pinning a split container is a promise for every component it stands for.
        if (splitCells[id] && splitCells[id].length) {
            var cells = splitCells[id];
            var turnOn = !pinned[id];
            for (var c = 0; c < cells.length; c++) {
                if (turnOn && !pinned[cells[c].id]) togglePin(cells[c].id, true);
                if (!turnOn && pinned[cells[c].id]) togglePin(cells[c].id, true);
            }
        }
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

        if (!quiet) {
            cue("place");
            globalThis.OpenlockToast(
                pinned[id] ? "Pinned" : "Unpinned",
                (windowById(id) && windowById(id).title ? windowById(id).title : id) +
                    (pinned[id] ? " stays while the shell is closed" : " leaves with the shell"),
                "",
                false);
        }

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
                var pinFrame = createFrame(pinWin);
                // A pinned frame is materialized by opening the shell, not by the player choosing
                // that window. Bind it cheaply until it is selected; ids and tokens still bind,
                // only the whole-HUD class sweep is deferred.
                if (pinFrame) pinFrame.preloaded = true;
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

    // The dashboard is the shell's fallback surface: when the game is drawing no panel the shell
    // owns, opening it lands on a menu that exists instead of on a frame around nothing.
    globalThis.OpenlockDashboard = function () {
        expanded = true;
        hudScanSig = "";
        freeCursor(true);
        choose(DASHBOARD_ID);
        render();
    };

    globalThis.OpenlockToggle = function () {
        skipPreload();
        expanded = !expanded;
        hudScanSig = "";
        if (expanded) showTaskbar();
        if (expanded) cue("select");
        freeCursor(expanded);
        if (expanded && !activeId) {
            // The dashboard is the shell's own screen and the only one that is guaranteed to
            // exist: the game's dashboard sits behind the pause menu in release. So a shell that
            // opens while no declared game panel is on screen opens its dashboard, not a tab that
            // would frame a panel the game is not drawing.
            activeId = presenceReading().live
                ? (data.tabs.length ? data.tabs[0] : WINDOWS_ID)
                : DASHBOARD_ID;
            if (activeId === DASHBOARD_ID) openWindow(DASHBOARD_ID, true);
        }
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
        hudScanSig = "";
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
        // A split container's chrome is hidden; minimizing its taskbar entry means minimizing the
        // component cells it stands for, not a frame the player cannot see.
        if (splitCells[id] && splitCells[id].length) {
            var split = splitCells[id];
            for (var sc = 0; sc < split.length; sc++) minimizeWindow(split[sc].id);
            minimized[id] = true;
            renderBar();
            return;
        }
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
        // The dp grid is the layout unit made visible. While the dashboard is open, a drag lands
        // on the grid and a resize keeps a whole number of grid squares, so the numbers in the
        // editor and the rectangle on screen are the same numbers.
        if (dashSnap && dashGrid > 0 && open[DASHBOARD_ID]) {
            g.x = clamp(Math.round(g.x / dashGrid) * dashGrid, 4, Math.max(4, screenW - 160));
            g.y = clamp(Math.round(g.y / dashGrid) * dashGrid, SHELL_TOP_DP,
                Math.max(SHELL_TOP_DP, screenH - 80));
            if (pointerDrag.mode.indexOf("resize") === 0) {
                g.w = Math.max(num(win.minWidth) || 160, Math.round(g.w / dashGrid) * dashGrid);
                if (!isPanelWindow(win)) {
                    g.h = Math.max(num(win.minHeight) || 120, Math.round(g.h / dashGrid) * dashGrid);
                }
            }
        }
        g.init = true;
        g.userSet = true;
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
        g.userSet = true;
        hideGrid();
        applyWindow(win);
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
            // A server-mounted shell is bridged onto OpenlockStandaloneHost; the DWHost_ panel
            // owns the layout but is never the shell's ancestor. Accept either, or every server
            // attribute would read as its default and delivery would look like a client bug.
            if (id.indexOf("DWHost_") === 0 || id === "OpenlockStandaloneHost") return p;
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
            // Do not BLoadLayout a guessed stock layout here. A live panel can be absent from this
            // reduced build (hero select in CSDK10 has no citadel_hero_grid resource), and an
            // unreadable layout asserts the whole client. "Launch layout" in the UI tree stays an
            // explicit choice; hooking a panel that is not on screen frames its declared window
            // and refuses the hook instead of guessing a file.
            var f = createFrame(win);
            f.auto = false;
            open[id] = true;
            delete dismissed[id];
            applyWindow(win);
            globalThis.OpenlockToast("Hook refused", win.title + " is not on screen in this build", "", true);
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

    // --- live packages -------------------------------------------------------
    // Delivery state, payload validation, version checks, atomic window-set replacement and
    // node creation live in openlock_delivery.js. The poll only hands over the host attribute;
    // parsing and panel work happen on that module's scheduled ticks with a small budget, so a
    // large package or observer XML cannot stall the poll frame.
    function renderAddonLayout(win, body) {
        headingXd(body, "package layout  ·  " + (win.addonName || win.addon || "addon"));
        if (win.liveTree && win.liveTree.length) {
            rowXd(body, win.liveTree.length + " source node(s)  ·  built by the shell, not mounted", "ViewMuted");
            var surface = $.CreatePanel("Panel", body, "");
            surface.AddClass("AddonHost");
            if (globalThis.OpenlockDelivery) {
                globalThis.OpenlockDelivery.renderTree(surface, win.liveTree, "addon:" + win.id);
            } else {
                rowXd(body, "delivery module is not in this build", "ViewMuted");
            }
            return;
        }
        if (win.layoutPath) {
            rowXd(body, win.layoutPath, "ViewMuted");
            var layoutHost = $.CreatePanel("Panel", body, "");
            layoutHost.AddClass("LayoutHost");
            var loaded = false;
            try { loaded = layoutHost.BLoadLayout(win.layoutPath, false, false); } catch (e) {
                refuseFeature("Package layout refused", String(e));
            }
            if (!loaded) {
                layoutHost.RemoveAndDeleteChildren();
                rowXd(body, "the mounted layout did not load; the package's live tree is the fallback", "ViewMuted");
                refuseFeature("Package layout refused", win.id + " carries no readable source tree or mounted layout");
            }
            return;
        }
        rowXd(body, "this window has no source XML and no mounted layout", "ViewMuted");
    }

    function closeAddonWindow(id) {
        if (frames[id]) closeWindow(id);
        delete index[id];
        delete geometry[id];
        delete bound[id];
    }

    function pollAddons() {
        if (globalThis.OpenlockDelivery) globalThis.OpenlockDelivery.offerAddons(attr("addons", ""));
    }

    function pollObserver() {
        if (globalThis.OpenlockDelivery) globalThis.OpenlockDelivery.offerObserver(attr("observer", ""));
    }

    if (globalThis.OpenlockDelivery) {
        globalThis.OpenlockDelivery.configure({
            windows: data.windows,
            index: index,
            closeWindow: closeAddonWindow,
            rebuild: function (win) {
                var f = frames[win.id];
                if (!f) return;
                f.win = win;
                if (!isPanelWindow(win)) renderOwn(win, f.body);
                applyWindow(win);
            },
            observer: showObserver,
            applied: function (stats) {
                if (!stats.added && !stats.updated && !stats.removed) return;
                logPerf("info", "packages " + stats.packages + "  ·  +" + stats.added +
                    " ~" + stats.updated + " -" + stats.removed + " rev=" + stats.revision);
                if (Date.now() - perf.startedAt > 2500) cue("notify");
                globalThis.OpenlockToast("Packages updated",
                    stats.packages + " package(s)  ·  " + stats.added + " added  ·  " +
                    stats.updated + " updated  ·  " + stats.removed + " removed",
                    stats.windowId || "", false);
            },
            refuse: refuseFeature,
            log: logPerf,
            cue: cue,
            bindDwell: function (panel, title, body) { bindDwell(panel, title, body, ""); }
        });
    }

    // --- picker --------------------------------------------------------------
    // The picker is the Popit tool for the live panorama tree. It captures the pointer with a
    // transparent overlay (so scrubbing cannot click through into the game), finds the smallest
    // measured HUD panel under the cursor, and records its real style values before an edit. The
    // overlay is created only for the scrub and removed on commit or cancel.
    var pickerActive = false;
    var pickerOverlay = null;
    var pickerHighlight = null;
    var pickerBadge = null;
    var pickerBadgeLabel = null;
    var pickerTarget = null;
    var pickerOffset = { x: 0, y: 0 };
    var pickerOriginal = null;

    function pickerName(entry) {
        return (entry && (entry.id || entry.cls)) || "panel";
    }

    function pickerAtCursor() {
        if (!pickerTarget) return null;
        var p = pickerTarget.panel;
        if (!p || !alive(p)) return null;
        return p;
    }

    function pickerPaintTarget() {
        if (!pickerHighlight) return;
        if (!pickerTarget) {
            pickerHighlight.style.visibility = "collapse";
            return;
        }
        pickerHighlight.style.visibility = "visible";
        pickerHighlight.style.marginLeft = Math.round(pickerTarget.x) + "px";
        pickerHighlight.style.marginTop = Math.round(pickerTarget.y) + "px";
        pickerHighlight.style.width = Math.round(pickerTarget.w) + "px";
        pickerHighlight.style.height = Math.round(pickerTarget.h) + "px";
    }

    function pickerEventPoint(event) {
        if (!event) return null;
        var candidates = [event, event.cursor, event.mouse];
        for (var i = 0; i < candidates.length; i++) {
            var p = candidates[i];
            if (!p) continue;
            var x = p.x !== undefined ? p.x : (p.cursorX !== undefined ? p.cursorX : p.mouseX);
            var y = p.y !== undefined ? p.y : (p.cursorY !== undefined ? p.cursorY : p.mouseY);
            if (x !== undefined && y !== undefined && isFinite(Number(x)) && isFinite(Number(y))) {
                return { x: Number(x), y: Number(y) };
            }
        }
        return null;
    }

    function pickerHover(event) {
        if (!pickerActive) return;
        var at = cursorPoint() || pickerEventPoint(event);
        if (!at) {
            if (pickerBadgeLabel) pickerBadgeLabel.text = "pointer API unavailable on this build";
            return;
        }

        var best = null;
        var bestArea = 0;
        for (var i = 0; i < hudStreamNodes.length; i++) {
            var entry = hudStreamNodes[i];
            if (!entry || !entry.panel || !alive(entry.panel)) continue;
            if (at.x < entry.x || at.y < entry.y || at.x > entry.x + entry.w || at.y > entry.y + entry.h) continue;
            var area = entry.w * entry.h;
            if (!best || area < bestArea) {
                best = entry;
                bestArea = area;
            }
        }

        pickerTarget = best;
        pickerPaintTarget();
        if (pickerBadgeLabel) {
            pickerBadgeLabel.text = best
                ? "PICK  " + pickerName(best) + "  ·  " + Math.round(best.w) + "×" + Math.round(best.h) +
                    "  ·  click to select"
                : "PICK  no element under the pointer";
        }
    }

    function stopPicker(quiet) {
        if (!pickerActive) return;
        pickerActive = false;
        if (pickerOverlay) {
            try { pickerOverlay.DeleteAsync(0); } catch (e) {}
            pickerOverlay = null;
        }
        if (pickerHighlight) {
            try { pickerHighlight.DeleteAsync(0); } catch (e) {}
            pickerHighlight = null;
        }
        pickerBadge = null;
        pickerBadgeLabel = null;
        freeCursor(false);
        if (!quiet) {
            globalThis.OpenlockToast("Picker", "scrub ended", "", false);
            logPerf("info", "picker stopped");
        }
    }

    function pickerCapture(entry) {
        if (!entry || !entry.panel || !alive(entry.panel)) {
            refuseFeature("Picker refused", "the selected panel is no longer on screen");
            return false;
        }
        var p = entry.panel;
        pickerTarget = entry;
        pickerOffset = { x: 0, y: 0 };
        pickerOriginal = {
            transform: p.style.transform || "",
            width: p.style.width || "",
            height: p.style.height || "",
            opacity: p.style.opacity || "",
            backgroundColor: p.style.backgroundColor || "",
            borderColor: p.style.borderColor || "",
            color: p.style.color || "",
            borderRadius: p.style.borderRadius || "",
            visibility: p.style.visibility || ""
        };
        uiSelected = entry.id || entry.cls || "";
        uiCss.selector = entry.cls ? "." + String(entry.cls).split(" ")[0] : "#" + (entry.id || "");
        return true;
    }

    function pickerCommit() {
        if (!pickerActive) return;
        if (!pickerTarget || !pickerTarget.panel) {
            globalThis.OpenlockToast("Picker", "no element under the pointer; move over the HUD and click", "", true);
            return;
        }
        var name = pickerName(pickerTarget);
        if (!pickerCapture(pickerTarget)) return;
        stopPicker(true);
        send("pick", name);
        logPerf("info", "picker selected " + name);
        cue("place");
        globalThis.OpenlockToast("Picked", name + "  ·  edit it in the Picker window", "picker", false);
        openWindow("picker", true);
    }

    function pickerApply(property, raw) {
        var p = pickerAtCursor();
        if (!p) {
            refuseFeature("Picker edit refused", "no live panel is selected");
            return false;
        }
        var value = String(raw === undefined ? "" : raw).trim();
        if (property === "x" || property === "y") {
            var n = parseInt(value, 10);
            if (!isFinite(n)) n = 0;
            pickerOffset[property] = n;
            var base = pickerOriginal ? pickerOriginal.transform : "";
            try {
                p.style.transform = "translate3d(" + pickerOffset.x + "px," + pickerOffset.y + "px,0)" +
                    (base ? " " + base : "");
            } catch (e) {}
        } else if (property === "width" || property === "height") {
            var size = parseInt(value, 10);
            if (!isFinite(size) || size < 1) {
                refuseFeature("Picker edit refused", property + " needs a positive pixel value");
                return false;
            }
            try { p.style[property] = size + "px"; } catch (e) {}
        } else if (property === "opacity") {
            var op = Number(value);
            if (!isFinite(op) || op < 0 || op > 1) {
                refuseFeature("Picker edit refused", "opacity is 0..1");
                return false;
            }
            try { p.style.opacity = String(op); } catch (e) {}
        } else if (property === "visibility") {
            try { p.style.visibility = value === "hidden" ? "collapse" : "visible"; } catch (e) {}
        } else if (property === "background-color") {
            try { p.style.backgroundColor = value; } catch (e) {}
        } else if (property === "border-color") {
            try { p.style.borderColor = value; } catch (e) {}
        } else if (property === "color") {
            try { p.style.color = value; } catch (e) {}
        } else if (property === "border-radius") {
            try { p.style.borderRadius = value; } catch (e) {}
        } else {
            refuseFeature("Picker edit refused", property + " is not an editable field");
            return false;
        }
        logPerf("info", "picker edit " + pickerName(pickerTarget) + " " + property + "=" + value);
        return true;
    }

    function pickerRestore() {
        var p = pickerAtCursor();
        if (!p || !pickerOriginal) return;
        try {
            p.style.transform = pickerOriginal.transform;
            p.style.width = pickerOriginal.width;
            p.style.height = pickerOriginal.height;
            p.style.opacity = pickerOriginal.opacity;
            p.style.backgroundColor = pickerOriginal.backgroundColor;
            p.style.borderColor = pickerOriginal.borderColor;
            p.style.color = pickerOriginal.color;
            p.style.borderRadius = pickerOriginal.borderRadius;
            p.style.visibility = pickerOriginal.visibility;
        } catch (e) {}
        pickerOffset = { x: 0, y: 0 };
        logPerf("info", "picker restored " + pickerName(pickerTarget));
        globalThis.OpenlockToast("Picker", "selected panel restored", "", false);
    }

    function pickerValue(property) {
        var p = pickerAtCursor();
        if (!p) return "";
        if (property === "x") return String(pickerOffset.x);
        if (property === "y") return String(pickerOffset.y);
        if (property === "width") return String(Math.round(num(p.actuallayoutwidth)));
        if (property === "height") return String(Math.round(num(p.actuallayoutheight)));
        if (property === "opacity") return String(p.style.opacity || "");
        if (property === "background-color") return String(p.style.backgroundColor || "");
        if (property === "border-color") return String(p.style.borderColor || "");
        if (property === "color") return String(p.style.color || "");
        if (property === "border-radius") return String(p.style.borderRadius || "");
        return "";
    }

    function startPicker() {
        if (pickerActive) return;
        if (!windowById("picker")) {
            refuseFeature("Picker refused", "this package declares no picker window");
            return;
        }

        pickerActive = true;
        hideDwell();
        closePopit();
        freeCursor(true);
        if (!hudStreamNodes.length || hudStreamActive) {
            streamHudPanels(function () { pickerHover(); });
        }

        pickerOverlay = $.CreatePanel("Panel", root, "OpenlockPicker");
        pickerOverlay.AddClass("PickerOverlay");
        pickerOverlay.hittest = true;
        pickerOverlay.SetPanelEvent("onmousemove", pickerHover);
        pickerOverlay.SetPanelEvent("onmouseactivate", pickerCommit);
        pickerOverlay.SetPanelEvent("oncontextmenu", function () { stopPicker(false); });

        pickerHighlight = $.CreatePanel("Panel", root, "OpenlockPickerHighlight");
        pickerHighlight.AddClass("PickerHighlight");
        pickerHighlight.hittest = false;
        pickerHighlight.hittestchildren = false;
        pickerHighlight.style.visibility = "collapse";

        pickerBadge = $.CreatePanel("Panel", pickerOverlay, "");
        pickerBadge.AddClass("PickerBadge");
        pickerBadgeLabel = $.CreatePanel("Label", pickerBadge, "");
        pickerBadgeLabel.AddClass("PickerBadgeLabel");
        pickerBadgeLabel.text = "PICK  move over a Deadlock element";
        var cancel = $.CreatePanel("Panel", pickerBadge, "");
        cancel.AddClass("PickerCancel");
        cancel.SetPanelEvent("onmouseactivate", function () { stopPicker(false); });
        var cancelLabel = $.CreatePanel("Label", cancel, "");
        cancelLabel.text = "Cancel scrub";
        cancelLabel.hittest = false;

        logPerf("info", "picker started");
        cue("select");
        globalThis.OpenlockToast("Picker", "Move over a HUD element and click. Right-click or Cancel stops.", "", false);
    }

    function windowForPanel(panel) {
        var p = panel;
        for (var depth = 0; p && depth < 6; depth++) {
            for (var id in bound) {
                if (!bound.hasOwnProperty(id) || !bound[id]) continue;
                if (bound[id].panel === p) return windowById(id);
            }
            try { p = p.GetParent(); } catch (e) { break; }
        }
        return null;
    }

    function renderPicker(body, win) {
        headingXd(body, "scrub the live panorama");
        rowXd(body, "The picker reads the panels the HUD actually built, not the package's catalog. " +
            "The overlay owns the pointer only while scrubbing, so a click cannot leak into the game.", "ViewMuted");
        actionXd(body, pickerActive ? "Scrubbing…" : "Start scrub", function () { startPicker(); });

        if (pickerTarget) {
            var p = pickerAtCursor();
            headingXd(body, "selected  ·  " + pickerName(pickerTarget));
            rowXd(body, (pickerTarget.id || "(no id)") + "  ·  " + (pickerTarget.cls || "(no class)") +
                "  ·  " + Math.round(pickerTarget.w) + "×" + Math.round(pickerTarget.h), "PickerTarget");
            if (!p) {
                rowXd(body, "the panel is no longer alive; start a new scrub", "ViewMuted");
            } else {
                rowXd(body, "x / y use a transform offset; width, height, opacity, colours and radius " +
                    "write that one panel's style. Restore puts the captured values back.", "PickerHint");
                uiField(body, "x offset", pickerValue("x"), function (v) { pickerApply("x", v); });
                uiField(body, "y offset", pickerValue("y"), function (v) { pickerApply("y", v); });
                uiField(body, "width", pickerValue("width"), function (v) { pickerApply("width", v); });
                uiField(body, "height", pickerValue("height"), function (v) { pickerApply("height", v); });
                uiField(body, "opacity 0..1", pickerValue("opacity"), function (v) { pickerApply("opacity", v); });
                uiField(body, "background-color", pickerValue("background-color"), function (v) { pickerApply("background-color", v); });
                uiField(body, "border-color", pickerValue("border-color"), function (v) { pickerApply("border-color", v); });
                uiField(body, "color", pickerValue("color"), function (v) { pickerApply("color", v); });
                uiField(body, "border-radius", pickerValue("border-radius"), function (v) { pickerApply("border-radius", v); });
                var isThemed = isThemedPanel(p);
                actionXd(body, isThemed
                    ? "Stop theming this element"
                    : "Theme this element with " + currentScheme + " / " + currentForm,
                    function () {
                        togglePanelTheme(p, pickerName(pickerTarget));
                        renderOwn(win, body);
                    });
                if (isThemed) {
                    rowXd(body, "themed inline; the active palette and form still own its colour and radius",
                        "PaletteNote");
                }
                var owner = windowForPanel(p);
                if (owner && !(splitCells[owner.id] && splitCells[owner.id].length) && isPanelWindow(owner)) {
                    actionXd(body, "Split " + (owner.title || owner.id) + " into cells", function () {
                        splitWindow(owner);
                        renderOwn(win, body);
                    });
                } else if (owner && splitCells[owner.id]) {
                    rowXd(body, (owner.title || owner.id) + " is split into " +
                        splitCells[owner.id].length + " cell(s)", "ViewMuted");
                }
                actionXd(body, "Hide selected panel", function () { pickerApply("visibility", "hidden"); });
                actionXd(body, "Show selected panel", function () { pickerApply("visibility", "visible"); });
                actionXd(body, "Restore selected panel", function () { pickerRestore(); });
                actionXd(body, "Rescrub", function () { startPicker(); });
                actionXd(body, "Inspect in UI tree", function () {
                    uiSelected = pickerTarget.id || pickerTarget.cls || "";
                    openWindow("uitree");
                });
            }
        } else {
            rowXd(body, "No element selected. Start a scrub, then click a HUD element.", "ViewMuted");
        }
    }

    // --- performance surface -------------------------------------------------
    // One window that measures the shell itself. The graph is the same `frameMs` reading the
    // title bars use, sampled every second while the shell is open; the log is the bounded ring
    // that every refusal, live package and Popit action writes to. Nothing here is a spinner or
    // a guessed number: an unavailable reading says so.
    var perfRenderToken = 0;

    function perfGraph(parent, values) {
        var graph = $.CreatePanel("Panel", parent, "");
        graph.AddClass("PerfGraph");
        var ceiling = 24;
        for (var c = 0; c < values.length; c++) ceiling = Math.max(ceiling, values[c]);
        ceiling = Math.ceil(ceiling / 8) * 8;
        if (!values.length) {
            var empty = $.CreatePanel("Label", graph, "");
            empty.AddClass("PerfMuted");
            empty.text = "no samples yet; open a window or move the shell";
            return graph;
        }
        for (var i = 0; i < values.length; i++) {
            var bar = $.CreatePanel("Panel", graph, "");
            bar.AddClass("PerfBar");
            if (values[i] > 24) bar.AddClass("Slow");
            bar.style.height = Math.max(2, Math.round((values[i] / ceiling) * 46)) + "px";
        }
        return graph;
    }

    function perfCostRows() {
        var rows = [];
        for (var id in perf.cost) {
            if (!perf.cost.hasOwnProperty(id)) continue;
            var c = perf.cost[id];
            if (!c.samples) continue;
            rows.push({ id: id, mean: c.total / c.samples, max: c.max || 0, samples: c.samples });
        }
        rows.sort(function (a, b) { return b.mean - a.mean; });
        return rows;
    }

    function renderPerf(body, win) {
        var samples = perf.samples || [];
        headingXd(body, "ui frame interval  ·  one bar per second");
        perfGraph(body, samples);
        var last = samples.length ? samples[samples.length - 1] : 0;
        var sum = 0, peak = 0;
        for (var s = 0; s < samples.length; s++) {
            sum += samples[s];
            peak = Math.max(peak, samples[s]);
        }
        var mean = samples.length ? (sum / samples.length) : 0;
        rowXd(body, "last " + (last ? last.toFixed(1) : "--") + " ms  ·  mean " +
            (mean ? mean.toFixed(1) : "--") + " ms  ·  peak " + (peak ? peak.toFixed(1) : "--") +
            " ms  ·  " + samples.length + " sample(s)", "PerfValue");
        if (frameMs) rowXd(body, "title-bar reading " + frameMs.toFixed(1) + " ms  ·  clock " +
            (clockIsPrecise ? "performance.now" : "Date.now (1 ms)"), "PerfMuted");

        headingXd(body, "counters");
        rowXd(body, "polls " + perf.polls + "  ·  applies " + perf.applies + "  ·  scans " +
            perf.scans + "  ·  full scans " + perf.fullScans, "PerfValue");
        rowXd(body, "style writes " + perf.writes + "  ·  skipped writes " + perf.skips +
            "  ·  frames " + Object.keys(frames).length + "  ·  shell " + (expanded ? "open" : "closed"), "PerfMuted");

        headingXd(body, "per-window apply cost");
        var costs = perfCostRows();
        if (!costs.length) {
            rowXd(body, "no measurement yet; the next window apply records one", "PerfMuted");
        }
        for (var c = 0; c < costs.length && c < 14; c++) {
            (function (row) {
                var label = "mean " + row.mean.toFixed(2) + " ms  ·  max " + row.max.toFixed(2) +
                    " ms  ·  " + row.samples + " sample(s)";
                if (windowById(row.id)) {
                    actionXd(body, windowById(row.id).title + "  ·  " + row.id + "  ·  " + label,
                        function () { openWindow(row.id); });
                } else {
                    rowXd(body, row.id + "  ·  " + label, "PerfMuted");
                }
            })(costs[c]);
        }

        headingXd(body, "log  ·  " + perf.log.length + " / 64");
        if (!perf.log.length) {
            rowXd(body, "the ring is empty; refusals, live packages and slow applies land here", "PerfMuted");
        }
        var start = Math.max(0, perf.log.length - 12);
        for (var l = perf.log.length - 1; l >= start; l--) {
            var entry = perf.log[l];
            var age = Math.max(0, Math.round((Date.now() - entry.at) / 1000));
            rowXd(body, "[" + age + "s] " + entry.kind + "  " + entry.text, "PerfLogRow");
        }
        actionXd(body, "Clear log", function () {
            perf.log.length = 0;
            renderOwn(win, body);
        });

        // One refresh in flight, and only while this window is the visible one. The token is
        // what stops a closed window from re-scheduling itself forever.
        var token = ++perfRenderToken;
        $.Schedule(1.0, function () {
            if (token !== perfRenderToken) return;
            var f = frames[win.id];
            if (!f || !open[win.id] || activeId !== win.id || !f.body) return;
            renderOwn(win, f.body);
        });
    }

    function renderPalette(body, win) {
        var scheme = schemeById(currentScheme) || schemeById(themes.default);
        headingXd(body, "palette  ·  " + (scheme ? scheme.label : "no scheme"));
        if (!scheme) {
            rowXd(body, "No scheme data in this build.", "ViewMuted");
            return;
        }

        var form = formById(currentForm);
        var renderer = rendererFor(form);
        rowXd(body, "palette " + scheme.id + "  ·  shape " + (form ? form.label : "none") +
            "  ·  " + renderer + " renderer" +
            (form && form.renderer === "popit" && renderer !== "popit" ? " (port absent; generic fallback)" : ""),
            "ViewMuted");
        rowXd(body, "Each row is one slot from this scheme's .theme schema. Click a row to cycle " +
            "its colour; the game and every shell surface follow.", "PaletteNote");

        var slots = scheme.palette || [];
        for (var i = 0; i < slots.length; i++) {
            (function (entry) {
                var value = paletteValue(scheme, entry.slot);
                var row = $.CreatePanel("Panel", body, "");
                row.AddClass("PaletteRow");
                row.hittest = true;
                var swatch = $.CreatePanel("Panel", row, "");
                swatch.AddClass("PaletteSwatch");
                swatch.hittest = false;
                swatch.style.backgroundColor = value;
                var name = $.CreatePanel("Label", row, "");
                name.AddClass("PaletteName");
                name.text = entry.label + "  ·  " + entry.slot;
                name.hittest = false;
                var hex = $.CreatePanel("Label", row, "");
                hex.AddClass("PaletteValue");
                hex.text = value;
                hex.hittest = false;
                bindDwell(row, entry.label, "Cycle the " + entry.slot + " slot. " +
                    "The current value is " + value + ".", win.id);
                row.SetPanelEvent("onmouseactivate", function () {
                    cyclePalette(scheme, entry);
                    renderOwn(win, body);
                });
            })(slots[i]);
        }

        actionXd(body, "Reset palette to schema", function () {
            resetPalette(scheme);
            renderOwn(win, body);
        });

        headingXd(body, "layout  ·  " + scheme.id);
        rowXd(body, "A layout is the whole arrangement: the taskbar tab, every open window, the " +
            "split cells, and which windows are pinned, minimized or focused. It loads automatically " +
            "when this palette is active.", "PaletteNote");
        var profile = layoutProfiles[scheme.id];
        var profileRows = profile && profile.windows ? profile.windows : profile;
        var rows = 0;
        if (profileRows) for (var pid in profileRows) if (profileRows.hasOwnProperty(pid)) rows++;
        rowXd(body, profile ? "saved: " + rows + " window(s) · " +
            ((profile.pinned && profile.pinned.length) || 0) + " pinned · " +
            ((profile.minimized && profile.minimized.length) || 0) + " minimized"
            : "no saved layout for this scheme", "ViewMuted");
        rowXd(body, profile ? "auto-load: on · applied at shell start" : "auto-load: waiting for the first save",
            "ViewMuted");
        actionXd(body, "Save current layout to file", function () { saveLayoutNow(false); });
        actionXd(body, "Load saved layout", function () {
            send("layout-load", scheme.id);
            applyLayoutProfile(scheme.id, true);
            renderOwn(win, body);
        });
        actionXd(body, "Export saved layout as a file", function () {
            send("layout-export", scheme.id);
            globalThis.OpenlockToast("Layout export",
                "Writing " + scheme.id + " under layouts/exports; the path follows in the next host update.",
                "", false);
        });
        actionXd(body, "Reset saved layout", function () {
            send("layout-reset", scheme.id);
            delete layoutProfiles[scheme.id];
            popitLayout = defaultPopitLayout();
            layoutLoadedFor = "";
            layoutExportPath = "";
            globalThis.OpenlockToast("Layout reset", scheme.id + " profile removed; package defaults remain.", "", false);
            renderOwn(win, body);
        });
        if (layoutExportPath) rowXd(body, "exported: " + layoutExportPath, "PaletteValue");
        if (layoutNotices.length) {
            for (var ln = 0; ln < layoutNotices.length && ln < 4; ln++) rowXd(body, layoutNotices[ln], "ViewMuted");
        }

        headingXd(body, "live-panel skin  ·  experimental");
        rowXd(body, "Deadlock owns these elements' styles. A skin writes this scheme's roles inline " +
            "on the actual panel, which overrides the game for that window only. Turning it off restores " +
            "the captured values.", "PaletteNote");
        var panelWindows = 0;
        for (var w = 0; w < data.windows.length; w++) {
            (function (pw) {
                if (!isPanelWindow(pw)) return;
                var b = bound[pw.id];
                if (!b || !b.panel || !alive(b.panel)) return;
                panelWindows++;
                var on = !!(liveSkin[pw.id] && liveSkin[pw.id].on);
                actionXd(body, (on ? "● " : "○ ") + "Skin " + (pw.title || pw.id) + "  ·  " +
                    (pw.panelCandidates[0].name || pw.panelCandidates[0].kind), function () {
                    toggleLiveSkin(pw);
                    renderOwn(win, body);
                });
            })(data.windows[w]);
        }
        if (!panelWindows) {
            rowXd(body, "No framed game panel is on screen. Open one from the Windows browser, or " +
                "right-click any panel window and choose Theme live panel.", "ViewMuted");
        }

        headingXd(body, "schema  ·  " + scheme.id + ".theme");
        var themeLines = importThemeText(scheme).split("\n");
        for (var t = 0; t < themeLines.length; t++) rowXd(body, themeLines[t], "PaletteValue");
        actionXd(body, "Export .theme to console", function () {
            $.Msg("[Openlock] exported theme ", scheme.id, "\n" + importThemeText(scheme));
            logPerf("info", "theme exported: " + scheme.id);
            globalThis.OpenlockToast("Theme exported", "The complete .theme document is in the client console.", "", false);
        });
    }

    // --- shell dashboard -----------------------------------------------------
    // The release game's dashboard is behind the pause menu, so the shell ships its own. The
    // layout is planet-shploingus's shell (f:/planet-shploingus): one window with a 34 dp title,
    // a 1 px seam, a 160 dp left rail of 48 dp destinations and a 32 dp status strip. Destinations
    // are apps inside this window, never extra windows.
    var DASH_DESTINATIONS = [
        { id: "menu", label: "MENU", hint: "the shell's surfaces" },
        { id: "layout", label: "LAYOUT", hint: "declared package, cells, contents and the dp grid" },
        { id: "xml", label: "XML", hint: "a game layout opened outside its window" },
        { id: "popit", label: "POPIT", hint: "the Popit surface's arrangement" },
        { id: "build", label: "BUILD", hint: "game panels, build and update" }
    ];
    var dashDest = "layout";
    var dashSelected = "";
    var dashGrid = 8;
    var dashSnap = true;

    function dashboardEntries() {
        var wanted = [
            { id: "windows", title: "All windows", win: WINDOWS_ID },
            { id: "uitree", title: "UI tree and layout", win: "uitree" },
            { id: "picker", title: "Pick a live element", win: "picker" },
            { id: "palette", title: "Theme palette", win: "palette" },
            { id: "settings", title: "Settings", win: "settings" },
            { id: "updates", title: "Updates", win: "updates" },
            { id: "refusals", title: "Refusals", win: "refusals" },
            { id: "performance", title: "Performance", win: "performance" },
            { id: "console", title: "Console", win: "console" }
        ];
        var out = [];
        for (var i = 0; i < wanted.length; i++) {
            if (wanted[i].win !== WINDOWS_ID && !windowById(wanted[i].win)) continue;
            out.push(wanted[i]);
        }
        return out;
    }

    function dashboardPopitActions() {
        var entries = dashboardEntries();
        var actions = [];
        for (var i = 0; i < entries.length; i++) {
            actions.push({ id: entries[i].id, label: entries[i].title, window: entries[i].win });
        }
        return actions;
    }

    // Presence is read from the live panel tree, never from the package: a declared window exists
    // when the game is drawing its panel, and on the dashboard none of them are.
    function panelOnScreen(win) {
        if (!isPanelWindow(win)) return false;
        var b = bound[win.id];
        if (!b || !b.panel) return false;
        return alive(b.panel) && panelVisible(b.panel);
    }

    function presenceReading() {
        var declared = 0, live = 0, absent = [];
        for (var i = 0; i < data.windows.length; i++) {
            var win = data.windows[i];
            if (!isPanelWindow(win)) continue;
            declared++;
            if (panelOnScreen(win)) live++;
            else if (absent.length < 6) absent.push(win.title || win.id);
        }
        return { declared: declared, live: live, absent: absent };
    }

    function refreshDashboard() {
        var f = frames[DASHBOARD_ID];
        if (f) renderOwn(f.win || DASHBOARD_VIEW, f.body);
    }

    function popitLayoutNow() {
        if (globalThis.OpenlockPopit) popitLayout = globalThis.OpenlockPopit.normalizeLayout(popitLayout);
        return popitLayout;
    }

    // One edit path: clamp through the module, repaint the editor, and re-place the open surface
    // so the player sees the arrangement they are editing instead of a stale menu.
    function setPopitLayout(patch) {
        var next = {
            columns: popitLayout.columns, width: popitLayout.width, frame: popitLayout.frame,
            mode: popitLayout.mode, order: popitLayout.order.slice(0)
        };
        for (var key in patch) if (patch.hasOwnProperty(key)) next[key] = patch[key];
        popitLayout = globalThis.OpenlockPopit
            ? globalThis.OpenlockPopit.normalizeLayout(next)
            : next;
        refreshDashboard();
        var st = globalThis.OpenlockPopit ? globalThis.OpenlockPopit.status() : null;
        if (st && st.visible) showDashboardPopit();
    }

    function movePopitTile(id, delta) {
        var actions = dashboardPopitActions();
        var order = popitLayout.order.slice(0);
        // The first move starts from what is on screen, so a fresh profile reorders in place
        // instead of jumping to a list that has only the tile the player pressed.
        for (var i = 0; i < actions.length; i++) {
            if (order.indexOf(actions[i].id) < 0) order.push(actions[i].id);
        }
        var at = order.indexOf(id);
        var to = at + delta;
        if (at < 0 || to < 0 || to >= order.length) return;
        order[at] = order[to];
        order[to] = id;
        setPopitLayout({ order: order });
    }

    function showDashboardPopit() {
        closePopit();
        if (!globalThis.OpenlockPopit || typeof globalThis.OpenlockPopit.show !== "function") {
            refuseFeature("Popit refused", "the surface module is not in this build");
            return;
        }
        var win = DASHBOARD_VIEW;
        var g = ensureGeometry(win);
        measureScreen();
        var openRects = [];
        for (var id in open) {
            if (!open.hasOwnProperty(id) || id === win.id || minimized[id]) continue;
            var other = geometry[id];
            if (!other) continue;
            openRects.push({
                id: id,
                title: (windowById(id) || {}).title || id,
                x: other.x, y: other.y, w: other.w, h: other.h
            });
        }
        var actions = dashboardPopitActions();
        cue("select");
        var result = globalThis.OpenlockPopit.show({
            root: root,
            window: { id: win.id, title: win.title },
            geometry: { x: g.x, y: g.y, w: g.w, h: g.h },
            screen: { w: screenW, h: screenH, top: SHELL_TOP_DP },
            openRects: openRects,
            form: currentForm,
            layout: popitLayoutNow(),
            layer: {
                title: "Openlock",
                hint: "The shell's own menu. Its arrangement is saved with this scheme.",
                actions: actions
            },
            actions: actions,
            onAction: function (action) {
                closePopit();
                if (action.window) openWindow(action.window);
                else cue("place");
            },
            onRefusal: function (title, why) { refuseFeature(title, why); },
            onHover: function (panel, label, body) {
                try { dwellAt(label, body, panel); } catch (e) {}
                try { enterFrame(win.id, "dwell"); } catch (e) {}
            },
            onHoverEnd: function () {
                hideDwell();
                try { leaveFrame(win.id, "dwell"); } catch (e) {}
            }
        });
        if (result && result.ok) {
            popitLayout = result.layout;
            logPerf("info", "dashboard popit: " + result.layout.columns + " column(s), " +
                result.layout.width + " px, " + result.tiles + " tile(s)");
            refreshDashboard();
        }
    }

    // --- the app shell (planet-shploingus' window model) ---------------------
    // Title 34 dp, seam 1 px, rail 160 dp, slot 48 dp, status 32 dp. These are the same metrics
    // docs/SHELL.md fixes, so a dashboard and a planet shell window read as one system.
    function dashRail(body, active) {
        var rail = $.CreatePanel("Panel", body, "");
        rail.AddClass("DashRail");
        for (var i = 0; i < DASH_DESTINATIONS.length; i++) {
            (function (dest) {
                var slot = $.CreatePanel("Panel", rail, "");
                slot.AddClass("DashRailSlot");
                if (dest.id === active) slot.AddClass("Active");
                slot.hittest = true;
                slot.SetPanelEvent("onmouseactivate", function () {
                    dashDest = dest.id;
                    refreshDashboard();
                    cue("select");
                });
                var mark = $.CreatePanel("Label", slot, "");
                mark.AddClass("DashRailMark");
                mark.text = dest.label.charAt(0);
                mark.hittest = false;
                var label = $.CreatePanel("Label", slot, "");
                label.AddClass("DashRailLabel");
                label.text = dest.label;
                label.hittest = false;
            })(DASH_DESTINATIONS[i]);
        }
        return rail;
    }

    function dashHeader(body, reading) {
        var header = $.CreatePanel("Panel", body, "");
        header.AddClass("DashHeader");
        var title = $.CreatePanel("Label", header, "");
        title.AddClass("DashTitle");
        title.text = "Openlock";
        title.hittest = false;
        var sub = $.CreatePanel("Label", header, "");
        sub.AddClass("DashSubtitle");
        sub.text = "shell dashboard  ·  " + reading.live + "/" + reading.declared + " game panels on screen";
        sub.hittest = false;
        var seam = $.CreatePanel("Panel", body, "");
        seam.AddClass("DashSeam");
        seam.hittest = false;
        return header;
    }

    function dashStatus(body, reading) {
        var status = $.CreatePanel("Panel", body, "");
        status.AddClass("DashStatus");
        var parts = [
            presencePart(reading),
            "grid " + dashGrid + " dp",
            dashSnap ? "snap on" : "snap off",
            dashDest
        ];
        for (var i = 0; i < parts.length; i++) {
            var part = $.CreatePanel("Label", status, "");
            part.AddClass("DashStatusLabel");
            part.text = parts[i];
            part.hittest = false;
        }
        return status;
    }

    function presencePart(reading) {
        return reading.live + "/" + reading.declared + " panels";
    }

    // --- LAYOUT: each window's declaration, cells and contents ---------------
    function dashWindowList() {
        var out = [];
        for (var i = 0; i < data.windows.length; i++) out.push(data.windows[i]);
        return out;
    }

    function dashSelectedWindow() {
        var win = dashSelected ? windowById(dashSelected) : null;
        if (!win) {
            var list = dashWindowList();
            win = null;
            for (var i = 0; i < list.length && !win; i++) if (isPanelWindow(list[i])) win = list[i];
            if (!win && list.length) win = list[0];
            dashSelected = win ? win.id : "";
        }
        return win;
    }

    function dashCellsOf(win, g) {
        var out = [];
        var split = splitCells[win.id] || [];
        if (split.length) {
            for (var i = 0; i < split.length; i++) {
                var cell = split[i];
                var cg = geometry[cell.id] || {};
                out.push({
                    id: cell.id,
                    label: cell.label || cell.key || cell.id,
                    contents: cell.label || cell.key || "cell",
                    x: num(cg.x), y: num(cg.y), w: num(cg.w), h: num(cg.h)
                });
            }
            return out;
        }
        out.push({
            id: win.id,
            label: win.title || win.id,
            contents: win.content || (isPanelWindow(win) ? "live panel" : "shell content"),
            x: num(g.x), y: num(g.y), w: num(g.w), h: num(g.h)
        });
        return out;
    }

    // One dp is one pixel at 100% zoom, so the canvas is a cropped viewport, not a scaled map:
    // the grid keeps its dp step and the window's rectangle keeps its real size.
    var DASH_CANVAS_W = 320;
    var DASH_CANVAS_H = 224;

    function dashGridCanvas(body, win, g, cells) {
        var canvas = $.CreatePanel("Panel", body, "");
        canvas.AddClass("DashCanvas");
        canvas.hittest = false;

        var originX = Math.max(0, Math.floor(g.x / dashGrid) * dashGrid - dashGrid);
        var originY = Math.max(0, Math.floor(g.y / dashGrid) * dashGrid - dashGrid);

        for (var x = 0; x <= DASH_CANVAS_W; x += dashGrid) {
            var v = $.CreatePanel("Panel", canvas, "");
            v.AddClass("DashGridLine");
            v.AddClass("Vertical");
            v.style.marginLeft = x + "px";
            v.hittest = false;
        }
        for (var y = 0; y <= DASH_CANVAS_H; y += dashGrid) {
            var h = $.CreatePanel("Panel", canvas, "");
            h.AddClass("DashGridLine");
            h.AddClass("Horizontal");
            h.style.marginTop = y + "px";
            h.hittest = false;
        }

        var rect = $.CreatePanel("Panel", canvas, "");
        rect.AddClass("DashWindowRect");
        rect.style.marginLeft = Math.round(g.x - originX) + "px";
        rect.style.marginTop = Math.round(g.y - originY) + "px";
        rect.style.width = Math.max(2, Math.min(DASH_CANVAS_W, g.w)) + "px";
        rect.style.height = Math.max(2, Math.min(DASH_CANVAS_H, g.h)) + "px";
        rect.hittest = false;

        for (var c = 0; c < cells.length; c++) {
            var cell = cells[c];
            var box = $.CreatePanel("Panel", canvas, "");
            box.AddClass("DashCell");
            box.style.marginLeft = Math.round(cell.x - originX) + "px";
            box.style.marginTop = Math.round(cell.y - originY) + "px";
            box.style.width = Math.max(2, Math.min(DASH_CANVAS_W, cell.w)) + "px";
            box.style.height = Math.max(2, Math.min(DASH_CANVAS_H, cell.h)) + "px";
            box.hittest = false;
            if (cell.w >= 40 && cell.h >= 14) {
                var label = $.CreatePanel("Label", box, "");
                label.AddClass("DashCellLabel");
                label.text = cell.label;
                label.hittest = false;
            }
        }
        return canvas;
    }

    function nudgeSelected(dx, dy, dw, dh) {
        var win = dashSelectedWindow();
        if (!win) return;
        var g = ensureGeometry(win);
        g.x = clamp(g.x + dx, 0, Math.max(0, screenW - 160));
        g.y = clamp(g.y + dy, SHELL_TOP_DP, Math.max(SHELL_TOP_DP, screenH - 80));
        g.w = clamp(g.w + dw, num(win.minWidth) || 160, screenW);
        if (!isPanelWindow(win)) g.h = clamp(g.h + dh, num(win.minHeight) || 120, screenH);
        g.init = true;
        g.userSet = true;
        applyWindow(win);
        refreshDashboard();
    }

    function renderDashLayout(body) {
        var win = dashSelectedWindow();
        if (!win) {
            rowXd(body, "the package declares no window to lay out", "ViewMuted");
            return;
        }
        var g = ensureGeometry(win);
        var cells = dashCellsOf(win, g);

        headingXd(body, "declared windows  ·  " + dashWindowList().length);
        for (var i = 0; i < data.windows.length; i++) {
            (function (entry) {
                var active = entry.id === win.id;
                actionXd(body, (active ? "●  " : "○  ") + entry.title + "  ·  " + entry.id, function () {
                    dashSelected = entry.id;
                    refreshDashboard();
                });
            })(data.windows[i]);
        }

        headingXd(body, "declared package  ·  " + win.id);
        rowXd(body, "title " + (win.title || "—") + "  ·  lane " + (win.lane || "—") +
            "  ·  extent " + (win.extent || "—"), "PaletteValue");
        rowXd(body, "content " + (win.content || "—") + "  ·  role " + (win["theme-role"] || "—") +
            "  ·  scale " + (win.scale === undefined ? "—" : win.scale + "%"), "ViewMuted");
        var candidates = win.panelCandidates || [];
        var panelText = [];
        for (var c = 0; c < candidates.length; c++) {
            panelText.push((candidates[c].name || candidates[c].kind) + " (" + candidates[c].kind + ")");
        }
        rowXd(body, "panel " + (panelText.length ? panelText.join(", ") : "drawn by the shell"), "ViewMuted");
        rowXd(body, "geometry " + Math.round(g.x) + "," + Math.round(g.y) + "  ·  " +
            Math.round(g.w) + "×" + Math.round(g.h) + " dp", "ViewMuted");
        rowXd(body, "presence " + (panelOnScreen(win) ? "on screen" : "not on screen") +
            (isPanelWindow(win) ? "" : "  ·  no game panel to watch"), "ViewMuted");

        headingXd(body, "visual cells  ·  " + cells.length);
        for (var v = 0; v < cells.length; v++) {
            rowXd(body, (v + 1) + "  " + cells[v].label + "  ·  " + cells[v].id, "ViewMuted");
            rowXd(body, "    contents " + cells[v].contents + "  ·  " +
                Math.round(cells[v].w) + "×" + Math.round(cells[v].h) + " dp at " +
                Math.round(cells[v].x) + "," + Math.round(cells[v].y), "ViewMuted");
        }
        rowXd(body, splitCells[win.id] && splitCells[win.id].length
            ? "Cells are this window's split components; each is framed, themed and saved on its own."
            : "One cell: this window has no split components, so its whole panel is the content.",
            "PaletteNote");

        headingXd(body, "dp pixel grid  ·  " + dashGrid + " dp");
        dashGridCanvas(body, win, g, cells);
        rowXd(body, "1 dp is 1 pixel at 100%; the canvas is a cropped viewport at the window's " +
            "corner, so a grid square is exactly " + dashGrid + " dp.", "PaletteNote");
        var steps = [8, 16, 32];
        for (var s = 0; s < steps.length; s++) {
            (function (step) {
                actionXd(body, step + " dp" + (dashGrid === step ? "  ·  active" : ""), function () {
                    dashGrid = step;
                    refreshDashboard();
                });
            })(steps[s]);
        }
        actionXd(body, dashSnap ? "Snap while dragging  ·  on" : "Snap while dragging  ·  off", function () {
            dashSnap = !dashSnap;
            refreshDashboard();
        });
        actionXd(body, "← " + dashGrid + " dp", function () { nudgeSelected(-dashGrid, 0, 0, 0); });
        actionXd(body, "→ " + dashGrid + " dp", function () { nudgeSelected(dashGrid, 0, 0, 0); });
        actionXd(body, "↑ " + dashGrid + " dp", function () { nudgeSelected(0, -dashGrid, 0, 0); });
        actionXd(body, "↓ " + dashGrid + " dp", function () { nudgeSelected(0, dashGrid, 0, 0); });
        actionXd(body, "wider " + dashGrid + " dp", function () { nudgeSelected(0, 0, dashGrid, 0); });
        actionXd(body, "narrower " + dashGrid + " dp", function () { nudgeSelected(0, 0, -dashGrid, 0); });
        if (!isPanelWindow(win)) {
            actionXd(body, "taller " + dashGrid + " dp", function () { nudgeSelected(0, 0, 0, dashGrid); });
            actionXd(body, "shorter " + dashGrid + " dp", function () { nudgeSelected(0, 0, 0, -dashGrid); });
        }
        actionXd(body, "Find its XML in the XML app", function () {
            dashLayoutQuery = win.content || win.id;
            dashDest = "xml";
            refreshDashboard();
        });
        actionXd(body, "Save this layout", function () { saveLayoutNow(false); });
    }

    // --- XML: a game layout opened outside its window ------------------------
    // The package format is what makes this safe: the layout is mounted into a shell-owned frame,
    // so the window that owns the XML is untouched and the dashboard's own cells, themes and
    // frames still govern what is drawn. Nothing is reparented into the game's tree.
    var dashLayoutQuery = "";
    var dashLayoutPath = "";
    var dashPackageTree = "";

    function renderDashXml(body) {
        rowXd(body, "A closed game window's layout XML can be mounted here, outside the window " +
            "that owns it. The mount draws into this shell-owned frame: the game's window and its " +
            "layout are not touched, so a window that is closed in the game still opens here.",
            "PaletteNote");

        // The shell already sends and receives XML packages at runtime: the host publishes them on
        // its addon attribute and openlock_delivery.js builds the node tree with CreatePanel. The
        // dashboard reads that same channel, so a package delivered while the game runs appears
        // here without a rebuild or a file read.
        var packages = [];
        for (var pi = 0; pi < data.windows.length; pi++) {
            if (data.windows[pi].liveTree && data.windows[pi].liveTree.length) packages.push(data.windows[pi]);
        }
        headingXd(body, "delivered packages  ·  " + packages.length);
        if (!packages.length) {
            rowXd(body, "no package is delivering an XML tree to this shell right now; one arrives " +
                "from the host while the game is running", "ViewMuted");
        }
        for (var pd = 0; pd < packages.length; pd++) {
            (function (win) {
                actionXd(body, (dashPackageTree === win.id ? "\u25cf  " : "\u25cb  ") +
                    win.title + "  ·  " + win.id, function () {
                    dashPackageTree = win.id;
                    dashLayoutPath = "";
                    refreshDashboard();
                });
            })(packages[pd]);
        }
        if (dashPackageTree) {
            var pkg = windowById(dashPackageTree);
            if (pkg && pkg.liveTree && globalThis.OpenlockDelivery) {
                headingXd(body, "package tree  ·  " + pkg.id);
                var hostTree = $.CreatePanel("Panel", body, "");
                hostTree.AddClass("DashXmlHost");
                globalThis.OpenlockDelivery.renderTree(hostTree, pkg.liveTree, "dash:" + pkg.id);
                rowXd(body, "This is the package's own tree, built by the shell's receiver; the " +
                    "package format is what makes a delivered window safe to draw.", "ViewMuted");
                actionXd(body, "Clear package tree", function () {
                    dashPackageTree = "";
                    refreshDashboard();
                });
            }
        }
        headingXd(body, "mounted game layouts");
        rowXd(body, "the stock layouts this install mounts; a layout that is closed in the game " +
            "opens here without its window", "ViewMuted");
        uiField(body, "layout", dashLayoutQuery, function (text) {
            dashLayoutQuery = text;
            refreshDashboard();
        });

        var layouts = data.layouts || [];
        var query = String(dashLayoutQuery || "").toLowerCase();
        var matches = [];
        for (var i = 0; i < layouts.length && matches.length < 24; i++) {
            if (query && String(layouts[i]).toLowerCase().indexOf(query) < 0) continue;
            matches.push(layouts[i]);
        }
        headingXd(body, "mounted layouts  ·  " + matches.length + " of " + layouts.length);
        if (!matches.length) {
            rowXd(body, "no mounted layout matches '" + dashLayoutQuery + "'", "ViewMuted");
        }
        for (var m = 0; m < matches.length; m++) {
            (function (path) {
                actionXd(body, (dashLayoutPath === path ? "\u25cf  " : "\u25cb  ") +
                    layoutFont(path) + "  ·  " + path, function () {
                    dashLayoutPath = path;
                    refreshDashboard();
                });
            })(matches[m]);
        }

        if (!dashLayoutPath) return;
        headingXd(body, "preview  ·  " + layoutFont(dashLayoutPath));
        var resolved = normalizeLayoutPath(dashLayoutPath);
        rowXd(body, resolved || "not a mounted panorama layout", "ViewMuted");
        var host = $.CreatePanel("Panel", body, "");
        host.AddClass("DashXmlHost");
        if (resolved) {
            try {
                host.BLoadLayout(resolved, false, false);
            } catch (e) {
                rowXd(body, "refused: " + String(e), "PaletteNote");
            }
        }
        rowXd(body, "The mount is a preview and a readout. Its cells are the layout's own; the " +
            "shell's per-cell frames and themes apply only to a window the shell owns.", "ViewMuted");
        actionXd(body, "Open as its own shell window", function () { openLayout(dashLayoutPath); });
        actionXd(body, "Clear preview", function () {
            dashLayoutPath = "";
            refreshDashboard();
        });
    }

    // --- MENU: the shell's surfaces -----------------------------------------
    function renderDashMenu(body) {
        rowXd(body, "The shell's own surfaces. The game's Citadel dashboard is a full screen only " +
            "in the tools client; in the release build it lives behind the pause menu, so this " +
            "dashboard is drawn by the shell and opens over whatever the game is showing — on " +
            "release, the pause menu's blurred world.", "PaletteNote");
        headingXd(body, "surfaces");
        var entries = dashboardEntries();
        for (var i = 0; i < entries.length; i++) {
            (function (entry) {
                actionXd(body, entry.title, function () { openWindow(entry.win); });
            })(entries[i]);
        }
        headingXd(body, "popit");
        actionXd(body, "Open the Popit surface", showDashboardPopit);
        actionXd(body, "Edit its arrangement", function () {
            dashDest = "popit";
            refreshDashboard();
        });
    }

    // --- POPIT: the surface's arrangement -----------------------------------
    function renderDashPopit(body) {
        var L = popitLayoutNow();
        var actions = dashboardPopitActions();
        rowXd(body, "The Popit surface is the shell's menu: one frame, rows of tiles and a mode. " +
            "This editor is the layout it was missing; the arrangement is saved with this scheme.",
            "PaletteNote");
        rowXd(body, L.columns + " column(s)  ·  " + L.width + " px  ·  frame " +
            String(L.frame).toUpperCase() + "  ·  " + String(L.mode).toUpperCase() + "  ·  " +
            actions.length + " tile(s)", "PaletteValue");
        rowXd(body, actions.length > L.columns * 4
            ? "Only " + (L.columns * 4) + " tiles fit this frame; widen the surface or use more columns."
            : "Up to " + (L.columns * 4) + " tiles fit at this column count.",
            actions.length > L.columns * 4 ? "PaletteNote" : "ViewMuted");
        actionXd(body, "Preview on the dashboard", showDashboardPopit);

        var columns = [1, 2, 3, 4];
        for (var c = 0; c < columns.length; c++) {
            (function (n) {
                actionXd(body, n + (L.columns === n ? " column  ·  active" : " column(s)"), function () {
                    setPopitLayout({ columns: n });
                });
            })(columns[c]);
        }
        actionXd(body, "Narrower  ·  " + (L.width - 24) + " px", function () {
            setPopitLayout({ width: L.width - 24 });
        });
        actionXd(body, "Wider  ·  " + (L.width + 24) + " px", function () {
            setPopitLayout({ width: L.width + 24 });
        });
        var frames = (globalThis.OpenlockPopit && globalThis.OpenlockPopit.frameList)
            ? globalThis.OpenlockPopit.frameList()
            : [{ id: "lbp3", label: "LBP3" }];
        var at = 0;
        for (var f = 0; f < frames.length; f++) if (frames[f].id === L.frame) at = f;
        var nextFrame = frames[(at + 1) % frames.length];
        actionXd(body, "Frame  ·  " + frames[at].label + "  →  " + nextFrame.label, function () {
            setPopitLayout({ frame: nextFrame.id });
        });
        actionXd(body, "Mode  ·  " + String(L.mode).toUpperCase() + "  →  " +
            (L.mode === "play" ? "CREATE" : "PLAY"), function () {
            setPopitLayout({ mode: L.mode === "play" ? "create" : "play" });
        });

        headingXd(body, "tile order");
        var ordered = [];
        for (var o = 0; o < L.order.length; o++) {
            for (var a = 0; a < actions.length; a++) {
                if (actions[a].id === L.order[o] && ordered.indexOf(actions[a]) < 0) ordered.push(actions[a]);
            }
        }
        for (var r = 0; r < actions.length; r++) {
            if (ordered.indexOf(actions[r]) < 0) ordered.push(actions[r]);
        }
        for (var t = 0; t < ordered.length; t++) {
            (function (action, index) {
                var row = $.CreatePanel("Panel", body, "");
                row.AddClass("ViewOrderRow");
                var label = $.CreatePanel("Label", row, "");
                label.AddClass("ViewLine");
                label.text = (index + 1) + "  " + action.title;
                addControl(row, "ViewAction", "Up", function () { movePopitTile(action.id, -1); });
                addControl(row, "ViewAction", "Down", function () { movePopitTile(action.id, 1); });
            })(ordered[t], t);
        }

        actionXd(body, "Reset popit layout", function () {
            popitLayout = defaultPopitLayout();
            refreshDashboard();
            globalThis.OpenlockToast("Popit layout reset",
                "four columns, 356 px, LBP3 frame, CREATE mode, package order", "", false);
        });
    }

    // --- BUILD: presence and the record -------------------------------------
    function renderDashBuild(body) {
        var reading = presenceReading();
        headingXd(body, "game windows  ·  " + reading.live + " of " + reading.declared + " on screen");
        if (!reading.declared) {
            rowXd(body, "the package declares no game panel window; every surface here is the " +
                "shell's own", "ViewMuted");
        } else if (!reading.live) {
            rowXd(body, "No declared game panel is on screen: the game is on its dashboard or in a " +
                "menu. A window is framed only when the game draws its panel, so nothing is drawn " +
                "here that does not exist.", "ViewMuted");
        } else {
            rowXd(body, "Presence is read from the live panel tree. A window appears when its " +
                "panel appears and leaves when it closes.", "ViewMuted");
        }
        if (reading.absent.length) rowXd(body, "not on screen: " + reading.absent.join(", "), "ViewMuted");
        actionXd(body, "Rescan game panels", function () {
            for (var k in findCache) if (findCache.hasOwnProperty(k)) delete findCache[k];
            for (var m in findMissAt) if (findMissAt.hasOwnProperty(m)) delete findMissAt[m];
            for (var id in bound) {
                if (!bound.hasOwnProperty(id)) continue;
                var b = bound[id];
                if (!b || !b.panel || !alive(b.panel)) bound[id] = null;
            }
            refreshDashboard();
            globalThis.OpenlockToast("Rescan",
                presenceReading().live + " game panel(s) on screen", "", false);
        });

        var build = data.build || {};
        headingXd(body, "build");
        rowXd(body, (build.version || "unrecorded") + "  ·  " + (build.grade || "dev") +
            (build.commit ? "  ·  " + build.commit : ""), "PaletteValue");
        if (build.stage) rowXd(body, String(build.stage), "ViewMuted");
        headingXd(body, "layout");
        rowXd(body, (currentScheme || "default") + "  ·  saved " +
            (layoutProfiles[currentScheme || "default"] ? "yes" : "no") +
            "  ·  popit saved with it", "ViewMuted");
        actionXd(body, "Save this layout", function () { saveLayoutNow(false); });
        actionXd(body, "Load saved layout", function () {
            var scheme = currentScheme || themes.default;
            send("layout-load", scheme);
            applyLayoutProfile(scheme, true);
            refreshDashboard();
        });
    }

    function renderDashboard(win, body) {
        measureScreen();
        var reading = presenceReading();
        var app = $.CreatePanel("Panel", body, "");
        app.AddClass("DashApp");
        dashHeader(app, reading);

        var row = $.CreatePanel("Panel", app, "");
        row.AddClass("DashBody");
        dashRail(row, dashDest);

        var panel = $.CreatePanel("Panel", row, "");
        panel.AddClass("DashPanel");
        if (dashDest === "layout") renderDashLayout(panel);
        else if (dashDest === "xml") renderDashXml(panel);
        else if (dashDest === "popit") renderDashPopit(panel);
        else if (dashDest === "build") renderDashBuild(panel);
        else renderDashMenu(panel);

        dashStatus(app, reading);
    }

    function renderOwn(win, body) {
        body.RemoveAndDeleteChildren();

        if (win.id === DASHBOARD_ID || win.view === "dashboard") {
            renderDashboard(win, body);
            return;
        }

        if (win.id === WINDOWS_ID || win.view === "windows") {
            renderWindowBrowser(body);
            return;
        }

        if (win.view === "ui-tree") {
            renderUiTree(body, win);
            return;
        }

        var kind = win.view || win.content;

        if (kind === "performance") {
            renderPerf(body, win);
            return;
        }

        if (kind === "picker") {
            renderPicker(body, win);
            return;
        }

        if (kind === "palette") {
            renderPalette(body, win);
            return;
        }

        if (kind === "addon-layout") {
            renderAddonLayout(win, body);
            return;
        }

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

        // Updates, repository and landing are the motd addon's window shape: a small package
        // window with a heading, a text body and one action, not a second modal over the game.
        if (kind === "updates") {
            var update = data.update || {};
            var build = data.build || {};
            headingXd(body, "updates");
            rowXd(body, "build  " + (build.label || data.version || "openlock"), "ViewMuted");
            rowXd(body, "repository  " + REPO_URL, "ViewMuted");
            if (update.available) {
                rowXd(body, "available  " + (update.version || "new build"), "ViewMuted");
                rowXd(body, String(update.notes || "Restart the client to apply the new build."), "ViewMuted");
                actionXd(body, "Restart now", function () { globalThis.OpenlockUpdateRestart(); });
                actionXd(body, "Later", function () { globalThis.OpenlockUpdateLater(); });
            } else {
                rowXd(body, "This client is on the current build.", "ViewMuted");
                rowXd(body, "The update record is published with the shell package.", "ViewMuted");
            }
            return;
        }

        if (kind === "repo") {
            var gitBuild = data.build || {};
            headingXd(body, "git repository");
            rowXd(body, REPO_URL, "ViewMuted");
            rowXd(body, "branch  " + (gitBuild.branch || "main"), "ViewMuted");
            rowXd(body, "commit  " + (gitBuild.commit || "unknown") +
                (gitBuild.dirty ? " (dirty)" : ""), "ViewMuted");
            rowXd(body, "The landing page is published from this repository.", "ViewMuted");
            return;
        }

        if (kind === "landing") {
            headingXd(body, "landing page");
            rowXd(body, LANDING_URL, "ViewMuted");
            rowXd(body, "Published from main through GitHub Pages.", "ViewMuted");
            rowXd(body, "The same package builds the in-game shell and the download page.", "ViewMuted");
            return;
        }

        if (kind === "settings") {
            // Colour and shape are separate selectors. These two lists never call each other:
            // picking a palette leaves the form class alone, and picking a shape leaves every
            // scheme class alone.
            headingXd(body, "palette");
            if (!themes.schemes.length) {
                rowXd(body, "no palettes in this build", "ViewMuted");
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

            headingXd(body, "shape");
            var forms = themes.forms || [];
            if (!forms.length) {
                rowXd(body, "no form schema in this build", "ViewMuted");
            }
            for (var fi = 0; fi < forms.length; fi++) {
                (function (form) {
                    actionXd(
                        body,
                        (form.id === currentForm ? "● " : "○ ") + form.label +
                            "  ·  " + (form.renderer || "generic") + " renderer",
                        function () {
                            applyForm(form.id, true);
                            renderOwn(win, body);
                        });
                })(forms[fi]);
            }

            actionXd(body, "Open palette editor", function () { openWindow("palette"); });

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

            headingXd(body, "the layout");
            rowXd(body, "A layout is how this screen is arranged: the active taskbar tab, every open " +
                "window and split cell, and which windows are pinned, minimized or focused. The package " +
                "provides the defaults; your save is restored on the next start.", "ViewMuted");
            rowXd(body, data.windows.length + " declared windows · " + data.tabs.length + " tabs · " + data.pins.length + " pins", "ViewMuted");
            actionXd(body, "Save current layout to file", function () { saveLayoutNow(false); });
            actionXd(body, "Load saved layout", function () {
                send("layout-load", currentScheme || themes.default);
                applyLayoutProfile(currentScheme || themes.default, true);
            });
            actionXd(body, "Export saved layout as a file", function () {
                send("layout-export", currentScheme || themes.default);
                globalThis.OpenlockToast("Layout export", "Writing the profile under layouts/exports.", "", false);
            });
            actionXd(body, "Reset saved layout", function () {
                send("layout-reset", currentScheme || themes.default);
                delete layoutProfiles[currentScheme || themes.default];
                popitLayout = defaultPopitLayout();
                layoutLoadedFor = "";
                layoutExportPath = "";
                globalThis.OpenlockToast("Layout reset",
                    (currentScheme || themes.default) + " profile removed; package defaults remain.", "", false);
            });
            actionXd(body, "Restore package defaults  ·  " + (currentScheme || themes.default), restoreUiLayout);

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

        actionXd(body, "Dashboard  ·  the shell's own menu and Popit layout", function () {
            openWindow(DASHBOARD_ID);
        });

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

    // --- layout profiles -----------------------------------------------------
    // The host owns the file; the client owns which windows exist. A snapshot is the same
    // scheme@id,x,y,w,h@... line the C# LayoutProfiles parser reads, so the player's Save button
    // and an operator's request use one path. Cell rows are ordinary ids; a split is recreated
    // from the `cell:<parent>:<key>` rows when the profile is loaded again.
    function layoutSnapshot() {
        var rows = [];
        var windows = 0;
        // State rows come first. They are what makes a saved layout the player's desktop:
        // the focused window, the active taskbar tab, what they pinned and what they minimized.
        if (activeId && open[activeId] && windowById(activeId)) rows.push("active=" + activeId);
        if (activeTab) rows.push("tab=" + activeTab);
        for (var pinId in pinned) {
            if (!pinned.hasOwnProperty(pinId) || !pinned[pinId] || !open[pinId] || !windowById(pinId)) continue;
            rows.push("pin=" + pinId);
        }
        for (var minId in minimized) {
            if (!minimized.hasOwnProperty(minId) || !minimized[minId] || !open[minId] || !windowById(minId)) continue;
            rows.push("min=" + minId);
        }
        // The Popit surface's arrangement travels with the desktop it belongs to. Tiles are
        // `+`-joined because a comma already separates a rectangle row.
        rows.push("popit=columns:" + popitLayout.columns + ";width:" + popitLayout.width +
            ";frame:" + popitLayout.frame + ";mode:" + popitLayout.mode +
            ";order:" + popitLayout.order.join("+"));
        for (var id in open) {
            if (!open.hasOwnProperty(id) || !open[id] || !windowById(id)) continue;
            var g = geometry[id];
            if (!g || !g.init) continue;
            if (String(id).indexOf("@") >= 0 || String(id).indexOf(",") >= 0) continue;
            var cell = !!windowById(id).cellWindow;
            var rowId = id;
            if (cell) {
                var b = bound[id];
                // A themed cell carries its theme in the row so a loaded split keeps the same
                // elements painted with the scheme instead of silently becoming unthemed.
                if (windowById(id).themed || (b && b.panel && isThemedPanel(b.panel))) rowId += ":t";
            }
            var w = Math.round(g.w);
            var h = Math.round(g.h);
            if (cell) { w = Math.max(16, w); h = Math.max(16, h); }
            else { w = Math.max(120, w); h = Math.max(64, h); }
            rows.push(rowId + "," + Math.round(g.x) + "," + Math.round(g.y) + "," + w + "," + h);
            windows++;
        }
        if (!windows) return "";
        return (currentScheme || "default") + "@" + rows.join("@");
    }

    function saveLayoutNow(quiet) {
        var snapshot = layoutSnapshot();
        if (!snapshot) {
            if (!quiet) globalThis.OpenlockToast("Layout not saved", "No window is open to snapshot.", "", true);
            return false;
        }
        send("layout", snapshot);
        if (!quiet) {
            var rows = 0;
            for (var i = 0; i < snapshot.length; i++) if (snapshot.charAt(i) === ",") rows++;
            globalThis.OpenlockToast("Layout saved",
                currentScheme + " · " + rows + " window(s) · active, tab, pins and cells are in the file", "", false);
        }
        logPerf("info", "layout save requested: " + currentScheme);
        return true;
    }

    function applyRect(id, rect) {
        var win = windowById(id);
        if (!win) return false;
        if (!open[id]) openWindow(id, true);
        geometry[id] = { x: rect.x, y: rect.y, w: rect.w, h: rect.h, init: true, userSet: true };
        if (frames[id]) applyWindow(win);
        return true;
    }

    // A saved cell row is `cell:<root>:<key>[:<key>...]`. Each prefix is a split container, so a
    // nested cell is restored by splitting its parent cell before restoring the final rectangle.
    function ensureSplitPath(rootId, path, themed, rect) {
        var parts = String(path || "").split(":");
        var root = windowById(rootId);
        if (!root || !isPanelWindow(root) || !parts.length || !parts[0]) return false;
        var containerId = rootId;
        var walked = "";
        for (var i = 0; i < parts.length; i++) {
            if (!parts[i]) return false;
            walked = walked ? walked + ":" + parts[i] : parts[i];
            if (!splitCells[containerId] || !splitCells[containerId].length) {
                if (!open[containerId]) openWindow(containerId, true);
                var container = windowById(containerId);
                if (!container || !splitWindow(container)) return false;
            }
            var cellId = cellIdFor(rootId, walked);
            if (!windowById(cellId)) return false;
            containerId = cellId;
        }
        if (!applyRect(containerId, rect)) return false;
        if (themed) {
            var cell = windowById(containerId);
            cell.themed = true;
            var b = bound[containerId];
            if (b && b.panel) themePanel(b.panel, parts[parts.length - 1]);
        }
        return true;
    }

    function applyLayoutProfile(scheme, announce) {
        var profile = layoutProfiles[scheme];
        if (!profile) {
            if (announce) {
                globalThis.OpenlockToast("No saved layout",
                    "There is no " + scheme + " profile yet. Move a window and press Save layout.", "", true);
            }
            return 0;
        }
        var rows = profile.windows || {};
        var applied = 0;
        var cells = 0;
        var expectedCells = 0;
        for (var id in rows) {
            if (!rows.hasOwnProperty(id)) continue;
            var rect = rows[id];
            if (String(id).indexOf("cell:") === 0) expectedCells++;
            if (String(id).indexOf("cell:") === 0) {
                var rest = String(id).substring(5);
                var themed = false;
                if (rest.substring(rest.length - 2) === ":t") {
                    themed = true;
                    rest = rest.substring(0, rest.length - 2);
                }
                var pieces = rest.split(":");
                var parentId = pieces.shift();
                if (!parentId || !pieces.length) continue;
                if (ensureSplitPath(parentId, pieces.join(":"), themed, rect)) cells++;
                continue;
            }
            if (applyRect(id, rect)) applied++;
        }

        // Replace the arrangement, don't merge it into the package defaults: a saved layout is
        // what the player last left on screen. Pins are restored after rows so a pinned window
        // has a frame to attach the state to.
        var hasState = profile.pinned || profile.minimized || profile.active || profile.tab;
        if (hasState) {
            for (var oldPin in pinned) {
                if (pinned.hasOwnProperty(oldPin)) delete pinned[oldPin];
            }
            for (var oldMin in minimized) {
                if (minimized.hasOwnProperty(oldMin)) delete minimized[oldMin];
            }
        }
        var pins = profile.pinned || [];
        for (var p = 0; p < pins.length; p++) {
            if (!windowById(pins[p])) continue;
            if (!open[pins[p]]) openWindow(pins[p], true);
            pinned[pins[p]] = true;
            enforcePinnedVisibility(pins[p]);
        }
        var mins = profile.minimized || [];
        for (var m = 0; m < mins.length; m++) {
            if (!windowById(mins[m]) || !open[mins[m]]) continue;
            minimized[mins[m]] = true;
        }
        // The Popit arrangement is part of the scheme, so loading a layout restores the menu the
        // player laid out for it. A profile written before the surface had an editor has none and
        // keeps the current arrangement.
        if (profile.popit) {
            popitLayout = globalThis.OpenlockPopit
                ? globalThis.OpenlockPopit.normalizeLayout(profile.popit)
                : popitLayout;
        }
        if (profile.tab && windowById(profile.tab)) activeTab = profile.tab;
        if (profile.active && splitCells[profile.active] && splitCells[profile.active].length) {
            activeId = firstLeafId(profile.active);
            focusWindow(activeId);
        } else if (profile.active && open[profile.active] && windowById(profile.active)) {
            activeId = profile.active;
            focusWindow(activeId);
        }

        renderBar();
        render();

        // A saved split can be restored before the game has built its HUD panel. Keep retrying
        // for a short window instead of marking the profile applied with cells missing; the
        // attempt is bounded, because a renamed component is a real mismatch, not a slow HUD.
        if (expectedCells > cells) {
            var attempt = (layoutRetries[scheme] || 0) + 1;
            layoutRetries[scheme] = attempt;
            logPerf("info", "layout waiting: " + scheme + " cells=" + cells + "/" + expectedCells +
                " attempt=" + attempt);
            if (attempt <= 15) {
                $.Schedule(1.0, function () {
                    if (currentScheme === scheme && layoutProfiles[scheme]) {
                        applyLayoutProfile(scheme, false);
                    }
                });
                return applied + cells;
            }
            layoutNotices.push("layout " + scheme + ": " + (expectedCells - cells) +
                " saved cell(s) no longer match the live HUD");
        }
        delete layoutRetries[scheme];
        layoutLoadedFor = scheme;
        if (announce) {
            globalThis.OpenlockToast("Layout loaded",
                scheme + " · " + applied + " window(s)" + (cells ? " · " + cells + " cell(s)" : "") +
                " · " + pins.length + " pinned · " + mins.length + " minimized",
                "", false);
        }
        logPerf("info", "layout applied: " + scheme + " windows=" + applied + " cells=" + cells +
            " pinned=" + pins.length + " minimized=" + mins.length);
        $.Msg("[Openlock] layout applied: ", scheme, " windows=", applied, " cells=", cells,
            " pinned=", pins.length, " minimized=", mins.length, " active=", activeId);
        return applied + cells;
    }

    function parseLayoutPayload(raw) {
        if (!raw || raw === lastLayoutRaw) return;
        lastLayoutRaw = raw;
        var parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) {
            logPerf("warn", "layout payload is not JSON");
            return;
        }
        if (!parsed || typeof parsed !== "object") return;
        layoutProfiles = {};
        layoutRetries = {};
        var profiles = parsed.profiles || {};
        for (var scheme in profiles) {
            if (!profiles.hasOwnProperty(scheme)) continue;
            var entry = profiles[scheme] || {};
            // Current payloads wrap geometry and arrangement state; an older payload is the
            // geometry map itself. Reading both keeps a profile written by an older install
            // loadable instead of silently discarding its windows.
            var rows = entry.windows || entry || {};
            var out = {};
            for (var id in rows) {
                if (!rows.hasOwnProperty(id)) continue;
                var rect = rows[id] || {};
                if (!rect || typeof rect !== "object") continue;
                out[id] = { x: Number(rect.x) || 0, y: Number(rect.y) || 0,
                    w: Number(rect.w) || 0, h: Number(rect.h) || 0 };
            }
            layoutProfiles[scheme] = {
                windows: out,
                active: typeof entry.active === "string" ? entry.active : "",
                tab: typeof entry.tab === "string" ? entry.tab : "",
                pinned: entry.pinned instanceof Array ? entry.pinned : [],
                minimized: entry.minimized instanceof Array ? entry.minimized : [],
                popit: entry.popit && typeof entry.popit === "object" ? entry.popit : null
            };
        }
        layoutNotices = parsed.notices || [];
        var count = 0;
        for (var p in layoutProfiles) if (layoutProfiles.hasOwnProperty(p)) count++;
        $.Msg("[Openlock] layout profiles: ", count, " scheme=", (currentScheme || "none"),
            " saved=", !!(currentScheme && layoutProfiles[currentScheme]));
        if (currentScheme && layoutProfiles[currentScheme] && layoutLoadedFor !== currentScheme) {
            $.Msg("[Openlock] layout auto-load: ", currentScheme);
            applyLayoutProfile(currentScheme, false);
        }
    }

    // --- server poll ---------------------------------------------------------

    var lastSig = "";
    var pollCount = 0;
    function pollOnce() {
        pollCount++;
        perf.polls++;
        // Live package and observer payloads arrive on the same host the panel properties use.
        // Comparing the payload string first means an unchanged payload costs one attribute read.
        pollAddons();
        pollObserver();
        // Profiles arrive as one host attribute. Parsing an unchanged payload is skipped by the
        // signature; a changed one is the only time the client re-reads geometry.
        try { parseLayoutPayload(attr("layout", "")); } catch (e) { noteFailure("layout parse", e); }
        var layoutRequest = attr("layoutrequest", "");
        if (layoutRequest && layoutRequest !== lastLayoutRequest) {
            lastLayoutRequest = layoutRequest;
            saveLayoutNow(true);
        }
        var layoutExport = attr("layoutexport", "");
        if (layoutExport && layoutExport !== lastLayoutExport) {
            lastLayoutExport = layoutExport;
            layoutExportPath = layoutExport;
            globalThis.OpenlockToast("Layout exported", layoutExport, "", false);
            logPerf("info", "layout exported: " + layoutExport);
        }
        var want = attr("active", "");
        var sig = want + "|" + attr("view", "") + "|" + attr("refusal", "") + "|" + attr("body", "").length;

        if (want && windowById(want) && (want !== activeId || sig !== lastSig)) {
            lastSig = sig;
            openWindow(want, true);
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
            try { applyWindow(win); } catch (e) {
                try { releasePanel(id); } catch (err) {}
                noteFailure("window apply", e);
            }
        }

        // The id index has to be current before autoFrameOpen asks it whether the shop or the
        // map is on screen. The walk itself is gated by the HUD's shape, so an idle shell pays
        // one cheap signature read here, not a full sweep.
        if (expanded && !discoveringHud && Date.now() - hudIndexAt > 3500) {
            try { discoverHudWindows(); } catch (e) {
                discoveringHud = false;
                noteFailure("hud scan", e);
            }
        }

        // Screens that came on screen after the shell opened (shop, map, escape menu) join the
        // layout while the shell is open. The check is every other second, not every poll.
        // Only the small autoFrame set is retried here.
        if (expanded && (pollCount % 4) === 0) {
            try { autoFrameOpen(); } catch (e) { noteFailure("auto frame", e); }
        }
        if (expanded && (pollCount % 4) === 2) {
            try { scanPopups(); } catch (e) { noteFailure("popup scan", e); }
        }

        if (expanded && !preloadActive && Date.now() - lastInteractionAt > 5000) hideTaskbar();
    }

    // A live HUD deletes and rebuilds panels while this poll reads them (the shop does it on every
    // open). A single "Underlying panel is deleted!" used to end the callback before its next
    // schedule, which is why the shell went quiet; the poll now survives its own scan and keeps
    // its cadence.
    function poll() {
        try { pollOnce(); } catch (e) { noteFailure("poll", e); }
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
    applyForm(themes.defaultForm, false);
    applyScheme(themes.default, false);
    renderBar();
    startPreload();
    startClock();
    // Toasts are the operator/package notice surface and must sit above every frame, including
    // a window opened at high z. The stylesheet already orders them; this makes the intent
    // explicit for a client whose frame stack grew past the CSS value.
    if (toastStack) {
        try { toastStack.style.zIndex = "100000"; } catch (e) {}
    }

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
            " commit=", (build.commit || "unknown"),
            " src=", String(build.sourceDigest || "unknown").substring(0, 12),
            " game=", (build.gameVersion || "unknown"),
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

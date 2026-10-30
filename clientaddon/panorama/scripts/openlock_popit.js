// Popit surface: the LittleBigPlanet tool menu as a real panel, not a ring of text rows.
//
// This module owns the surface only. The shell hands it the window geometry, the declared
// layer actions, the other open windows and three callbacks (act, refuse, hover). Shape is
// selected by a frame class from forms/popit.form; colour is chosen by the active
// .Scheme<Id> palette. No colour or frame geometry is declared in JavaScript.
//
// The version frames are the documented family: LBP3's rounded hexagon, LBP1's soft bubble,
// LBP2's flat block, the PSP page, the Vita card and Karting's beam card. The frame badge
// cycles them; the CREATE/PLAY pill is a local selection and never sends a game mode.
(function () {
    var ICON_ROOT = "s2r://panorama/images/";
    var ICONS = {
        trees: "control_icons/expand_collapse_png.vtex",
        refusals: "control_icons/warning_alt_png.vtex",
        picker: "control_icons/star_png.vtex",
        reconcile: "control_icons/refresh_psd.vtex",
        uitree: "control_icons/hamburger_png.vtex",
        settings: "control_icons/icon_auto_style_png.vtex",
        performance: "control_icons/history_png.vtex",
        repo: "control_icons/arrow_solid_right_png.vtex",
        landing: "control_icons/broadcast_psd.vtex",
        updates: "control_icons/refresh_psd.vtex",
        skin: "control_icons/icon_auto_style_png.vtex",
        minimap: "getting_started/map_lanes_icon_png.vtex",
        world: "getting_started/map_bg_nolines_png.vtex",
        abilities: "control_icons/mod_track_tech_psd.vtex",
        "default": "control_icons/playbutton_psd.vtex"
    };
    var FRAMES = [
        { id: "lbp3", label: "LBP3", cls: "Lbp3" },
        { id: "lbp1", label: "LBP1", cls: "Lbp1" },
        { id: "lbp2", label: "LBP2", cls: "Lbp2" },
        { id: "psp", label: "PSP", cls: "Psp" },
        { id: "vita", label: "VITA", cls: "Vita" },
        { id: "karting", label: "KART", cls: "Karting" }
    ];
    var COLUMNS = 4;
    var WIDTH = 356;
    var MIN_WIDTH = 240;
    var MAX_WIDTH = 900;
    var MAX_ROWS = 4;
    // These are the same fixed frame heights as forms/popit.form's PopitRows* classes. They
    // are used only for the overlap/screen test; the actual height comes from the form.
    var FRAME_HEIGHTS = [0, 260, 380, 480, 580];
    // The surface's arrangement. The shell's dashboard edits this and saves it with the layout;
    // the module owns only the legal range, so a hand-edited profile cannot draw a 40-column
    // surface in a frame that has no height class for it.
    var currentLayout = { columns: COLUMNS, width: WIDTH, frame: "lbp3", mode: "create", order: [] };

    function clampInt(value, low, high, fallback) {
        var n = Math.round(Number(value));
        if (!isFinite(n)) return fallback;
        return Math.max(low, Math.min(high, n));
    }

    function normalizeLayout(input) {
        var src = input || {};
        var columns = clampInt(src.columns, 1, 4, COLUMNS);
        var width = clampInt(src.width, MIN_WIDTH, MAX_WIDTH, WIDTH);
        var frame = "lbp3";
        if (src.frame) frame = frameById(src.frame).id;
        var mode = src.mode === "play" ? "play" : "create";
        var order = [];
        var raw = src.order instanceof Array ? src.order : [];
        for (var i = 0; i < raw.length && order.length < 32; i++) {
            var id = String(raw[i] || "");
            if (id && order.indexOf(id) < 0) order.push(id);
        }
        return { columns: columns, width: width, frame: frame, mode: mode, order: order };
    }

    // The edited order leads; any action the surface also carries follows in declaration order,
    // so a tile added to the package appears without the player having to reset their layout.
    function orderActions(actions, order) {
        if (!order || !order.length) return actions.slice(0);
        var out = [];
        var used = {};
        for (var i = 0; i < order.length; i++) {
            for (var j = 0; j < actions.length; j++) {
                if (used[j]) continue;
                if (String(actions[j].id) !== order[i]) continue;
                out.push(actions[j]);
                used[j] = true;
                break;
            }
        }
        for (var k = 0; k < actions.length; k++) if (!used[k]) out.push(actions[k]);
        return out;
    }

    var root = null;
    var dismiss = null;
    var surface = null;
    var current = null;
    var framePanel = null;
    var tailPanel = null;
    var badgeLabel = null;
    var detailLabel = null;
    var actions = [];
    var modePanels = { create: null, play: null };
    var tiles = [];
    var selected = 0;
    var hovered = -1;
    var frame = "lbp3";
    var mode = "create";
    var placed = null;
    var screen = { w: 1600, h: 900, top: 46 };
    var status = { visible: false, frame: "lbp3", mode: "create", actions: 0, rows: 0, placed: null };

    function note(text) {
        try { $.Msg("[Openlock] popit: ", text); } catch (e) {}
    }

    function frameById(id) {
        for (var i = 0; i < FRAMES.length; i++) {
            if (FRAMES[i].id === id) return FRAMES[i];
        }
        return FRAMES[0];
    }

    function frameClass(id) {
        return frameById(id).cls;
    }

    function iconFor(action) {
        var id = String((action && action.id) || "").toLowerCase();
        if (ICONS[id]) return ICON_ROOT + ICONS[id];
        var label = String((action && action.label) || "").toLowerCase();
        for (var key in ICONS) {
            if (key !== "default" && label.indexOf(key) >= 0) return ICON_ROOT + ICONS[key];
        }
        return ICON_ROOT + ICONS["default"];
    }

    function setImage(panel, src) {
        if (!panel) return false;
        try {
            if (typeof panel.SetImage === "function") {
                panel.SetImage(src);
                return true;
            }
        } catch (e) {}
        try {
            panel.src = src;
            return true;
        } catch (e) {}
        return false;
    }

    function describe(action) {
        if (!action) return "";
        if (action.window) return "OPENS " + String(action.window).toUpperCase();
        return "SENDS " + String(action.id || "").toUpperCase();
    }

    function overlaps(a, b) {
        var pad = 6;
        return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x &&
            a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
    }

    // A Popit that would cover another floating window is refused instead of drawn over it.
    // Candidate 0 is inside the owner's own frame; the others sit around it. Every candidate is
    // clamped to the safe screen box before the overlap test.
    function place(req, height, width) {
        var g = req.geometry || { x: 16, y: 64, w: 480, h: 440 };
        var s = req.screen || screen;
        var sw = Number(s.w) || 1600;
        var sh = Number(s.h) || 900;
        var top = Number(s.top) || 46;
        var w = width || WIDTH;
        var open = req.openRects || [];
        var candidates = [
            { x: Math.round(g.x + g.w - w - 8), y: Math.round(g.y + 30) },
            { x: Math.round(g.x + g.w + 10), y: Math.round(g.y) },
            { x: Math.round(g.x - w - 10), y: Math.round(g.y) },
            { x: Math.round(g.x), y: Math.round(g.y + g.h + 10) },
            { x: Math.round(g.x), y: Math.round(g.y - height - 10) },
            { x: Math.round((sw - w) / 2), y: Math.round(top + 18) }
        ];
        var blockers = [];
        for (var i = 0; i < candidates.length; i++) {
            var at = {
                x: Math.max(8, Math.min(Math.max(8, sw - w - 8), candidates[i].x)),
                y: Math.max(top, Math.min(Math.max(top, sh - height - 8), candidates[i].y)),
                w: w,
                h: height
            };
            var hit = null;
            for (var j = 0; j < open.length; j++) {
                if (overlaps(at, open[j])) { hit = open[j]; break; }
            }
            if (!hit) return { ok: true, x: at.x, y: at.y };
            if (blockers.indexOf(hit.title || hit.id) < 0) blockers.push(hit.title || hit.id);
        }
        return {
            ok: false,
            why: "the surface would overlap " + (blockers.length ? blockers.join(", ") : "another floating window")
        };
    }

    function close() {
        if (surface) {
            try { surface.DeleteAsync(0); } catch (e) {}
        }
        if (dismiss) {
            try { dismiss.DeleteAsync(0); } catch (e) {}
        }
        surface = null;
        dismiss = null;
        current = null;
        framePanel = null;
        tailPanel = null;
        badgeLabel = null;
        detailLabel = null;
        tiles = [];
        modePanels = { create: null, play: null };
        selected = 0;
        hovered = -1;
        placed = null;
        status.visible = false;
        status.placed = null;
    }

    function selectedAction() {
        var at = hovered >= 0 ? hovered : selected;
        return tiles[at] ? tiles[at].action : null;
    }

    function updateDetail() {
        if (!detailLabel) return;
        var action = selectedAction();
        if (!action) {
            detailLabel.text = "NO TOOLS";
            return;
        }
        detailLabel.text = (mode === "create" ? "CREATE" : "PLAY") + "  ·  " +
            (action.label || action.id) + "  ·  " + describe(action);
    }

    function refreshSelection() {
        for (var i = 0; i < tiles.length; i++) {
            try {
                if (i === selected) tiles[i].panel.AddClass("Selected");
                else tiles[i].panel.RemoveClass("Selected");
            } catch (e) {}
        }
        updateDetail();
    }

    function setSelected(index) {
        selected = Math.max(0, Math.min(tiles.length - 1, Number(index) || 0));
        refreshSelection();
    }

    function setMode(next) {
        mode = next === "play" ? "play" : "create";
        var ids = ["create", "play"];
        for (var i = 0; i < ids.length; i++) {
            var panel = modePanels[ids[i]];
            if (!panel) continue;
            try {
                if (ids[i] === mode) panel.AddClass("Active");
                else panel.RemoveClass("Active");
            } catch (e) {}
        }
        currentLayout.mode = mode;
        status.mode = mode;
        updateDetail();
        note("mode " + mode);
    }

    function setFrame(next) {
        var target = frameById(next);
        frame = target.id;
        if (framePanel) {
            for (var i = 0; i < FRAMES.length; i++) {
                try { framePanel.RemoveClass(FRAMES[i].cls); } catch (e) {}
            }
            try { framePanel.AddClass(target.cls); } catch (e) {}
        }
        if (tailPanel) {
            for (var j = 0; j < FRAMES.length; j++) {
                try { tailPanel.RemoveClass(FRAMES[j].cls); } catch (e) {}
            }
            try { tailPanel.AddClass(target.cls); } catch (e) {}
        }
        if (badgeLabel) badgeLabel.text = target.label;
        currentLayout.frame = frame;
        status.frame = frame;
        note("frame " + frame);
    }

    function cycleFrame() {
        var at = 0;
        for (var i = 0; i < FRAMES.length; i++) {
            if (FRAMES[i].id === frame) { at = i; break; }
        }
        setFrame(FRAMES[(at + 1) % FRAMES.length].id);
    }

    function addMode(pill, id, label) {
        var item = $.CreatePanel("Panel", pill, id === "play" ? "OpenlockPopitModePlay" : "OpenlockPopitModeCreate");
        item.AddClass("PopitMode");
        item.hittest = true;
        item.SetPanelEvent("onmouseactivate", function () { setMode(id); });
        var text = $.CreatePanel("Label", item, "");
        text.text = label;
        text.hittest = false;
        modePanels[id] = item;
        return item;
    }

    function makeTile(row, action, index) {
        var tile = $.CreatePanel("Panel", row, "");
        tile.AddClass("PopitTile");
        if (index === selected) tile.AddClass("Selected");
        tile.hittest = true;

        var icon = $.CreatePanel("Image", tile, "");
        icon.AddClass("PopitTileIcon");
        icon.hittest = false;
        setImage(icon, iconFor(action));

        var label = $.CreatePanel("Label", tile, "");
        label.AddClass("PopitTileLabel");
        label.text = action.label || action.id;
        label.hittest = false;

        tile.SetPanelEvent("onmouseover", function () {
            hovered = index;
            try { tile.AddClass("Hover"); } catch (e) {}
            updateDetail();
            if (current && current.onHover) {
                try { current.onHover(tile, action.label || action.id, describe(action)); } catch (e) {}
            }
        });
        tile.SetPanelEvent("onmouseout", function () {
            hovered = -1;
            try { tile.RemoveClass("Hover"); } catch (e) {}
            updateDetail();
            if (current && current.onHoverEnd) {
                try { current.onHoverEnd(); } catch (e) {}
            }
        });
        tile.SetPanelEvent("onmouseactivate", function () {
            setSelected(index);
            var onAction = current && current.onAction;
            if (onAction) onAction(action);
        });
        tiles.push({ panel: tile, action: action });
        return tile;
    }

    function show(req) {
        if (!req || !req.root) {
            note("REFUSED no root panel");
            return { ok: false, why: "no root panel" };
        }
        close();
        root = req.root;
        screen = req.screen || screen;
        current = req;
        actions = req.actions || [];
        if (!actions.length) {
            current = null;
            note("REFUSED no actions");
            if (req.onRefusal) req.onRefusal("Popit refused", "this window declares no tool layer");
            return { ok: false, why: "no actions" };
        }

        var layout = normalizeLayout(req.layout || {
            columns: COLUMNS, width: WIDTH, frame: req.frame || frame, mode: req.mode || mode,
            order: []
        });
        currentLayout = layout;
        actions = orderActions(actions, layout.order);
        frame = layout.frame;
        mode = layout.mode;
        var rows = Math.min(MAX_ROWS, Math.ceil(actions.length / layout.columns));
        var capacity = rows * layout.columns;
        if (capacity < actions.length) {
            // The form has four row heights. A one-column surface with more tiles than that fits
            // is refused rather than drawn clipped, because a clipped tile is a tile the player
            // cannot see or press.
            if (req.onRefusal) {
                req.onRefusal("Popit refused",
                    layout.columns + " column(s) show " + capacity + " of " + actions.length +
                    " tiles; widen the surface or use more columns");
            }
            current = null;
            return { ok: false, why: "too many tiles for the frame", capacity: capacity, tiles: actions.length };
        }
        var height = FRAME_HEIGHTS[Math.min(FRAME_HEIGHTS.length - 1, Math.max(1, rows))];
        var at = place(req, height, layout.width);
        if (!at.ok) {
            current = null;
            note("REFUSED " + at.why);
            if (req.onRefusal) req.onRefusal("Popit refused", at.why);
            return { ok: false, why: at.why };
        }
        placed = at;

        // The dismiss surface is the only full-screen hit-testable panel. It is created before
        // the frame, so the frame and every tile paint above it.
        dismiss = $.CreatePanel("Panel", root, "OpenlockPopitDismiss");
        dismiss.AddClass("PopitDismiss");
        dismiss.hittest = true;
        dismiss.SetPanelEvent("onmouseactivate", close);

        surface = $.CreatePanel("Panel", root, "OpenlockPopit");
        surface.AddClass("PopitSurface");
        surface.hittest = true;
        surface.style.marginLeft = at.x + "px";
        surface.style.marginTop = at.y + "px";
        surface.style.width = layout.width + "px";

        // Tail first, frame second: the opaque plate covers the upper half of the rotated tail,
        // leaving the lower half as a speech-bubble point.
        tailPanel = $.CreatePanel("Panel", surface, "");
        tailPanel.AddClass("PopitTail");
        tailPanel.AddClass(frameClass(frame));
        tailPanel.hittest = false;

        framePanel = $.CreatePanel("Panel", surface, "");
        framePanel.AddClass("PopitFrame");
        framePanel.AddClass(frameClass(frame));
        framePanel.AddClass("PopitRows" + rows);
        framePanel.style.width = layout.width + "px";
        framePanel.hittest = true;

        var hex = $.CreatePanel("Panel", framePanel, "");
        hex.AddClass("PopitHex");
        hex.hittest = false;
        var edges = ["Top", "UpperLeft", "LowerLeft", "Bottom", "LowerRight", "UpperRight"];
        for (var e = 0; e < edges.length; e++) {
            var edge = $.CreatePanel("Panel", hex, "");
            edge.AddClass("PopitHexEdge");
            edge.AddClass(edges[e]);
            edge.hittest = false;
        }

        var plate = $.CreatePanel("Panel", framePanel, "");
        plate.AddClass("PopitPlate");
        plate.hittest = false;

        var beam = $.CreatePanel("Panel", framePanel, "");
        beam.AddClass("PopitBeam");
        beam.hittest = false;

        var body = $.CreatePanel("Panel", framePanel, "");
        body.AddClass("PopitBody");

        var header = $.CreatePanel("Panel", body, "");
        header.AddClass("PopitHeader");
        var title = $.CreatePanel("Label", header, "");
        title.AddClass("PopitHeaderTitle");
        title.text = (req.layer && req.layer.title) || "Popit";
        title.hittest = false;
        var spacer = $.CreatePanel("Panel", header, "");
        spacer.AddClass("PopitHeaderSpacer");
        spacer.hittest = false;
        var badge = $.CreatePanel("Panel", header, "");
        badge.AddClass("PopitFrameBadge");
        badge.hittest = true;
        badge.SetPanelEvent("onmouseactivate", cycleFrame);
        badgeLabel = $.CreatePanel("Label", badge, "");
        badgeLabel.text = frameById(frame).label;
        badgeLabel.hittest = false;

        var modeRow = $.CreatePanel("Panel", body, "");
        modeRow.AddClass("PopitModeRow");
        var pill = $.CreatePanel("Panel", modeRow, "");
        pill.AddClass("PopitModePill");
        var create = addMode(pill, "create", "CREATE");
        var play = addMode(pill, "play", "PLAY");
        try {
            (mode === "play" ? play : create).AddClass("Active");
        } catch (err) {}

        var grid = $.CreatePanel("Panel", body, "");
        grid.AddClass("PopitGrid");
        for (var r = 0; r < rows; r++) {
            var row = $.CreatePanel("Panel", grid, "");
            row.AddClass("PopitRow");
            for (var c = 0; c < layout.columns; c++) {
                var index = r * layout.columns + c;
                if (index >= actions.length) break;
                makeTile(row, actions[index], index);
            }
        }

        detailLabel = $.CreatePanel("Label", body, "");
        detailLabel.AddClass("PopitDetail");
        detailLabel.hittest = false;
        var hint = null;
        if (req.layer && req.layer.hint) {
            hint = $.CreatePanel("Label", body, "");
            hint.AddClass("PopitHint");
            hint.text = req.layer.hint;
            hint.hittest = false;
        }

        status.visible = true;
        status.frame = frame;
        status.mode = mode;
        status.actions = actions.length;
        status.rows = rows;
        status.columns = layout.columns;
        status.width = layout.width;
        status.placed = { x: at.x, y: at.y };
        refreshSelection();
        note("open " + frame + " " + actions.length + " tile(s) at " + at.x + "," + at.y +
            " form=" + String(req.form || "?"));

        // The frame's height is content-driven; one post-layout check keeps a tall surface
        // inside the screen without a recurring schedule.
        var expected = height;
        $.Schedule(0, function () {
            if (!surface || placed !== at) return;
            var actual = 0;
            try { actual = Number(surface.actuallayoutheight) || 0; } catch (e) {}
            if (actual <= 0) actual = expected;
            var maxY = Math.max(screen.top, screen.h - actual - 8);
            if (at.y > maxY) {
                at.y = maxY;
                try { surface.style.marginTop = maxY + "px"; } catch (e) {}
            }
        });

        return {
            ok: true, frame: frame, placed: at, rows: rows, tiles: actions.length,
            layout: { columns: layout.columns, width: layout.width, frame: frame, mode: mode, order: layout.order }
        };
    }

    globalThis.OpenlockPopit = {
        show: show,
        close: close,
        setFrame: setFrame,
        // The dashboard editor reads the legal range from the module instead of duplicating it.
        layout: function () {
            return {
                columns: currentLayout.columns, width: currentLayout.width, frame: currentLayout.frame,
                mode: currentLayout.mode, order: currentLayout.order.slice(0),
                columnsMin: 1, columnsMax: 4, widthMin: MIN_WIDTH, widthMax: MAX_WIDTH,
                maxRows: MAX_ROWS, maxOrder: 32
            };
        },
        normalizeLayout: normalizeLayout,
        status: function () { return status; },
        frames: function () {
            var ids = [];
            for (var i = 0; i < FRAMES.length; i++) ids.push(FRAMES[i].id);
            return ids;
        },
        // The dashboard's frame control reads the same list the badge cycles, so a form added
        // here appears in the editor without a second copy of the family.
        frameList: function () {
            var out = [];
            for (var i = 0; i < FRAMES.length; i++) out.push({ id: FRAMES[i].id, label: FRAMES[i].label });
            return out;
        }
    };
})();

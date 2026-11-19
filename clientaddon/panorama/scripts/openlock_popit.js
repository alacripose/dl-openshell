// Popit: the in-game cell editor, rebuilt to the design bible.
//
// The bible corrects the old surface in three ways, and this module follows all three:
//
//   ROOT / CHILD   The root stays present. Choosing a section keeps the root (same identity,
//                  same selection) and reveals a contextual child pane beside it; Back closes
//                  the child and returns the root without resetting anything. Section selection
//                  never unmounts the root into a different page.
//   ROLE MAP       The LBP3 player palette is a role map, not four decorative colours:
//                  secondary is the menu background, primary the highlight/tooltip/ownership
//                  accent, tertiary the menu accent, emphasis the emphasised text. A pair is a
//                  skin for the Popit slab; the cell edit and the shell ground are separate.
//   PERSISTENCE    The chosen pair travels in the saved layout profile (`popit=...;pair:<id>`)
//                  and is restored with the rest of the desktop, not remembered for one open.
//
// The cell edit contract is unchanged: the six axes are indexes into the tables below and
// `encodeState` still writes the fixed alphabet the host's LayoutProfiles parses.
//
// Geometry limit, stated rather than hidden: Panorama cannot draw the bible's custom Nexus
// contour as a path. The surface uses the closest per-corner approximation the form declares;
// `shell/alpha-shell/forms/popit.form` says so at the rule.
(function () {
    var FRAME = "lbp3";
    var ROOT_W = 300;
    var CHILD_W = 340;
    var GAP = 8;
    var WIDTH = ROOT_W;

    // The same six slots the shell's scheme exposes. The labels are the shell's vocabulary,
    // not a new palette: every swatch is resolved from req.palette at draw time.
    var COLORS = [
        { id: "accent", label: "Accent" },
        { id: "ink", label: "Ink" },
        { id: "muted", label: "Muted" },
        { id: "borderStrong", label: "Strong" },
        { id: "alert", label: "Alert" },
        { id: "title", label: "Title" }
    ];

    var MATERIALS = [
        { id: "paper", label: "Paper", wash: "panel" },
        { id: "card", label: "Card", wash: "title" },
        { id: "glass", label: "Glass", wash: "meta" },
        { id: "tint", label: "Tint", wash: "color" },
        { id: "ink", label: "Ink", wash: "ink" },
        { id: "accent", label: "Accent", wash: "accent" },
        { id: "none", label: "Bare", wash: "" }
    ];

    var DECORATIONS = [
        { id: "edge", label: "Edge" },
        { id: "stitch", label: "Stitch" },
        { id: "tag", label: "Tag" },
        { id: "corners", label: "Corners" },
        { id: "none", label: "None" }
    ];

    var RADII = [
        { value: -1, label: "Form" },
        { value: 0, label: "0" },
        { value: 6, label: "6" },
        { value: 12, label: "12" },
        { value: 18, label: "18" }
    ];
    var BORDERS = [
        { value: -1, label: "Form" },
        { value: 0, label: "0" },
        { value: 1, label: "1" },
        { value: 2, label: "2" },
        { value: 3, label: "3" }
    ];
    var OPACITIES = [
        { value: -1, label: "Form" },
        { value: 75, label: "75%" },
        { value: 90, label: "90%" },
        { value: 100, label: "100%" }
    ];

    // The root's sections. The short code stays on the root row as a stable label anchor; the
    // words carry the meaning, so a section is never identified by a colour or an icon alone.
    var PAGES = [
        { id: "cursor", code: "CUR", title: "Cursor", hint: "select a cell" },
        { id: "palette", code: "PAL", title: "Palette", hint: "37 player colours" },
        { id: "goodies", code: "GOO", title: "Goodies Bag", hint: "materials" },
        { id: "stickers", code: "STK", title: "Stickers", hint: "edges and decorations" },
        { id: "tools", code: "TLS", title: "Tools Bag", hint: "corners, border, opacity" },
        { id: "color", code: "CLR", title: "Player Color", hint: "scheme roles" }
    ];

    var root = null;
    var dismiss = null;
    var surface = null;
    var rootPanel = null;
    var rootBody = null;
    var child = null;
    var childBody = null;
    var childTitle = null;
    var headerTitle = null;
    var targetLabel = null;
    var detailLabel = null;
    var pairLabel = null;
    var pairDot = null;
    var classicChip = null;
    var dotRow = null;
    var cursorHalo = null;
    var rowButtons = {};
    var currentPage = "";
    var childOpen = false;
    var current = null;
    var targets = [];
    var target = null;
    var state = defaultState();
    var palette = {};
    var placed = null;
    var hovered = null;
    var pairId = "";
    var classic = false;
    var reduced = false;
    var appliedPair = "";
    var status = {
        visible: false, frame: FRAME, page: "", target: null, targets: 0,
        items: 0, pageTiles: 0, placed: null, width: WIDTH, pair: "", classic: false,
        child: false, reducedMotion: false
    };

    function defaultState() {
        return { material: "none", color: "", decoration: "none", radius: -1, border: -1, opacity: -1 };
    }

    function note(text) {
        try { $.Msg("[Openlock] popit: ", text); } catch (e) {}
    }

    function clampInt(value, low, high, fallback) {
        var n = Math.round(Number(value));
        if (!isFinite(n)) return fallback;
        return Math.max(low, Math.min(high, n));
    }

    function normalizeState(input) {
        var src = input || {};
        var out = defaultState();
        var material = String(src.material || "none");
        var decoration = String(src.decoration || "none");
        var color = String(src.color || "");
        for (var m = 0; m < MATERIALS.length; m++) if (MATERIALS[m].id === material) out.material = material;
        for (var d = 0; d < DECORATIONS.length; d++) if (DECORATIONS[d].id === decoration) out.decoration = decoration;
        for (var c = 0; c < COLORS.length; c++) if (COLORS[c].id === color) out.color = color;
        out.radius = clampInt(src.radius, -1, 18, -1);
        out.border = clampInt(src.border, -1, 3, -1);
        out.opacity = clampInt(src.opacity, -1, 100, -1);
        return out;
    }

    // A saved profile carries one compact style per cell. The six axes are indexes into the
    // same tables the surface draws, so a profile can never name a material or colour the
    // editor does not have. `-1` is the form's own value, not a colour or a radius.
    var MATERIAL_INDEX = ["paper", "card", "glass", "tint", "ink", "accent", "none"];
    var COLOR_INDEX = ["", "accent", "ink", "muted", "borderStrong", "alert", "title"];
    var DECORATION_INDEX = ["edge", "stitch", "tag", "corners", "none"];

    function indexOf(list, value) {
        for (var i = 0; i < list.length; i++) if (list[i] === value) return i;
        return -1;
    }

    function indexValue(list, value) {
        for (var i = 0; i < list.length; i++) if (Number(list[i].value) === Number(value)) return Number(value);
        return -1;
    }

    function hasEdit(input) {
        var s = normalizeState(input);
        return s.material !== "none" || s.decoration !== "none" || !!s.color ||
            s.radius >= 0 || s.border >= 0 || s.opacity >= 0;
    }

    function encodeState(input) {
        var s = normalizeState(input);
        if (!hasEdit(s)) return "";
        var m = indexOf(MATERIAL_INDEX, s.material);
        var c = indexOf(COLOR_INDEX, s.color);
        var d = indexOf(DECORATION_INDEX, s.decoration);
        var r = indexValue(RADII, s.radius);
        var b = indexValue(BORDERS, s.border);
        var o = indexValue(OPACITIES, s.opacity);
        if (m < 0) m = MATERIAL_INDEX.length - 1;
        if (c < 0) c = 0;
        if (d < 0) d = DECORATION_INDEX.length - 1;
        return "m" + m + "c" + c + "d" + d + "r" + r + "b" + b + "o" + o;
    }

    function decodeState(code) {
        var text = String(code || "");
        var match = /^m([0-6])c([0-6])d([0-4])r(-1|0|6|12|18)b(-1|0|1|2|3)o(-1|75|90|100)$/.exec(text);
        if (!match) return null;
        return normalizeState({
            material: MATERIAL_INDEX[Number(match[1])],
            color: COLOR_INDEX[Number(match[2])],
            decoration: DECORATION_INDEX[Number(match[3])],
            radius: Number(match[4]),
            border: Number(match[5]),
            opacity: Number(match[6])
        });
    }

    // --- colour pairs ---------------------------------------------------------
    // The table is generated from shell/alpha-shell/popit-pairs.json by
    // tools/gen_popit_pairs.py. A missing table refuses the page instead of inventing colours.

    function pairList() {
        var data = globalThis.OpenlockPopitPairs;
        return data && data.pairs instanceof Array ? data.pairs : [];
    }

    function defaultPairId() {
        var data = globalThis.OpenlockPopitPairs;
        return data && data.default ? String(data.default) : "";
    }

    function pairById(id) {
        var pairs = pairList();
        for (var i = 0; i < pairs.length; i++) if (pairs[i].id === id) return pairs[i];
        return null;
    }

    function pairClass(id) {
        // Keep this identical to pair_class() in tools/gen_popit_pairs.py.
        var words = String(id || "").split(/[-_]/);
        var out = "Pair";
        for (var i = 0; i < words.length; i++) {
            if (!words[i]) continue;
            out += words[i].charAt(0).toUpperCase() + words[i].slice(1);
        }
        return out;
    }

    function applyPairClass() {
        if (!surface) return;
        if (appliedPair) {
            try { surface.RemoveClass(appliedPair); } catch (e) {}
            appliedPair = "";
        }
        if (classic || !pairId || !pairById(pairId)) return;
        appliedPair = pairClass(pairId);
        try { surface.AddClass(appliedPair); } catch (e) { note("pair class refused " + appliedPair); }
    }

    function pageSpec(id) {
        for (var i = 0; i < PAGES.length; i++) if (PAGES[i].id === id) return PAGES[i];
        return null;
    }

    function targetTitle() {
        return target ? target.title : "no cell selected";
    }

    function targetDetail() {
        if (!target) return "point at a cell";
        var kind = target.kind === "window" ? "window" : (target.kind === "panel" ? "game panel" : "cell");
        return kind + (target.detail ? " · " + target.detail : "");
    }

    function renderHeader() {
        var spec = pageSpec(currentPage);
        if (headerTitle) headerTitle.text = spec ? spec.title.toUpperCase() : "POPIT";
        if (targetLabel) targetLabel.text = targetTitle() + (target ? "  ·  " + targetDetail() : "");
        var pair = classic ? null : pairById(pairId);
        if (pairLabel) pairLabel.text = classic ? "Classic" : (pair ? pair.name : "No pair");
        if (pairDot) {
            try {
                pairDot.style.backgroundColor = pair ? pair.secondary : "transparent";
                pairDot.style.borderColor = pair ? pair.primary : "";
            } catch (e) {}
        }
        if (classicChip) {
            try {
                if (classic) classicChip.AddClass("On");
                else classicChip.RemoveClass("On");
            } catch (e) {}
        }
        for (var id in rowButtons) {
            if (!rowButtons.hasOwnProperty(id)) continue;
            try {
                if (id === currentPage) rowButtons[id].AddClass("Active");
                else rowButtons[id].RemoveClass("Active");
            } catch (e) {}
        }
        if (dotRow) {
            for (var d = 0; d < dotRow.GetChildCount(); d++) {
                var dot = dotRow.GetChild(d);
                try {
                    if (dot.pairPage === currentPage) dot.AddClass("On");
                    else dot.RemoveClass("On");
                } catch (e) {}
            }
        }
    }

    function choosePair(pair) {
        if (!pair) return;
        pairId = pair.id;
        classic = false;
        status.pair = pairId;
        status.classic = false;
        applyPairClass();
        renderHeader();
        renderChild();
        if (current && current.onPair) {
            try { current.onPair(pair); } catch (e) {}
        }
        if (detailLabel) detailLabel.text = "palette  ·  " + pair.name + "  ·  " + pair.game;
        note("pair " + pairId);
    }

    function setClassic(on) {
        classic = !!on;
        if (surface) {
            try {
                if (classic) surface.AddClass("Classic");
                else surface.RemoveClass("Classic");
            } catch (e) {}
        }
        applyPairClass();
        renderHeader();
        renderChild();
        status.classic = classic;
        if (current && current.onClassic) {
            try { current.onClassic(classic); } catch (e) {}
        }
        if (detailLabel) detailLabel.text = classic
            ? "classic  ·  the scheme's own colours"
            : "palette  ·  " + (pairById(pairId) ? pairById(pairId).name : "no pair");
        note("classic " + classic);
    }

    function normalizeTarget(input) {
        if (!input) return null;
        var rect = input.rect || input.geometry || null;
        var out = {
            id: String(input.id || ""),
            title: String(input.title || input.id || "cell"),
            kind: String(input.kind || "cell"),
            detail: String(input.detail || "")
        };
        if (rect && isFinite(Number(rect.x)) && isFinite(Number(rect.y)) &&
            isFinite(Number(rect.w)) && isFinite(Number(rect.h))) {
            out.rect = {
                x: Number(rect.x), y: Number(rect.y),
                w: Math.max(1, Number(rect.w)), h: Math.max(1, Number(rect.h))
            };
        }
        return out;
    }

    function normalizeTargets(list) {
        var out = [];
        var raw = list instanceof Array ? list : [];
        for (var i = 0; i < raw.length && out.length < 64; i++) {
            var t = normalizeTarget(raw[i]);
            if (t && t.id) out.push(t);
        }
        return out;
    }

    function paletteValue(role, fallback) {
        return palette[role] || palette[fallback] || "";
    }

    function currentColor() {
        return state.color ? paletteValue(state.color, "accent") : paletteValue("accent", "ink");
    }

    function overlaps(a, b) {
        var pad = 6;
        return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x &&
            a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
    }

    // The root and the child are one instrument: the child opens beside the root, and the pair
    // stays glued to whichever side has room. A full desktop falls back to a clamped position
    // rather than refusing to open.
    function place(req, height, width) {
        var s = (req && req.screen) || { w: 1600, h: 900, top: 46 };
        var sw = Number(s.w) || 1600;
        var sh = Number(s.h) || 900;
        var top = Number(s.top) || 46;
        var w = width || WIDTH;
        var candidates = [];
        if (target && target.rect) {
            var g = target.rect;
            candidates.push({ x: Math.round(g.x + g.w + 10), y: Math.round(g.y) });
            candidates.push({ x: Math.round(g.x - w - 10), y: Math.round(g.y) });
            candidates.push({ x: Math.round(g.x), y: Math.round(g.y + g.h + 8) });
            candidates.push({ x: Math.round(g.x), y: Math.round(g.y - height - 8) });
            candidates.push({ x: Math.round(g.x + g.w - w - 8), y: Math.round(g.y + 24) });
        }
        candidates.push({ x: Math.round((sw - w) / 2), y: Math.round(top + 18) });
        var blockers = [];
        var open = req && req.openRects instanceof Array ? req.openRects : [];
        for (var b = 0; b < open.length; b++) {
            var r = open[b];
            if (!r || r.id === (target && target.id)) continue;
            blockers.push({ x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h) });
        }
        for (var i = 0; i < candidates.length; i++) {
            var at = {
                x: Math.max(8, Math.min(Math.max(8, sw - w - 8), candidates[i].x)),
                y: Math.max(top, Math.min(Math.max(top, sh - height - 8), candidates[i].y)),
                w: w,
                h: height
            };
            var hit = target && target.rect && overlaps(at, target.rect);
            for (var k = 0; !hit && k < blockers.length; k++) {
                if (isFinite(blockers[k].w) && overlaps(at, blockers[k])) hit = true;
            }
            if (!hit || i === candidates.length - 1) return { ok: true, x: at.x, y: at.y };
        }
        return { ok: true, x: 8, y: top };
    }

    function clearChildren(panel) {
        if (!panel) return;
        var kids = [];
        try {
            for (var i = 0; i < panel.GetChildCount(); i++) kids.push(panel.GetChild(i));
        } catch (e) {}
        for (var k = 0; k < kids.length; k++) {
            try { kids[k].DeleteAsync(0); } catch (e) {}
        }
    }

    function addLabel(parent, cls, text) {
        var label = $.CreatePanel("Label", parent, "");
        label.AddClass(cls);
        label.text = text;
        label.hittest = false;
        return label;
    }

    function bindHover(panel, title, body) {
        panel.SetPanelEvent("onmouseover", function () {
            hovered = panel;
            try { panel.AddClass("Hover"); } catch (e) {}
            if (current && current.onHover) {
                try { current.onHover(panel, title, body); } catch (e) {}
            }
            paintHalo();
        });
        panel.SetPanelEvent("onmouseout", function () {
            if (hovered === panel) hovered = null;
            try { panel.RemoveClass("Hover"); } catch (e) {}
            if (current && current.onHoverEnd) {
                try { current.onHoverEnd(); } catch (e) {}
            }
            paintHalo();
        });
    }

    function paintHalo() {
        if (!cursorHalo) return;
        if (!target || !target.rect) {
            try { cursorHalo.style.visibility = "collapse"; } catch (e) {}
            return;
        }
        var r = target.rect;
        try {
            cursorHalo.style.visibility = "visible";
            cursorHalo.style.marginLeft = Math.round(r.x) + "px";
            cursorHalo.style.marginTop = Math.round(r.y) + "px";
            cursorHalo.style.width = Math.round(r.w) + "px";
            cursorHalo.style.height = Math.round(r.h) + "px";
            cursorHalo.style.borderColor = currentColor();
        } catch (e) {}
    }

    function close() {
        var wasVisible = !!surface;
        if (surface) {
            try { surface.DeleteAsync(0); } catch (e) {}
        }
        if (dismiss) {
            try { dismiss.DeleteAsync(0); } catch (e) {}
        }
        if (cursorHalo) {
            try { cursorHalo.DeleteAsync(0); } catch (e) {}
        }
        surface = null;
        dismiss = null;
        cursorHalo = null;
        rootPanel = null;
        rootBody = null;
        child = null;
        childBody = null;
        childTitle = null;
        headerTitle = null;
        targetLabel = null;
        detailLabel = null;
        pairLabel = null;
        pairDot = null;
        classicChip = null;
        dotRow = null;
        rowButtons = {};
        placed = null;
        hovered = null;
        appliedPair = "";
        currentPage = "";
        childOpen = false;
        status.visible = false;
        status.placed = null;
        status.page = "";
        status.child = false;
        if (wasVisible && current && current.onClose) {
            try { current.onClose(); } catch (e) {}
        }
    }

    function selectedValue(field, value) {
        if (field === "radius" || field === "border" || field === "opacity") {
            return Number(state[field]) === Number(value);
        }
        return String(state[field] || "") === String(value || "");
    }

    function markSelected(items, field) {
        for (var i = 0; i < items.length; i++) {
            try {
                if (selectedValue(field, items[i].value)) items[i].panel.AddClass("Selected");
                else items[i].panel.RemoveClass("Selected");
            } catch (e) {}
        }
    }

    function itemDetail(item, field) {
        if (field === "material") return "material  ·  " + item.label;
        if (field === "decoration") return "decoration  ·  " + item.label;
        if (field === "color") return "player colour  ·  " + item.label;
        return field + "  ·  " + item.label;
    }

    function commit(field, value, label) {
        var patch = {};
        patch[field] = value;
        var next = normalizeState(state);
        for (var key in patch) if (patch.hasOwnProperty(key)) next[key] = patch[key];
        state = next;
        if (current && current.onApply) {
            try { current.onApply(state, field, value); } catch (e) {}
        }
        if (detailLabel) detailLabel.text = label;
        paintHalo();
        renderChild();
        note("edit " + field + "=" + String(value));
    }

    // The bible's labeller: an uppercase section label and a dashed rule to a collapse mark.
    function section(title) {
        var group = $.CreatePanel("Panel", childBody, "");
        group.AddClass("PopitSection");
        var head = $.CreatePanel("Panel", group, "");
        head.AddClass("PopitSectionHead");
        addLabel(head, "PopitSectionLabel", String(title).toUpperCase());
        var rule = $.CreatePanel("Panel", head, "");
        rule.AddClass("PopitSectionRule");
        return group;
    }

    function addGridItem(parent, spec) {
        var item = $.CreatePanel("Panel", parent, "");
        item.AddClass("PopitItem");
        item.hittest = true;
        var swatch = $.CreatePanel("Panel", item, "");
        swatch.AddClass("PopitSwatch");
        swatch.hittest = false;
        if (spec.wash) {
            try { swatch.style.backgroundColor = spec.wash; } catch (e) {}
        }
        if (spec.border) {
            try {
                swatch.style.borderColor = spec.border;
                swatch.style.borderStyle = spec.borderStyle || "solid";
            } catch (e) {}
        }
        if (spec.dash) {
            try { swatch.style.borderStyle = "dashed"; } catch (e) {}
        }
        var label = addLabel(item, "PopitItemLabel", spec.label);
        item.value = spec.value;
        item.panel = item;
        bindHover(item, spec.label, spec.detail || spec.label);
        item.SetPanelEvent("onmouseactivate", function () {
            commit(spec.field, spec.value, itemDetail(spec, spec.field));
        });
        return item;
    }

    function buildGrid(field, specs, title) {
        var host = title ? section(title) : childBody;
        var grid = $.CreatePanel("Panel", host, "");
        grid.AddClass("PopitGrid");
        var made = [];
        for (var i = 0; i < specs.length; i++) {
            var spec = specs[i];
            spec.field = field;
            made.push(addGridItem(grid, spec));
        }
        markSelected(made, field);
        status.pageTiles += made.length;
        return grid;
    }

    function materialSpecs() {
        var out = [];
        for (var i = 0; i < MATERIALS.length; i++) {
            var m = MATERIALS[i];
            var wash = "";
            if (m.wash === "color") wash = currentColor();
            else if (m.wash) wash = paletteValue(m.wash, "panel");
            out.push({
                id: m.id, label: m.label, value: m.id, wash: wash,
                detail: m.id === "none" ? "restore the cell surface" : "material  ·  " + m.label
            });
        }
        return out;
    }

    function decorationSpecs() {
        var out = [];
        for (var i = 0; i < DECORATIONS.length; i++) {
            var d = DECORATIONS[i];
            out.push({
                id: d.id, label: d.label, value: d.id, wash: "",
                border: d.id === "none" ? "" : currentColor(),
                borderStyle: d.id === "stitch" ? "dashed" : "solid",
                detail: d.id === "none" ? "remove the decoration" : "decoration  ·  " + d.label
            });
        }
        return out;
    }

    function colorSpecs() {
        var out = [];
        out.push({ id: "default", label: "Default", value: "", wash: "", detail: "use the form's colour" });
        for (var i = 0; i < COLORS.length; i++) {
            var c = COLORS[i];
            out.push({
                id: c.id, label: c.label, value: c.id,
                wash: paletteValue(c.id, "accent"),
                detail: "player colour  ·  " + c.label
            });
        }
        return out;
    }

    function buildCursorPage() {
        var host = section("Cells");
        if (!targets.length) {
            addLabel(host, "PopitEmpty", "No open cell. Split a game window into cells, or open a panel, then press Popit again.");
            status.pageTiles = 0;
            return;
        }
        var list = $.CreatePanel("Panel", host, "");
        list.AddClass("PopitTargetList");
        for (var i = 0; i < targets.length; i++) {
            (function (t) {
                var row = $.CreatePanel("Panel", list, "");
                row.AddClass("PopitTarget");
                row.hittest = true;
                if (target && t.id === target.id) row.AddClass("Selected");
                addLabel(row, "PopitTargetName", t.title);
                addLabel(row, "PopitTargetKind",
                    (t.kind === "window" ? "window" : (t.kind === "panel" ? "game panel" : "cell")) +
                    (t.detail ? "  ·  " + t.detail : ""));
                bindHover(row, t.title, "select this cell with the Popit cursor");
                row.SetPanelEvent("onmouseactivate", function () {
                    if (current && current.onSelect) {
                        try { current.onSelect(t); } catch (e) {}
                    }
                });
            })(targets[i]);
        }
        status.pageTiles = targets.length;
    }

    function addPairItem(parent, pair) {
        var item = $.CreatePanel("Panel", parent, "");
        item.AddClass("PopitItem");
        item.AddClass("PopitItemPair");
        item.hittest = true;
        if (!classic && pair.id === pairId) item.AddClass("Selected");
        var strip = $.CreatePanel("Panel", item, "");
        strip.AddClass("PopitPairSwatch");
        strip.hittest = false;
        var roles = ["primary", "secondary", "tertiary"];
        for (var i = 0; i < roles.length; i++) {
            var band = $.CreatePanel("Panel", strip, "");
            band.AddClass("PopitPairBand");
            band.hittest = false;
            try { band.style.backgroundColor = pair[roles[i]]; } catch (e) {}
        }
        addLabel(item, "PopitItemLabel", pair.name);
        addLabel(item, "PopitPairGame", pair.game);
        item.value = pair.id;
        item.pair = pair;
        bindHover(item, pair.name, pair.game + "  ·  palette");
        item.SetPanelEvent("onmouseactivate", function () { choosePair(pair); });
        return item;
    }

    function buildPairPage() {
        var pairs = pairList();
        if (!pairs.length) {
            var empty = section("Palette");
            addLabel(empty, "PopitEmpty", "The colour-pair table is not in this build. The scheme's own colours still apply.");
            status.pageTiles = 0;
            return;
        }
        var games = [];
        for (var i = 0; i < pairs.length; i++) {
            if (games.indexOf(pairs[i].game) < 0) games.push(pairs[i].game);
        }
        for (var g = 0; g < games.length; g++) {
            var host = section(games[g]);
            var grid = $.CreatePanel("Panel", host, "");
            grid.AddClass("PopitGrid");
            grid.AddClass("PopitPairGrid");
            for (var p = 0; p < pairs.length; p++) {
                if (pairs[p].game !== games[g]) continue;
                addPairItem(grid, pairs[p]);
                status.pageTiles++;
            }
        }
        var noteRow = section("Pair");
        addLabel(noteRow, "PopitPairNote",
            classic
                ? "Classic is on; pick a pair to leave it."
                : "The pair skins this slab and its title. The cell's own colour is on Player Color.");
    }

    function optionGroup(title, field, options) {
        var group = section(title);
        var row = $.CreatePanel("Panel", group, "");
        row.AddClass("PopitOptionRow");
        var made = [];
        for (var i = 0; i < options.length; i++) {
            (function (opt) {
                var button = $.CreatePanel("Panel", row, "");
                button.AddClass("PopitOption");
                button.hittest = true;
                addLabel(button, "PopitOptionLabel", opt.label);
                button.value = opt.value;
                button.panel = button;
                made.push(button);
                bindHover(button, title + ": " + opt.label, "tweak  ·  " + title.toLowerCase());
                button.SetPanelEvent("onmouseactivate", function () {
                    commit(field, opt.value, title + "  ·  " + opt.label);
                });
            })(options[i]);
        }
        markSelected(made, field);
        return group;
    }

    function buildToolsPage() {
        optionGroup("Corners", "radius", RADII);
        optionGroup("Border", "border", BORDERS);
        optionGroup("Opacity", "opacity", OPACITIES);
        status.pageTiles = RADII.length + BORDERS.length + OPACITIES.length;
        var host = section("Reset");
        var reset = $.CreatePanel("Panel", host, "");
        reset.AddClass("PopitReset");
        reset.hittest = true;
        addLabel(reset, "PopitResetLabel", "Restore this cell");
        bindHover(reset, "Restore this cell", "remove every Popit edit from the selected cell");
        reset.SetPanelEvent("onmouseactivate", function () {
            if (current && current.onReset) {
                try { current.onReset(state); } catch (e) {}
            }
            state = defaultState();
            paintHalo();
            renderChild();
            if (detailLabel) detailLabel.text = "cell restored to the game's rendering";
        });
        status.pageTiles += 1;
    }

    function renderChild() {
        if (!childBody) return;
        clearChildren(childBody);
        status.pageTiles = 0;
        var spec = pageSpec(currentPage);
        if (childTitle) childTitle.text = spec ? spec.title.toUpperCase() : "";
        if (!spec) return;
        if (currentPage === "cursor") buildCursorPage();
        else if (currentPage === "palette") buildPairPage();
        else if (currentPage === "goodies") buildGrid("material", materialSpecs(), "Materials");
        else if (currentPage === "stickers") buildGrid("decoration", decorationSpecs(), "Decorations");
        else if (currentPage === "tools") buildToolsPage();
        else if (currentPage === "color") buildGrid("color", colorSpecs(), "Player Colour");
    }

    // Opening a section keeps the root mounted and reveals the child beside it. That is the
    // bible's P0: the root is a persistent personal tool, not a page that is replaced.
    function openSection(id) {
        var spec = pageSpec(id);
        if (!spec) return false;
        currentPage = spec.id;
        childOpen = true;
        if (surface) {
            try { surface.AddClass("ChildOpen"); } catch (e) {}
            try { surface.style.width = (ROOT_W + GAP + CHILD_W) + "px"; } catch (e) {}
        }
        if (child) {
            try { child.style.visibility = "visible"; } catch (e) {}
        }
        if (detailLabel) detailLabel.text = "editing " + (target ? target.title : "no cell");
        status.page = currentPage;
        status.child = true;
        renderHeader();
        renderChild();
        note("child " + currentPage);
        return true;
    }

    function closeSection() {
        currentPage = "";
        childOpen = false;
        if (surface) {
            try { surface.RemoveClass("ChildOpen"); } catch (e) {}
            try { surface.style.width = ROOT_W + "px"; } catch (e) {}
        }
        if (child) {
            try { child.style.visibility = "collapse"; } catch (e) {}
        }
        if (childBody) clearChildren(childBody);
        status.page = "";
        status.child = false;
        status.pageTiles = 0;
        renderHeader();
        if (detailLabel) detailLabel.text = target ? "editing " + target.title : "select a cell with the cursor";
        note("child closed");
    }

    function setPage(id) {
        if (!id) {
            closeSection();
            return;
        }
        openSection(id);
    }

    function addRootRow(parent, spec) {
        var row = $.CreatePanel("Panel", parent, "");
        row.AddClass("PopitRootRow");
        row.hittest = true;
        var code = addLabel(row, "PopitRootCode", spec.code);
        code.hittest = false;
        var name = addLabel(row, "PopitRootName", spec.title);
        name.hittest = false;
        var hint = addLabel(row, "PopitRootHint", spec.hint);
        hint.hittest = false;
        bindHover(row, spec.title, spec.hint);
        row.SetPanelEvent("onmouseactivate", function () { openSection(spec.id); });
        rowButtons[spec.id] = row;
        return row;
    }

    function addDot(parent, spec) {
        var dot = $.CreatePanel("Panel", parent, "");
        dot.AddClass("PopitPageDot");
        dot.pairPage = spec.id;
        dot.hittest = true;
        bindHover(dot, spec.title, "open the " + spec.title.toLowerCase() + " section");
        dot.SetPanelEvent("onmouseactivate", function () { openSection(spec.id); });
        return dot;
    }

    function animate() {
        if (!surface || reduced) return;
        try {
            surface.style.opacity = "0";
            surface.style.transform = "translate3d(0, 8px, 0)";
        } catch (e) {}
        $.Schedule(0, function () {
            if (!surface) return;
            try {
                surface.style.opacity = "1";
                surface.style.transform = "translate3d(0, 0, 0)";
            } catch (e) {}
        });
    }

    function show(req) {
        if (!req || !req.root) {
            note("REFUSED no root panel");
            return { ok: false, why: "no root panel" };
        }
        close();
        root = req.root;
        current = req;
        palette = req.palette || {};
        targets = normalizeTargets(req.targets);
        target = normalizeTarget(req.target);
        if (!target && targets.length && req.autoSelect) target = targets[0];
        state = normalizeState(req.state);
        pairId = req.pair && pairById(req.pair) ? String(req.pair) : defaultPairId();
        classic = !!req.classic;
        reduced = !!req.reducedMotion;
        currentPage = "";
        childOpen = false;

        var at = place(req, 320, ROOT_W);
        placed = at;

        dismiss = $.CreatePanel("Panel", root, "OpenlockPopitDismiss");
        dismiss.AddClass("PopitDismiss");
        dismiss.hittest = true;
        try { dismiss.style.top = "0px"; dismiss.style.left = "0px"; } catch (e) {}
        dismiss.SetPanelEvent("onmouseactivate", close);

        cursorHalo = $.CreatePanel("Panel", root, "OpenlockPopitCursor");
        cursorHalo.AddClass("PopitCursorHalo");
        cursorHalo.hittest = false;
        cursorHalo.hittestchildren = false;
        try { cursorHalo.style.top = "0px"; cursorHalo.style.left = "0px"; } catch (e) {}
        paintHalo();

        surface = $.CreatePanel("Panel", root, "OpenlockPopit");
        surface.AddClass("PopitSurface");
        surface.AddClass("Lbp3");
        surface.hittest = true;
        if (reduced) {
            try { surface.AddClass("ReducedMotion"); } catch (e) {}
        }
        try { surface.style.top = "0px"; surface.style.left = "0px"; } catch (e) {}
        surface.style.marginLeft = at.x + "px";
        surface.style.marginTop = at.y + "px";
        surface.style.width = ROOT_W + "px";
        if (classic) {
            try { surface.AddClass("Classic"); } catch (e) {}
        }
        applyPairClass();

        // The root: identity, the pair chip, the six sections and the page dots. It stays.
        rootPanel = $.CreatePanel("Panel", surface, "");
        rootPanel.AddClass("PopitRoot");
        rootPanel.AddClass("PopitTray");
        rootPanel.hittest = true;

        var header = $.CreatePanel("Panel", rootPanel, "");
        header.AddClass("PopitHeader");
        var top = $.CreatePanel("Panel", header, "");
        top.AddClass("PopitHeaderRow");
        addLabel(top, "PopitWordmark", "POPIT");
        var spacer = $.CreatePanel("Panel", top, "");
        spacer.AddClass("PopitHeaderSpacer");
        var pairChip = $.CreatePanel("Panel", top, "");
        pairChip.AddClass("PopitPairChip");
        pairChip.hittest = true;
        pairDot = $.CreatePanel("Panel", pairChip, "");
        pairDot.AddClass("PopitPairDot");
        pairDot.hittest = false;
        pairLabel = addLabel(pairChip, "PopitPairChipLabel", "Pair");
        bindHover(pairChip, "Popit colour pair", "open the 37 player colours");
        pairChip.SetPanelEvent("onmouseactivate", function () { openSection("palette"); });
        classicChip = $.CreatePanel("Panel", top, "");
        classicChip.AddClass("PopitClassicChip");
        classicChip.hittest = true;
        addLabel(classicChip, "PopitClassicChipLabel", "Classic");
        bindHover(classicChip, "Classic", "drop the pair and use the scheme's own colours");
        classicChip.SetPanelEvent("onmouseactivate", function () { setClassic(!classic); });

        headerTitle = addLabel(header, "PopitHeaderTitle", "POPIT");
        targetLabel = addLabel(header, "PopitTargetLabel", "");

        rootBody = $.CreatePanel("Panel", rootPanel, "");
        rootBody.AddClass("PopitRootBody");
        for (var p = 0; p < PAGES.length; p++) addRootRow(rootBody, PAGES[p]);

        dotRow = $.CreatePanel("Panel", rootPanel, "");
        dotRow.AddClass("PopitPageDots");
        dotRow.hittest = true;
        for (var d = 0; d < PAGES.length; d++) addDot(dotRow, PAGES[d]);

        detailLabel = addLabel(rootPanel, "PopitDetail", "");

        // The child: one contextual pane. It reveals beside the root and is closed by Back.
        child = $.CreatePanel("Panel", surface, "");
        child.AddClass("PopitChild");
        child.hittest = true;
        try { child.style.visibility = "collapse"; } catch (e) {}
        var childHead = $.CreatePanel("Panel", child, "");
        childHead.AddClass("PopitChildHead");
        var back = $.CreatePanel("Panel", childHead, "");
        back.AddClass("PopitBack");
        back.hittest = true;
        addLabel(back, "PopitBackLabel", "Back");
        bindHover(back, "Back", "close this pane and keep the Popit root");
        back.SetPanelEvent("onmouseactivate", closeSection);
        childTitle = addLabel(childHead, "PopitChildTitle", "");
        childBody = $.CreatePanel("Panel", child, "");
        childBody.AddClass("PopitPage");
        childBody.hittest = true;

        status.visible = true;
        status.frame = FRAME;
        status.target = target ? target.id : "";
        status.targets = targets.length;
        status.placed = { x: at.x, y: at.y };
        status.width = ROOT_W;
        status.items = 0;
        status.pair = pairId;
        status.classic = classic;
        status.reducedMotion = reduced;

        renderHeader();
        if (detailLabel) detailLabel.text = target ? "editing " + target.title : "select a cell with the cursor";
        if (req.page) openSection(req.page);
        animate();
        note("open target=" + (target ? target.id : "none") + " page=" + (currentPage || "root") +
            " pair=" + (pairId || "none") + " at " + at.x + "," + at.y);

        $.Schedule(0, function () {
            if (!surface || placed !== at) return;
            var actual = 0;
            try { actual = Number(surface.actuallayoutheight) || 0; } catch (e) {}
            if (actual <= 0) actual = 320;
            var maxY = Math.max(Number(req.screen && req.screen.top) || 46,
                (Number(req.screen && req.screen.h) || 900) - actual - 8);
            if (at.y > maxY) {
                at.y = maxY;
                try { surface.style.marginTop = maxY + "px"; } catch (e) {}
            }
        });

        return {
            ok: true, frame: FRAME, placed: at, page: currentPage, target: target,
            targets: targets.length, tiles: status.pageTiles, pair: pairId, classic: classic,
            child: childOpen, reducedMotion: reduced, layout: { frame: FRAME }
        };
    }

    function setTarget(next, page) {
        target = normalizeTarget(next);
        status.target = target ? target.id : "";
        paintHalo();
        renderHeader();
        if (page) openSection(page);
        else renderChild();
    }

    function setPair(id) {
        var pair = pairById(id);
        if (!pair) return false;
        choosePair(pair);
        return true;
    }

    function setReducedMotion(on) {
        reduced = !!on;
        status.reducedMotion = reduced;
        if (!surface) return;
        try {
            if (reduced) surface.AddClass("ReducedMotion");
            else surface.RemoveClass("ReducedMotion");
        } catch (e) {}
    }

    // The `popit=` layout row. The module owns the grammar so the shell writer, the host reader
    // and the browser probe share one definition instead of three copies. The C#
    // LayoutProfiles reader accepts the same fields; this side drops an unknown pair id rather
    // than painting a palette the table does not contain.
    function encodeProfile(input) {
        var src = input || {};
        var columns = clampInt(src.columns, 1, 4, 4);
        var width = clampInt(src.width, 240, 900, 356);
        var mode = src.mode === "play" ? "play" : "create";
        var order = [];
        if (src.order instanceof Array) {
            for (var i = 0; i < src.order.length && order.length < 32; i++) {
                var id = String(src.order[i] || "");
                if (id && order.indexOf(id) < 0) order.push(id);
            }
        }
        var pair = typeof src.pair === "string" && pairById(src.pair) ? src.pair : "";
        return "columns:" + columns + ";width:" + width + ";frame:" + FRAME +
            ";mode:" + mode + ";order:" + order.join("+") + ";pair:" + pair;
    }

    function decodeProfile(row) {
        var text = String(row == null ? "" : row);
        if (text.indexOf("popit=") === 0) text = text.slice("popit=".length);
        var out = { columns: 4, width: 356, frame: FRAME, mode: "create", order: [], pair: "" };
        var fields = text.split(";");
        for (var i = 0; i < fields.length; i++) {
            var at = fields[i].indexOf(":");
            if (at < 0) continue;
            var key = fields[i].slice(0, at);
            var value = fields[i].slice(at + 1);
            if (key === "columns") out.columns = clampInt(value, 1, 4, 4);
            else if (key === "width") out.width = clampInt(value, 240, 900, 356);
            else if (key === "mode") out.mode = value === "play" ? "play" : "create";
            else if (key === "order") {
                var ids = value ? value.split("+") : [];
                for (var o = 0; o < ids.length && out.order.length < 32; o++) {
                    if (ids[o] && out.order.indexOf(ids[o]) < 0) out.order.push(ids[o]);
                }
            } else if (key === "pair") {
                out.pair = pairById(value) ? value : "";
            }
        }
        return out;
    }

    globalThis.OpenlockPopit = {
        show: show,
        close: close,
        setTarget: setTarget,
        setPage: setPage,
        openSection: openSection,
        closeSection: closeSection,
        setPair: setPair,
        setClassic: setClassic,
        setReducedMotion: setReducedMotion,
        state: function () { return normalizeState(state); },
        normalizeState: normalizeState,
        defaultState: defaultState,
        hasEdit: hasEdit,
        encodeState: encodeState,
        decodeState: decodeState,
        encodeProfile: encodeProfile,
        decodeProfile: decodeProfile,
        targets: function () { return targets.slice(0); },
        status: function () { return status; },
        pair: function () { return pairId; },
        classic: function () { return classic; },
        pairs: function () { return pairList().slice(0); },
        frames: function () { return [FRAME]; },
        frameList: function () { return [{ id: FRAME, label: "LBP3" }]; },
        pages: function () {
            var out = [];
            for (var i = 0; i < PAGES.length; i++) out.push({ id: PAGES[i].id, title: PAGES[i].title });
            return out;
        },
        items: function (page) {
            if (page === "goodies") return MATERIALS.slice(0);
            if (page === "stickers") return DECORATIONS.slice(0);
            if (page === "color") return COLORS.slice(0);
            if (page === "palette") return pairList().slice(0);
            if (page === "tools") return { radius: RADII.slice(0), border: BORDERS.slice(0), opacity: OPACITIES.slice(0) };
            return [];
        }
    };
})();

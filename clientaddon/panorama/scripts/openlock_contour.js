// The contour is the framing authority for the Panorama shell, exactly as it is for the
// native client. `openlock_contour_data.js` carries the measured page 9 profile and the pin;
// this file draws it as nine slices, because Panorama has no `clip-path`:
//
//   * a crown is a stack of one pixel rows whose spans are cut from the profile;
//   * a rail is one panel across the span between the two crowns;
//   * nothing is scaled. A row is one pixel high at every surface size, so the shape never
//     stretches, it lengthens.
//
// The corner is the accepted taskbar button corner. `cornerPx` shrinks only when a surface is
// too short to hold it (`h / 3` fitted by the collar), which is the same arithmetic the native
// client uses, so a 22 px taskbar chip and a 660 px window read as one shape.
(function () {
    "use strict";

    var data = globalThis.OpenlockContourData || null;
    var refused = [];

    function refuse(host, code) {
        if (!host) return;
        try { host.AddClass("ContourRefused"); } catch (e) { /* panel already gone */ }
        try { host.SetAttributeString("data-refused", code); } catch (e) { /* not a panel */ }
        refused.push({ code: code, surface: String(host.id || "panel") });
        if (!host.__contourRefused) {
            host.__contourRefused = true;
            try { $.Msg("[openlock] refused " + code + " on " + (host.id || "panel")); } catch (e) { /* console closed */ }
        }
    }

    function cubic(p0, p1, p2, p3, t) {
        var u = 1 - t;
        return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
    }

    // A cubic's x and y from one t. The profile is a closed loop of eight cubics, so a row is
    // the horizontal line's crossings with them.
    function pointAt(curve, t) {
        return [cubic(curve[0], curve[2], curve[4], curve[6], t), cubic(curve[1], curve[3], curve[5], curve[7], t)];
    }

    // loopFor places every measured point on the surface: each corner is scaled by ONE factor
    // and translated so the drawing's own box corner reaches the surface's box corner. That is
    // the nine-slice arithmetic: corners keep their shape, rails take the span.
    function loopFor(width, height, pad, cornerPx) {
        var shape = data;
        var inset = Math.min(pad, width / 6, height / 6);
        var boxW = Math.max(2, width - 2 * inset);
        var boxH = Math.max(2, height - 2 * inset);
        var band = shape.band;
        var scale = Math.min(
            cornerPx / band.y,
            boxH / 3 / band.y,
            boxW / 3 / band.x
        );
        var right = inset + boxW;
        var bottom = inset + boxH;
        var corners = {
            BL: [inset - shape.box.left * scale, bottom - shape.box.bottom * scale],
            BR: [right - shape.box.right * scale, bottom - shape.box.bottom * scale],
            TR: [right - shape.box.right * scale, inset - shape.box.top * scale],
            TL: [inset - shape.box.left * scale, inset - shape.box.top * scale],
        };
        var owner = ["BL", "BR", "BR", "TR", "TR", "TL", "TL", "BL"];
        var points = [
            [461.43, 634.0], [510.57, 634.0], [525.0, 612.17], [525.0, 537.83],
            [510.57, 516.0], [461.43, 516.0], [447.0, 537.83], [447.0, 612.17],
        ];
        var loop = [];
        for (var i = 0; i < points.length; i += 1) {
            var t = corners[owner[i]];
            loop.push([points[i][0] * scale + t[0], points[i][1] * scale + t[1]]);
        }
        var curves = [];
        for (var s = 0; s < shape.segments.length; s += 1) {
            var segment = shape.segments[s];
            var start = points[s];
            var end = points[(s + 1) % points.length];
            var from = loop[s];
            var to = loop[(s + 1) % points.length];
            curves.push([
                from[0], from[1],
                from[0] + (segment[0] - start[0]) * scale, from[1] + (segment[1] - start[1]) * scale,
                to[0] + (segment[2] - end[0]) * scale, to[1] + (segment[3] - end[1]) * scale,
                to[0], to[1],
            ]);
        }
        return { curves: curves, band: Math.max(1, Math.round(band.y * scale)), scale: scale };
    }

    // span is the row's own left and right edge: the horizontal line through y, crossed with
    // the loop. Each cubic is walked for a crossing, then bisected, so a crown's curve is read
    // at the row it actually passes through.
    function span(row, y) {
        var low = Infinity;
        var high = -Infinity;
        var STEPS = 64;
        for (var c = 0; c < row.curves.length; c += 1) {
            var curve = row.curves[c];
            var previous = cubic(curve[1], curve[3], curve[5], curve[7], 0) - y;
            for (var step = 1; step <= STEPS; step += 1) {
                var t1 = step / STEPS;
                var value = cubic(curve[1], curve[3], curve[5], curve[7], t1) - y;
                if ((previous <= 0 && value > 0) || (previous >= 0 && value < 0)) {
                    var lo = (step - 1) / STEPS;
                    var hi = t1;
                    for (var pass = 0; pass < 24; pass += 1) {
                        var mid = (lo + hi) / 2;
                        var at = cubic(curve[1], curve[3], curve[5], curve[7], mid) - y;
                        if ((at <= 0) === (previous <= 0)) lo = mid; else hi = mid;
                    }
                    var x = cubic(curve[0], curve[2], curve[4], curve[6], (lo + hi) / 2);
                    if (x < low) low = x;
                    if (x > high) high = x;
                }
                previous = value;
            }
        }
        return low === Infinity ? null : { left: low, right: high };
    }

    function setStyle(panel, property, value) {
        try { panel.style[property] = value; } catch (e) { /* older Panorama ignores it */ }
    }

    // paint draws one silhouette: the border colour as the outer shape and the fill colour as the
    // same shape inset by the stroke. The panels are a fixed pool that is resized in place, so a
    // repaint never races a deferred delete and a surface cannot end up with two layers of slices
    // (which is what painted a bar cell solid brass: the ink body drawn twice and the fill under it).
    // padsOf is the one place the pin's padding becomes pixels: the frame pad the profile is cut at,
    // the clip pad the reference keeps outside it, and the stroke the ink is drawn with.
    function padsOf(look) {
        var constants = (look && look.constants) || {};
        return {
            clip: Number(constants.clip_pad) || 0.5,
            frame: Number(constants.frame_pad) || 1.5,
            stroke: Math.max(1, Number(constants.stroke_width) || 1),
        };
    }

    // The pinned application draws the silhouette on a surface one pixel larger than the thing it
    // frames: the reference's clip sits at half a pixel outside the frame, so the frame's own stroke
    // is never cut in half at a boundary. A whole pixel is the closest this renderer can place it, and
    // it is the difference between a frame that reaches the box's edge and one that reads as clipped.
    var OVERHANG = 1;

    function paint(layer, width, height, strokeClass, fillClass) {
        if (!data) return false;
        if (width < 4 || height < 4) {
            refuse(layer, "contour-too-small");
            return false;
        }
        var look = data.look;
        var pads = padsOf(look);
        // The drawn surface is the host inflated by the overhang, so the frame lands on the host's own
        // edge with both halves of its stroke inside the clip, exactly as the reference applies it.
        var outerW = width + 2 * OVERHANG;
        var outerH = height + 2 * OVERHANG;
        var corner = Math.min(look.corner_px.height, outerH / 2);
        // One shared padding arithmetic for every surface: the frame sits at the pin's frame pad, the
        // ink is one stroke wide, and the fill starts at pad plus stroke. A cell, a window crown and a
        // window row all come through here, so none of them carries its own numbers.
        var shape = loopFor(outerW, outerH, pads.frame, corner);
        var band = shape.band;
        if (band * 2 > outerH) {
            refuse(layer, "contour-crown-outside-frame");
            return false;
        }
        var inner = loopFor(Math.max(4, outerW - 2 * pads.stroke), Math.max(4, outerH - 2 * pads.stroke),
            pads.frame, corner);
        // The stroke is an outline: two crowns and two side lines, one pixel each. The fill is a
        // whole surface: two crowns and the span between them. A stroke painted as a slab is what
        // turned a bar cell solid brass — the fill is 6 per cent paper and cannot hide a slab.
        var slots = band * 2 + 2;
        var pool = [];

        var kids = [];
        var count = 0;
        try { count = layer.GetChildCount ? layer.GetChildCount() : 0; } catch (e) { count = 0; }
        for (var i = 0; i < count; i += 1) {
            var kid = null;
            try { kid = layer.GetChild(i); } catch (e) { kid = null; }
            if (kid) kids.push(kid);
        }
        while (kids.length < slots * 2) {
            var made = $.CreatePanel("Panel", layer, "");
            made.hittest = false;
            setStyle(made, "ignoreParentFlow", "true");
            setStyle(made, "horizontalAlign", "left");
            setStyle(made, "verticalAlign", "top");
            kids.push(made);
        }
        // A pool larger than this surface needs is hidden, never drawn at a stale size.
        for (var extra = slots * 2; extra < kids.length; extra += 1) {
            setStyle(kids[extra], "visibility", "collapse");
        }

        // everyRow walks one silhouette's rows and rail into the pool at base, returning the
        // number of pixels of geometry it wrote.
        function everyRow(target, w, h, offsetX, offsetY, cls, base) {
            var written = 0;
            // A slot this surface does not fill is hidden first, so a leftover row from a larger
            // repaint cannot survive at a stale offset.
            for (var hide = 0; hide < slots; hide += 1) {
                if (target[base + hide]) setStyle(target[base + hide], "visibility", "collapse");
            }
            function put(index, x, y, sw, sh) {
                var panel = target[base + index];
                if (!panel) return;
                try { panel.SetHasClass(cls, true); panel.SetHasClass(cls === "ContourInk" ? "ContourFill" : "ContourInk", false); } catch (e) {
                    panel.AddClass(cls);
                }
                // A row is one pixel of a crown; a rail is anything taller. The classes are the
                // vocabulary the gate reads, so they stay whatever shape the piece is.
                try {
                    panel.SetHasClass("ContourRow", sh <= 1);
                    panel.SetHasClass("ContourRail", sh > 1);
                } catch (e2) {
                    panel.AddClass(sh > 1 ? "ContourRail" : "ContourRow");
                }
                setStyle(panel, "visibility", "visible");
                setStyle(panel, "marginLeft", Math.round(offsetX + x) + "px");
                setStyle(panel, "marginTop", Math.round(offsetY + y) + "px");
                setStyle(panel, "width", Math.max(1, Math.round(sw)) + "px");
                setStyle(panel, "height", Math.max(1, Math.round(sh)) + "px");
                written += 1;
            }
            for (var r = 0; r < band; r += 1) {
                var top = span(shapeFor(w, h), r + 0.5);
                if (top) put(r, top.left, r, top.right - top.left, 1);
                var bottomY = h - band + r;
                var bottom = span(shapeFor(w, h), bottomY + 0.5);
                if (bottom) put(band + r, bottom.left, bottomY, bottom.right - bottom.left, 1);
            }
            var mid = span(shapeFor(w, h), h / 2);
            if (!mid) return written;
            if (interior) {
                put(band * 2, mid.left, band, mid.right - mid.left, h - band * 2);
            } else {
                // Two side lines instead of a slab, so the outline is an ink and not a fill.
                put(band * 2, mid.left, band, 1, h - band * 2);
                put(band * 2 + 1, mid.right - 1, band, 1, h - band * 2);
            }
            return written;
        }

        // The fill is the same profile one pixel in, so the rim is the stroke and nothing else.
        var outerShape = shape;
        var innerShape = inner;
        var useInner = false;
        var interior = false;
        function shapeFor(w, h) { return useInner ? innerShape : outerShape; }

        var drawnOuter = everyRow(kids, outerW, outerH, -OVERHANG, -OVERHANG, strokeClass, 0);
        interior = true;
        useInner = true;
        var drawnInner = everyRow(kids, outerW - 2 * pads.stroke, outerH - 2 * pads.stroke,
            -OVERHANG + pads.stroke, -OVERHANG + pads.stroke, fillClass, slots);
        if (drawnOuter === 0 || drawnInner === 0) {
            refuse(layer, "contour-crown-outside-frame");
            return false;
        }
        return true;
    }

    function layerFor(host) {
        if (host.HasClass && host.HasClass("ContourSlices")) return host;
        // A layer belongs to its own host, so only a DIRECT child counts. A descendant search found
        // the card's leading mark's layer and painted the card's silhouette inside that mark.
        var existing = null;
        var kids = 0;
        try { kids = host.GetChildCount ? host.GetChildCount() : 0; } catch (e) { kids = 0; }
        for (var k = 0; k < kids; k += 1) {
            var kid = null;
            try { kid = host.GetChild(k); } catch (e2) { kid = null; }
            if (kid && kid.HasClass && kid.HasClass("ContourSlices")) { existing = kid; break; }
        }
        if (existing) return existing;
        var layer = $.CreatePanel("Panel", host, "ContourSlices");
        layer.AddClass("ContourSlices");
        layer.hittest = false;
        layer.hittestchildren = false;
        // The slices are a ground, so they go under everything the surface draws. Asking to move a
        // panel before itself is not a no-op: it can move it to the end, and a fill over the label
        // is what made a bar cell's text disappear.
        try {
            // GetChild(0) is the accessor this client actually has; GetFirstChild is not, and the
            // throw left the slices last, painting a fill over every bar cell's label.
            var first = null;
            try { first = host.GetChildCount && host.GetChildCount() > 0 ? host.GetChild(0) : null; } catch (e0) { first = null; }
            if (!first) { try { first = host.GetFirstChild ? host.GetFirstChild() : null; } catch (e1) { first = null; } }
            if (first && first !== layer) host.MoveChildBefore(layer, first);
        } catch (e) { /* already first */ }
        return layer;
    }

    // draw repaints a surface. `measure` is passed by the caller because Panorama cannot read
    // its own laid out box before the panel is placed; the shell already knows both numbers.
    function draw(host, width, height) {
        if (!host || !data) return false;
        var w = Math.round(Number(width) || 0);
        var h = Math.round(Number(height) || 0);
        if (w < 4 || h < 4) {
            // A box with no room for the shape is named, not drawn as a rectangle.
            refuse(host, "contour-too-small");
            return false;
        }
        var layer = layerFor(host);
        // The silhouette's surface is the host plus the overhang on each side, placed back over the
        // host: the frame then lands on the host's own edge with both halves of its stroke inside the
        // clip, which is how the reference applies it.
        setStyle(layer, "width", (w + 2 * OVERHANG) + "px");
        setStyle(layer, "height", (h + 2 * OVERHANG) + "px");
        setStyle(layer, "marginLeft", (-OVERHANG) + "px");
        setStyle(layer, "marginTop", (-OVERHANG) + "px");
        // Panorama panels have no Children(): the engine's accessors are GetChildCount/GetChild,
        // and asking for Children() left every previous slice in place.
        var count = 0;
        try { count = layer.GetChildCount ? layer.GetChildCount() : 0; } catch (e) { count = 0; }
        for (var i = count - 1; i >= 0; i -= 1) {
            var node = null;
            try { node = layer.GetChild(i); } catch (e) { node = null; }
            if (node) { try { node.DeleteAsync(0); } catch (e2) {} }
        }
        var ok = paint(layer, w, h, "ContourInk", "ContourFill");
        // One line per surface, so a contour that is refused or clamped is visible in the log
        // rather than inferred from a picture.
        try {
            var rows = 0;
            try { rows = layer.GetChildCount ? layer.GetChildCount() : 0; } catch (e) { rows = 0; }
            var who = "";
            try { who = String(host.id || "") + "|" + String(host.GetAttributeString("class") || ""); } catch (e) { who = "?"; }
            $.Msg("[openlock] contour " + w + "x" + h + " band=" + OpenlockContour.band(h)
                + " slices=" + rows + " " + (ok ? "drawn" : "refused") + " on " + who);
        } catch (e2) { /* console closed */ }
        try { host.SetAttributeString("data-contour", ok ? "slice" : "refused"); } catch (e) { /* not a panel */ }
        return ok;
    }

    globalThis.OpenlockContour = {
        draw: draw,
        pads: function () { return data ? padsOf(data.look) : { clip: 0.5, frame: 1.5, stroke: 1 }; },
        // The drawn surface is this many pixels larger than the host on each side, and the caller
        // that models the geometry has to know it.
        overhang: function () { return OVERHANG; },
        refuse: refuse,
        refusals: function () { return refused.slice(); },
        band: function (height) {
            if (!data) return 11;
            var corner = Math.min(data.look.corner_px.height, height / 2);
            return Math.max(1, Math.round(data.band.y * Math.min(corner / data.band.y, height / 3 / data.band.y)));
        },
        ink: function () {
            if (!data) return { x: 8, y: 11 };
            return { x: Math.round(data.look.corner_px.width), y: Math.round(data.look.corner_px.height) };
        },
    };
}());

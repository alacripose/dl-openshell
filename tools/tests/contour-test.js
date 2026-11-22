// The contour's nine slices, measured against an independent reading of the profile.
//
// `openlock_contour.js` samples each cubic for the row it crosses. This test flattens the whole
// closed path into a polygon and cuts the same rows with plain line intersections, so the two
// readings agree only if both are right. It also proves the three shape rules the owner set:
// a row is never taller than a pixel (nothing stretches), the crown is narrower than the span
// (it is not a rounded rectangle), and a surface too small to hold a crown is refused by name.
//
//   node tools/tests/contour-test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..", "..");
const dataPath = path.join(root, "clientaddon/panorama/scripts/openlock_contour_data.js");
const scriptPath = path.join(root, "clientaddon/panorama/scripts/openlock_contour.js");

const failures = [];
let checks = 0;

function fail(message) {
    failures.push(message);
}

function ok(condition, message) {
    checks += 1;
    if (!condition) fail(message);
}

// --- a panel that records what the runtime asked of it ----------------------
function makePanel(id) {
    const panel = {
        id: id || "",
        classes: [],
        children: [],
        style: {},
        AddClass(name) { this.classes.push(name); },
        HasClass(name) { return this.classes.indexOf(name) !== -1; },
        // The engine's real accessors. Children() never existed on a Panorama panel: asking for it
        // returned nothing, which is why a repaint used to stack a second set of slices.
        SetHasClass(name, on) {
            const at = this.classes.indexOf(name);
            if (on && at === -1) this.classes.push(name);
            if (!on && at !== -1) this.classes.splice(at, 1);
        },
        GetChildCount() { return this.children.length; },
        GetChild(index) { return this.children[index] || null; },
        DeleteAsync() { this.deleted = true; },
        SetAttributeString() {},
        FindChildTraverse(wanted) {
            for (const child of this.children) {
                if (child.id === wanted) return child;
                const found = child.FindChildTraverse(wanted);
                if (found) return found;
            }
            return null;
        },
        GetFirstChild() { return this.children[0] || null; },
        MoveChildBefore(child) {
            this.children = [child].concat(this.children.filter((c) => c !== child));
        },
    };
    return panel;
}

globalThis.$ = {
    CreatePanel(type, parent, id) {
        const panel = makePanel(id);
        if (parent && parent.children) parent.children.push(panel);
        return panel;
    },
    Schedule(_delay, fn) { fn(); },
    Msg() {},
};

vm.runInThisContext(fs.readFileSync(dataPath, "utf8"), { filename: dataPath });
vm.runInThisContext(fs.readFileSync(scriptPath, "utf8"), { filename: scriptPath });

const data = globalThis.OpenlockContourData;
const contour = globalThis.OpenlockContour;
ok(Boolean(data), "the contour data did not load");
ok(Boolean(contour), "the contour runtime did not load");
if (!data || !contour) {
    console.error(failures.join("\n"));
    process.exit(1);
}

// --- an independent reading: flatten the loop, then intersect the rows -----
function flattenedLoop(width, height, pad, cornerPx) {
    const inset = Math.min(pad, width / 6, height / 6);
    const boxW = Math.max(2, width - 2 * inset);
    const boxH = Math.max(2, height - 2 * inset);
    const scale = Math.min(cornerPx / data.band.y, boxH / 3 / data.band.y, boxW / 3 / data.band.x);
    const right = inset + boxW;
    const bottom = inset + boxH;
    const corners = {
        BL: [inset - data.box.left * scale, bottom - data.box.bottom * scale],
        BR: [right - data.box.right * scale, bottom - data.box.bottom * scale],
        TR: [right - data.box.right * scale, inset - data.box.top * scale],
        TL: [inset - data.box.left * scale, inset - data.box.top * scale],
    };
    const owner = ["BL", "BR", "BR", "TR", "TR", "TL", "TL", "BL"];
    const points = [
        [461.43, 634.0], [510.57, 634.0], [525.0, 612.17], [525.0, 537.83],
        [510.57, 516.0], [461.43, 516.0], [447.0, 537.83], [447.0, 612.17],
    ];
    const loop = points.map((point, index) => {
        const [tx, ty] = corners[owner[index]];
        return [point[0] * scale + tx, point[1] * scale + ty];
    });
    const polygon = [];
    const steps = 400;
    for (let s = 0; s < data.segments.length; s += 1) {
        const segment = data.segments[s];
        const start = points[s];
        const end = points[(s + 1) % points.length];
        const from = loop[s];
        const to = loop[(s + 1) % points.length];
        const c1 = [from[0] + (segment[0] - start[0]) * scale, from[1] + (segment[1] - start[1]) * scale];
        const c2 = [to[0] + (segment[2] - end[0]) * scale, to[1] + (segment[3] - end[1]) * scale];
        for (let i = 0; i < steps; i += 1) {
            const t = i / steps;
            const u = 1 - t;
            polygon.push([
                u * u * u * from[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * to[0],
                u * u * u * from[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * to[1],
            ]);
        }
    }
    return { polygon, band: Math.max(1, Math.round(data.band.y * scale)), scale };
}

function spanFromPolygon(polygon, y) {
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < polygon.length; i += 1) {
        const [x0, y0] = polygon[i];
        const [x1, y1] = polygon[(i + 1) % polygon.length];
        if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
            const x = x0 + ((y - y0) / (y1 - y0)) * (x1 - x0);
            if (x < low) low = x;
            if (x > high) high = x;
        }
    }
    return low === Infinity ? null : { left: low, right: high };
}

function rowsOf(layer, className) {
    return layer.children
        // A row is one pixel of the crown; the rail is the span between two crowns.
        .filter((child) => child.HasClass(className) && child.HasClass("ContourRow"))
        .map((child) => ({
            left: parseFloat(child.style.marginLeft),
            top: parseFloat(child.style.marginTop),
            width: parseFloat(child.style.width),
            height: parseFloat(child.style.height),
        }));
}

function railsOf(layer, className) {
    return layer.children
        .filter((child) => child.HasClass(className) && child.HasClass("ContourRail"))
        .map((child) => ({
            left: parseFloat(child.style.marginLeft),
            top: parseFloat(child.style.marginTop),
            width: parseFloat(child.style.width),
            height: parseFloat(child.style.height),
        }));
}

// --- the two surfaces the owner named: a window frame and a bar chip -------
const frame = { width: 620, height: 660 };
const chip = { width: 140, height: 22 };

for (const surface of [frame, chip]) {
    const layer = makePanel("ContourSlices");
    layer.AddClass("ContourSlices");
    const drawn = contour.draw(layer, surface.width, surface.height);
    ok(drawn === true, `${surface.width}x${surface.height} was refused`);
    const ink = rowsOf(layer, "ContourInk");
    ok(ink.length > 0, `${surface.width}x${surface.height} drew no slices`);
    const tall = ink.filter((row) => row.height !== 1);
    ok(tall.length === 0, `${surface.width}x${surface.height} has a slice taller than one pixel`);

    const reference = flattenedLoop(surface.width, surface.height, data.look.constants.frame_pad,
        Math.min(data.look.corner_px.height, surface.height / 2));
    const band = reference.band;
    let compared = 0;
    for (const row of ink) {
        // Only the crown rows carry the curve; the rail is one panel across the span.
        if (row.top + row.height > band && row.top < surface.height - band) continue;
        const y = row.top + 0.5;
        const expected = spanFromPolygon(reference.polygon, y);
        if (!expected) continue;
        compared += 1;
        const left = Math.round(expected.left);
        const right = Math.round(expected.right);
        ok(Math.abs(row.left - left) <= 1 && Math.abs(row.left + row.width - right) <= 1,
            `${surface.width}x${surface.height} row ${y} is ${row.left}..${row.left + row.width}, the profile says ${left}..${right}`);
    }
    ok(compared >= band, `${surface.width}x${surface.height} compared ${compared} crown rows, expected ${band}`);

    // The crown is a crown: the highest row is narrower than the widest, and it does not reach
    // the box edge. A rounded rectangle would fail both, and so would a cut corner.
    const highest = ink.reduce((best, row) => (best === null || row.top < best.top ? row : best), null);
    ok(Boolean(highest), `${surface.width}x${surface.height} has no crown row`);
    if (highest) {
        const widest = Math.max.apply(null, ink.map((row) => row.width));
        ok(highest.width < widest, `${surface.width}x${surface.height} the highest row is as wide as the span`);
        ok(highest.width < surface.width - 2, `${surface.width}x${surface.height} the highest row is the full width`);
        ok(highest.left > 0 && highest.left + highest.width < surface.width,
            `${surface.width}x${surface.height} the highest row reaches the box edge`);
        // The ink is an outline: two one pixel side lines between the crowns, never a slab. A slab
        // is what painted a bar cell solid brass, because the fill is six per cent paper.
        const rail = railsOf(layer, "ContourInk").sort((a, b) => a.left - b.left);
        ok(rail.length === 2, `${surface.width}x${surface.height} has ${rail.length} ink rails, expected two side lines`);
        if (rail.length === 2) {
            ok(rail[0].width === 1 && rail[1].width === 1, `${surface.width}x${surface.height} an ink rail is wider than a pixel`);
            ok(rail[0].top > highest.top && rail[0].top + rail[0].height < surface.height,
                `${surface.width}x${surface.height} the rail does not sit between the crowns`);
            ok(rail[0].left < rail[1].left, `${surface.width}x${surface.height} the two side lines are not the two sides`);
            ok(rail[1].left + rail[1].width >= surface.width - 2,
                `${surface.width}x${surface.height} the right side line is not on the right edge`);
        }
        // The fill is one surface inside that outline, one pixel in on every side.
        const fillRail = railsOf(layer, "ContourFill");
        ok(fillRail.length === 1, `${surface.width}x${surface.height} has ${fillRail.length} fill surfaces`);
        if (fillRail.length === 1) {
            ok(fillRail[0].width >= surface.width - 9, `${surface.width}x${surface.height} the fill is narrower than the surface`);
            ok(fillRail[0].left >= 1, `${surface.width}x${surface.height} the fill is not inset`);
        }
    }
}

// A surface with no room for a crown is refused by name, not drawn as a rectangle.
const tiny = makePanel("ContourSlices");
tiny.AddClass("ContourSlices");
const refused = contour.draw(tiny, 3, 3);
ok(refused === false, "a 3x3 surface was drawn");
ok(contour.refusals().some((entry) => entry.code === "contour-too-small"), "the refusal was not recorded");

// The chip's corner never grows past a third of its height: the shape fits a short surface.
ok(contour.band(chip.height) <= Math.ceil(chip.height / 3) + 1,
    `a ${chip.height}px chip takes a ${contour.band(chip.height)}px corner`);

if (failures.length) {
    console.error(failures.join("\n"));
    process.exit(1);
}
console.log(`contour: ${checks} checks, 0 failures`);

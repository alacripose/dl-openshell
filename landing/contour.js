// The family contour on the landing page, drawn as nine slices from the measured profile in
// `family-look.json`: one pixel rows at the crowns, one rail across the span between them.
// Nothing is scaled and nothing is clipped, so the page shows the same shape the Panorama shell
// draws and the same corner a taskbar chip takes.

const CORNER_FALLBACK = { width: 7.67, height: 11 };

function cubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function loopFor(shape, width, height, pad, cornerPx) {
  const inset = Math.min(pad, width / 6, height / 6);
  const boxW = Math.max(2, width - 2 * inset);
  const boxH = Math.max(2, height - 2 * inset);
  const band = { x: shape.start[0] - shape.left, y: shape.bottom - shape.segments[1][5] };
  const scale = Math.min(cornerPx / band.y, boxH / 3 / band.y, boxW / 3 / band.x);
  const right = inset + boxW;
  const bottom = inset + boxH;
  const corners = {
    BL: [inset - shape.left * scale, bottom - shape.bottom * scale],
    BR: [right - shape.right * scale, bottom - shape.bottom * scale],
    TR: [right - shape.right * scale, inset - shape.top * scale],
    TL: [inset - shape.left * scale, inset - shape.top * scale],
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
  const curves = shape.segments.map((segment, index) => {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const from = loop[index];
    const to = loop[(index + 1) % loop.length];
    return [
      from[0], from[1],
      from[0] + (segment[0] - start[0]) * scale, from[1] + (segment[1] - start[1]) * scale,
      to[0] + (segment[2] - end[0]) * scale, to[1] + (segment[3] - end[1]) * scale,
      to[0], to[1],
    ];
  });
  return { curves, band: Math.max(1, Math.round(band.y * scale)) };
}

function span(curves, y) {
  let low = Infinity;
  let high = -Infinity;
  const steps = 96;
  for (const curve of curves) {
    let previous = cubic(curve[1], curve[3], curve[5], curve[7], 0) - y;
    for (let step = 1; step <= steps; step += 1) {
      const t1 = step / steps;
      const value = cubic(curve[1], curve[3], curve[5], curve[7], t1) - y;
      if ((previous <= 0 && value > 0) || (previous >= 0 && value < 0)) {
        let lo = (step - 1) / steps;
        let hi = t1;
        for (let pass = 0; pass < 20; pass += 1) {
          const mid = (lo + hi) / 2;
          const at = cubic(curve[1], curve[3], curve[5], curve[7], mid) - y;
          if ((at <= 0) === (previous <= 0)) lo = mid; else hi = mid;
        }
        const x = cubic(curve[0], curve[2], curve[4], curve[6], (lo + hi) / 2);
        if (x < low) low = x;
        if (x > high) high = x;
      }
      previous = value;
    }
  }
  return low === Infinity ? null : { left: low, right: high };
}

function body(layer, shape, width, height, offset, pad, cornerPx, className) {
  const loop = loopFor(shape, width, height, pad, cornerPx);
  if (loop.band * 2 > height) return false;
  const rows = [];
  for (let i = 0; i < loop.band; i += 1) rows.push(i);
  for (let j = height - loop.band; j < height; j += 1) rows.push(j);
  let drawn = 0;
  for (const row of rows) {
    const line = span(loop.curves, row + 0.5);
    if (!line) continue;
    const left = Math.max(0, Math.round(line.left));
    const right = Math.min(width, Math.round(line.right));
    if (right - left < 1) continue;
    drawn += 1;
    const strip = document.createElement("div");
    strip.className = className;
    strip.style.cssText = `left:${offset + left}px;top:${offset + row}px;width:${right - left}px;height:1px`;
    layer.append(strip);
  }
  if (drawn === 0) return false;
  const rail = document.createElement("div");
  rail.className = className;
  rail.style.cssText = `left:${offset}px;top:${offset + loop.band}px;width:${width}px;height:${height - loop.band * 2}px`;
  layer.append(rail);
  return true;
}

function paint(element, shape, look) {
  const width = Math.max(4, Math.floor(element.clientWidth));
  const height = Math.max(4, Math.floor(element.clientHeight));
  const corner = Math.min(look.corner_px.height, height / 2);
  element.replaceChildren();
  const ink = document.createElement("div");
  ink.className = "contour-layer";
  element.append(ink);
  if (!body(ink, shape, width, height, 0, look.constants.frame_pad, corner, "contour-ink")) return;
  body(ink, shape, width - 2, height - 2, 1, look.constants.frame_pad, corner, "contour-fill");
  element.dataset.contour = "sliced";
}

async function main() {
  const response = await fetch("family-look.json");
  if (!response.ok) return;
  const facts = await response.json();
  const set = (id, text) => {
    const node = document.getElementById(id);
    if (node && text) node.textContent = text;
  };
  set("contour-lede", facts.copy.lede);
  set("contour-caption", facts.copy.caption);
  set("contour-note", facts.copy.note);
  const surfaces = Array.from(document.querySelectorAll("[data-contour-surface]"));
  const draw = () => surfaces.forEach((surface) => paint(surface, facts.contour, facts.look));
  draw();
  new ResizeObserver(draw).observe(document.body);
}

main().catch(() => {});

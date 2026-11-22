// The family contour on the landing page. This is the shape engine the pinned client uses
// (`popit-shell/ui/contour.js`), not a second drawing of it: the same measured page 9 profile,
// the same one-factor corners, the same clip padding, so a surface on this page is cut exactly
// the way a taskbar chip and a window frame are cut in the shell.
//
// A surface paints through `--clip` and strokes the same path one pixel inside it, so the
// outline is never clipped. The page reads `contour.json` beside it for the profile.

const UNITS_W = 81.9;
const UNITS_H = 121.348;
const CORNER_BAND_X = 16.38;
const CORNER_BAND_Y = 23.48;
const CORNER_UNITS = 27.8;
const BAR_HEIGHT = 48;
const CLIP_PAD = 0.5;
const FRAME_PAD = 1.5;
const CORNER_PX = (CORNER_UNITS * BAR_HEIGHT) / UNITS_H;

const PROFILE_END = [
  [461.43, 634.0, 510.57, 634.0],
  [510.57, 634.0, 525.0, 612.17],
  [525.0, 612.17, 525.0, 537.83],
  [525.0, 537.83, 510.57, 516.0],
  [510.57, 516.0, 461.43, 516.0],
  [461.43, 516.0, 447.0, 537.83],
  [447.0, 537.83, 447.0, 612.17],
  [447.0, 612.17, 461.43, 634.0],
];

let shape = null;

async function loadContour() {
  shape = await (await fetch("contour.json")).json();
  return shape;
}

// scaleOf is the one uniform scale a surface of this size takes: the contour never stretches,
// so the smaller of the two fits governs.
function scaleOf(width, height) {
  return Math.min(width / UNITS_W, height / UNITS_H);
}

function contourPath(width, height, pad = FRAME_PAD, cornerPx = CORNER_PX) {
  if (!shape) return "";
  const inset = Math.min(pad, width / 6, height / 6);
  const boxW = Math.max(2, width - 2 * inset);
  const boxH = Math.max(2, height - 2 * inset);
  const scale = Math.min(cornerPx / CORNER_BAND_Y, boxH / 3 / CORNER_BAND_Y, boxW / 3 / CORNER_BAND_X);
  const right = inset + boxW;
  const bottom = inset + boxH;
  const corners = {
    BL: [inset - shape.left * scale, bottom - shape.bottom * scale],
    BR: [right - shape.right * scale, bottom - shape.bottom * scale],
    TR: [right - shape.right * scale, inset - shape.top * scale],
    TL: [inset - shape.left * scale, inset - shape.top * scale],
  };
  const owner = ["BL", "BR", "BR", "TR", "TR", "TL", "TL", "BL"];
  const loop = [
    [461.43, 634.0], [510.57, 634.0], [525.0, 612.17], [525.0, 537.83],
    [510.57, 516.0], [461.43, 516.0], [447.0, 537.83], [447.0, 612.17],
  ].map((point, index) => {
    const [tx, ty] = corners[owner[index]];
    return [point[0] * scale + tx, point[1] * scale + ty];
  });
  const fmt = (value) => (Math.round(value * 2) / 2).toFixed(1);
  const xy = (x, y) => `${fmt(x)} ${fmt(y)}`;
  let d = `M ${xy(loop[0][0], loop[0][1])}`;
  for (let i = 0; i < shape.segments.length; i += 1) {
    const seg = shape.segments[i];
    const [sx, sy, ex, ey] = PROFILE_END[i];
    const [dsx, dsy] = loop[i];
    const [dex, dey] = loop[(i + 1) % loop.length];
    d += ` C ${xy(dsx + (seg[0] - sx) * scale, dsy + (seg[1] - sy) * scale)},`;
    d += ` ${xy(dex + (seg[2] - ex) * scale, dey + (seg[3] - ey) * scale)}, ${xy(dex, dey)}`;
  }
  return `${d} Z`;
}

function contourFits(path, width, height, pad) {
  const numbers = path.match(/-?\d+(\.\d+)?/g) || [];
  const xs = [];
  const ys = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    xs.push(Number(numbers[i]));
    ys.push(Number(numbers[i + 1]));
  }
  const low = pad - 0.75;
  return xs.every((x) => x >= low && x <= width - pad + 0.75)
    && ys.every((y) => y >= low && y <= height - pad + 0.75);
}

// A painted surface that is not the contour is refused by name: the paint is removed and the
// surface says so, rather than a rounded rectangle standing in for the shape.
function refuse(element, code) {
  if (!element || element.dataset.refused === code) return;
  element.dataset.refused = code;
  element.style.background = "none";
  element.style.border = "0";
  element.style.clipPath = "none";
  element.setAttribute("title", `refused ${code}`);
}

function clipToContour(element) {
  if (!shape || !element) return;
  const apply = () => {
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const w = Math.max(2, Math.floor(rect.width));
    const h = Math.max(2, Math.floor(rect.height));
    const d = contourPath(w, h, FRAME_PAD);
    const clip = contourPath(w, h, CLIP_PAD);
    if (!contourFits(clip, w, h, CLIP_PAD)) {
      refuse(element, "contour-crown-outside-frame");
      return;
    }
    element.style.setProperty("--clip", `path('${clip}')`);
    let frame = element.querySelector(":scope > .contour-frame");
    if (!frame) {
      frame = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      frame.setAttribute("class", "contour-frame");
      frame.setAttribute("aria-hidden", "true");
      const stroke = document.createElementNS("http://www.w3.org/2000/svg", "path");
      stroke.setAttribute("fill", "none");
      frame.append(stroke);
      element.append(frame);
    }
    frame.setAttribute("width", String(w));
    frame.setAttribute("height", String(h));
    frame.setAttribute("viewBox", `0 0 ${w} ${h}`);
    frame.setAttribute("preserveAspectRatio", "none");
    frame.style.width = `${w}px`;
    frame.style.height = `${h}px`;
    const stroke = frame.firstElementChild;
    stroke.setAttribute("d", d);
    stroke.setAttribute("stroke-width", "1");
    stroke.setAttribute("stroke-linejoin", "round");
    stroke.setAttribute("shape-rendering", "geometricPrecision");
  };
  apply();
  new ResizeObserver(apply).observe(element);
}

function fillContours(root) {
  root.querySelectorAll("[data-contour]").forEach(clipToContour);
}

async function main() {
  await loadContour();
  fillContours(document);
  const again = () => fillContours(document);
  new ResizeObserver(again).observe(document.body);
  window.addEventListener("resize", again);
  // The machine's sentences for this section, written into the page from its own reading.
  const facts = await (await fetch("family-look.json")).json();
  const set = (id, text) => {
    const node = document.getElementById(id);
    if (node && text) node.textContent = text;
  };
  set("contour-lede", facts.copy.lede);
  set("contour-note", facts.copy.note);
  set("contour-caption", facts.copy.caption);
}

main().catch(() => {});

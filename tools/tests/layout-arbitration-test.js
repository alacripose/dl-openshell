// Headless proof for the automatic layout pass: open/close reservation, edge clamping, refusal
// recording and the pre-shell rect round-trip. This drives the same standalone module the shell
// loads, with no Panorama VM and no client control.
//
// Run: node tools/tests/layout-arbitration-test.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'clientaddon/panorama/scripts/openlock_layout.js'), 'utf8');
vm.runInThisContext(source, { filename: 'openlock_layout.js' });

const Layout = globalThis.OpenlockLayoutPass;
if (!Layout) throw new Error('OpenlockLayoutPass was not exported');

let checks = 0;
function check(cond, name) {
    checks++;
    if (!cond) throw new Error('FAILED: ' + name);
    console.log('ok ' + checks + ' - ' + name);
}
function near(a, b, epsilon = 0.01) {
    return Math.abs(a - b) <= epsilon;
}

Layout.setViewport(1600, 900);
Layout.configure({ top: 46, right: 0, bottom: 0, left: 0 });

const topRect = { x: 0, y: 0, w: 1600, h: 140 };
const topClosed = Layout.place('top-bar', topRect, 16);
check(topClosed.y === 0 && topClosed.dy === 0, 'closed shell leaves the top bar at its game rect');

Layout.setOpen(true);
const topOpen = Layout.place('top-bar', topRect, 16);
check(topOpen.y === 62, 'open shell reserves the 46 dp bar plus 16 dp chrome: ' + topOpen.y);
check(topOpen.dy === 62, 'the top bar is shifted by the reserved delta');
check(topOpen.first === true, 'the first placement is marked as a layout, not a tween');
const topAgain = Layout.place('top-bar', topRect, 16);
check(topAgain.first === false, 'the next placement is motion so the shell can ease a reflow');
check(Layout.restore('top-bar').y === 0, 'the pre-shell rect is kept for the close path');
const topRecord = Layout.snapshot().find(r => r.id === 'top-bar');
check(topRecord && topRecord.preShell.y === 0 && topRecord.placed.y === 62,
    'the record carries both pre-shell and placed rects');

// A shell window is already measured from the bar. It must not be shifted by the bar a second
// time, but it still has to clamp inside the reserved area and refuse when it cannot fit.
const shellWindow = Layout.placeShell('shell-window', { x: 100, y: 46, w: 400, h: 300 });
check(shellWindow.y === 46, 'a shell window keeps its own below-bar y: ' + shellWindow.y);
const shellEdge = Layout.placeShell('shell-edge', { x: 0, y: 0, w: 400, h: 300 });
check(shellEdge.x === 0 && shellEdge.y === 46, 'a shell window clamps under the bar without a second shift');

const edge = Layout.place('edge-window', { x: 1560, y: 860, w: 400, h: 100 }, 0);
check(edge.x === 1200 && edge.y === 800,
    'right/bottom edges clamp inside the reserved space: ' + edge.x + ',' + edge.y);

const full = Layout.place('full-screen', { x: 0, y: 0, w: 1600, h: 900 }, 0);
check(full.refused === true && full.dx === 0 && full.dy === 0,
    'an element that cannot fit is refused, not scaled into a hole');
const refusals = Layout.takeRefusals();
check(refusals.length === 1 && refusals[0].id === 'full-screen',
    'the refusal is a real record with the element id');
check(Layout.takeRefusals().length === 0, 'taking refusals does not leave a duplicate');

Layout.setOpen(false);
const shellClosed = Layout.placeShell('shell-window', { x: 100, y: 46, w: 400, h: 300 });
check(shellClosed.y === 46, 'closing the shell leaves a shell window at its own y');
const closedAgain = Layout.place('top-bar', topRect, 16);
check(closedAgain.y === 0 && closedAgain.dy === 0, 'closing the shell releases the reserved top space');
const edgeClosed = Layout.place('edge-window', { x: 1560, y: 860, w: 400, h: 100 }, 0);
check(edgeClosed.x === 1560 && edgeClosed.y === 860,
    'closing the shell returns the edge window to its own rect');

Layout.setOpen(true);
const reopened = Layout.place('top-bar', topRect, 16);
const reopenedRecord = Layout.snapshot().find(r => r.id === 'top-bar');
check(reopened.y === 62, 'reopening reserves the space again');
check(reopened.first === true, 'reopening is a fresh layout for the shell to apply immediately');
check(reopenedRecord.preShell.y === 0,
    'a new session records the current game rect, not the previous session');

console.log('layout-arbitration-test OK ' + checks + ' checks');

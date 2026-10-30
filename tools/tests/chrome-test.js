// Fake-tree proof for the two chrome defects:
//   1. the context menu survives cursor-probe noise while hovered, measures its real rect, and
//      closes only after a real leave plus dwell;
//   2. a focused narrow frame still owns all of its controls.
//
// Run: node tools/tests/chrome-test.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const msgs = [];
const dispatched = [];
let nowMs = 1000000;
Date.now = () => nowMs;

class FakePanel {
    constructor(type, parent, id) {
        this.type = type;
        this.id = id || '';
        this.parent = parent || null;
        this.children = [];
        this.classes = new Set();
        this.style = {};
        this.events = {};
        this.hittest = true;
        this.text = '';
        this.visibleFlag = true;
        this.actuallayoutwidth = id === 'OpenlockContextMenu' ? 170 : 1920;
        this.actuallayoutheight = id === 'OpenlockContextMenu' ? 220 : 1080;
        // The host attribute channel. Empty by default, so the shell reads its defaults until a
        // test publishes a payload the way a server would.
        this.attrs = {};
        if (parent) parent.children.push(this);
    }
    AddClass(c) { this.classes.add(c); }
    RemoveClass(c) { this.classes.delete(c); }
    HasClass(c) { return this.classes.has(c); }
    SetHasClass(c, on) { if (on) this.classes.add(c); else this.classes.delete(c); }
    SetPanelEvent(e, fn) { this.events[e] = fn; }
    DeleteAsync() {
        if (this.parent) {
            const i = this.parent.children.indexOf(this);
            if (i >= 0) this.parent.children.splice(i, 1);
            this.parent = null;
        }
    }
    RemoveAndDeleteChildren() {
        for (const child of this.children) child.parent = null;
        this.children = [];
    }
    FindChildTraverse(id) {
        for (const child of this.children) {
            if (child.id === id) return child;
            const found = child.FindChildTraverse(id);
            if (found) return found;
        }
        return null;
    }
    FindChildrenWithClassTraverse(cls) {
        const out = [];
        const walk = panel => {
            for (const child of panel.children) {
                if (child.classes.has(cls)) out.push(child);
                walk(child);
            }
        };
        walk(this);
        return out;
    }
    GetChildCount() { return this.children.length; }
    GetChild(i) { return this.children[i] || null; }
    GetParent() { return this.parent; }
    IsVisible() { return this.visibleFlag; }
    BLoadLayout() { this.loaded = true; return true; }
    SetImage(src) { this.src = src; }
    GetAttributeString(name, dflt) {
        if (this.attrs && this.attrs[name] !== undefined) return this.attrs[name];
        return dflt || '';
    }
    GetAttributeInt() { return 0; }
    GetPositionWithinWindow() {
        if (this.id === 'OpenlockContextMenu') {
            return {
                x: parseFloat(this.style.marginLeft) || 0,
                y: parseFloat(this.style.marginTop) || 0
            };
        }
        return { x: 0, y: 0 };
    }
    SetFocus() {}
}

const root = new FakePanel('Panel', null, 'ShellRoot');
for (const id of ['WindowLayer', 'PanelLayer', 'Taskbar', 'PreloadStrip', 'PreloadLabel',
    'PreloadModules', 'PreloadFill', 'TabStrip', 'TaskbarRight', 'DashboardButton',
    'WindowsButton', 'VersionLabel', 'Clock', 'LauncherBar', 'LauncherButton', 'SchemeButton',
    'FormButton', 'LauncherLabel', 'SchemeLabel', 'FormLabel', 'DropGrid', 'ToastStack',
    'BuildStrip', 'UpdateModal', 'PointerProbe']) {
    new FakePanel('Panel', root, id);
}
const hud = new FakePanel('Panel', null, 'Hud');
root.parent = hud;
hud.children.push(root);
const hudAbilities = new FakePanel('Panel', hud, 'HudAbilities');
hudAbilities.AddClass('CitadelHudAbilities');
// Narrow enough that the frame gets the Narrow class, still above the panel's 80 dp minimum.
hudAbilities.actuallayoutwidth = 100;
hudAbilities.actuallayoutheight = 80;

let immediateBudget = 80;
let timerSeq = 0;
let timers = [];
let cursor = { x: 20, y: 20 };
let mouseDown = false;

globalThis.$ = {
    GetContextPanel: () => root,
    CreatePanel: (type, parent, id) => new FakePanel(type, parent, id),
    Schedule: (delay, fn) => {
        const id = ++timerSeq;
        if (delay === 0 && immediateBudget > 0) {
            immediateBudget--;
            fn();
            return id;
        }
        timers.push({ at: nowMs + Math.max(0, delay) * 1000, id, fn });
        return id;
    },
    Msg: (...args) => { msgs.push(args.join('')); },
    DispatchEvent: (...args) => { dispatched.push(args); },
    MousePosition: () => cursor,
    GetCursorPosition: () => cursor,
    Localize: s => s,
};
globalThis.GameUI = {
    GetCursorPosition: () => cursor,
    IsMouseDown: () => mouseDown,
};
globalThis.Game = {};

function load(rel) { vm.runInThisContext(read(rel), { filename: rel }); }
load('clientaddon/panorama/scripts/openlock_shell_data.js');
load('clientaddon/panorama/scripts/openlock_audio.js');
load('clientaddon/panorama/scripts/openlock_popit.js');
load('clientaddon/panorama/scripts/openlock_layout.js');
// Delivery owns the observer/addon attribute validators; without it pollObserver is a no-op and
// the server-authored paths below would never run.
load('clientaddon/panorama/scripts/openlock_delivery.js');
load('clientaddon/panorama/scripts/openlock_shell.js');

function advance(ms) {
    nowMs += ms;
    let guard = 0;
    while (guard++ < 200) {
        const due = timers
            .filter(t => t.at <= nowMs)
            .sort((a, b) => (a.at - b.at) || (a.id - b.id))[0];
        if (!due) break;
        timers = timers.filter(t => t !== due);
        due.fn();
    }
}

let checks = 0;
function check(cond, name) {
    checks++;
    if (!cond) throw new Error('FAILED: ' + name);
    console.log('ok ' + checks + ' - ' + name);
}
function texts(panel) {
    const out = [];
    const walk = p => {
        if (typeof p.text === 'string' && p.text) out.push(p.text);
        p.children.forEach(walk);
    };
    walk(panel);
    return out;
}
function dashboardBody() {
    const app = root.FindChildrenWithClassTraverse('DashApp')[0];
    if (!app) throw new Error('dashboard app not drawn');
    return app;
}

// Boot the shell onto the dashboard and select the one live HUD window (Abilities).
globalThis.OpenlockDashboard();
const rail = dashboardBody().FindChildrenWithClassTraverse('DashRail')[0];
const layoutSlot = rail.FindChildrenWithClassTraverse('DashRailSlot')
    .find(s => texts(s).includes('LAYOUT'));
check(!!layoutSlot, 'dashboard exposes LAYOUT');
layoutSlot.events.onmouseactivate();
const abilities = dashboardBody().FindChildrenWithClassTraverse('ViewAction')
    .find(b => texts(b).some(t => t.indexOf('Abilities') >= 0 && t.indexOf('abilities') >= 0));
check(!!abilities, 'dashboard exposes Abilities');
abilities.events.onmouseactivate();

const frame = root.FindChildTraverse('OpenlockFrame_abilities');
check(!!frame, 'the fake tree built the Abilities frame');
check(frame.classes.has('Narrow'), 'a 100 dp frame is Narrow');
const titleBar = frame.FindChildrenWithClassTraverse('WindowTitle')[0];
// Selecting in the editor frames the window; clicking its title is the focus promotion the
// reported defect was about. Drive that path explicitly, then assert the chrome state.
titleBar.events.onmouseactivate();
check(frame.classes.has('Focused'), 'focusing Abilities promotes the frame');
const buttons = frame.FindChildrenWithClassTraverse('WindowButton');
check(buttons.length >= 6, 'the narrow frame still owns all controls (' + buttons.length + ')');
check(buttons.every(b => b.hittest !== false), 'every narrow control remains hit-testable');

// The controls are shapes, not codepoints in a font. A non-empty label would be the Unicode
// regression; the shape classes are the contract the pointer actually sees.
check(buttons.every(b => texts(b).length === 0),
    'window controls draw no text glyphs');
check(frame.FindChildrenWithClassTraverse('IconMin').length === 1,
    'minimize is an explicit bar');
check(frame.FindChildrenWithClassTraverse('IconMax').length === 1,
    'maximize is an explicit square');
check(frame.FindChildrenWithClassTraverse('IconRestore').length === 2,
    'restore is two offset squares, not a second codepoint');
const closeStrokes = frame.FindChildrenWithClassTraverse('IconCloseBar').length;
check(closeStrokes === 6,
    'close is a drawn staircase, not a Unicode × (' + closeStrokes + ')');
const maxButton = buttons.find(b => b.FindChildrenWithClassTraverse('IconMax').length);
check(!!maxButton, 'the maximize control owns its shape button');
maxButton.events.onmouseactivate();
check(maxButton.classes.has('Maximized'), 'maximize toggles a state class, not glyph text');
advance(300);
maxButton.events.onmouseactivate();
check(!maxButton.classes.has('Maximized'), 'restore returns the maximize control state');

// Dragging follows the pointer through a burst of null cursor probes. The old path ended the
// gesture on the first miss, so the final position never reached the frame. Snap is the
// dashboard's own grid rule, not a drag rule; turn it off so the pointer delta is exact.
const snapToggle = dashboardBody().FindChildrenWithClassTraverse('ViewAction')
    .find(b => texts(b).some(t => t.indexOf('Snap while dragging') >= 0));
check(!!snapToggle, 'the dashboard exposes the snap toggle');
snapToggle.events.onmouseactivate();
const dragStrip = frame.FindChildrenWithClassTraverse('WindowDrag')[0];
check(!!dragStrip && typeof dragStrip.events.onmousedown === 'function',
    'the title strip owns a drag handler');
const dragLeft = parseFloat(frame.style.marginLeft) || 0;
const dragTop = parseFloat(frame.style.marginTop) || 0;
cursor = { x: 30, y: 30 };
mouseDown = true;
dragStrip.events.onmousedown();
advance(16);
cursor = null;
for (let i = 0; i < 20; i++) advance(16);
cursor = { x: 150, y: 70 };
advance(16);
mouseDown = false;
advance(16);
const dragLeftAfter = parseFloat(frame.style.marginLeft) || 0;
const dragTopAfter = parseFloat(frame.style.marginTop) || 0;
check(Math.abs(dragLeftAfter - (dragLeft + 120)) < 1,
    'a drag survives null probes and lands at the pointer x: ' + dragLeft + ' -> ' + dragLeftAfter);
check(Math.abs(dragTopAfter - (dragTop + 40)) < 1,
    'a drag survives null probes and lands at the pointer y: ' + dragTop + ' -> ' + dragTopAfter);

// Resizing writes both axes. SE grows width and height by the pointer delta; NW pins the
// opposite corner by moving the origin and shrinking both axes.
function dragGrip(gripClass, dx, dy) {
    const grip = frame.FindChildrenWithClassTraverse(gripClass)[0];
    check(!!grip && typeof grip.events.onmousedown === 'function',
        gripClass + ' is a real drag surface');
    cursor = { x: 400, y: 400 };
    mouseDown = true;
    grip.events.onmousedown();
    advance(16);
    cursor = { x: 400 + dx, y: 400 + dy };
    advance(16);
    mouseDown = false;
    advance(16);
}

// Abilities declares a 200 dp minimum width but its live HUD content is 100 dp. A zero-delta
// SE gesture is the normalising step that takes the frame to its supported minimum; after that
// the 80 x 40 gesture is an exact pointer delta.
dragGrip('GripSE', 0, 0);
const beforeSe = {
    left: parseFloat(frame.style.marginLeft) || 0,
    top: parseFloat(frame.style.marginTop) || 0,
    width: parseFloat(frame.style.width) || 0,
    height: parseFloat(frame.style.height) || 0,
};
dragGrip('GripSE', 80, 40);
const afterSe = {
    left: parseFloat(frame.style.marginLeft) || 0,
    top: parseFloat(frame.style.marginTop) || 0,
    width: parseFloat(frame.style.width) || 0,
    height: parseFloat(frame.style.height) || 0,
};
check(Math.abs(afterSe.width - (beforeSe.width + 80)) < 1,
    'SE resize changes width: ' + beforeSe.width + ' -> ' + afterSe.width);
check(Math.abs(afterSe.height - (beforeSe.height + 40)) < 1,
    'SE resize changes height independently: ' + beforeSe.height + ' -> ' + afterSe.height);

const beforeNw = afterSe;
dragGrip('GripNW', 80, 40);
const afterNw = {
    left: parseFloat(frame.style.marginLeft) || 0,
    top: parseFloat(frame.style.marginTop) || 0,
    width: parseFloat(frame.style.width) || 0,
    height: parseFloat(frame.style.height) || 0,
};
check(Math.abs(afterNw.left - (beforeNw.left + 80)) < 1 &&
    Math.abs(afterNw.top - (beforeNw.top + 40)) < 1,
    'NW resize pins the opposite corner and moves the origin');
check(Math.abs(afterNw.width - (beforeNw.width - 80)) < 1 &&
    Math.abs(afterNw.height - (beforeNw.height - 40)) < 1,
    'NW resize shrinks width and height independently');

// A user-placed frame is not re-sampled. Changing the live panel's native rect must not move
// the chrome on the next poll.
const frozen = {
    left: parseFloat(frame.style.marginLeft) || 0,
    top: parseFloat(frame.style.marginTop) || 0,
    width: parseFloat(frame.style.width) || 0,
    height: parseFloat(frame.style.height) || 0,
};
hudAbilities.actuallayoutwidth = 200;
hudAbilities.actuallayoutheight = 60;
advance(650);
check(Math.abs((parseFloat(frame.style.marginLeft) || 0) - frozen.left) < 1 &&
    Math.abs((parseFloat(frame.style.marginTop) || 0) - frozen.top) < 1,
    'a user-placed frame does not follow a live-panel reflow');
check(Math.abs((parseFloat(frame.style.width) || 0) - frozen.width) < 1 &&
    Math.abs((parseFloat(frame.style.height) || 0) - frozen.height) < 1,
    'a user-placed frame keeps the size the player set');

// A running client's own package. The host discovered a game window and a cell and hands the
// shell their source trees; each one must take the same streamer surface as a package window,
// land on the rect the package declared, and ease in with the bar's curve. A row with no source
// is refused by id rather than opening an empty frame. The package arrives while the shell is
// already running, so the preloader has handed the strip its final tabs first.
for (let i = 0; i < 8; i++) advance(400);
check(root.FindChildrenWithClassTraverse('ShellTab').length > 0,
    'the taskbar strip owns its final tabs before a game package arrives');
const streamTree = [{
    tag: 'Panel', id: 'StreamProof', class: 'StreamProof', children: [
        { tag: 'Label', id: 'StreamProofLabel', text: 'streamed package proof', children: [] }
    ]
}];
const wrongFormat = globalThis.OpenlockStreamPackage({
    format: 'openlock.addons/2',
    windows: [{ id: 'game-hud_wrong_format', title: 'Wrong Format', tree: streamTree }]
});
check(wrongFormat.opened.length === 0,
    'a payload in another format is refused, not streamed');
check(globalThis.OpenlockStreamPackage.format === 'openlock.game/1',
    'the shell publishes the game package streamer format');
const streamReceipt = globalThis.OpenlockStreamPackage({
    format: 'openlock.game/1',
    windows: [
        { id: 'game-hud_stream_proof', title: 'Hud Stream Proof', tree: streamTree,
          geometry: [140, 96, 360, 220] },
        { id: 'cell-stream_proof', title: 'Cell Stream Proof', cell: true, tree: streamTree,
          geometry: [200, 360, 280, 160] },
        { id: 'game-hud_no_source', title: 'No Source' }
    ]
});
check(streamReceipt.opened.length === 2, 'a game package opens its window and its cell');
check(streamReceipt.refused.length === 1 && streamReceipt.refused[0].id === 'game-hud_no_source',
    'a game window without a readable source is refused by id');
const streamFrame = root.FindChildTraverse('OpenlockFrame_game_hud_stream_proof');
check(!!streamFrame, 'the streamed game window has a shell frame');
check(streamFrame.classes.has('StreamedXml'), 'the streamed game window is on the streamer surface');
const cellFrame = root.FindChildTraverse('OpenlockFrame_cell_stream_proof');
check(!!cellFrame, 'the streamed cell has a shell frame');
const streamTab = root.FindChildrenWithClassTraverse('ShellTab')
    .find(t => texts(t).some(t => t.indexOf('Hud Stream Proof') >= 0));
check(!!streamTab, 'the streamed game window has a taskbar entry');
check(parseFloat(streamFrame.style.opacity) < 0.2, 'the streamed window starts under the entrance curve');
const entranceLeft = parseFloat(streamFrame.style.marginLeft) || 0;
const entranceTop = parseFloat(streamFrame.style.marginTop) || 0;
check(Math.abs(entranceLeft - 140) < 1 && Math.abs(entranceTop - 96) < 1,
    'the streamed window opens at the rect the package declared: ' + entranceLeft + ' ' + entranceTop);
let entranceMin = 1;
let entranceMoved = false;
for (let i = 0; i < 12; i++) {
    advance(20);
    entranceMin = Math.min(entranceMin, parseFloat(streamFrame.style.opacity) || 0);
    if (Math.abs((parseFloat(streamFrame.style.marginLeft) || 0) - entranceLeft) > 1 ||
        Math.abs((parseFloat(streamFrame.style.marginTop) || 0) - entranceTop) > 1) {
        entranceMoved = true;
    }
}
check(entranceMin < 0.2, 'the streamed window eases in instead of cutting in');
check(!entranceMoved, 'the entrance moves no geometry');
check(Math.abs((parseFloat(streamFrame.style.opacity) || 0) - 0.93) < 0.02,
    'the streamed window settles at the declared opacity: ' + streamFrame.style.opacity);

// --- host attribute channel (TB3): a server authors these strings ---------------------------
// Move the shell under a host panel so `host()` resolves and the poll reads the real channel.
// This runs before the context-menu section, which clears the timer queue to isolate its own
// dwell timers; the poll chain must still be alive here.
hud.children = hud.children.filter(child => child !== root);
const hostPanel = new FakePanel('Panel', hud, 'OpenlockStandaloneHost');
root.parent = hostPanel;
hostPanel.children.push(root);
hostPanel.attrs.dw_live = '1';

// A layout profile whose rectangle is not finite is refused whole and named, rather than being
// coerced to 0 (a window at the origin) or to Infinity (a style the engine drops).
hostPanel.attrs.dwv_layout = JSON.stringify({
    profiles: { default: { windows: { 'live:x:10x10': { x: 'Infinity', y: 0, w: 10, h: 10 } } } }
});
advance(700);
check(msgs.some(m => m.indexOf('REFUSED Layout profile refused') >= 0),
    'a non-finite saved rect refuses the layout profile by name');
check(msgs.some(m => m.indexOf('no finite x, y, w or h') >= 0),
    'the refusal says which fact failed');

// The same channel carries the layout map, so it gets the same ceiling as an addon payload.
hostPanel.attrs.dwv_layout = 'x'.repeat(4 * 1024 * 1024 + 1);
advance(700);
check(msgs.some(m => m.indexOf('REFUSED Layout payload refused') >= 0 && m.indexOf('4 MiB') >= 0),
    'a layout payload over 4 MiB is refused before it is parsed');

// An observer notice can carry a layout path. A server-authored path outside {resources}/layout
// must not reach BLoadLayout; the same notice with a resources path still loads.
hostPanel.attrs.dwv_observer = JSON.stringify({
    title: 'Observed', layout: 'file:///C:/Windows/system32/drivers/etc/hosts'
});
advance(700);
let observerToasts = root.FindChildrenWithClassTraverse('ObserverXmlToast');
let observerSurface = observerToasts.length
    ? observerToasts[observerToasts.length - 1].FindChildrenWithClassTraverse('ObserverXmlHost')[0]
    : null;
check(!!observerSurface && observerSurface.loaded !== true,
    'an observer layout path outside the resources layout directory is not loaded');
check(msgs.some(m => m.indexOf('REFUSED Observer XML refused') >= 0 &&
    m.indexOf('not file://{resources}/layout/') >= 0),
    'the observer refusal names the missing prefix');

hostPanel.attrs.dwv_observer = JSON.stringify({
    title: 'Observed', layout: 'file://{resources}/layout/openlock_hud.xml'
});
advance(700);
observerToasts = root.FindChildrenWithClassTraverse('ObserverXmlToast');
observerSurface = observerToasts.length
    ? observerToasts[observerToasts.length - 1].FindChildrenWithClassTraverse('ObserverXmlHost')[0]
    : null;
check(!!observerSurface && observerSurface.loaded === true,
    'an observer layout path inside the resources layout directory still loads');

// Context menu: use the frame title's real context handler.
check(!!titleBar && typeof titleBar.events.oncontextmenu === 'function',
    'the frame title exposes a context-menu handler');
timers = [];
titleBar.events.oncontextmenu();
let menu = root.FindChildTraverse('OpenlockContextMenu');
check(!!menu, 'right-click opens the context menu');
// A full action list is taller than the retired 180 x 280 guess. The measured rect is 170 x 400.
menu.actuallayoutheight = 400;
const menuX = parseFloat(menu.style.marginLeft) || 0;
const menuY = parseFloat(menu.style.marginTop) || 0;

// Hover wins over a burst of outside probes. The menu is being read; the cursor sample is noise.
menu.events.onmouseover();
for (let i = 0; i < 4; i++) {
    cursor = { x: menuX + 900 + i * 30, y: menuY + 900 };
    advance(120);
}
check(!!root.FindChildTraverse('OpenlockContextMenu'),
    'a hovered menu survives a burst of outside cursor probes');

// A spurious out while the pointer is still inside the measured rect must not close it. This
// cursor is outside the old 280 dp guess but inside the real 400 dp menu.
menu.events.onmouseout();
cursor = { x: menuX + 20, y: menuY + 350 };
advance(500);
check(!!root.FindChildTraverse('OpenlockContextMenu'),
    'the measured menu rect keeps a menu the old guess would have dismissed');

// A real leave waits for the dwell, then closes.
menu.events.onmouseout();
cursor = { x: menuX + 900, y: menuY + 900 };
advance(400);
check(!!root.FindChildTraverse('OpenlockContextMenu'),
    'a leave does not close the menu before the dwell');
advance(80);
check(!root.FindChildTraverse('OpenlockContextMenu'),
    'a real leave plus dwell closes the menu');

// The dismiss surface remains the explicit outside-click path.
titleBar.events.oncontextmenu();
menu = root.FindChildTraverse('OpenlockContextMenu');
const dismiss = root.FindChildTraverse('OpenlockContextDismiss');
check(!!menu && !!dismiss, 'the menu and its dismiss surface are paired');
dismiss.events.onmouseactivate();
check(!root.FindChildTraverse('OpenlockContextMenu'),
    'clicking the dismiss surface closes the menu');

console.log('chrome-test OK ' + checks + ' checks');

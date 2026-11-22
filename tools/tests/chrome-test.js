// Fake-tree proof for the chrome defects:
//   1. the context menu survives cursor-probe noise while hovered, measures its real rect, and
//      closes only after a real leave plus dwell;
//   2. a focused narrow frame still owns all of its controls;
//   3. a saved-layout payload cannot name a scheme or a window `__proto__`, and the older
//      geometry-map format is not read as if its arrangement keys were window rows.
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
load('clientaddon/panorama/scripts/openlock_pairs.js');
load('clientaddon/panorama/scripts/openlock_popit.js');
load('clientaddon/panorama/scripts/openlock_layout.js');
load('clientaddon/panorama/scripts/openlock_split.js');
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
// The shell may not arrange game panels without consent. These tests exercise the arranging
// shell, so they grant what the Settings surface grants in the client.
check(globalThis.OpenlockLayoutConsent() === false, 'layout consent starts off');
globalThis.OpenlockAllowLayout(true);
check(globalThis.OpenlockLayoutConsent() === true, 'the settings surface grants layout consent');
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
const grips = frame.FindChildrenWithClassTraverse('ResizeGrip');
check(grips.length === 4, 'the frame owns four corner grips (' + grips.length + ')');
check(grips.every(g => g.hittest === true && g.hittestchildren === false),
    'every corner grip opts back into hit-testing over a pointer-transparent frame');

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
const dragWidth = parseFloat(frame.style.width) || 0;
const dragHeight = parseFloat(frame.style.height) || 0;
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
check(Math.abs((parseFloat(frame.style.width) || 0) - dragWidth) < 1 &&
    Math.abs((parseFloat(frame.style.height) || 0) - dragHeight) < 1,
    'moving a window does not change its size: ' + dragWidth + 'x' + dragHeight +
    ' -> ' + frame.style.width + 'x' + frame.style.height);

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
// The taskbar is retired; the lower cloud band is the only rail and it carries the Popit's own
// interface controls. A package arriving must not put a window entry back on it.
// The lower shelf is withdrawn: the pinned client has no cloud band, so the Popit's controls are
// actions by name rather than a drawn rail, and every one of them still answers.
const cloudBar = root.FindChildTraverse('CloudBar');
check(!cloudBar, 'the withdrawn cloud shelf is not drawn: ' + (cloudBar ? 'present' : 'absent'));
const ran = ['prev-page', 'next-page', 'prev-cell', 'next-cell', 'section', 'popit']
    .map(id => globalThis.runPopitAction(id));
check(ran.length === 6 && ran.every(Boolean),
    'every Popit action answers by name: ' + ran.filter(Boolean).length + '/6');
check(globalThis.runPopitAction('not-an-action') === false,
    'an action that does not exist is refused by name');
const streamTree = [{
    tag: 'Panel', id: 'StreamProof', class: 'StreamProof', children: [
        { tag: 'Label', id: 'StreamProofLabel', text: 'streamed package proof', children: [] }
    ]
}];
const wrongFormat = globalThis.OpenlockStreamPackage({
    format: 'openlock.addons/a5d7cf25e0a40c0a06b836992556491d',
    windows: [{ id: 'game-hud_wrong_format', title: 'Wrong Format', tree: streamTree }]
});
check(wrongFormat.opened.length === 0,
    'a payload in another format is refused, not streamed');
check(globalThis.OpenlockStreamPackage.format === 'openlock.game/05b2d815a8a5f1006596d6b0d9e0fa27',
    'the shell publishes the game package streamer format');
const streamReceipt = globalThis.OpenlockStreamPackage({
    format: 'openlock.game/05b2d815a8a5f1006596d6b0d9e0fa27',
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
check(!streamTab, 'a streamed window no longer gets a taskbar entry');
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

// --- saved-layout keys (F4): the profile channel is server-authored --------------------------
// An older profile is the geometry map itself; `active`, `tab`, `pinned`, `minimized` and
// `popit` are arrangement state beside the rows. Reading one of them as a window row would
// refuse the whole profile, so the legacy shape must skip exactly those keys and still load its
// real rows. This payload runs while `popit` is the active scheme, so it also restores geometry.
const cleanPrototype = Object.getPrototypeOf({});
globalThis.OpenlockScheme('popit');
let layoutMark = msgs.length;
hostPanel.attrs.dwv_layout = JSON.stringify({
    profiles: {
        popit: {
            active: 'abilities',
            tab: 'abilities',
            pinned: ['abilities'],
            minimized: [],
            popit: {},
            abilities: { x: 320, y: 150, w: 380, h: 230 }
        }
    }
});
advance(700);
check(!msgs.slice(layoutMark).some(m => m.indexOf('REFUSED Layout profile refused') >= 0),
    'a legacy geometry map skips its arrangement keys instead of refusing them as window rows');
check(msgs.slice(layoutMark).some(m => m.indexOf('layout profiles: 1') >= 0 &&
    m.indexOf('saved=true') >= 0),
    'the legacy profile is retained under its scheme');
// A game-panel frame is scaled to the live panel, so the height is arbitrated; the origin and
// the requested width are the row's own numbers and must land.
check(Math.abs((parseFloat(frame.style.marginLeft) || 0) - 320) < 1 &&
    Math.abs((parseFloat(frame.style.width) || 0) - 380) < 1,
    'the legacy profile still restores the rect of its real window row');

// A scheme named `__proto__` would be assigned through the prototype setter. It is refused by
// name before it reaches the profile map, and the valid profile in the same payload still loads.
// The raw text is what a server sends; JSON.stringify would create an own property instead of
// the hostile key this path has to survive.
layoutMark = msgs.length;
hostPanel.attrs.dwv_layout =
    '{"profiles":{"__proto__":{"windows":{"live:evil:10x10":' +
    '{"x":1,"y":2,"w":30,"h":40}}},' +
    '"alpha":{"windows":{"abilities":{"x":300,"y":140,"w":400,"h":240}}}}}';
advance(700);
check(msgs.slice(layoutMark).some(m => m.indexOf('__proto__: the scheme is not a profile name') >= 0),
    'a __proto__ scheme is refused by name');
check(msgs.slice(layoutMark).some(m => m.indexOf('layout profiles: 1') >= 0),
    'a refused __proto__ scheme does not take the valid profile beside it down');
check(Object.getPrototypeOf({}) === cleanPrototype && !('windows' in {}) && !('active' in {}),
    'a __proto__ scheme leaves the object prototype untouched');

// A window id named `__proto__` would be assigned into the row map the same way. The profile
// that declares it is refused whole, by id, and the valid profile beside it still loads.
layoutMark = msgs.length;
hostPanel.attrs.dwv_layout =
    '{"profiles":{"popit":{"windows":{"__proto__":' +
    '{"x":1,"y":2,"w":30,"h":40},' +
    '"abilities":{"x":260,"y":120,"w":360,"h":220}}},' +
    '"alpha":{"windows":{"abilities":{"x":300,"y":140,"w":400,"h":240}}}}}';
advance(700);
check(msgs.slice(layoutMark).some(m => m.indexOf('__proto__: the id is not a window id') >= 0),
    'a __proto__ window id is refused by name');
check(msgs.slice(layoutMark).some(m => m.indexOf('layout profiles: 1') >= 0),
    'a refused __proto__ window id does not take the valid profile beside it down');
check(Object.getPrototypeOf({}) === cleanPrototype && !('x' in {}),
    'a __proto__ window id leaves the object prototype untouched');

// The surviving profile is not merely counted: switching to it applies its row.
globalThis.OpenlockScheme('alpha');
advance(50);
check(Math.abs((parseFloat(frame.style.marginLeft) || 0) - 300) < 1 &&
    Math.abs((parseFloat(frame.style.width) || 0) - 400) < 1,
    'the valid profile beside a refused __proto__ entry still restores its rect');
globalThis.OpenlockScheme('popit');
advance(50);

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

// Splitting measures the children after removing the parent's composited transform. Without the
// reset the cells inherit the old offset/scale and the first drag compounds it. The fake tree
// cannot apply CSS transforms, so the assertion is on the property the runtime write owns.
const childA = new FakePanel('Panel', hudAbilities, 'ChildA');
childA.AddClass('AbilitySlot');
childA.actuallayoutwidth = 40;
childA.actuallayoutheight = 30;
const childB = new FakePanel('Panel', hudAbilities, 'ChildB');
childB.AddClass('AbilitySlot');
childB.actuallayoutwidth = 50;
childB.actuallayoutheight = 30;
hudAbilities.actuallayoutwidth = 200;
hudAbilities.actuallayoutheight = 60;
hudAbilities.style.transform = 'translate3d(37px,19px,0px) scale3d(1.4,1.4,1)';
titleBar.events.oncontextmenu();
const splitAction = root.FindChildrenWithClassTraverse('ViewAction')
    .find(b => texts(b).some(t => t.indexOf('Split into cells') >= 0));
check(!!splitAction, 'the context menu offers Split into cells');
splitAction.events.onmouseactivate();
check(hudAbilities.style.transform === '',
    'the split clears the parent transform before measuring its components');

const splitCellFrame = root.FindChildTraverse('OpenlockFrame_cell_abilities_ChildA');
check(!!splitCellFrame, 'the split creates a frame for the first component');
const cellLeft = parseFloat(splitCellFrame.style.marginLeft) || 0;
const cellTop = parseFloat(splitCellFrame.style.marginTop) || 0;
const cellWidth = parseFloat(splitCellFrame.style.width) || 0;
const cellHeight = parseFloat(splitCellFrame.style.height) || 0;
const cellDrag = splitCellFrame.FindChildrenWithClassTraverse('WindowDrag')[0];
check(!!cellDrag && typeof cellDrag.events.onmousedown === 'function',
    'a split cell owns a move handle');
cursor = { x: 600, y: 600 };
mouseDown = true;
cellDrag.events.onmousedown();
advance(16);
cursor = { x: 640, y: 620 };
advance(16);
mouseDown = false;
advance(16);
check(Math.abs((parseFloat(splitCellFrame.style.marginLeft) || 0) - (cellLeft + 40)) < 1 &&
    Math.abs((parseFloat(splitCellFrame.style.marginTop) || 0) - (cellTop + 20)) < 1,
    'moving a cell lands one-to-one at the pointer: ' + cellLeft + ',' + cellTop +
    ' -> ' + splitCellFrame.style.marginLeft + ',' + splitCellFrame.style.marginTop);
check(Math.abs((parseFloat(splitCellFrame.style.width) || 0) - cellWidth) < 1 &&
    Math.abs((parseFloat(splitCellFrame.style.height) || 0) - cellHeight) < 1,
    'moving a cell does not stretch it: ' + cellWidth + 'x' + cellHeight +
    ' -> ' + splitCellFrame.style.width + 'x' + splitCellFrame.style.height);

// A Deadlock cell declares its boundary and draws its content inside its own inset. The frame
// traces the declared cell instead of the tight box around its painted leaves; the outline is
// drawn one pixel outside that boundary. The fake tree measures every fixture at 0,0, so the
// boundary rule itself is called through the harness hook rather than through discovery.
const declared = { x: 600, y: 300, w: 240, h: 160 };
const padded = { x: 640, y: 340, w: 160, h: 80 };
const framed = globalThis.OpenlockCellFrame(padded, declared);
check(framed.x === 600 && framed.y === 300 && framed.w === 240 && framed.h === 160,
    'a padded cell keeps its declared boundary: ' + JSON.stringify(framed));
const tight = { x: 602, y: 302, w: 236, h: 156 };
const tightFrame = globalThis.OpenlockCellFrame(tight, declared);
check(tightFrame.x === 602 && tightFrame.w === 236,
    'a cell whose paint fills its edge is framed on the paint, not the wrapper');
const sliver = { x: 620, y: 340, w: 120, h: 60 };
const sliverFrame = globalThis.OpenlockCellFrame(sliver, declared);
check(sliverFrame.x === 620 && sliverFrame.h === 60,
    'a small inset element inside a big wrapper does not claim the wrapper boundary');

// A pair is a live surface choice, not a Popit-only skin: the generated slot map is scoped by a
// class on the shell root, so it reaches the window manager's frames and dressed cells. A slug
// the generated table does not carry is refused rather than added, and Classic removes it.
// One theme system. A palette entry is a scheme: there is no second pair class to keep in step,
// and the palette page lists exactly the scheme registry.
check(globalThis.OpenlockScheme('alpha') !== undefined && root.HasClass('SchemeAlpha'),
    'a palette entry applies the scheme class');
const schemeBefore = Array.from(root.classes).filter(c => c.indexOf('Scheme') === 0).join(',');
globalThis.OpenlockScheme('not-a-scheme');
check(Array.from(root.classes).filter(c => c.indexOf('Scheme') === 0).join(',') === schemeBefore,
    'an unknown scheme cannot replace the active one');
globalThis.OpenlockScheme('popit');
check(root.HasClass('SchemePopit') && !root.HasClass('SchemeAlpha'),
    'switching schemes replaces exactly one class on the root');
const paletteIds = globalThis.OpenlockPopitPairs.pairs.map(p => p.id);
check(paletteIds.indexOf('family') >= 0 && paletteIds.indexOf('lbp1-yellow-fuchsia') < 0,
    'the palette page lists schemes, not the retired pair table');

// Two cell schemas. A game cell the player has not dressed stays in the Deadlock layout; the shell
// draws its boundary and no title, controls or fill. Dressing it with the Popit promotes it to a
// Brass Meridian shell cell. The rail itself carries the Popit controls.
const sheet = read('clientaddon/panorama/styles/openlock_shell.css');
const schema = globalThis.OpenlockCellSchema;
check(typeof schema === 'function' && schema({ id: 'undressed', discovered: true }) === 'deadlock',
    'an undressed game cell stays in the Deadlock schema');
check(typeof schema === 'function' && schema({ id: 'owned', title: 'Owned' }) === 'shell',
    'a shell window is a shell cell');
check(/\.ShellRoot \.WindowFrame\.DeadlockCell[\s\S]{0,200}?border:\s*0px/.test(sheet) &&
    /\.WindowFrame\.DeadlockCell \.WindowTitle/.test(sheet),
    'the Deadlock schema draws no frame chrome over the game HUD');
check(/\.ShellRoot \.WindowFrame\.DeadlockCell\.Focused/.test(sheet) &&
    /\.ShellRoot \.WindowFrame\.DeadlockCell\.Pinned/.test(sheet),
    'a focused or pinned Deadlock cell still draws no boundary');
check(!/\.CloudControl\s*\{/.test(sheet) && !/\.CloudBar\s*\{/.test(sheet),
    'the withdrawn cloud shelf leaves no style behind');

// One theme system: the Popit's palette page lists the shell's schemes, and a palette entry
// applies the scheme class rather than a second pair class.
check(typeof globalThis.OpenlockPopitPairs.pairs[0].game === 'string' ||
    Array.isArray(globalThis.OpenlockPopitPairs.pairs),
    'the palette page has a registry');
check(/\.BuildHashChip\s*\{/.test(read('clientaddon/panorama/styles/openlock_shell.css')),
    'the top strip is a build-hash chip');
check(/\.LauncherBar \.LauncherButton/.test(read('clientaddon/panorama/styles/openlock_shell.css')),
    'the launcher and its switches no longer draw');

// The bar is a surface, not a state. "Show" had been left collapsing the strip while every pointer
// move called it, so the shell drew nothing but its preload sliver; an idle timer hid it too. Both
// are refused by reading the source: show is visible, hide is collapse, and render asserts it.
const shellJs = read('clientaddon/panorama/scripts/openlock_shell.js');
const showBody = (shellJs.match(/function showTaskbar\(\)[\s\S]{0,400}?\n    \}/) || [''])[0];
const hideBody = (shellJs.match(/function hideTaskbar\(\)[\s\S]{0,400}?\n    \}/) || [''])[0];
check(/taskbar\.style\.visibility = "visible"/.test(showBody) &&
    !/taskbar\.style\.visibility = "collapse"/.test(showBody),
    'showTaskbar makes the bar visible instead of collapsing it');
check(/taskbar\.style\.visibility = "collapse"/.test(hideBody) &&
    !/taskbar\.style\.visibility = "visible"/.test(hideBody),
    'hideTaskbar is the only path that collapses the bar');
check(/showTaskbar\(\);/.test(shellJs.split('function render()')[1] || ''),
    'every render asserts the bar');
check(!/lastInteractionAt > 5000\) hideTaskbar\(\)/.test(shellJs),
    'the bar is not hidden by an idle timer');

console.log('chrome-test OK ' + checks + ' checks');

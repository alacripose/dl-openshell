// Headless behaviour test for the shell's dashboard app: rail, dp grid, cells, popit layout,
// absence detection and the saved snapshot. It drives the real openlock_shell.js with a fake
// Panorama panel and asserts the state transitions, not the source text.
//
// Run: node tools/tests/dashboard-test.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const msgs = [];
const dispatched = [];

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
        this.actuallayoutwidth = 1920;
        this.actuallayoutheight = 1080;
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
    GetAttributeString() { return ''; }
    GetAttributeInt() { return 0; }
    GetPositionWithinWindow() { return { x: 0, y: 0 }; }
    SetFocus() {}
}

const root = new FakePanel('Panel', null, 'ShellRoot');
for (const id of ['WindowLayer', 'PanelLayer', 'Taskbar', 'PreloadStrip', 'PreloadLabel',
    'PreloadModules', 'PreloadFill', 'TabStrip', 'TaskbarRight', 'DashboardButton',
    'WindowsButton', 'VersionLabel', 'Clock', 'LauncherBar', 'LauncherButton', 'SchemeButton',
    'FormButton', 'LauncherLabel', 'SchemeLabel', 'FormLabel', 'DropGrid', 'ToastStack',
    'BuildStrip', 'UpdateModal']) {
    new FakePanel('Panel', root, id);
}
// A HUD tree above the shell root, as the game mounts it: the shell's stream yields on a real
// tree, and an empty fake tree would re-enter the browser instead of settling.
const hud = new FakePanel('Panel', null, 'Hud');
root.parent = hud;
hud.children.push(root);
const hudAbilities = new FakePanel('Panel', hud, 'HudAbilities');
hudAbilities.AddClass('CitadelHudAbilities');
hudAbilities.actuallayoutwidth = 420;
hudAbilities.actuallayoutheight = 140;

let scheduled = 0;
// Zero-delay callbacks run inline, but only a bounded number of them: the shell's HUD stream
// reschedules itself, and a fake engine that ran every tick forever would recurse instead of
// yielding a frame.
let immediateBudget = 40;
globalThis.$ = {
    GetContextPanel: () => root,
    CreatePanel: (type, parent, id) => new FakePanel(type, parent, id),
    Schedule: (delay, fn) => {
        scheduled++;
        if (delay === 0 && typeof fn === 'function' && immediateBudget > 0) {
            immediateBudget--;
            fn();
        }
        return scheduled;
    },
    Msg: (...args) => { msgs.push(args.join('')); },
    DispatchEvent: (...args) => { dispatched.push(args); },
    MousePosition: () => ({ x: 10, y: 10 }),
    GetCursorPosition: () => ({ x: 10, y: 10 }),
    Localize: s => s,
};
globalThis.GameUI = {
    GetCursorPosition: () => ({ x: 10, y: 10 }),
    IsMouseDown: () => false,
};
globalThis.Game = {};

function load(rel) { vm.runInThisContext(read(rel), { filename: rel }); }
load('clientaddon/panorama/scripts/openlock_shell_data.js');
load('clientaddon/panorama/scripts/openlock_audio.js');
load('clientaddon/panorama/scripts/openlock_popit.js');
load('clientaddon/panorama/scripts/openlock_layout.js');
load('clientaddon/panorama/scripts/openlock_shell.js');

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
function buttons(panel, label) {
    return panel.FindChildrenWithClassTraverse('ViewAction')
        .filter(b => texts(b).includes(label));
}

check(typeof globalThis.OpenlockDashboard === 'function', 'OpenlockDashboard is exported');

// The game is on its dashboard: no declared panel is bound, so the shell has nothing to frame.
globalThis.OpenlockDashboard();
check(globalThis.OpenlockLayoutPass && globalThis.OpenlockLayoutPass.isOpen(),
    'opening the dashboard opens the layout pass');
check(globalThis.OpenlockLayoutPass.snapshot().some(r => r.id === '__dashboard'),
    'a shell-drawn window is a participant in the same layout pass');

const app = dashboardBody();
check(app.FindChildrenWithClassTraverse('DashHeader').length === 1, 'the app draws its 34 dp header');
check(app.FindChildrenWithClassTraverse('DashSeam').length === 1, 'the header is followed by a 1 px seam');
const rail = app.FindChildrenWithClassTraverse('DashRail')[0];
check(!!rail, 'the app draws its rail');
const slots = rail.FindChildrenWithClassTraverse('DashRailSlot');
check(slots.length === 5, 'the rail has five destinations (' + slots.length + ')');
check(slots.some(s => s.classes.has('Active') && texts(s).includes('LAYOUT')),
    'LAYOUT is the active destination');
check(app.FindChildrenWithClassTraverse('DashStatus').length === 1, 'the app draws its 32 dp status strip');
check(texts(app).some(t => t.indexOf('0/328 game panels on screen') >= 0),
    'the header reads the live tree before any panel is bound');
const statusText = texts(app.FindChildrenWithClassTraverse('DashStatus')[0]).join(' | ');
check(/grid 8 dp/.test(statusText), 'the status strip names the dp grid: ' + statusText);
check(/snap on/.test(statusText), 'the status strip names the snap state');

// LAYOUT: the declared package, its cells, its contents, and a 1:1 grid.
const panel = app.FindChildrenWithClassTraverse('DashPanel')[0];
const panelText = texts(panel).join('\n');
check(panelText.includes('declared package'), 'the layout destination shows the declared package');
check(panelText.includes('visual cells'), 'the layout destination shows visual cells');
check(panelText.includes('contents'), 'the layout destination shows contents');
check(panelText.includes('dp pixel grid'), 'the layout destination shows the dp grid');
const vertical = panel.FindChildrenWithClassTraverse('DashGridLine')
    .filter(l => l.classes.has('Vertical'));
const horizontal = panel.FindChildrenWithClassTraverse('DashGridLine')
    .filter(l => l.classes.has('Horizontal'));
check(vertical.length === 320 / 8 + 1, '8 dp grid: 41 vertical seams (' + vertical.length + ')');
check(horizontal.length === 224 / 8 + 1, '8 dp grid: 29 horizontal seams (' + horizontal.length + ')');
check(panel.FindChildrenWithClassTraverse('DashWindowRect').length === 1, 'the window rect is drawn once');
check(panel.FindChildrenWithClassTraverse('DashCell').length >= 1, 'the window cell is drawn');

// Selecting a game window follows its declared package and its absence from the live tree.
// Inventory's declared panel is CitadelHudHeroShop and the fake HUD is not drawing it, so it is
// the closed window the editor must still describe.
const inventoryRow = panel.FindChildrenWithClassTraverse('ViewAction')
    .find(b => texts(b).some(t => t.indexOf('Inventory / crafting') >= 0));
check(!!inventoryRow, 'the window list offers Inventory');
inventoryRow.events.onmouseactivate();
const selectedText = texts(dashboardBody().FindChildrenWithClassTraverse('DashPanel')[0]).join('\n');
check(selectedText.includes('declared package  ·  inventory'), 'selecting a window re-reads its package');
check(selectedText.includes('not on screen'), 'a closed game window reads as not on screen');
check(selectedText.includes('CitadelHudHeroShop'), 'the package row carries the declared panel candidate');
check(!selectedText.includes('presence on screen'), 'a closed window is not reported as present');

// Opening a closed window is still an explicit act: the hook creates the frame and refuses the
// binding because the game is not drawing the panel — the absence is named, not guessed at.
globalThis.OpenlockWindows();
const hook = root.FindChildrenWithClassTraverse('ViewAction')
    .find(b => texts(b).some(t => t.indexOf('Inventory / crafting') >= 0 && t.indexOf('CitadelHudHeroShop') >= 0));
check(!!hook, 'the window browser offers the Inventory hook');
hook.events.onmouseactivate();

// A nudge moves the real geometry by exactly one grid square and reaches the saved row. Abilities
// is the window the fake HUD is drawing, so its frame is bound and its placement is the player's.
const layoutRail = dashboardBody().FindChildrenWithClassTraverse('DashRailSlot')
    .find(s => texts(s).includes('LAYOUT'));
layoutRail.events.onmouseactivate();
const abilitiesAction = dashboardBody().FindChildrenWithClassTraverse('ViewAction')
    .find(b => texts(b).some(t => t.indexOf('Abilities') >= 0 && t.indexOf('abilities') >= 0));
check(!!abilitiesAction, 'the layout destination selects Abilities');
abilitiesAction.events.onmouseactivate();
const abilityPlacement = globalThis.OpenlockLayoutPass.snapshot().find(r => r.id === 'abilities');
check(!!abilityPlacement, 'the shell records the Abilities window in the layout pass');
check(abilityPlacement.placed.y > abilityPlacement.preShell.y,
    'the top-row ability window is shifted below the shell chrome: ' +
    abilityPlacement.preShell.y + ' -> ' + abilityPlacement.placed.y);
check(typeof hudAbilities.style.transform === 'string' &&
    hudAbilities.style.transform.indexOf(String(abilityPlacement.placed.y) + 'px') >= 0,
    'the live panel transform carries the shift: ' + hudAbilities.style.transform);
const right = buttons(dashboardBody(), '→ 8 dp')[0];
check(!!right, 'the editor offers a one-grid nudge');
right.events.onmouseactivate();
const saveAfterNudge = buttons(dashboardBody(), 'Save this layout')[0];
saveAfterNudge.events.onmouseactivate();
const nudgeDispatch = dispatched.filter(d => d[0] === 'CitadelConCommand' &&
    String(d[1]).indexOf('openlock-shell|layout:') >= 0).pop();
if (!nudgeDispatch) {
    throw new Error('no layout dispatch after nudge; frames=' + JSON.stringify(dispatched.slice(-4)));
}
const nudgedSnapshot = String(nudgeDispatch[1]).split('|')[1].slice('layout:'.length);
check(/@abilities,12,46,420,140(?:@|$)/.test(nudgedSnapshot),
    'the nudge moved Abilities by one 8 dp square in the saved row: ' + nudgedSnapshot.slice(0, 160));

// The grid step re-lays the canvas instead of scaling it.
const step16 = buttons(dashboardBody(), '16 dp')[0];
check(!!step16, 'the editor offers a 16 dp grid');
step16.events.onmouseactivate();
const vertical16 = dashboardBody().FindChildrenWithClassTraverse('DashGridLine')
    .filter(l => l.classes.has('Vertical'));
check(vertical16.length === 320 / 16 + 1, '16 dp grid: 21 vertical seams (' + vertical16.length + ')');

// POPIT: the dashboard page describes the cell editor and opens the same cursor surface.
const popitSlot = rail.FindChildrenWithClassTraverse('DashRailSlot')
    .find(s => texts(s).includes('POPIT'));
popitSlot.events.onmouseactivate();
const popitText = texts(dashboardBody().FindChildrenWithClassTraverse('DashPanel')[0]).join('\n');
check(popitText.includes('successor to a declared XML window'),
    'the popit page starts from the cell-editor model: ' + popitText.slice(0, 60));
check(popitText.includes('CURSOR  select the live cell') &&
    popitText.includes('PALETTE  all 37 LBP player colours') &&
    popitText.includes('GOODIES  materials'),
    'the popit page names the root sections, including the pair palette');
check(!popitText.includes('two CREATE/PLAY cards') && !popitText.includes('Play cards'),
    'the popit page no longer describes a CREATE/PLAY launcher');
buttons(dashboardBody(), 'Open the Popit cursor')[0].events.onmouseactivate();
const surface = root.FindChildrenWithClassTraverse('PopitSurface')[0];
check(!!surface, 'the dashboard draws the cursor surface');
check(surface.FindChildrenWithClassTraverse('PopitRootRow').length === 6,
    'the surface carries the six-section root');
check(surface.FindChildrenWithClassTraverse('PopitChild').length === 1 && surface.HasClass('ChildOpen'),
    'the surface reveals its contextual child beside the root');
check(surface.FindChildrenWithClassTraverse('PopitCard').length === 0,
    'the surface has no CREATE/PLAY cards');
check(globalThis.OpenlockPopit.status().page === 'cursor',
    'the dashboard opens the Popit on the Cursor page');

// Selecting the live Abilities panel takes the surface to Goodies, and a material writes the
// style on the actual fake HUD panel.
const popitTargets = surface.FindChildrenWithClassTraverse('PopitTarget');
check(popitTargets.length >= 1, 'the cursor lists the live panel');
popitTargets[0].events.onmouseactivate();
const materialSurface = root.FindChildrenWithClassTraverse('PopitSurface')[0];
check(!!materialSurface && globalThis.OpenlockPopit.status().page === 'goodies',
    'selecting a target opens its Goodies Bag');
const cardMaterial = materialSurface.FindChildrenWithClassTraverse('PopitItem')
    .find(item => texts(item).includes('Card'));
check(!!cardMaterial, 'the Goodies Bag offers Card');
const beforePaint = hudAbilities.style.backgroundColor || '';
cardMaterial.events.onmouseactivate();
check(!!hudAbilities.style.backgroundColor && hudAbilities.style.backgroundColor !== beforePaint,
    'a material paints the live cell, not a separate platform');
globalThis.OpenlockPopit.close();
check(root.FindChildrenWithClassTraverse('PopitSurface').length === 0,
    'closing the cursor removes the surface');

// An intermediate save proves the edited arrangement reaches the profile line.
layoutRail.events.onmouseactivate();
buttons(dashboardBody(), 'Save this layout')[0].events.onmouseactivate();
const midDispatch = dispatched.filter(d => d[0] === 'CitadelConCommand' &&
    String(d[1]).indexOf('openlock-shell|layout:') >= 0).pop();
console.log('MID>>> ' + String(midDispatch[1]).slice(-80));

// BUILD: presence is read from the panel tree, not assumed.
const buildSlot = rail.FindChildrenWithClassTraverse('DashRailSlot')
    .find(s => texts(s).includes('BUILD'));
buildSlot.events.onmouseactivate();
const buildText = texts(dashboardBody().FindChildrenWithClassTraverse('DashPanel')[0]).join('\n');
check(/1 of 328 on screen/.test(buildText), 'build counts the one panel the fake HUD is drawing: ' + buildText.slice(0, 90));
check(/Presence is read from the live panel tree/.test(buildText), 'build names the live tree as its source');

// XML: a closed window's layout can be selected and mounted outside its window.
const xmlSlot = rail.FindChildrenWithClassTraverse('DashRailSlot')
    .find(s => texts(s).includes('XML'));
xmlSlot.events.onmouseactivate();
const xmlPanel = dashboardBody().FindChildrenWithClassTraverse('DashPanel')[0];
const xmlFirst = xmlPanel.FindChildrenWithClassTraverse('ViewAction')
    .find(b => texts(b).some(t => t.indexOf('.xml') >= 0));
check(!!xmlFirst, 'the XML app lists mounted layouts');
xmlFirst.events.onmouseactivate();
const host = dashboardBody().FindChildrenWithClassTraverse('DashXmlHost')[0];
check(!!host && host.loaded === true, 'the selected layout mounts into the shell-owned host');
check(host.children.length === 0, 'the mount is not reparented into the game tree');


// Saving: the layout snapshot is the profile line the host's parser reads.
const layoutSlot = rail.FindChildrenWithClassTraverse('DashRailSlot')
    .find(s => texts(s).includes('LAYOUT'));
layoutSlot.events.onmouseactivate();
const save = buttons(dashboardBody(), 'Save this layout')[0];
check(!!save, 'the layout destination offers a save');
save.events.onmouseactivate();
const layoutDispatch = dispatched.filter(d => d[0] === 'CitadelConCommand' &&
    String(d[1]).indexOf('openlock-shell|layout:') >= 0).pop();
check(!!layoutDispatch, 'save dispatches a layout snapshot to the host');
const snapshot = String(layoutDispatch[1]).split('|')[1].slice('layout:'.length);
check(/@popit=columns:4;width:356;frame:lbp3;mode:create;order:/.test(snapshot),
    'the legacy popit profile row is still emitted for older readers: ' + snapshot.slice(0, 120));
check(/@abilities,12,46,420,140,m[0-6]c[0-6]d[0-4]r(-1|0|6|12|18)b(-1|0|1|2|3)o(-1|75|90|100)(?:@|$)/.test(snapshot),
    'the painted cell carries its Popit style in the saved row: ' + snapshot.slice(0, 180));

// Closing releases the reservation. The next placement asks the pass while it is closed and gets
// the pre-shell rect back, which is what the game's own UI fits into again.
globalThis.OpenlockCollapse();
check(!globalThis.OpenlockLayoutPass.isOpen(), 'closing the shell closes the layout pass');
const abilityAfterClose = globalThis.OpenlockLayoutPass.snapshot().find(r => r.id === 'abilities');
const released = globalThis.OpenlockLayoutPass.place('abilities', abilityAfterClose.preShell,
    abilityAfterClose.extraTop);
check(released.y === abilityAfterClose.preShell.y && released.dy === 0,
    'the closed pass returns the stored pre-shell rect');
// Abilities is pinned (the package's pin list), so closing keeps its placement but must drop the
// shell's extra chrome shift. An unpinned panel is released outright by releasePanel().
check(hudAbilities.style.transform.indexOf(String(abilityPlacement.placed.y) + 'px') < 0,
    'closing the shell removes the chrome shift from the live panel: ' + hudAbilities.style.transform);

console.log('dashboard-test OK ' + checks + ' checks');

// Popit surface proof: the design-bible root/child model, not a page-replacing launcher.
//
// The root stays mounted with its six sections. Opening a section reveals a contextual child
// pane; Back closes it and keeps the root. Palette carries the 37 LBP colour pairs and the
// chosen pair is reported to the shell for the saved profile. The cell-edit alphabet is
// unchanged, so the rework cannot quietly change what the host parses.
//
// Run: node tools/tests/popit-test.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

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
        this.actuallayoutheight = id === 'OpenlockPopit' ? 320 : 0;
        if (parent) parent.children.push(this);
    }
    AddClass(c) { this.classes.add(c); }
    RemoveClass(c) { this.classes.delete(c); }
    HasClass(c) { return this.classes.has(c); }
    SetPanelEvent(e, fn) { this.events[e] = fn; }
    GetChildCount() { return this.children.length; }
    GetChild(i) { return this.children[i] || null; }
    DeleteAsync() {
        if (this.parent) {
            const at = this.parent.children.indexOf(this);
            if (at >= 0) this.parent.children.splice(at, 1);
        }
        this.parent = null;
    }
    SetImage(src) { this.src = src; }
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
}

globalThis.$ = {
    CreatePanel: (type, parent, id) => new FakePanel(type, parent, id),
    Schedule: () => {},
    Msg: () => {},
};

const root = new FakePanel('Panel', null, 'root');
vm.runInThisContext(read('clientaddon/panorama/scripts/openlock_pairs.js'),
    { filename: 'clientaddon/panorama/scripts/openlock_pairs.js' });
vm.runInThisContext(read('clientaddon/panorama/scripts/openlock_popit.js'),
    { filename: 'clientaddon/panorama/scripts/openlock_popit.js' });

let checks = 0;
function check(cond, name) {
    checks++;
    if (!cond) throw new Error('FAILED: ' + name);
    console.log('ok ' + checks + ' - ' + name);
}

const palette = {
    body: '#12151A', panel: '#171B21', title: '#1C222B', meta: '#0C0E11',
    border: '#262C34', borderStrong: '#F0C454', ink: '#ECEFF2', muted: '#AAB3BD',
    accent: '#F0C454', alert: '#E4786F',
};
const targets = [
    { id: 'cell:root:health', title: 'Health', kind: 'cell', rect: { x: 100, y: 300, w: 180, h: 42 } },
    { id: 'citadel:shop', title: 'Shop', kind: 'window', rect: { x: 500, y: 120, w: 420, h: 300 } },
];
const edits = [];
const pairsChosen = [];
const classicStates = [];
let selected = null;
let resets = 0;
let closed = 0;

check(/^openlock\.popit-pairs\/[0-9a-f]{32}$/.test(globalThis.OpenlockPopitPairs.format),
    'the pair table is hash-pinned and loads with the surface');
check(globalThis.OpenlockPopitPairs.pairs.length === 37, 'the pair table carries 37 player colours');

const opened = globalThis.OpenlockPopit.show({
    root,
    screen: { w: 1600, h: 900, top: 46 },
    palette,
    targets,
    target: targets[0],
    state: { material: 'none', decoration: 'none', color: '', radius: -1, border: -1, opacity: -1 },
    page: 'cursor',
    onSelect(t) { selected = t; },
    onApply(state) { edits.push(state); },
    onPair(pair) { pairsChosen.push(pair.id); },
    onClassic(on) { classicStates.push(on); },
    onReset() { resets++; },
    onClose() { closed++; },
});
check(opened.ok, 'the Popit opens on a live target');
check(opened.pair === 'popit-blue', 'the default pair is the blue Popit');
check(opened.child === true, 'a requested section opens the child pane');

const surface = root.children.find(p => p.id === 'OpenlockPopit');
check(!!surface, 'the surface is a real panel');
check(surface.HasClass('PairPopitBlue'), 'the default pair class is on the surface');
check(surface.HasClass('ChildOpen'), 'the surface carries the child-open state');
check(surface.FindChildrenWithClassTraverse('PopitRoot').length === 1,
    'the persistent root is mounted');
const rootRows = surface.FindChildrenWithClassTraverse('PopitRootRow');
check(rootRows.length === 6, 'the root lists all six sections');
check(surface.FindChildrenWithClassTraverse('PopitPageDot').length === 6,
    'the root foot carries one dot per section');
check(surface.FindChildrenWithClassTraverse('PopitSection').length === 1,
    'the child opens with one section labeller');
check(surface.FindChildrenWithClassTraverse('PopitWordmark').length === 1,
    'the root header carries the Popit wordmark');
check(surface.FindChildrenWithClassTraverse('PopitPairChip').length === 1,
    'the root header carries the pair chip');
check(surface.FindChildrenWithClassTraverse('PopitClassicChip').length === 1,
    'the root header carries the Classic chip');
check(surface.FindChildrenWithClassTraverse('PopitBack').length === 1,
    'the child carries a Back control');

const halo = root.children.find(p => p.id === 'OpenlockPopitCursor');
check(!!halo && halo.HasClass('PopitCursorHalo'), 'the cursor halo is drawn around the selected cell');
check(halo.style.borderColor === palette.accent && halo.style.visibility === 'visible',
    'the halo uses the Player Colour and is visible');

const rows = surface.FindChildrenWithClassTraverse('PopitTarget');
check(rows.length === 2, 'the Cursor child lists exactly the live targets');
rows[1].events.onmouseactivate();
check(selected && selected.id === 'citadel:shop', 'clicking a target asks the shell to select it');

// Opening another section keeps the root mounted and swaps only the child's content.
const rootBefore = surface.FindChildrenWithClassTraverse('PopitRoot')[0];
globalThis.OpenlockPopit.setPage('palette');
const palettePage = root.children.find(p => p.id === 'OpenlockPopit');
check(palettePage.FindChildrenWithClassTraverse('PopitRoot')[0] === rootBefore,
    'the root object survives a section change');
const pairTiles = palettePage.FindChildrenWithClassTraverse('PopitItemPair');
check(pairTiles.length === 37, 'the Palette child lists all 37 player colours');
check(palettePage.FindChildrenWithClassTraverse('PopitSection').length >= 3,
    'the Palette child groups the colours under game labellers');
const blueTile = pairTiles.find(item => item.value === 'popit-blue');
check(blueTile && blueTile.HasClass('Selected'), 'the active pair is the selected tile');
const yellow = pairTiles.find(item => item.value === 'lbp1-yellow-fuchsia');
check(!!yellow, 'a specific LBP1 pair is addressable');
yellow.events.onmouseactivate();
check(pairsChosen.length === 1 && pairsChosen[0] === 'lbp1-yellow-fuchsia',
    'picking a pair notifies the shell for the saved profile');
check(surface.HasClass('PairLbp1YellowFuchsia') && !surface.HasClass('PairPopitBlue'),
    'the chosen pair class replaces the previous one');
check(globalThis.OpenlockPopit.status().pair === 'lbp1-yellow-fuchsia',
    'status reports the chosen pair');

// Classic is the opt-out: the pair class leaves and the scheme's own roles return.
const classicChip = palettePage.FindChildrenWithClassTraverse('PopitClassicChip')[0];
classicChip.events.onmouseactivate();
check(classicStates.length === 1 && classicStates[0] === true, 'Classic notifies the shell');
check(surface.HasClass('Classic'), 'the surface carries the Classic class');
check(!surface.HasClass('PairLbp1YellowFuchsia'), 'Classic removes the pair class');
check(globalThis.OpenlockPopit.status().classic === true, 'status reports Classic');
classicChip.events.onmouseactivate();
check(classicStates[1] === false && surface.HasClass('PairLbp1YellowFuchsia'),
    'leaving Classic restores the chosen pair');

// Back closes the child and keeps the root and its section state.
const back = palettePage.FindChildrenWithClassTraverse('PopitBack')[0];
back.events.onmouseactivate();
check(!surface.HasClass('ChildOpen'), 'Back closes the child');
check(surface.FindChildrenWithClassTraverse('PopitRootRow').length === 6,
    'Back leaves the root mounted with all six sections');
check(surface.FindChildrenWithClassTraverse('PopitItemPair').length === 0,
    'Back clears the child content');

// Reduced motion is a real suppression path.
globalThis.OpenlockPopit.setReducedMotion(true);
check(surface.HasClass('ReducedMotion'), 'reduced motion adds the suppression class');
check(globalThis.OpenlockPopit.status().reducedMotion === true, 'status reports reduced motion');
globalThis.OpenlockPopit.setReducedMotion(false);
check(!surface.HasClass('ReducedMotion'), 'motion can be restored');

globalThis.OpenlockPopit.close();
check(closed === 1, 'closing the surface notifies the shell once');
check(!root.children.find(p => p.id === 'OpenlockPopit'), 'closing removes the surface panel');
check(!root.children.find(p => p.id === 'OpenlockPopitCursor'), 'closing removes the halo');
check(!root.children.find(p => p.id === 'OpenlockPopitDismiss'), 'closing removes the dismiss layer');

const reopened = globalThis.OpenlockPopit.show({
    root,
    screen: { w: 1600, h: 900, top: 46 },
    palette,
    targets,
    target: targets[0],
    state: { material: 'none', decoration: 'none', color: '', radius: -1, border: -1, opacity: -1 },
    page: 'goodies',
    pair: 'lbp3-candy-jar',
    onApply(state) { edits.push(state); },
    onReset() { resets++; },
});
check(reopened.ok, 'the Goodies section opens on the same target');
check(reopened.pair === 'lbp3-candy-jar', 'a saved pair is applied on open');
const goodies = root.children.find(p => p.id === 'OpenlockPopit');
check(goodies.HasClass('PairLbp3CandyJar'), 'the saved pair class is on the reopened surface');
const materials = goodies.FindChildrenWithClassTraverse('PopitItem');
check(materials.length === 7, 'the Goodies Bag lists seven materials including Bare');
const card = materials.find(item => item.value === 'card');
check(!!card, 'the Card material is addressable');
card.events.onmouseactivate();
check(edits.length === 1 && edits[0].material === 'card',
    'picking Card emits a material edit, not a launcher action');
check(globalThis.OpenlockPopit.status().page === 'goodies', 'the child stays on the section after an edit');

globalThis.OpenlockPopit.setPage('stickers');
const decorations = goodies.FindChildrenWithClassTraverse('PopitItem');
check(decorations.length === 5, 'Stickers lists four treatments and None');
decorations.find(item => item.value === 'stitch').events.onmouseactivate();
check(edits[1].decoration === 'stitch', 'picking Stitch emits a decoration edit');

globalThis.OpenlockPopit.setPage('tools');
const options = goodies.FindChildrenWithClassTraverse('PopitOption');
check(options.length === 14, 'Tools has Form and four values for corners, border and opacity');
options.find(item => Number(item.value) === 12).events.onmouseactivate();
check(edits[2].radius === 12, 'the corners option emits a radius tweak');
const reset = goodies.FindChildrenWithClassTraverse('PopitReset')[0];
reset.events.onmouseactivate();
check(resets === 1, 'Restore this cell asks the shell to clear the edit');

globalThis.OpenlockPopit.setPage('color');
const colors = goodies.FindChildrenWithClassTraverse('PopitItem');
check(colors.length === 7, 'Player Color lists Default and six scheme roles');
colors.find(item => item.value === 'accent').events.onmouseactivate();
check(edits[3].color === 'accent', 'picking a Player Colour emits a colour edit');

const encoded = globalThis.OpenlockPopit.encodeState(edits[3]);
check(encoded === 'm6c1d4r-1b-1o-1', 'a style encodes to the fixed profile alphabet');
const decoded = globalThis.OpenlockPopit.decodeState(encoded);
check(decoded && decoded.color === 'accent' && decoded.material === 'none',
    'the profile code decodes to the same edit');
check(globalThis.OpenlockPopit.decodeState('m9c1d0r0b0o100') === null,
    'an out-of-range style is refused instead of guessed');

console.log('popit-test OK ' + checks + ' checks');

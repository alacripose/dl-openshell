// Popit surface proof: the tool menu is a real panel with declared tiles, icons, frame classes,
// a local play/create selection, frame switching and an overlap refusal. The dashboard suite only
// reads status().columns, so this is the surface's own check.
//
// Run: node tools/tests/popit-test.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const msgs = [];

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
        this.actuallayoutheight = id === 'OpenlockPopit' ? 480 : 0;
        if (parent) parent.children.push(this);
    }
    AddClass(c) { this.classes.add(c); }
    RemoveClass(c) { this.classes.delete(c); }
    HasClass(c) { return this.classes.has(c); }
    SetPanelEvent(e, fn) { this.events[e] = fn; }
    DeleteAsync() {
        if (!this.parent) return;
        const at = this.parent.children.indexOf(this);
        if (at >= 0) this.parent.children.splice(at, 1);
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
    Msg: (...args) => { msgs.push(args.join('')); },
};

const root = new FakePanel('Panel', null, 'root');
vm.runInThisContext(read('clientaddon/panorama/scripts/openlock_popit.js'),
    { filename: 'clientaddon/panorama/scripts/openlock_popit.js' });

let checks = 0;
function check(cond, name) {
    checks++;
    if (!cond) throw new Error('FAILED: ' + name);
    console.log('ok ' + checks + ' - ' + name);
}

const actions = ['trees', 'picker', 'settings', 'performance', 'minimap']
    .map(id => ({ id, label: id }));
let refusals = 0;
const opened = globalThis.OpenlockPopit.show({
    root,
    geometry: { x: 100, y: 100, w: 500, h: 400 },
    screen: { w: 1600, h: 900, top: 46 },
    openRects: [],
    form: 'popit',
    layer: { title: 'Map / plan', hint: 'Pick a tool.' },
    actions,
    onAction() {},
    onRefusal() { refusals++; },
    onHover() {},
    onHoverEnd() {},
});
check(opened.ok, 'the surface opens on a declared layer');

const surface = root.children.find(p => p.id === 'OpenlockPopit');
check(!!surface, 'the surface is a real panel');
const tiles = surface.FindChildrenWithClassTraverse('PopitTile');
check(tiles.length === 5, 'the surface draws one tile per declared action');
check(tiles.filter(t => t.classes.has('Selected')).length === 1,
    'exactly one tile starts selected');
check(surface.FindChildrenWithClassTraverse('Lbp3').length > 0,
    'the declared form class is applied to the surface');
const icons = surface.FindChildrenWithClassTraverse('PopitTileIcon');
check(icons.length === 5 && icons.every(i => i.src && i.src.startsWith('s2r://panorama/images/')),
    'every tile draws a declared icon, not a text glyph');

const modes = surface.FindChildrenWithClassTraverse('PopitMode');
const play = modes.find(p => p.id === 'OpenlockPopitModePlay');
play.events.onmouseactivate();
check(play.classes.has('Active'), 'selecting play marks the mode active');
check(!modes.find(p => p.id === 'OpenlockPopitModeCreate').classes.has('Active'),
    'selecting play clears create');

globalThis.OpenlockPopit.setFrame('karting');
check(surface.FindChildrenWithClassTraverse('Karting').length > 0,
    'switching the frame applies the new form class');
check(surface.FindChildrenWithClassTraverse('Lbp3').length === 0,
    'switching the frame removes the old form class');
const status = globalThis.OpenlockPopit.status();
check(status.frame === 'karting' && status.mode === 'play' && status.actions === 5,
    'status reports the frame, the local mode and the tile count');

globalThis.OpenlockPopit.close();
const blocked = globalThis.OpenlockPopit.show({
    root,
    geometry: { x: 0, y: 0, w: 1600, h: 900 },
    screen: { w: 1600, h: 900, top: 46 },
    openRects: [{ id: 'other', title: 'Other', x: 0, y: 0, w: 1600, h: 900 }],
    layer: { title: 'Blocked' },
    actions,
    onRefusal() { refusals++; },
});
check(!blocked.ok && refusals === 1, 'a surface over another window is refused, not drawn twice');

console.log('popit-test OK ' + checks + ' checks');

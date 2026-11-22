// The standalone boot's carrier rule, exercised without the game.
//
// The in-game measurement was `Taskbar:0x0 < OpenlockStandaloneHost:0x0 < CitadelHudRoot:0x0`: the
// boot created its host on a component root that has no parent and no box, so every child measured
// zero and nothing drew. This test stands that tree up in JavaScript and checks the rule the fix
// claims: a created host lands on a panel that reports a layout box (an ancestor, or the nearest
// laid-out panel the component built), a shipped anchor is used where it exists, and a Deadworks
// host still makes the boot yield.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BOOT = path.join(__dirname, '..', '..', 'clientaddon', 'standalone', 'panorama', 'scripts', 'openlock_boot.js');

let checks = 0;
let failures = 0;

function expect(label, actual, wanted) {
    checks += 1;
    if (actual !== wanted) {
        failures += 1;
        console.log('FAIL ' + label + ': wanted ' + wanted + ', got ' + actual);
    }
}

function panel(id, width, height, parent) {
    const node = {
        id: id,
        style: {},
        hittest: true,
        hittestchildren: false,
        actuallayoutwidth: width,
        actuallayoutheight: height,
        kids: [],
        mounted: 0,
        _parent: parent || null,
        GetParent: function () { return node._parent; },
        GetChild: function (index) { return node.kids[index] || null; },
        GetChildCount: function () { return node.kids.length; },
        RemoveAndDeleteChildren: function () { node.kids.length = 0; },
        BLoadLayout: function () { node.mounted += 1; return true; },
        AddChild: function (child) { node.kids.push(child); },
        FindChildTraverse: function (wanted) {
            if (node.id === wanted) return node;
            for (let i = 0; i < node.kids.length; i += 1) {
                const hit = node.kids[i].FindChildTraverse(wanted);
                if (hit) return hit;
            }
            return null;
        }
    };
    if (parent) parent.AddChild(node);
    return node;
}

function runScenario(build) {
    const tree = build(panel);
    const dollar = {
        GetContextPanel: function () { return tree.context; },
        Msg: function () {
            if (process.env.BOOT_VERBOSE) console.log('  boot:', Array.prototype.join.call(arguments, ''));
        },
        CreatePanel: function (type, parent, id) {
            tree.created += 1;
            const made = panel(id, 0, 0, parent);
            return made;
        }
    };
    const context = { $: dollar, console: console };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(BOOT, 'utf8'), context, { filename: 'openlock_boot.js' });
    return tree;
}

// The component root has no parent and no box; the HUD panels it built are the ones on screen.
function clientTree(make, withAnchor, withContent) {
    const root = make('CitadelHudRoot', 0, 0, null);
    const context = make('Context', 0, 0, root);
    const tree = { root: root, context: context, created: 0 };
    if (withContent) tree.content = make('HudContent', 1920, 1080, root);
    if (withAnchor) tree.anchor = make('OpenlockStandaloneHost', 0, 0, tree.content || root);
    return tree;
}

// 1. no shipped anchor, but the component built a laid-out panel: the host goes there, not on the
//    0x0 component root.
let tree = runScenario(function (make) { return clientTree(make, false, true); });
const created1 = tree.content.FindChildTraverse('OpenlockStandaloneHost');
expect('created host lands on the laid-out panel', created1 && created1.GetParent() === tree.content, true);
const direct = tree.root.kids.filter(function (kid) { return kid.id === 'OpenlockStandaloneHost'; });
expect('the component root received no direct host', direct.length, 0);
expect('one host was created', tree.created, 1);
expect('the shell loaded into the host', created1.mounted, 1);

// 2. the shipped anchor is used where base_hud put it, and no second host appears beside it.
tree = runScenario(function (make) { return clientTree(make, true, true); });
expect('shipped anchor is reused', tree.anchor.mounted, 1);
expect('no host is created when one ships', tree.created, 0);

// 3. nothing has a box at all: the boot still mounts, on the outermost panel, rather than drawing
//    nothing silently.
tree = runScenario(function (make) { return clientTree(make, false, false); });
expect('last resort still creates a host', tree.created, 1);
expect('last resort mounts the shell', tree.root.FindChildTraverse('OpenlockStandaloneHost').mounted, 1);

// 4. the shipped anchor exists but its whole tree is dead (the live client's measurement): the
//    boot must not trust it, and must mount where the HUD is actually drawn.
tree = runScenario(function (make) {
    const root = make('CitadelHudRoot', 0, 0, null);
    const context = make('Context', 0, 0, root);
    const deadWindowRoot = make('WindowRoot', 0, 0, root);
    const anchor = make('OpenlockStandaloneHost', 0, 0, deadWindowRoot);
    const content = make('HudContent', 1920, 1080, root);
    return { root: root, context: context, anchor: anchor, content: content, created: 0 };
});
const liveHost = tree.content.FindChildTraverse('OpenlockStandaloneHost');
expect('dead anchor is not mounted into', tree.anchor.mounted, 0);
expect('the shell mounts on the drawn HUD', liveHost !== null && liveHost.mounted, 1);
expect('one host was created beside the dead anchor', tree.created, 1);

// 5. a Deadworks host owns the shell: the boot yields and loads nothing.
tree = runScenario(function (make) {
    const built = clientTree(make, true, true);
    make('DWHost_openlock-shell', 0, 0, built.content);
    return built;
});
expect('yields to the Deadworks host', tree.anchor.mounted, 0);

console.log('boot-carrier: ' + checks + ' checks, ' + failures + ' failures');
process.exit(failures ? 1 : 0);

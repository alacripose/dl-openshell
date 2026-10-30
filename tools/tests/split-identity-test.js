// Focused proof for split identity on a discovered window: the durable key survives an id that
// changes between reloads (size suffix and panel name), the cells keep the ids the saved layout
// holds, and a window with no name or class family is still refused by name.
//
// Run: node tools/tests/split-identity-test.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(
    path.join(ROOT, 'clientaddon/panorama/scripts/openlock_split.js'), 'utf8');
vm.runInThisContext(source, { filename: 'openlock_split.js' });

const Split = globalThis.OpenlockSplit;
if (!Split) throw new Error('OpenlockSplit was not exported');

let checks = 0;
function check(cond, name) {
    checks++;
    if (!cond) throw new Error('FAILED: ' + name);
    console.log('ok ' + checks + ' - ' + name);
}

// A declared window keeps its package id as its identity.
const declared = Split.stableKey({ id: 'abilities' });
check(declared.key === 'abilities' && !declared.why, 'a declared window keeps its own id');

// A discovered window is pinned by what it is, never by its measured size.
const before = {
    id: 'live:AbilityContainer:400x200',
    live: true,
    discoveredBase: 'AbilityContainer',
    discoveredClass: 'AbilityContainer'
};
const first = Split.stableKey(before);
check(first.key === 'split:live_AbilityContainer', 'a discovered window pins to kind + name: ' + first.key);
check(first.key.indexOf('400') < 0 && first.key.indexOf('200') < 0,
    'the measured size is not part of the key');

const cellsBefore = ['Damage', 'Shield'].map(key => Split.cellId(first.key, key));
check(cellsBefore[0] === 'cell:split:live_AbilityContainer:Damage',
    'a cell id is keyed to the durable split key: ' + cellsBefore[0]);

// Reload one: the HUD rebuilds at another size, so the id's suffix changes.
const resized = {
    id: 'live:AbilityContainer:512x288',
    live: true,
    discoveredBase: 'AbilityContainer',
    discoveredClass: 'AbilityContainer'
};
const resizedHit = Split.resolve([Split.sourceOf(before, first.key)], [resized])[0];
check(resizedHit.id === resized.id, 'a resized HUD window resolves to the pinned split');
check(Split.stableKey(resized).key === first.key, 'the size change does not move the key');

// Reload two: the mod renames the panel id but the class family is unchanged.
const renamed = {
    id: 'live:AbilityHUD_42:512x288',
    live: true,
    discoveredBase: 'AbilityHUD_42',
    discoveredClass: 'AbilityContainer'
};
const renamedHit = Split.resolve([Split.sourceOf(before, first.key)], [renamed])[0];
check(renamedHit.id === renamed.id, 'a renamed panel resolves by its class family');
check(Split.stableKey(renamed).key === 'split:live_AbilityHUD_42_AbilityContainer',
    'the renamed window gets its own key, and the saved split still resolves to it');

// The cells the saved layout holds still match the resolved window: same ids, same paths.
const saved = cellsBefore.map((id, at) => ({
    id: id,
    cellRoot: first.key,
    cellPath: ['Damage', 'Shield'][at],
    cellKey: ['Damage', 'Shield'][at],
    x: 10 + at * 120,
    y: 40,
    width: 110,
    height: 60
}));
const owned = Split.cellsFor(saved, first.key);
check(owned.length === 2 && owned[0].id === cellsBefore[0] && owned[1].id === cellsBefore[1],
    'both saved cells belong to the resolved split key');
check(Split.pathOf(owned[1]) === 'Shield', 'a cell still carries its component path');

// The layout is the cells' own record; the split never rewrote it.
check(owned[0].x === 10 && owned[1].x === 130 && owned[0].height === 60,
    'the saved rects are unchanged by the reload');

// A window whose identity genuinely cannot be pinned keeps the refusal, by name.
const anonymous = Split.stableKey({ id: 'live::400x200', live: true });
check(anonymous.key === '' && /no name/.test(anonymous.why),
    'a window with no name or class is refused with the reason: ' + anonymous.why);

const positional = Split.stableKey({
    id: 'live:part2:400x200', live: true, discoveredBase: 'part2'
});
check(positional.key === '' && /position/.test(positional.why),
    'a discovery fallback name is a position, not an identity: ' + positional.why);

// And a key pins nothing when the window never comes back.
const gone = Split.resolve([Split.sourceOf(before, first.key)], []);
check(gone[0].id === '' && /no discovered window/.test(gone[0].why),
    'a split whose window is gone stays unresolved with its reason');

console.log('ok: ' + checks + ' split identity check(s)');

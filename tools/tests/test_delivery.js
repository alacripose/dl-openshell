// Focused Node harness for openlock_delivery.js. Panorama is not available in Node, so the
// panel API is a small fake; the module's payload, version, atomic-set and node-attribute logic
// is the same code the client runs.
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const scheduled = [];
const logs = [];
let nextId = 1;

function panel(tag, parent, id) {
    const p = {
        id: id || "",
        tag,
        classes: [],
        style: {},
        children: [],
        parent: parent || null,
        enabled: true,
        visible: true,
        selected: false,
        text: "",
        value: undefined,
        src: "",
        AddClass(c) { this.classes.push(c); },
        RemoveAndDeleteChildren() { this.children = []; },
        GetChildCount() { return this.children.length; },
        SetImage(v) { this.src = v; },
        SetPanelEvent() {}
    };
    p.__uid = nextId++;
    if (parent) parent.children.push(p);
    return p;
}

const root = panel("Panel", null, "root");
const context = {
    console,
    Date,
    JSON,
    Number,
    String,
    Math,
    isFinite,
    parseInt,
    Array,
    Object,
    RegExp,
    globalThis: null,
    $: {
        Msg: (...args) => logs.push(args.join(" ")),
        Schedule: (delay, fn) => { scheduled.push(fn); return 1; },
        CreatePanel: (tag, parent, id) => panel(tag, parent, id)
    }
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync("clientaddon/panorama/scripts/openlock_delivery.js", "utf8"), context);

function drain(limit = 1000) {
    let n = 0;
    while (scheduled.length) {
        if (n++ > limit) throw new Error("schedule loop");
        const fn = scheduled.shift();
        fn();
    }
}

const body = panel("Panel", root, "body");

const host = {
    windows: [],
    index: {},
    log: (kind, text) => logs.push(`${kind}: ${text}`),
    refuse: (title, why) => { throw new Error(`refused: ${title}: ${why}`); },
    applied: (stats) => { host.lastApplied = stats; },
    closeWindow: (id) => { delete host.index[id]; },
    rebuild: (win) => { logs.push("rebuild " + win.id + " tree=" + (win.liveTree ? win.liveTree.length : "none")); context.OpenlockDelivery.renderTree(body, win.liveTree, "addon:" + win.id); },
    observer: (payload) => { host.lastObserver = payload; }
};
context.OpenlockDelivery.configure(host);

function node(version) {
    const v2 = version === 2;
    return {
        tag: "Panel",
        id: "",
        class: "ProofRoot",
        text: "",
        attrs: {},
        styles: { width: "100%", height: "100%" },
        children: [
            { tag: "Label", id: "ProofTitle", class: "ProofTitle", text: v2 ? "v2 · replaced in place" : "v1 · delivered package", attrs: {}, styles: {}, children: [] },
            { tag: "Image", id: "ProofImage", class: "ProofImage", text: "", attrs: { src: v2 ? "s2r://panorama/images/control_icons/warning_alt_png.vtex" : "s2r://panorama/images/control_icons/star_png.vtex" }, styles: {}, children: [] },
            { tag: "ProgressBar", id: "ProofProgress", class: "ProofProgress", text: "", attrs: { value: v2 ? "0.75" : "0.25" }, styles: {}, children: [] },
            { tag: "Label", id: "ProofHidden", class: "ProofValue", text: "hidden attribute was ignored", attrs: { visible: "false" }, styles: {}, children: [] },
            { tag: "Button", id: "ProofButton", class: "ProofButton", text: "action", attrs: { enabled: v2 ? "false" : "true", visible: "true", selected: "true" }, styles: {}, children: [] }
        ]
    };
}

function payload(revision, version, windows) {
    return JSON.stringify({
        format: "openlock.addons/2",
        revision,
        packages: [{ name: "proof-ui", version: `${version}-0-0` }],
        windows
    });
}

function windowFor(revision, version) {
    return [{
        id: "addon:proof-ui:proof-panel",
        title: "Delivery proof",
        content: "readout",
        view: "addon-layout",
        addon: "proof-ui",
        addonName: "proof-ui",
        layoutPath: "",
        liveTree: [node(version)]
    }];
}

context.OpenlockDelivery.offerAddons(payload(1, 1, windowFor(1, 1)));
drain();
assert.strictEqual(host.windows.length, 1);
assert.strictEqual(host.windows[0].liveTree[0].children[0].text, "v1 · delivered package");
assert.strictEqual(host.lastApplied.added, 1);
const tree = body.children[0] || { children: [] };
const title = tree.children.find((p) => p.id === "ProofTitle");
const image = tree.children.find((p) => p.id === "ProofImage");
const progress = tree.children.find((p) => p.id === "ProofProgress");
const hidden = tree.children.find((p) => p.id === "ProofHidden");
const button = tree.children.find((p) => p.id === "ProofButton");
assert(title && title.text === "v1 · delivered package", "v1 title rendered");
assert.deepStrictEqual(tree.children.map((p) => p.id), ["ProofTitle", "ProofImage", "ProofProgress", "ProofHidden", "ProofButton"], "children keep source order");
assert(tree.hittest === true, "a package Panel owns the pointer surface");
assert(title && title.hittest === false, "a package Label is pointer-transparent");
assert(image && image.hittest === false, "a package Image is pointer-transparent");
assert(button && button.hittest === true, "a package Button owns the pointer surface");
assert(image && image.src.endsWith("star_png.vtex"), "v1 image src applied");
assert(progress && progress.value === 25, "v1 progress value applied as a percentage");
assert(hidden && hidden.style.visibility === "collapse", "hidden attr collapses label");
assert(button && button.enabled === true && button.selected === true, "v1 button enabled/selected");

context.OpenlockDelivery.offerAddons(payload(2, 2, windowFor(2, 2)));
drain();
assert.strictEqual(host.windows.length, 1);
assert.strictEqual(host.windows[0].liveTree[0].children[0].text, "v2 · replaced in place");
assert.strictEqual(host.lastApplied.updated, 1);
const tree2 = body.children[0] || { children: [] };
const title2 = tree2.children.find((p) => p.id === "ProofTitle");
const image2 = tree2.children.find((p) => p.id === "ProofImage");
const progress2 = tree2.children.find((p) => p.id === "ProofProgress");
const button2 = tree2.children.find((p) => p.id === "ProofButton");
assert(title2 && title2.text === "v2 · replaced in place", "v2 title replaced");
assert(image2 && image2.src.endsWith("warning_alt_png.vtex"), "v2 image src applied");
assert(progress2 && progress2.value === 75, "v2 progress value applied as a percentage");
const fill2 = progress2.children && progress2.children[0];
assert(fill2 && fill2.classes.indexOf("ProgressFill") >= 0, "v2 determinate fill created");
assert(fill2.style.width === "75%", "v2 determinate fill is 75% of the bar");
assert(button2 && button2.enabled === false, "v2 disabled button honored");

const before = host.windows.length;
let rejected = false;
const oldRefuse = host.refuse;
host.refuse = () => { rejected = true; };
context.OpenlockDelivery.offerAddons(payload(3, 3, [
    { id: "addon:proof-ui:proof-panel", title: "bad", view: "addon-layout", liveTree: [{ tag: "Panel", children: [] }] },
    { id: "addon:other:missing", title: "bad", view: "addon-layout", liveTree: [] }
]));
drain();
assert(rejected, "invalid window set refused");
assert.strictEqual(host.windows.length, before, "invalid set leaves the window set unchanged");
host.refuse = oldRefuse;

// A refused replace must leave the catalog, the index and the per-window signatures exactly as
// they were. The hostile catalog write fails after the first record was swapped, so this exercises
// the rollback path that a purely malformed payload never reaches.
const catalog = host.index;
let threw = false;
host.index = new Proxy(catalog, {
    set(target, key, value) {
        if (key === "addon:proof-ui:proof-extra" && !threw) {
            threw = true;
            throw new Error("catalog write failed");
        }
        target[key] = value;
        return true;
    }
});
let rollback = "";
const previousRefuse = host.refuse;
host.refuse = (title, why) => { rollback = `${title}: ${why}`; };
context.OpenlockDelivery.offerAddons(payload(4, 3, [
    { id: "addon:proof-ui:proof-panel", title: "v3", view: "addon-layout", addon: "proof-ui", addonName: "proof-ui", liveTree: [node(3)] },
    { id: "addon:proof-ui:proof-extra", title: "extra", view: "addon-layout", addon: "proof-ui", addonName: "proof-ui", liveTree: [] }
]));
drain();
host.refuse = previousRefuse;
host.index = catalog;
assert(threw, "the hostile catalog write was reached");
assert(rollback.includes("rolled back"), "a failed replace rolls back");
assert.strictEqual(host.windows.length, 1, "rollback leaves exactly the previous window");
assert.strictEqual(host.windows[0].liveTree[0].children[0].text, "v2 · replaced in place", "rollback restores the previous record");
assert(!host.index["addon:proof-ui:proof-extra"], "rollback removes the half-added window");
assert.strictEqual(host.index["addon:proof-ui:proof-panel"], host.windows[0], "index and catalog agree after rollback");
context.OpenlockDelivery.offerAddons(payload(5, 2, windowFor(5, 2)));
drain();
assert.strictEqual(host.lastApplied.updated, 0, "signatures were restored with the catalog");
assert.strictEqual(host.lastApplied.added, 0, "the restored window is not re-added");
assert.strictEqual(host.windows[0].liveTree[0].children[0].text, "v2 · replaced in place", "the restored record keeps its content");

context.OpenlockDelivery.offerObserver(JSON.stringify({
    title: "Observer proof",
    body: "live XML",
    tree: [{ tag: "Panel", id: "ObsRoot", children: [
        { tag: "Image", id: "ObsImage", attrs: { src: "s2r://panorama/images/control_icons/star_png.vtex" }, children: [] },
        { tag: "ProgressBar", id: "ObsProgress", attrs: { value: "0.6" }, children: [] }
    ] }]
}));
drain();
assert(host.lastObserver && host.lastObserver.tree.length === 1, "observer tree delivered");

// An oversized observer payload is refused before JSON.parse, not inside the poll frame.
let bigRefused = "";
const prevRefuse = host.refuse;
host.refuse = (title, why) => { bigRefused = `${title}: ${why}`; };
context.OpenlockDelivery.offerObserver("x".repeat(4 * 1024 * 1024 + 1));
drain();
host.refuse = prevRefuse;
assert(bigRefused.includes("larger than 4 MiB"), "oversized observer payload refused before parse");

// A Slider also carries a `value`, and the determinate fill must not be appended to it.
context.OpenlockDelivery.renderTree(body, [{ tag: "Slider", id: "ProofSlider", attrs: { value: "0.5" }, children: [] }], "slider");
drain();
const slider = body.children.find((p) => p.id === "ProofSlider");
assert(slider && slider.children.length === 0, "non-ProgressBar value nodes get no fill child");
assert(slider.value === 50, "slider value is still scaled");
assert(logs.some((line) => line.includes("progress=75")), "render log records v2 progress");
assert(logs.some((line) => line.includes("hidden=1")), "render log records hidden attr");

// A package record with no windows is a valid payload shape (the server records such a package
// when a delivery carries rows but no window). It must apply, add nothing, and invent no window.
context.OpenlockDelivery.offerAddons(JSON.stringify({
    format: "openlock.addons/2",
    revision: 7,
    packages: [
        { name: "proof-ui", version: "2-0-0" },
        { name: "zero-ui", version: "1-0-0" }
    ],
    windows: windowFor(7, 2)
}));
drain();
assert.strictEqual(host.windows.length, 1, "a zero-window package adds no window");
assert.strictEqual(host.lastApplied.packages, 2, "the zero-window package is recorded in the payload");
assert.strictEqual(host.lastApplied.added, 0, "the zero-window package reports no added windows");
assert(logs.some((line) => line.includes("applied revision 7")), "the zero-window payload was applied");

// The refusal ceiling and the server's zero-window success signal are C# state, not JS. Run the
// server harness from here so one command covers both halves of the delivery path.
const { spawnSync } = require("child_process");
const server = spawnSync("dotnet", [
    "run", "--project", ".scratch/deliverytest/deliverytest.csproj", "-c", "Release"
], { encoding: "utf8" });
if (server.status !== 0) {
    console.error(server.stdout || "");
    console.error(server.stderr || "");
    throw new Error("server delivery harness failed");
}
const lastServerLine = String(server.stdout).trim().split("\n").pop();
assert.strictEqual(lastServerLine, "server delivery harness: PASS", "server delivery harness reports PASS");
console.log("delivery harness: PASS");
console.log(logs.filter((line) => line.startsWith("info: render")).join("\n"));

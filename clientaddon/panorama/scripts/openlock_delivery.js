// Live package delivery: versioned addon payloads, atomic window-set replacement, observer
// payloads, and a chunked XML node renderer.
//
// The shell's poll only hands this module the host attribute string. Parsing, validation, window
// reconciliation and node creation happen on scheduled ticks with a small time budget, so a large
// package or a long observer XML cannot hold the poll frame. The module owns delivery state; the
// shell owns the panel chrome and supplies the hooks in configure().
(function () {
    var FORMAT = "openlock.addons/2";
    var MAX_PAYLOAD = 4 * 1024 * 1024;
    var MAX_NODES = 512;
    var MAX_DEPTH = 24;
    var TAGS = ["Panel", "Label", "Button", "Image", "TextEntry", "ProgressBar", "Slider", "DropDown"];
    var STYLE_NAMES = {
        "background-color": "backgroundColor",
        "border-color": "borderColor",
        "border-top-color": "borderTopColor",
        "border-bottom-color": "borderBottomColor",
        "border-left-color": "borderLeftColor",
        "border-right-color": "borderRightColor",
        "wash-color": "washColor"
    };

    var host = null;
    var lastAddonsSig = "";
    var lastObserverSig = "";
    var pendingAddons = null;
    var pendingObserver = null;
    var pumpScheduled = false;
    var lastRevision = -1;
    var appliedVersions = {};
    var signatures = {};
    var rebuildQueue = [];
    var closeQueue = [];
    var rebuildScheduled = false;
    var renderJobs = [];
    var renderByKey = {};
    var renderScheduled = false;
    var renderToken = 0;
    var stats = { payloads: 0, applied: 0, rejected: 0, added: 0, updated: 0, removed: 0, nodes: 0 };

    function log(text) {
        if (host && host.log) {
            try { host.log("info", text); } catch (e) {}
        }
        // One line per delivery event (apply, refusal, rendered tree), not per node: an operator
        // can verify a live package landed from the client log without opening the shell.
        try { $.Msg("[Openlock] delivery: ", text); } catch (e) {}
    }

    function reject(title, why) {
        stats.rejected++;
        if (host && host.refuse) {
            try { host.refuse(title, why); return; } catch (e) {}
        }
        try { $.Msg("[Openlock] delivery REFUSED: ", title, " — ", why); } catch (e) {}
    }

    function isAddonId(id) {
        return String(id || "").indexOf("addon:") === 0;
    }

    function alive(panel) {
        if (!panel) return false;
        try { panel.GetChildCount(); return true; } catch (e) { return false; }
    }

    function boolValue(value) {
        if (value === false || value === 0) return false;
        var text = String(value).toLowerCase();
        return text !== "false" && text !== "0" && text !== "no";
    }

    function versionTokens(version) {
        var parts = String(version || "").split(/[^0-9A-Za-z]+/);
        var out = [];
        for (var i = 0; i < parts.length; i++) if (parts[i]) out.push(parts[i]);
        return out;
    }

    function compareVersions(left, right) {
        var a = versionTokens(left);
        var b = versionTokens(right);
        var count = Math.max(a.length, b.length);
        for (var i = 0; i < count; i++) {
            var one = i < a.length ? a[i] : "0";
            var two = i < b.length ? b[i] : "0";
            var oneNumber = /^\d+$/.test(one) ? Number(one) : null;
            var twoNumber = /^\d+$/.test(two) ? Number(two) : null;
            if (oneNumber !== null && twoNumber !== null) {
                if (oneNumber !== twoNumber) return oneNumber < twoNumber ? -1 : 1;
                continue;
            }
            if (one.toLowerCase() !== two.toLowerCase()) return one.toLowerCase() < two.toLowerCase() ? -1 : 1;
        }
        return 0;
    }

    function validateNodes(nodes, label) {
        if (nodes === undefined || nodes === null) return "";
        if (!(nodes instanceof Array)) return label + " is not a node list";
        var count = 0;
        var stack = [];
        for (var i = nodes.length - 1; i >= 0; i--) stack.push({ node: nodes[i], depth: 0 });
        while (stack.length) {
            var item = stack.pop();
            var node = item.node;
            count++;
            if (count > MAX_NODES) return label + " declares more than " + MAX_NODES + " nodes";
            if (item.depth > MAX_DEPTH) return label + " is deeper than " + MAX_DEPTH;
            if (!node || typeof node !== "object") return label + " contains a non-node entry";
            if (node.attrs !== undefined && node.attrs !== null && typeof node.attrs !== "object") return label + " attrs are not an object";
            if (node.styles !== undefined && node.styles !== null && typeof node.styles !== "object") return label + " styles are not an object";
            if (node.children !== undefined && node.children !== null && !(node.children instanceof Array)) return label + " children are not a list";
            var children = node.children || [];
            for (var c = children.length - 1; c >= 0; c--) stack.push({ node: children[c], depth: item.depth + 1 });
        }
        return "";
    }

    function readPayload(raw) {
        if (!raw) return null;
        if (raw.length > MAX_PAYLOAD) {
            reject("Package payload refused", "payload is larger than 4 MiB");
            return null;
        }

        var payload;
        try { payload = JSON.parse(raw); } catch (e) {
            reject("Package payload refused", "not JSON: " + String(e));
            return null;
        }

        if (!payload || payload.format !== FORMAT) {
            reject("Package payload refused", "payload format is not " + FORMAT);
            return null;
        }

        var revision = Number(payload.revision);
        if (!isFinite(revision)) revision = -1;
        if (revision >= 0 && lastRevision >= 0) {
            if (revision < lastRevision) {
                log("stale payload revision " + revision + " < " + lastRevision);
                return { stale: true };
            }
            if (revision === lastRevision) {
                reject("Package payload refused", "revision " + revision + " is already mounted with different content");
                return null;
            }
        }

        var packages = payload.packages || [];
        if (!(packages instanceof Array)) {
            reject("Package payload refused", "packages is not a list");
            return null;
        }

        var versions = {};
        for (var p = 0; p < packages.length; p++) {
            var record = packages[p];
            if (!record || !record.name) {
                reject("Package payload refused", "a package record has no name");
                return null;
            }
            versions[String(record.name)] = String(record.version || "");
        }

        for (var name in versions) {
            if (!versions.hasOwnProperty(name)) continue;
            if (appliedVersions[name] !== undefined && compareVersions(versions[name], appliedVersions[name]) < 0) {
                reject("Package payload refused",
                    "package '" + name + "' " + versions[name] + " is older than mounted " + appliedVersions[name]);
                return null;
            }
        }

        var windows = payload.windows || [];
        if (!(windows instanceof Array)) {
            reject("Package payload refused", "windows is not a list");
            return null;
        }

        var byId = {};
        for (var w = 0; w < windows.length; w++) {
            var win = windows[w];
            if (!win || !win.id || !isAddonId(win.id)) {
                reject("Package window refused", "a live window needs an addon: package id");
                return null;
            }
            if (byId[win.id]) {
                reject("Package window refused", "window id is declared twice: " + win.id);
                return null;
            }
            var at = String(win.id).indexOf(":", 6);
            var packageName = at > 6 ? String(win.id).substring(6, at) : "";
            if (!packageName || versions[packageName] === undefined) {
                reject("Package window refused", win.id + " does not name a delivered package");
                return null;
            }
            var treeError = validateNodes(win.liveTree, win.id + " liveTree");
            if (treeError) {
                reject("Package window refused", treeError);
                return null;
            }
            byId[win.id] = win;
        }

        return {
            payload: payload,
            packages: packages,
            windows: windows,
            byId: byId,
            versions: versions,
            revision: revision
        };
    }

    function windowSignature(win) {
        try { return JSON.stringify(win); } catch (e) { return String(win && win.id); }
    }

    function queueRebuild(win) {
        for (var i = 0; i < rebuildQueue.length; i++) {
            if (rebuildQueue[i].id === win.id) { rebuildQueue[i].win = win; return; }
        }
        rebuildQueue.push({ id: win.id, win: win });
    }

    function queueClose(id) {
        if (closeQueue.indexOf(id) < 0) closeQueue.push(id);
    }

    function applyWindowSet(parsed) {
        var windows = host.windows;
        var index = host.index;
        if (!windows || !index) {
            reject("Package payload refused", "the shell did not expose its window catalog");
            return false;
        }

        // Records are replaced, never copied onto in place, so this snapshot holds exactly the
        // objects that were mounted. A rollback can then restore the catalog and its signatures
        // without the snapshot having been mutated underneath it.
        var before = windows.slice();
        var beforeIndex = {};
        for (var key in index) {
            if (index.hasOwnProperty(key)) beforeIndex[key] = index[key];
        }
        var beforeSignatures = {};
        for (var signed in signatures) {
            if (signatures.hasOwnProperty(signed)) beforeSignatures[signed] = signatures[signed];
        }
        var beforeRevision = lastRevision;
        var beforeVersions = appliedVersions;

        var added = 0;
        var updated = 0;
        var removed = [];
        var changed = [];

        try {
            for (var i = windows.length - 1; i >= 0; i--) {
                var current = windows[i];
                if (!isAddonId(current.id) || parsed.byId[current.id]) continue;
                windows.splice(i, 1);
                delete index[current.id];
                delete signatures[current.id];
                removed.push(current.id);
            }

            for (var id in parsed.byId) {
                if (!parsed.byId.hasOwnProperty(id)) continue;
                var incoming = parsed.byId[id];
                var existing = index[id];
                if (existing) {
                    var signature = windowSignature(incoming);
                    if (signatures[id] !== signature) {
                        var at = windows.indexOf(existing);
                        if (at >= 0) windows[at] = incoming;
                        else windows.push(incoming);
                        index[id] = incoming;
                        signatures[id] = signature;
                        updated++;
                        changed.push(incoming);
                    }
                } else {
                    windows.push(incoming);
                    index[id] = incoming;
                    signatures[id] = windowSignature(incoming);
                    added++;
                    changed.push(incoming);
                }
            }

            lastRevision = parsed.revision >= 0 ? parsed.revision : lastRevision;
            appliedVersions = parsed.versions;
        } catch (e) {
            windows.length = 0;
            for (var b = 0; b < before.length; b++) windows.push(before[b]);
            for (var old in index) {
                if (index.hasOwnProperty(old)) delete index[old];
            }
            for (var previous in beforeIndex) {
                if (beforeIndex.hasOwnProperty(previous)) index[previous] = beforeIndex[previous];
            }
            signatures = beforeSignatures;
            lastRevision = beforeRevision;
            appliedVersions = beforeVersions;
            reject("Package payload rolled back", String(e));
            return false;
        }

        var changedId = changed.length ? changed[changed.length - 1].id : "";
        log("applied revision " + lastRevision + " packages=" + parsed.packages.length +
            " +" + added + " ~" + updated + " -" + removed.length +
            (changedId ? " window=" + changedId : ""));

        stats.applied++;
        stats.added += added;
        stats.updated += updated;
        stats.removed += removed.length;

        for (var c = 0; c < changed.length; c++) queueRebuild(changed[c]);
        for (var r = 0; r < removed.length; r++) queueClose(removed[r]);

        if (host.applied) {
            try {
                host.applied({
                    packages: parsed.packages.length,
                    added: added,
                    updated: updated,
                    removed: removed.length,
                    revision: lastRevision,
                    windowId: changed.length ? changed[changed.length - 1].id : ""
                });
            } catch (e) {
                reject("Package payload applied with a toast error", String(e));
            }
        }

        kickRebuilds();
        return true;
    }

    function applyAddons(raw) {
        stats.payloads++;
        var parsed = readPayload(raw);
        if (!parsed || parsed.stale) return;
        applyWindowSet(parsed);
    }

    function applyObserver(raw) {
        // The observer attribute is host-supplied and can carry a whole window tree. Bound it
        // before parsing: a multi-megabyte JSON.parse runs synchronously in this scheduled tick
        // and would hold the frame, exactly like an unbounded package payload.
        if (typeof raw !== "string" || raw.length > MAX_PAYLOAD) {
            reject("Observer payload refused", "payload is larger than 4 MiB or is not text");
            return;
        }

        var payload;
        try { payload = JSON.parse(raw); } catch (e) {
            reject("Observer payload refused", String(e));
            return;
        }
        if (!payload || (!payload.title && !payload.body && !payload.layout && !(payload.tree && payload.tree.length))) {
            reject("Observer payload refused", "notice is empty");
            return;
        }
        var treeError = validateNodes(payload.tree, "observer tree");
        if (treeError) {
            reject("Observer payload refused", treeError);
            return;
        }
        if (host && host.observer) {
            try { host.observer(payload); } catch (e) {
                reject("Observer payload refused", String(e));
            }
        }
    }

    function pump() {
        pumpScheduled = false;
        try {
            if (pendingAddons) {
                var addons = pendingAddons;
                pendingAddons = null;
                applyAddons(addons);
            }
            if (pendingObserver) {
                var observer = pendingObserver;
                pendingObserver = null;
                applyObserver(observer);
            }
        } catch (e) {
            reject("Delivery pump failed", String(e));
        }

        if (pendingAddons || pendingObserver) kickPump();
        else kickRebuilds();
    }

    function kickPump() {
        if (pumpScheduled) return;
        pumpScheduled = true;
        try { $.Schedule(0, pump); } catch (e) { pumpScheduled = false; }
    }

    function kickRebuilds() {
        if (rebuildScheduled || (!rebuildQueue.length && !closeQueue.length)) return;
        rebuildScheduled = true;
        try { $.Schedule(0, rebuildPump); } catch (e) { rebuildScheduled = false; }
    }

    function rebuildPump() {
        rebuildScheduled = false;
        var started = Date.now();
        try {
            while (closeQueue.length && Date.now() - started < 4) {
                var closeId = closeQueue.shift();
                if (host && host.closeWindow) host.closeWindow(closeId);
            }
            if (rebuildQueue.length && Date.now() - started < 7) {
                var job = rebuildQueue.shift();
                if (host && host.rebuild) host.rebuild(job.win);
            }
        } catch (e) {
            reject("Package window rebuild refused", String(e));
        }

        if (closeQueue.length || rebuildQueue.length) kickRebuilds();
    }

    function styleProperty(name) {
        return STYLE_NAMES[name] || name;
    }

    function setImage(panel, src) {
        if (!panel || !src) return false;
        try {
            if (typeof panel.SetImage === "function") {
                panel.SetImage(String(src));
                return true;
            }
        } catch (e) {}
        try { panel.src = String(src); return true; } catch (e) {}
        return false;
    }

    function applyNode(panel, node, job) {
        // The package XML contract: labels and images are decoration and must not swallow a
        // control underneath them; panels and real controls own the pointer surface. Set this
        // before children are created so the hit-test tree is correct from the first frame.
        var tag = String(node.tag || "Panel");
        try {
            if (tag === "Label" || tag === "Image") {
                panel.hittest = false;
                panel.hittestchildren = false;
            } else {
                panel.hittest = true;
                panel.hittestchildren = true;
            }
        } catch (e) {}

        if (node.class) {
            var classes = String(node.class).split(" ");
            for (var c = 0; c < classes.length; c++) {
                if (!classes[c]) continue;
                try { panel.AddClass(classes[c]); } catch (e) {}
            }
        }

        if (node.text !== undefined && node.text !== null && panel.text !== undefined) {
            panel.text = String(node.text);
        }

        var styles = node.styles || {};
        for (var key in styles) {
            if (!styles.hasOwnProperty(key)) continue;
            var value = String(styles[key] || "");
            if (!value || value.indexOf("url(") >= 0) continue;
            try { panel.style[styleProperty(key)] = value; } catch (e) {}
        }

        var attrs = node.attrs || {};
        if (attrs.placeholder !== undefined && panel.placeholder !== undefined) panel.placeholder = String(attrs.placeholder);
        if (attrs.multiline !== undefined && panel.multiline !== undefined) panel.multiline = boolValue(attrs.multiline);
        if (attrs.maxchars !== undefined && panel.maxchars !== undefined) panel.maxchars = parseInt(attrs.maxchars, 10) || 0;
        if (attrs.html !== undefined && panel.html !== undefined) panel.html = boolValue(attrs.html);

        if (attrs.src !== undefined && attrs.src !== "") {
            if (setImage(panel, attrs.src)) job.images++;
        }

        if (attrs.value !== undefined && attrs.value !== "") {
            var number = Number(attrs.value);
            if (isFinite(number)) {
                // Panorama's ProgressBar value is a percentage. Packages declare the natural
                // 0..1 progress, so a value in that range is scaled once here instead of drawing
                // a 0.75%-full bar that looks empty.
                var shown = number >= 0 && number <= 1 ? number * 100 : number;
                try { panel.value = shown; } catch (e) {}
                try { if (typeof panel.SetValue === "function") panel.SetValue(shown); } catch (e2) {}
                job.progress = shown;

                // The engine's own ProgressBar fill follows the game's compiled style, which a
                // live package cannot see. Drawing the determinate fill here makes the value
                // visible whatever that style is; the engine value is still set above. Only a
                // ProgressBar gets a child: Slider and TextEntry also carry a `value`, and a
                // panel of another control type must not gain a child it never declared.
                if (String(node.tag || "") === "ProgressBar") {
                    try {
                        var fill = $.CreatePanel("Panel", panel, "");
                        fill.AddClass("ProgressFill");
                        fill.style.height = "100%";
                        fill.style.width = Math.max(0, Math.min(100, shown)) + "%";
                        fill.hittest = false;
                    } catch (e3) {}
                }
            }
        }

        if (attrs.enabled !== undefined) {
            var enabled = boolValue(attrs.enabled);
            try { panel.enabled = enabled; } catch (e) {}
            if (!enabled) job.disabled++;
        }

        if (attrs.visible !== undefined) {
            var visible = boolValue(attrs.visible);
            try { panel.visible = visible; } catch (e) {}
            try { panel.style.visibility = visible ? "visible" : "collapse"; } catch (e2) {}
            if (!visible) job.hidden++;
        }

        if (attrs.selected !== undefined) {
            var selected = boolValue(attrs.selected);
            try { panel.selected = selected; } catch (e) {}
            try { if (typeof panel.SetSelected === "function") panel.SetSelected(selected); } catch (e2) {}
            if (selected) job.selected++;
        }

        if (attrs.tooltip_text && host && host.bindDwell) {
            try { host.bindDwell(panel, String(node.text || node.id || "addon"), String(attrs.tooltip_text)); } catch (e) {}
        }
    }

    function finishJob(job) {
        stats.nodes += job.count;
        log("render " + job.key + " nodes=" + job.count + " images=" + job.images +
            " progress=" + (job.progress === null ? "-" : job.progress) +
            " hidden=" + job.hidden + " disabled=" + job.disabled + " selected=" + job.selected);
        delete renderByKey[job.key];
    }

    function renderPump() {
        renderScheduled = false;
        var started = Date.now();
        var made = 0;

        while (renderJobs.length && made < 64 && Date.now() - started < 5) {
            var job = renderJobs[0];
            if (job.cancelled || !alive(job.parent)) {
                renderJobs.shift();
                if (renderByKey[job.key] === job) delete renderByKey[job.key];
                continue;
            }

            if (!job.queue.length) {
                renderJobs.shift();
                finishJob(job);
                continue;
            }

            var item = job.queue.pop();
            var node = item.node;
            var tag = String(node.tag || "Panel");
            if (TAGS.indexOf(tag) < 0) tag = "Panel";

            var panel = null;
            try { panel = $.CreatePanel(tag, item.parent, String(node.id || "")); } catch (e) { panel = null; }
            if (panel) {
                applyNode(panel, node, job);
                job.count++;
                made++;
                var children = node.children || [];
                for (var c = children.length - 1; c >= 0; c--) {
                    job.queue.push({ node: children[c], parent: panel, depth: item.depth + 1 });
                }
                // The queue is a stack: children were pushed last-first, so the next pop is the
                // first child. Panorama appends CreatePanel children in creation order, which is
                // the source order the package declared.
            }
        }

        if (renderJobs.length) kickRender();
    }

    function kickRender() {
        if (renderScheduled) return;
        renderScheduled = true;
        try { $.Schedule(0, renderPump); } catch (e) { renderScheduled = false; }
    }

    function cancelTree(key) {
        var job = renderByKey[key];
        if (!job) return false;
        job.cancelled = true;
        delete renderByKey[key];
        for (var i = renderJobs.length - 1; i >= 0; i--) {
            if (renderJobs[i] === job) renderJobs.splice(i, 1);
        }
        return true;
    }

    function renderTree(parent, nodes, key) {
        if (!parent || !nodes || !nodes.length) return false;
        key = String(key || ("tree:" + (++renderToken)));
        cancelTree(key);
        parent.RemoveAndDeleteChildren();

        var job = {
            key: key,
            parent: parent,
            queue: [],
            depth: 0,
            count: 0,
            images: 0,
            progress: null,
            disabled: 0,
            hidden: 0,
            selected: 0,
            cancelled: false
        };
        for (var i = nodes.length - 1; i >= 0; i--) job.queue.push({ node: nodes[i], parent: parent, depth: 0 });
        renderByKey[key] = job;
        renderJobs.push(job);
        kickRender();
        return true;
    }

    function offerAddons(raw) {
        if (!host || !raw || raw === lastAddonsSig) return false;
        lastAddonsSig = raw;
        pendingAddons = raw;
        kickPump();
        return true;
    }

    function offerObserver(raw) {
        if (!host || !raw || raw === lastObserverSig) return false;
        lastObserverSig = raw;
        pendingObserver = raw;
        kickPump();
        return true;
    }

    function configure(next) {
        host = next || null;
        lastAddonsSig = "";
        lastObserverSig = "";
        pendingAddons = null;
        pendingObserver = null;
        lastRevision = -1;
        appliedVersions = {};
        signatures = {};
        rebuildQueue = [];
        closeQueue = [];
        renderJobs = [];
        renderByKey = {};
        stats = { payloads: 0, applied: 0, rejected: 0, added: 0, updated: 0, removed: 0, nodes: 0 };
    }

    globalThis.OpenlockDelivery = {
        configure: configure,
        offerAddons: offerAddons,
        offerObserver: offerObserver,
        renderTree: renderTree,
        cancelTree: cancelTree,
        stats: function () { return stats; }
    };
})();

// Browser-side Panorama adapter for the real Openlock shell.
//
// This is not a second shell. `docs/shell-sandbox.html` embeds this file, the real
// `openlock_shell.xml`, `openlock_shell_data.js`, `openlock_shell.js` and the shell stylesheet.
// The adapter supplies only the engine surface the script already calls: CreatePanel, Schedule,
// panel traversal, events, style writes and the cursor. Windows, titles, controls and grips are
// created by `openlock_shell.js`, so a regression in the shell is what the sandbox draws.
(function () {
    "use strict";

    var errors = [];
    var messages = [];
    var events = [];
    var cursor = { x: 20, y: 20 };
    var mouseDown = false;
    var panelSeq = 0;

    function recordError(where, error) {
        var text = where + ": " + (error && error.stack ? error.stack : String(error));
        errors.push(text);
        try { console.error("[sandbox] " + text); } catch (e) {}
    }

    window.addEventListener("error", function (event) {
        recordError("window", event.error || event.message);
    });
    window.addEventListener("unhandledrejection", function (event) {
        recordError("promise", event.reason);
    });
    window.addEventListener("mousemove", function (event) {
        cursor = { x: event.clientX, y: event.clientY };
    });
    window.addEventListener("mousedown", function () { mouseDown = true; });
    window.addEventListener("mouseup", function () { mouseDown = false; });

    function cssValue(name, value) {
        if (value === undefined || value === null) return null;
        if (name === "visibility" && value === "collapse") return "hidden";
        if (name === "visibility" && value === "visible") return "visible";
        if (name === "overflow" && /clip/.test(String(value))) return "hidden";
        if (name === "overflow" && /scroll/.test(String(value))) return "auto";
        if (name === "horizontalAlign") {
            return null;
        }
        if (name === "verticalAlign") {
            if (value === "center") return "center";
            if (value === "bottom") return "flex-end";
            if (value === "top") return "flex-start";
            return null;
        }
        return value;
    }

    function applyStyle(element, name, value) {
        var mapped = cssValue(name, value);
        if (mapped === null) return;
        if (name === "verticalAlign") {
            element.style.alignSelf = mapped;
            return;
        }
        try {
            element.style[name] = mapped;
        } catch (error) {
            try { element.style.setProperty(name, String(mapped)); } catch (e) {}
        }
    }

    class DomPanel {
        constructor(type, parent, id, existing) {
            this.type = type || "Panel";
            this.id = id || "";
            this.parent = parent || null;
            this.children = [];
            this.classes = new Set();
            this.events = {};
            this._text = "";
            this._hittest = true;
            this.el = existing || document.createElement(this.type === "Label" ? "span" : "div");
            this.el.classList.add("Panel");
            if (this.id) this.el.id = this.id;
            if (!existing) this.el.setAttribute("data-panel-seq", String(++panelSeq));
            if (parent && !existing) {
                parent.el.appendChild(this.el);
                parent.children.push(this);
            }
            var self = this;
            this.style = new Proxy({}, {
                get: function (target, key) {
                    if (key === "visibility") return self.el.style.visibility;
                    return target[key];
                },
                set: function (target, key, value) {
                    target[key] = value;
                    applyStyle(self.el, key, value);
                    return true;
                }
            });
        }

        AddClass(name) {
            if (!name) return;
            String(name).split(/\s+/).filter(Boolean).forEach((cls) => {
                this.classes.add(cls);
                this.el.classList.add(cls);
            });
        }
        RemoveClass(name) {
            this.classes.delete(name);
            this.el.classList.remove(name);
        }
        HasClass(name) { return this.classes.has(name); }
        SetHasClass(name, on) {
            if (on) this.AddClass(name);
            else this.RemoveClass(name);
        }
        SetPanelEvent(name, fn) {
            this.events[name] = fn;
            var eventName = name === "onmouseactivate" ? "click" : name.replace(/^on/, "").toLowerCase();
            if (typeof fn === "function" && eventName) {
                try { this.el.addEventListener(eventName, fn); } catch (e) {}
            }
        }
        DeleteAsync() {
            if (this.parent) {
                var index = this.parent.children.indexOf(this);
                if (index >= 0) this.parent.children.splice(index, 1);
                this.parent = null;
            }
            if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
        }
        RemoveAndDeleteChildren() {
            this.children.forEach((child) => { child.parent = null; });
            this.children = [];
            while (this.el.firstChild) this.el.removeChild(this.el.firstChild);
        }
        FindChildTraverse(id) {
            for (var i = 0; i < this.children.length; i++) {
                var child = this.children[i];
                if (child.id === id) return child;
                var found = child.FindChildTraverse(id);
                if (found) return found;
            }
            return null;
        }
        FindChildrenWithClassTraverse(cls) {
            var out = [];
            var walk = (panel) => {
                panel.children.forEach((child) => {
                    if (child.classes.has(cls)) out.push(child);
                    walk(child);
                });
            };
            walk(this);
            return out;
        }
        GetChildCount() { return this.children.length; }
        GetChild(index) { return this.children[index] || null; }
        GetParent() { return this.parent; }
        IsVisible() { return this.el.style.visibility !== "hidden" && this.el.style.display !== "none"; }
        BLoadLayout() { return true; }
        SetImage(src) { this.src = src; }
        GetAttributeString() { return ""; }
        GetAttributeInt() { return 0; }
        GetPositionWithinWindow() {
            var rect = this.el.getBoundingClientRect();
            var rootEl = document.getElementById("ShellRoot");
            var rootRect = rootEl ? rootEl.getBoundingClientRect() : { x: 0, y: 0 };
            return { x: rect.x - rootRect.x, y: rect.y - rootRect.y };
        }
        SetFocus() {}
        get text() { return this._text; }
        set text(value) {
            this._text = value === undefined || value === null ? "" : String(value);
            this.el.textContent = this._text;
        }
        get hittest() { return this._hittest; }
        set hittest(value) {
            this._hittest = value !== false;
            this.el.style.pointerEvents = this._hittest ? "auto" : "none";
        }
        get hittestchildren() { return this._hittestchildren !== false; }
        set hittestchildren(value) { this._hittestchildren = value !== false; }
        get actuallayoutwidth() { return this.el.getBoundingClientRect().width; }
        get actuallayoutheight() { return this.el.getBoundingClientRect().height; }
    }

    function panelFromNode(node, parent) {
        var tag = node.tagName;
        if (tag !== "Panel" && tag !== "Label") return null;
        var panel = new DomPanel(tag, parent, node.getAttribute("id") || "");
        panel.AddClass(node.getAttribute("class") || "");
        ["hittest", "hittestchildren"].forEach((name) => {
            var value = node.getAttribute(name);
            if (value !== null) panel[name] = value !== "false";
        });
        if (tag === "Label") panel.text = node.getAttribute("text") || node.textContent || "";
        Array.prototype.slice.call(node.children || []).forEach((child) => panelFromNode(child, panel));
        return panel;
    }

    var rootEl = document.getElementById("ShellRoot");
    var root = new DomPanel("Panel", null, "ShellRoot", rootEl);
    root.AddClass("ShellRoot");
    // In the client the shell is mounted under the HUD root, not at the top of the tree. The
    // shell's HUD scan climbs from this root; without a parent it would scan its own frames and
    // frame them as game panels. The sandbox supplies an empty HUD, which is the real mount shape.
    var hudEl = document.getElementById("Hud");
    if (hudEl) {
        var hud = new DomPanel("Panel", null, "Hud", hudEl);
        hud.AddClass("Hud");
        root.parent = hud;
        hud.children.push(root);
    }
    var xml = document.getElementById("shell-layout-xml");
    if (xml) {
        try {
            var doc = new DOMParser().parseFromString(xml.textContent, "application/xml");
            Array.prototype.slice.call(doc.documentElement.children).forEach((node) => {
                if (node.tagName === "Panel") panelFromNode(node, root);
            });
        } catch (error) {
            recordError("layout", error);
        }
    } else {
        recordError("layout", "shell layout XML is missing");
    }

    globalThis.$ = {
        GetContextPanel: () => root,
        CreatePanel: (type, parent, id) => new DomPanel(type, parent, id),
        Schedule: (delay, fn) => window.setTimeout(fn, Math.max(0, Number(delay) || 0) * 1000),
        Msg: function () {
            var text = Array.prototype.slice.call(arguments).join("");
            messages.push(text);
            try { console.log("[shell] " + text); } catch (e) {}
        },
        DispatchEvent: function () { events.push(Array.prototype.slice.call(arguments)); },
        MousePosition: () => cursor,
        GetCursorPosition: () => cursor,
        Localize: (value) => value
    };
    globalThis.GameUI = {
        GetCursorPosition: () => cursor,
        IsMouseDown: () => mouseDown
    };
    globalThis.Game = {};
    globalThis.OpenlockSandbox = {
        root: root,
        errors: errors,
        messages: messages,
        events: events,
        recordError: recordError,
        panels: () => Array.prototype.slice.call(document.querySelectorAll(".Panel")),
        frames: () => Array.prototype.slice.call(document.querySelectorAll(".WindowFrame"))
    };

    window.setTimeout(function () {
        try {
            if (globalThis.OpenlockDashboard) globalThis.OpenlockDashboard();
            else recordError("boot", "OpenlockDashboard is not exported");
        } catch (error) {
            recordError("boot", error);
        }
        // The dashboard is the shell's own window. The windows browser is deliberately not
        // opened here: it streams the shell's own frame list and is not the mount path this
        // sandbox is proving.

        // Prove the live-package path in the real shell, not only in the fake tree: offer an
        // openlock.addons/2 window with a small XML node tree, then open it through the same
        // console route a player uses. The tree exercises a Panel, a Label and a Button so the
        // browser can read the pointer-surface rule back out of the drawn DOM.
        window.setTimeout(function () {
            var proofTree = [{
                tag: "Panel", class: "SandboxProof", styles: {
                    width: "100%", height: "100%", padding: "12px", "flow-children": "down",
                    "background-color": "#10161df2"
                }, children: [
                    { tag: "Label", id: "SandboxProofLabel", class: "SandboxProofLabel",
                      text: "live XML package proof", attrs: {}, styles: {
                          color: "#e0b56a", "font-size": "15px", "margin-bottom": "10px"
                      }, children: [] },
                    { tag: "Button", id: "SandboxProofButton", class: "SandboxProofButton",
                      text: "package control", attrs: {}, styles: {
                          width: "140px", height: "28px"
                      }, children: [] }
                ]
            }];
            var proofWindow = {
                id: "addon:sandbox-proof:proof-panel",
                title: "Package proof",
                content: "readout",
                lane: "frame",
                extent: "square-pixels",
                x: 148, y: 132, width: 380, height: 230,
                minWidth: 220, minHeight: 120,
                opacity: 950,
                elevation: 1,
                "theme-role": "panel",
                pinnable: true,
                layout: "title-position,minimize,maximize,close",
                behavior: "drag,resize,minimize,maximize,close",
                "record-id": "proof-panel",
                view: "addon-layout",
                addon: "sandbox-proof",
                addonName: "sandbox-proof",
                layoutPath: "",
                liveTree: proofTree,
                controls: [
                    { kind: "pin", label: "Pin" },
                    { kind: "minimize", label: "Minimize" },
                    { kind: "maximize", label: "Maximize" },
                    { kind: "close", label: "Close" }
                ]
            };
            try {
                if (!globalThis.OpenlockDelivery) throw new Error("delivery module is missing");
                globalThis.OpenlockDelivery.offerAddons(JSON.stringify({
                    format: "openlock.addons/2",
                    revision: 1,
                    packages: [{ name: "sandbox-proof", version: "1-0-0" }],
                    windows: [proofWindow]
                }));
                window.setTimeout(function () {
                    if (globalThis.OpenlockConsole) {
                        globalThis.OpenlockConsole("addon:sandbox-proof:proof-panel");
                    } else {
                        recordError("package", "OpenlockConsole is not exported");
                    }
                }, 300);
            } catch (error) {
                recordError("package", error);
            }
        }, 2500);

    }, 220);
}());

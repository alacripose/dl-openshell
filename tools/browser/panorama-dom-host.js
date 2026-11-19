// A Panorama panel host for a real browser, so the shipped module can be driven in Chrome/Edge.
//
// Panorama has no DOM: `$.CreatePanel` builds engine panels and CSS uses Valve's properties
// (`flow-children`, `horizontal-align`, `ignore-parent-flow`, `visibility: collapse`). This host
// maps each shipped panel to a real DOM element and translates the shipped stylesheets, so layout,
// computed colour and transitions are the browser's own. It is a host adapter, not a re-render:
// the module, the pair table, the stylesheets and their values are the files the shell ships.
(function () {
    "use strict";

    var PANORAMA_ONLY = {
        "flow-children": function (value, out) {
            // Panorama aligns flow children to the top by default; CSS flex would stretch the
            // root to the tallest child, which the engine does not do.
            out.push("display:flex");
            out.push("align-items:flex-start");
            if (value === "down") out.push("flex-direction:column");
            else if (value === "right") out.push("flex-direction:row");
            else if (value === "right-wrap") { out.push("flex-direction:row"); out.push("flex-wrap:wrap"); }
            else if (value === "down-wrap") { out.push("flex-direction:column"); out.push("flex-wrap:wrap"); }
        },
        "horizontal-align": function (value, out) {
            if (value === "center") { out.push("margin-left:auto"); out.push("margin-right:auto"); }
            else if (value === "right") out.push("margin-left:auto");
        },
        "vertical-align": function (value, out) {
            out.push("align-self:" + (value === "center" ? "center" : value === "bottom" ? "flex-end" : "flex-start"));
        },
        "ignore-parent-flow": function (value, out) {
            if (value === "true") out.push("position:absolute");
        },
        "text-overflow": function (value, out) {
            out.push("text-overflow:" + value);
            out.push("overflow:hidden");
        }
    };

    // The module assigns `visibility = "collapse"` (Panorama's layout-collapsing value). The DOM
    // has no such value; `hidden` is the same observable state for this surface, and the pair
    // CSS/transition behaviour is unchanged.
    function translateDeclaration(property, value, out) {
        if (PANORAMA_ONLY[property]) {
            PANORAMA_ONLY[property](value, out);
            return;
        }
        out.push(property + ":" + value);
    }

    function translateCss(text) {
        return String(text)
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/([^{}]+)\{([^{}]*)\}/g, function (whole, selector, body) {
                var out = [];
                body.split(";").forEach(function (declaration) {
                    var at = declaration.indexOf(":");
                    if (at < 0) return;
                    var property = declaration.slice(0, at).trim();
                    var value = declaration.slice(at + 1).trim();
                    if (!property || !value) return;
                    translateDeclaration(property, value, out);
                });
                return selector + "{" + out.join(";") + "}";
            });
    }

    function styleProxy(element) {
        var native = element.style;
        return new Proxy(native, {
            get: function (target, key) {
                var value = target[key];
                return typeof value === "function" ? value.bind(target) : value;
            },
            set: function (target, key, value) {
                var next = value;
                if (typeof next === "string" && next.trim() === "collapse") next = "hidden";
                target[key] = next;
                return true;
            }
        });
    }

    function createPanel(type, parent, id) {
        var element = document.createElement(type === "Label" ? "span" : "div");
        element.className = "ppanel";
        if (type === "Label") element.classList.add("plabel");
        if (id) element.id = id;
        Object.defineProperty(element, "style", { value: styleProxy(element), configurable: true });

        element.AddClass = function (name) { element.classList.add(name); };
        element.RemoveClass = function (name) { element.classList.remove(name); };
        element.HasClass = function (name) { return element.classList.contains(name); };
        element.SetPanelEvent = function (name, fn) {
            element.__events = element.__events || {};
            element.__events[name] = fn;
            var dom = name === "onmouseactivate" ? "click"
                : name === "onmouseover" ? "mouseenter"
                    : name === "onmouseout" ? "mouseleave" : name;
            element.addEventListener(dom, function (event) { fn(event); });
        };
        element.GetChild = function (index) { return element.children[index] || null; };
        element.GetChildCount = function () { return element.children.length; };
        element.DeleteAsync = function () { element.remove(); };
        element.SetImage = function () {};
        Object.defineProperty(element, "text", {
            get: function () { return element.textContent; },
            set: function (value) { element.textContent = value == null ? "" : String(value); },
            configurable: true
        });
        Object.defineProperty(element, "hittest", {
            get: function () { return element.style.pointerEvents !== "none"; },
            set: function (value) { element.style.pointerEvents = value ? "auto" : "none"; },
            configurable: true
        });
        Object.defineProperty(element, "hittestchildren", {
            get: function () { return true; },
            set: function () {},
            configurable: true
        });

        if (parent) parent.appendChild(element);
        return element;
    }

    globalThis.OpenlockPanoramaCss = translateCss;
    globalThis.$ = {
        CreatePanel: createPanel,
        Schedule: function () { return 0; },
        Msg: function () { if (globalThis.console) console.log.apply(console, arguments); },
        Localize: function (value) { return value; }
    };
})();

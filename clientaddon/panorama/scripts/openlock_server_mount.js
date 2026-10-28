// Server-mounted shell bridge. base_hud mounts the standalone shell before a server can address
// this client. Moving that panel into the Deadworks host stops its polling, so this wrapper does
// not mount or move anything: it copies the server's dwv_* attributes onto the existing
// OpenlockStandaloneHost, where the shell's host() walk can read them.
(function () {
    function log(text) {
        try { $.Msg("[Openlock] server mount: ", text); } catch (e) {}
    }

    function report(text) {
        log(text);
        try { $.DispatchEvent("CitadelConCommand", "dw_ui openlock-shell|mountlog|" + String(text)); }
        catch (e) {}
    }

    try {
        var root = $.GetContextPanel();
        if (!root) {
            report("no context panel");
            return;
        }

        report("begin root=" + (root.id || "?") + " dw=" + (typeof DW) + " addon=" + (typeof DWAddon));

        var top = root;
        var depth = 0;
        while (top && depth < 30) {
            var parent = null;
            try { parent = top.GetParent(); } catch (e) { break; }
            if (!parent) break;
            top = parent;
            depth++;
        }

        var standalone = null;
        try {
            if (top) standalone = top.FindChildTraverse("OpenlockStandaloneHost");
        } catch (e) {}

        if (!standalone) {
            report("REFUSED: no standalone shell host; no second shell will be mounted");
            return;
        }

        function bridge(panel) {
            if (!panel || !standalone) return;
            var state = panel.state ? panel.state() : {};
            for (var key in state) {
                if (!state.hasOwnProperty(key)) continue;
                try { standalone.SetAttributeString("dwv_" + key, String(state[key])); } catch (e) {}
            }
            try {
                standalone.SetAttributeString("dw_live", panel.connected && panel.connected() ? "1" : "0");
            } catch (e) {}
        }

        // dw_addon.js deliberately leaves the bootstrap's DW.registerPanel in place: that entry
        // point is for a bundled panel, not a runtime addon. DWAddon.register is the runtime
        // addon path, and it is the only one that can report Ready.
        if (typeof DWAddon === "undefined" || !DWAddon || typeof DWAddon.register !== "function") {
            report("REFUSED: DWAddon.register is unavailable; standalone shell left untouched");
            return;
        }

        DWAddon.register({
            init: function (panel) { bridge(panel); },
            render: function (panel) { bridge(panel); }
        });

        report("bridged standalone shell");
    } catch (e) {
        report("REFUSED: " + String(e));
    }
})();

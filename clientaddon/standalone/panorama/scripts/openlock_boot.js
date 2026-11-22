// Client mount: put the Openlock window manager above the stock HUD.
//
// This file is included by panorama/layout/base_hud.xml, the game's own root HUD layout. It must
// never throw into that layout: base_hud also contains <CitadelHud>, which is every stock game
// window the client draws. If anything here fails, the stock HUD is what the player keeps.
//
// The anchor the layout ships is empty and non-hit-testing. The shell is loaded into it, so the
// only panels that take the pointer are the ones the shell itself marks hit-testable (the launcher
// bar, a window, a toast). A duplicate boot is a no-op, not a second shell.
(function () {
    function log(text) {
        try { $.Msg("[dl-openshell] mount: ", text); } catch (e) {}
    }

    try {
        var root = $.GetContextPanel();
        if (!root) {
            log("no context panel; stock HUD untouched");
            return;
        }

        // Deadworks' UI channel owns the shell when a server has mounted it. Yielding keeps one
        // shell, but this path is the standalone one: no server, no host, the shell still mounts.
        //
        // The behaviour this file is fed runs inside a component (<CitadelHud>), and a component's
        // own root is not laid out: walking to the outermost ancestor landed the shell in a 0x0
        // panel, where every child measured 0x0 and drew nothing. So the ancestors are collected,
        // the shipped anchor is looked for at each one, and a created host goes on the outermost
        // ancestor that actually has a box.
        var chain = [];
        var node = root;
        var depth = 0;
        while (node && depth < 30) {
            chain.push(node);
            var parent = null;
            try { parent = node.GetParent(); } catch (e) { break; }
            if (!parent) break;
            node = parent;
            depth += 1;
        }
        if (!chain.length) {
            log("no HUD root; stock HUD untouched");
            return;
        }

        var outer = chain[chain.length - 1];
        var existing = null;
        try { existing = outer.FindChildTraverse("DWHost_openlock-shell"); } catch (e) {}
        if (!existing) {
            for (var ci = 0; ci < chain.length && !existing; ci += 1) {
                try { existing = chain[ci].FindChildTraverse("DWHost_openlock-shell"); } catch (e) {}
            }
        }
        if (existing) {
            log("Deadworks host owns the shell; yielding");
            return;
        }

        // base_hud ships the anchor. Keeping the lookup means a client whose base_hud revision
        // dropped the panel still mounts.
        var host = null;
        for (var ai = 0; ai < chain.length && !host; ai += 1) {
            try { host = chain[ai].FindChildTraverse("OpenlockStandaloneHost"); } catch (e) {}
        }
        var carrier = null;
        for (var bi = 0; bi < chain.length && !carrier; bi += 1) {
            var w = 0;
            try { w = Math.round(chain[bi].actuallayoutwidth); } catch (e) { w = 0; }
            if (w > 0) carrier = chain[bi];
        }
        // A component root is not laid out and neither are its ancestors, so the box that is on
        // screen belongs to a panel the component built. The nearest laid-out descendant is where
        // a host can draw; without one the client would get an invisible shell over a live HUD.
        if (!carrier) {
            var queue = [outer];
            var seen = 0;
            while (queue.length && !carrier && seen < 200) {
                var head = queue.shift();
                seen += 1;
                var children = [];
                try { children = head.Children ? head.Children() : []; } catch (e) { children = []; }
                for (var qi = 0; qi < children.length; qi += 1) {
                    var kid = children[qi];
                    var kw = 0;
                    var kh = 0;
                    try { kw = Math.round(kid.actuallayoutwidth); kh = Math.round(kid.actuallayoutheight); } catch (e) { kw = 0; }
                    if (kw > 0 && kh > 0) { carrier = kid; break; }
                    queue.push(kid);
                }
            }
        }
        if (!carrier) {
            // Last resort: the outermost ancestor, with its box stated so a child can fill it.
            carrier = outer;
            try {
                carrier.style.width = "100%";
                carrier.style.height = "100%";
            } catch (e) {}
        }
        if (!host) {
            try { host = $.CreatePanel("Panel", carrier, "OpenlockStandaloneHost"); } catch (e) {
                log("anchor create threw: " + String(e) + "; stock HUD untouched");
                return;
            }
        }
        if (!host) {
            log("anchor was not created; stock HUD untouched");
            return;
        }

        host.style.width = "100%";
        host.style.height = "100%";
        host.style.zIndex = "10000";
        host.hittest = false;
        host.hittestchildren = true;

        var children = 0;
        try { children = host.GetChildCount(); } catch (e) {}
        if (children > 0) {
            log("anchor already carries a shell; yielding");
            return;
        }

        var mounted = false;
        try {
            mounted = host.BLoadLayout("file://{resources}/layout/openlock_shell.xml", false, false);
        } catch (e) {
            log("shell load threw: " + String(e));
        }

        if (!mounted) {
            try { host.RemoveAndDeleteChildren(); } catch (e) {}
            log("REFUSED: openlock_shell.xml did not mount; stock HUD untouched");
            return;
        }

        log("shell mounted from base_hud without a server");
    } catch (e) {
        log("REFUSED: " + String(e) + "; stock HUD untouched");
    }
})();

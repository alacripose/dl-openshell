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

        function boxOf(panel) {
            var w = 0;
            var h = 0;
            try { w = Math.round(panel.actuallayoutwidth); h = Math.round(panel.actuallayoutheight); } catch (e) { w = 0; }
            return [w, h];
        }

        function laidOut(panel) {
            var box = boxOf(panel);
            return box[0] > 0 && box[1] > 0;
        }

        // Panorama panels have no Children(): the engine's own accessors are GetChildCount() and
        // GetChild(i). Asking for Children() returned undefined for every panel, the walk found no
        // carrier, and the host landed on the 0x0 component root again.
        function kidsOf(panel) {
            var out = [];
            var count = 0;
            try { count = panel.GetChildCount ? panel.GetChildCount() : 0; } catch (e) { count = 0; }
            for (var i = 0; i < count; i += 1) {
                var kid = null;
                try { kid = panel.GetChild(i); } catch (e) { kid = null; }
                if (kid) out.push(kid);
            }
            return out;
        }

        // base_hud ships the anchor, but shipping it proves nothing: the measurement in a live
        // client was `Taskbar:0x0 < OpenlockStandaloneHost:0x0 < CitadelHudRoot:0x0`, the anchor
        // inside a tree that is never laid out. So the anchor is used only when a panel above it
        // has a box; otherwise the shell mounts where the HUD is actually drawn.
        var anchor = null;
        for (var ai = 0; ai < chain.length && !anchor; ai += 1) {
            try { anchor = chain[ai].FindChildTraverse("OpenlockStandaloneHost"); } catch (e) {}
        }

        var host = null;
        if (anchor) {
            var above = null;
            try { above = anchor.GetParent ? anchor.GetParent() : null; } catch (e) { above = null; }
            var proof = laidOut(anchor);
            var guard = 0;
            while (!proof && above && guard < 30) {
                proof = laidOut(above);
                try { above = above.GetParent ? above.GetParent() : null; } catch (e) { above = null; }
                guard += 1;
            }
            if (proof) host = anchor;
        }

        var carrier = null;
        for (var bi = 0; bi < chain.length && !carrier; bi += 1) {
            if (laidOut(chain[bi])) carrier = chain[bi];
        }
        // A component root is not laid out and neither are its ancestors, so the box that is on
        // screen belongs to a panel the component built. The nearest laid-out descendant is where
        // a host can draw; without one the client would get an invisible shell over a live HUD.
        var walked = 0;
        var bestW = 0;
        var bestH = 0;
        if (!carrier) {
            var queue = [outer];
            var seen = 0;
            while (queue.length && !carrier && seen < 400) {
                var head = queue.shift();
                seen += 1;
                var kids = kidsOf(head);
                for (var qi = 0; qi < kids.length; qi += 1) {
                    var kb = boxOf(kids[qi]);
                    if (kb[0] > bestW) bestW = kb[0];
                    if (kb[1] > bestH) bestH = kb[1];
                    if (laidOut(kids[qi])) { carrier = kids[qi]; break; }
                    queue.push(kids[qi]);
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
        if (host !== anchor) {
            log(anchor ? "the shipped anchor sits in a tree with no box; mounting where a box is"
                       : "no shipped anchor in this tree; mounting where a box is");
            log("carrier walk: visited=" + seen + " widest=" + bestW + "x" + bestH
                + " carrier=" + (carrier && carrier.id ? carrier.id : "(no id)"));
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

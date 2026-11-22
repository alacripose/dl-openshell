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

        // A host that took our layout root's children as its own has no box of its own: with a
        // 100% child and no size it is fit-children and resolves to 0x0, and every panel under it
        // does too (the live client measured four hundred of them, none laid out). Stating the
        // host's box is what makes the chain real, so it happens before anything is measured.
        try {
            if (!laidOut(outer)) {
                outer.style.width = "100%";
                outer.style.height = "100%";
            }
        } catch (e) {}
        var outer = chain[chain.length - 1];
        // Which tree is this? The answer decides whether the layout override reached the drawn HUD
        // or whether some other host is loading this script into a panel nobody paints.
        try {
            var ctxId = root.id ? root.id : "(no id)";
            var ctxClass = root.GetAttributeString ? (root.GetAttributeString("class", "") || "(no class)") : "(no class)";
            var topKids = outer.GetChildCount ? outer.GetChildCount() : -1;
            var hasWindowRoot = outer.FindChildTraverse("WindowRoot") ? "yes" : "no";
            var hasAnchor = outer.FindChildTraverse("OpenlockStandaloneHost") ? "yes" : "no";
            var kidsText = "";
            try {
                var kidCount = outer.GetChildCount ? outer.GetChildCount() : 0;
                var parts = [];
                for (var ki = 0; ki < kidCount && ki < 6; ki += 1) {
                    var kid = outer.GetChild(ki);
                    if (!kid) continue;
                    var kidClass = "";
                    try { kidClass = kid.GetAttributeString ? (kid.GetAttributeString("class", "") || "") : ""; } catch (e2) {}
                    var kb = boxOf(kid);
                    parts.push((kid.id || "(no id)") + "[" + (kidClass || "-") + "]:" + kb[0] + "x" + kb[1]);
                }
                kidsText = " kids=" + parts.join(" , ");
            } catch (e3) { kidsText = " kids=?"; }
            var pos = "";
            try { var xy = root.GetPositionWithinWindow ? root.GetPositionWithinWindow() : null; pos = xy ? (" pos=" + Math.round(xy[0]) + "," + Math.round(xy[1])) : ""; } catch (e4) {}
            log("tree: context=" + ctxId + " class=" + ctxClass + " top=" + (outer.id || "(no id)") + pos + kidsText
                + " topKids=" + topKids + " windowRoot=" + hasWindowRoot + " anchor=" + hasAnchor
                + " chain=" + chain.length);
        } catch (e) {
            log("tree: report threw " + String(e));
        }
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

        // There is exactly one shell, so exactly one host may carry it. Two boots in one tree left
        // an empty second host behind and the measurement read that one: host=1920x1080 root=none.
        // Every host is collected, the one with children is the shell's, and an empty one is reused
        // instead of being duplicated.
        function findShellHosts(seed) {
            var found = [];
            var queue = [seed];
            var seen = 0;
            while (queue.length && seen < 900) {
                var panel = queue.shift();
                seen += 1;
                try {
                    if (panel.id === "OpenlockStandaloneHost") found.push(panel);
                } catch (e) {}
                var kids = kidsOf(panel);
                for (var i = 0; i < kids.length; i += 1) queue.push(kids[i]);
            }
            return found;
        }

        function findShellHost(seed) {
            var hosts = findShellHosts(seed);
            for (var i = 0; i < hosts.length; i += 1) {
                var kids = 0;
                try { kids = hosts[i].GetChildCount(); } catch (e) {}
                if (kids > 0) return hosts[i];
            }
            return hosts.length > 0 ? hosts[0] : null;
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
        var liveHosts = findShellHosts(outer);
        var carried = null;
        for (var hi = 0; hi < liveHosts.length; hi += 1) {
            var hostKids = 0;
            try { hostKids = liveHosts[hi].GetChildCount(); } catch (e) {}
            if (hostKids > 0) carried = liveHosts[hi];
        }
        if (carried) {
            log("a shell host already carries a shell; yielding (" + liveHosts.length + " host panel(s) in this tree)");
            return;
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

        // Mounting is not the same as being laid out. The client loads this layout while it has no
        // HUD, so the host can sit in a tree with no box; a second or three later the HUD exists and
        // some panel in this tree has a real box. The shell follows the box instead of reporting the
        // 0x0 it was born with.
        function widestLaid(seed) {
            var best = null;
            var bestArea = 0;
            var queue = [seed];
            var seen = 0;
            while (queue.length && seen < 800) {
                var panel = queue.shift();
                seen += 1;
                var box = boxOf(panel);
                if (box[0] > 0 && box[1] > 0 && box[0] * box[1] > bestArea) {
                    best = panel;
                    bestArea = box[0] * box[1];
                }
                var kids = kidsOf(panel);
                for (var i = 0; i < kids.length; i += 1) queue.push(kids[i]);
            }
            return best;
        }

        // Being laid out is the host's business; being visible is the shell's. The shell root was
        // spliced into a host that states its own box, so the root and the bar state theirs too, and
        // the numbers are reported rather than assumed.
        function sizeShell(seed) {
            try {
                var shellHost = findShellHost(seed);
                if (!shellHost) {
                    log("shell sizes: no host in this tree");
                    return;
                }
                var sizeRoot = null;
                try { sizeRoot = shellHost.GetChild(0); } catch (e) {}
                if (sizeRoot) {
                    sizeRoot.style.width = "100%";
                    sizeRoot.style.height = "100%";
                }
                var bar = null;
                try { bar = shellHost.FindChildTraverse("Taskbar"); } catch (e) {}
                var barBox = [0, 0];
                if (bar) {
                    barBox = boxOf(bar);
                    if (barBox[0] === 0 || barBox[1] === 0) {
                        bar.style.width = "100%";
                        bar.style.height = "48px";
                        barBox = boxOf(bar);
                    }
                }
                var hostSizes = [];
                var allHosts = findShellHosts(seed);
                for (var hx = 0; hx < allHosts.length; hx += 1) {
                    var hk = 0;
                    try { hk = allHosts[hx].GetChildCount(); } catch (e) {}
                    hostSizes.push(boxOf(allHosts[hx]).join("x") + "/" + hk + " kids");
                }
                log("shell hosts: " + hostSizes.join(" , "));
                log("shell sizes: host=" + boxOf(shellHost).join("x")
                    + " root=" + (sizeRoot ? boxOf(sizeRoot).join("x") : "none")
                    + " bar=" + (bar ? barBox.join("x") : "none"));
            } catch (e) {
                log("sizeShell threw: " + String(e));
            }
        }

        function settle(step) {
            var delays = [1.0, 2.0, 4.0, 6.0, 8.0];
            $.Schedule(delays[step], function () {
                try {
                    var shellHost = findShellHost(outer);
                    if (shellHost && laidOut(shellHost)) {
                        log("settle: host laid out " + boxOf(shellHost).join("x") + " at step " + step);
                        sizeShell(outer);
                        if (step + 1 < delays.length) settle(step + 1);
                        return;
                    }
                    var target = widestLaid(outer);
                    if (target && shellHost && target !== shellHost) {
                        var targetBox = boxOf(target);
                        try { shellHost.SetParent(target); } catch (e) {}
                        shellHost.style.width = "100%";
                        shellHost.style.height = "100%";
                        shellHost.style.zIndex = "10000";
                        log("settle: step " + step + " moved the shell onto " + (target.id || "(no id)")
                            + " " + targetBox.join("x"));
                    } else {
                        log("settle: step " + step + " no laid panel in this tree yet");
                    }
                    if (step + 1 < delays.length) settle(step + 1);
                } catch (e) {
                    log("settle threw: " + String(e));
                }
            });
        }
        settle(0);
        // A style written this frame is measured next frame, so the reading that matters is the one
        // after layout has run: two late passes report the bar's real box instead of zero.
        $.Schedule(20, function () { sizeShell(outer); });
        $.Schedule(26, function () { sizeShell(outer); });
        $.Schedule(34, function () { sizeShell(outer); });
    } catch (e) {
        log("REFUSED: " + String(e) + "; stock HUD untouched");
    }
})();

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
        try { $.Msg("[Openlock] mount: ", text); } catch (e) {}
    }

    try {
        var root = $.GetContextPanel();
        if (!root) {
            log("no context panel; stock HUD untouched");
            return;
        }

        // Deadworks' UI channel owns the shell when a server has mounted it. Yielding keeps one
        // shell, but this path is the standalone one: no server, no host, the shell still mounts.
        var hud = root;
        var depth = 0;
        while (hud && depth < 30) {
            var parent = null;
            try { parent = hud.GetParent(); } catch (e) { break; }
            if (!parent) break;
            hud = parent;
            depth++;
        }
        if (!hud) {
            log("no HUD root; stock HUD untouched");
            return;
        }

        var existing = null;
        try { existing = hud.FindChildTraverse("DWHost_openlock-shell"); } catch (e) {}
        if (existing) {
            log("Deadworks host owns the shell; yielding");
            return;
        }

        if (globalThis.__openlockShellMounted) {
            log("already mounted this session; yielding");
            return;
        }

        // base_hud ships the anchor. Keeping the lookup means a client whose base_hud revision
        // dropped the panel still mounts: the fallback is a panel created on the HUD root.
        var host = null;
        try { host = hud.FindChildTraverse("OpenlockStandaloneHost"); } catch (e) {}
        if (!host) {
            try { host = root.FindChildTraverse("OpenlockStandaloneHost"); } catch (e) {}
        }
        if (!host) {
            try { host = $.CreatePanel("Panel", hud, "OpenlockStandaloneHost"); } catch (e) {
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

        globalThis.__openlockShellMounted = true;
        log("shell mounted from base_hud without a server");
    } catch (e) {
        log("REFUSED: " + String(e) + "; stock HUD untouched");
    }
})();

// CSDK 10 mount. Only the reduced tools build includes this file: its base_hud and
// base_dashboard override the stock root, keep the host's own child (CitadelHud / CitadelDB),
// and load the legacy shell entry generated from the live shell at pack time.
//
// The live mount (openlock_boot.js) is untouched, so a workaround for this older Panorama parser
// can never change what the live game loads.
(function () {
    function log(text) {
        try { $.Msg("[dl-openshell] csdk10 mount: ", text); } catch (e) {}
    }

    try {
        var root = $.GetContextPanel();
        if (!root) {
            log("no context panel");
            return;
        }

        var top = root;
        var depth = 0;
        while (top && depth < 30) {
            var parent = null;
            try { parent = top.GetParent(); } catch (e) { break; }
            if (!parent) break;
            top = parent;
            depth++;
        }

        if (globalThis.__openlockCsdk10Mounted) {
            log("already mounted this session");
            return;
        }

        var hostRoot = null;
        try { hostRoot = top.FindChildTraverse("Dashboard"); } catch (e) {}
        if (!hostRoot) {
            try { hostRoot = top.FindChildTraverse("Hud"); } catch (e) {}
        }
        if (!hostRoot) {
            log("REFUSED: no Dashboard or Hud host root");
            return;
        }

        var host = null;
        try { host = hostRoot.FindChildTraverse("OpenlockStandaloneHost"); } catch (e) {}
        if (!host) {
            try { host = $.CreatePanel("Panel", hostRoot, "OpenlockStandaloneHost"); } catch (e) {
                log("host create threw: " + String(e));
                return;
            }
        }
        if (!host) {
            log("host was not created");
            return;
        }

        var children = 0;
        try { children = host.GetChildCount(); } catch (e) {}
        if (children > 0) {
            log("host already carries a shell");
            return;
        }

        host.style.width = "100%";
        host.style.height = "100%";
        host.hittest = false;
        host.hittestchildren = true;

        var mounted = false;
        try {
            mounted = host.BLoadLayout("file://{resources}/layout/openlock_shell_legacy.xml", false, false);
        } catch (e) {
            log("legacy shell load threw: " + String(e));
        }
        if (!mounted) {
            try { host.RemoveAndDeleteChildren(); } catch (e) {}
            log("REFUSED: openlock_shell_legacy.xml did not mount");
            return;
        }

        globalThis.__openlockCsdk10Mounted = true;
        globalThis.__openlockShellMounted = true;
        log("legacy shell mounted from " + (hostRoot.id || "host root"));
    } catch (e) {
        log("REFUSED: " + String(e));
    }
})();

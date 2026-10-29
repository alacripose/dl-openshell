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

        // The host is one per layout tree. base_hud and base_dashboard can both run this script;
        // a second host would draw a second taskbar and two sets of frames over the same pixels,
        // which reads as the bar flickering between two positions. Yield to the host already
        // mounted in this tree before choosing a root.
        var mountedHost = null;
        try { mountedHost = top.FindChildTraverse("OpenlockStandaloneHost"); } catch (e) {}
        if (mountedHost && mountedHost.GetChildCount() > 0) {
            log("shell already mounted in this tree; yielding");
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

        var mountKey = String(hostRoot.id || "root");

        // Dashboard and Hud are separate roots and the client can load either first. A single
        // session flag put the shell only in whichever loaded first, so the dashboard showed no
        // shell after the HUD had mounted. Each root owns one host; reopening a root is a no-op.
        // The reduced tools build exposes no shared client object (Game and Steam are absent), so
        // the map below can only dedupe within one JS context. Separate layout trees each get
        // their own shell and report their mount line in the console.
        var mountedRoots = globalThis.__openlockCsdk10MountedRoots;
        if (!mountedRoots) {
            mountedRoots = {};
            globalThis.__openlockCsdk10MountedRoots = mountedRoots;
        }
        if (mountedRoots[mountKey]) {
            log("already mounted into " + mountKey);
            return;
        }
        // Claim before the panel exists. Two Hud loads can interleave inside one frame, and a
        // claim written after BLoadLayout is too late for the second one.
        mountedRoots[mountKey] = true;

        var claimId = "OpenlockMountClaim_" + mountKey;
        var claimed = null;
        try { claimed = top.FindChildTraverse(claimId); } catch (e) {}
        if (claimed) {
            log("mount already claimed for " + mountKey);
            return;
        }
        try { $.CreatePanel("Panel", top, claimId); } catch (e) {}

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
        host.style.zIndex = "10000";
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

        mountedRoots[mountKey] = true;
        globalThis.__openlockShellMounted = true;
        log("legacy shell mounted from " + mountKey);
    } catch (e) {
        log("REFUSED: " + String(e));
    }
})();

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

        // The host is one per layout tree. base_hud and base_dashboard can both run this script,
        // and a single root can load the layout more than once in the same frame. Checking child
        // count lost that race: the first host existed but BLoadLayout had not added its child
        // yet, so every later script created another host. Three shells then drew three taskbars
        // and three sets of frames over the same pixels, which reads as the bar flickering.
        // Claim the host before loading, and treat a claim as owned even while it is empty.
        var mountedHost = null;
        try { mountedHost = top.FindChildTraverse("OpenlockStandaloneHost"); } catch (e) {}
        if (mountedHost) {
            var claimed = "";
            try { claimed = mountedHost.GetAttributeString("openlock_claimed", ""); } catch (e) {}
            var mountedChildren = 0;
            try { mountedChildren = mountedHost.GetChildCount(); } catch (e) {}
            if (claimed === "1" || mountedChildren > 0) {
                log("shell already hosted at " + String(mountedHost.GetParent ? (mountedHost.GetParent().id || "root") : "root") + "; yielding");
                return;
            }
            // An empty, unclaimed host is debris from a refused mount. Replace it.
            try { mountedHost.DeleteAsync(0); } catch (e) {}
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

        // Claim before the load. A second script in the same frame now yields instead of
        // creating a peer host whose child count is still zero.
        try { host.SetAttributeString("openlock_claimed", "1"); } catch (e) {}

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
            try { host.SetAttributeString("openlock_claimed", "0"); } catch (e) {}
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

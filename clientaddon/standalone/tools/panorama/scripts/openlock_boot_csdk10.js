// CSDK 10 mount. Only the reduced tools build includes this file: its base_hud, base_dashboard
// and dashboard overrides keep the host's own children (CitadelHud / CitadelDB) and load the
// legacy shell entry generated from the live shell at pack time.
//
// This older client is not the live game in two ways that matter here:
//   * base_dashboard.xml is never loaded; the full-screen menu is the stock dashboard.xml root.
//   * the menu and settings are separate layout roots, and a host inside a host root's child is
//     painted underneath the menu rather than over it.
// The shell host therefore belongs on the layout root itself, as a sibling of the stock content.
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
        if (!top) {
            log("no layout root");
            return;
        }

        // The layout root is the only panel that survives every screen in this build: the stock
        // dashboard is its child, the HUD is its child, and popups are grandchildren. A host on
        // the root is above all of them.
        var mountKey = String(top.id || "root");

        var rootClaim = "";
        try { rootClaim = top.GetAttributeString("openlock_shell_root", ""); } catch (e) {}
        if (rootClaim === "1") {
            log("layout root already carries the shell");
            return;
        }

        // A layout root can be loaded more than once in a session, and each instance is a new
        // panel whose attribute claim is empty. The session map is the claim that survives that:
        // one shell per root id, not one per load. Dashboard and HUD have different ids and each
        // gets its own shell, which is the screen the player is on.
        var mountedRoots = globalThis.__openlockCsdk10MountedRoots;
        if (!mountedRoots) {
            mountedRoots = {};
            globalThis.__openlockCsdk10MountedRoots = mountedRoots;
        }
        if (mountedRoots[mountKey]) {
            log("root " + mountKey + " already mounted this session; yielding");
            return;
        }
        mountedRoots[mountKey] = true;

        var existing = null;
        try { existing = top.FindChildTraverse("OpenlockStandaloneHost"); } catch (e) {}
        if (existing) {
            var existingChildren = 0;
            try { existingChildren = existing.GetChildCount(); } catch (e) {}
            if (existingChildren > 0) {
                log("shell already hosted on " + mountKey + "; yielding");
                return;
            }
            try { existing.DeleteAsync(0); } catch (e) {}
        }

        // Claim before the panel exists. Two script loads can interleave inside one frame, and a
        // claim written after BLoadLayout is too late for the second one. The attribute belongs
        // to the layout root, so two separate roots (dashboard and HUD) each get one shell.
        try { top.SetAttributeString("openlock_shell_root", "1"); } catch (e) {}

        var host = null;
        try { host = $.CreatePanel("Panel", top, "OpenlockStandaloneHost"); } catch (e) {
            try { top.SetAttributeString("openlock_shell_root", "0"); } catch (e2) {}
            log("host create threw: " + String(e));
            return;
        }
        if (!host) {
            try { top.SetAttributeString("openlock_shell_root", "0"); } catch (e) {}
            log("host was not created");
            return;
        }

        host.style.width = "100%";
        host.style.height = "100%";
        host.style.zIndex = "10000";
        // This parser has no `position`; ignore-parent-flow is the absolute-positioning
        // equivalent the legacy sheet already uses. Both are set so neither parser drops the host
        // into the stock root's flow.
        try { host.style.ignoreParentFlow = true; } catch (e) {}
        try { host.style.position = "absolute"; } catch (e) {}
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
            try { host.DeleteAsync(0); } catch (e) {}
            try { top.SetAttributeString("openlock_shell_root", "0"); } catch (e) {}
            try { delete mountedRoots[mountKey]; } catch (e) {}
            log("REFUSED: openlock_shell_legacy.xml did not mount");
            return;
        }

        globalThis.__openlockShellMounted = true;
        log("legacy shell mounted over " + mountKey);
    } catch (e) {
        log("REFUSED: " + String(e));
    }
})();

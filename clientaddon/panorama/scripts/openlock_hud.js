// Openlock ability-HUD collapse, loaded by the server through UI.Panel.LoadXml.
//
// The server writes "hud=0" while the mode is on and "hud=1" when it is off. The DW bootstrap
// forwards every Set to this addon's host as a dwv_<key> attribute, so the script polls that
// attribute and nothing else. Only ability panels are collapsed; the shop, the Openlock shell and
// the rest of the HUD are untouched.
(function () {
    // The game's own ids, read from its compiled HUD layouts (hud_abilities.xml has the
    // id "abilities" for the icon strip; ability_upgrades_panel.xml has the upgrade list).
    // Classes cover the containers the game creates without an id.
    var ABILITY_PANELS = [
        "abilities",
        "hud_abilities",
        "ability_upgrades_panel",
        "AbilityUpgradesHeaderContainer",
        "abilityLevelButtonContainer",
        "upgradeOptions"
    ];

    var ABILITY_CLASSES = [
        "abilities_container",
        "hud_abilities",
        "ability_panels_container"
    ];

    var panel = $.GetContextPanel();
    var host = panel.GetParent ? panel.GetParent() : null;
    var root = panel;
    var depth = 0;
    while (root.GetParent && root.GetParent() && depth < 30) {
        root = root.GetParent();
        depth++;
    }

    var saved = {};
    var applied = null;

    function find(id) {
        try {
            if (root.FindChildTraverse) return root.FindChildTraverse(id);
            if ($.GetContextPanel().FindChildTraverse) return $.GetContextPanel().FindChildTraverse(id);
        } catch (e) {}
        return null;
    }

    function apply(hide) {
        if (applied === hide) return;
        applied = hide;

        var matched = 0;

        function toggle(node, key) {
            if (!node) return;
            matched++;
            if (hide) {
                if (!Object.prototype.hasOwnProperty.call(saved, key)) {
                    try { saved[key] = node.style.visibility || ""; } catch (e) { saved[key] = ""; }
                }
                try { node.style.visibility = "collapse"; } catch (e) {}
            } else if (Object.prototype.hasOwnProperty.call(saved, key)) {
                try { node.style.visibility = saved[key]; } catch (e) {}
                delete saved[key];
            }
        }

        for (var i = 0; i < ABILITY_PANELS.length; i++)
            toggle(find(ABILITY_PANELS[i]), ABILITY_PANELS[i]);

        for (var c = 0; c < ABILITY_CLASSES.length; c++) {
            var nodes = null;
            try {
                nodes = root.FindChildrenWithClassTraverse
                    ? root.FindChildrenWithClassTraverse(ABILITY_CLASSES[c])
                    : null;
            } catch (e) { nodes = null; }
            if (!nodes) continue;
            for (var n = 0; n < nodes.length; n++) toggle(nodes[n], "class:" + ABILITY_CLASSES[c] + ":" + n);
        }

        $.Msg("[Openlock] ability HUD ", hide ? "collapsed" : "restored", " (", matched, " panel(s))");
    }

    function poll() {
        if (host && host.GetAttributeString) {
            var value = "";
            try { value = host.GetAttributeString("dwv_hud", ""); } catch (e) {}
            if (value === "0") apply(true);
            else if (value === "1") apply(false);
        }
        $.Schedule(0.25, poll);
    }

    poll();
})();

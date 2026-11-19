// Drive the shipped Popit in a real browser and read the rendered result.
//
// Everything under test is the shipped file: openlock_popit.js, the generated pair table and the
// generated pair CSS. Only the Panorama host is adapted (panorama-dom-host.js). No assertion is
// imported from the module's own test harness; the checks below read DOM nodes, class names and
// computed styles.
(async function () {
    "use strict";

    var report = { checks: [], failures: [], details: {} };

    function check(name, ok, detail) {
        report.checks.push({ name: name, ok: !!ok, detail: detail === undefined ? "" : detail });
        if (!ok) report.failures.push(name + (detail ? " — " + detail : ""));
    }

    async function loadCss(path) {
        var response = await fetch(path, { cache: "no-store" });
        var text = await response.text();
        var style = document.createElement("style");
        style.dataset.source = path;
        style.textContent = globalThis.OpenlockPanoramaCss(text);
        document.head.appendChild(style);
    }

    function loadScript(path) {
        return new Promise(function (resolve, reject) {
            var script = document.createElement("script");
            script.src = path;
            script.onload = resolve;
            script.onerror = function () { reject(new Error("script failed: " + path)); };
            document.head.appendChild(script);
        });
    }

    function rgb(value) {
        var match = /rgba?\(([^)]+)\)/.exec(value || "");
        if (!match) return null;
        var parts = match[1].split(",").map(function (part) { return parseFloat(part.trim()); });
        return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }

    function sameColor(actual, expected, tolerance) {
        var a = rgb(actual);
        var e = rgb(expected);
        if (!a || !e) return false;
        var limit = tolerance === undefined ? 2 : tolerance;
        return Math.abs(a.r - e.r) <= limit && Math.abs(a.g - e.g) <= limit && Math.abs(a.b - e.b) <= limit;
    }

    function hexRgb(hex) {
        var value = hex.replace("#", "");
        return "rgb(" + parseInt(value.slice(0, 2), 16) + ", " + parseInt(value.slice(2, 4), 16) + ", " +
            parseInt(value.slice(4, 6), 16) + ")";
    }

    function channel(value) {
        var v = value / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }

    function luminance(color) {
        return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
    }

    function contrast(a, b) {
        var la = luminance(a);
        var lb = luminance(b);
        var light = Math.max(la, lb);
        var dark = Math.min(la, lb);
        return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
    }

    function composite(color, backdrop) {
        var alpha = color.a === undefined ? 1 : color.a;
        return {
            r: color.r * alpha + backdrop.r * (1 - alpha),
            g: color.g * alpha + backdrop.g * (1 - alpha),
            b: color.b * alpha + backdrop.b * (1 - alpha),
            a: 1
        };
    }

    function classesOf(element) {
        return element ? Array.prototype.slice.call(element.classList) : [];
    }

    function pairClasses(element) {
        return classesOf(element).filter(function (name) { return /^Pair[A-Z]/.test(name); });
    }

    function byText(nodes, text) {
        for (var i = 0; i < nodes.length; i++) {
            if ((nodes[i].textContent || "").toUpperCase().indexOf(text.toUpperCase()) >= 0) return nodes[i];
        }
        return null;
    }

    var targets = [
        { id: "cell:root:health", title: "Health", kind: "cell", rect: { x: 1000, y: 300, w: 180, h: 42 } },
        { id: "citadel:shop", title: "Shop", kind: "window", rect: { x: 1080, y: 120, w: 420, h: 300 } }
    ];
    var palette = {
        body: "#12151A", panel: "#171B21", title: "#1C222B", meta: "#0C0E11",
        border: "#262C34", borderStrong: "#F0C454", ink: "#ECEFF2", muted: "#AAB3BD",
        accent: "#F0C454", alert: "#E4786F"
    };
    var root = document.getElementById("root");
    var lastPair = "";
    var classicEvents = [];

    function show(page, pair) {
        return globalThis.OpenlockPopit.show({
            root: root,
            screen: { w: 1600, h: 900, top: 46 },
            palette: palette,
            targets: targets,
            target: targets[0],
            state: { material: "none", decoration: "none", color: "", radius: -1, border: -1, opacity: -1 },
            page: page,
            pair: pair || "popit-blue",
            onPair: function (chosen) { lastPair = chosen.id; },
            onClassic: function (on) { classicEvents.push(on); }
        });
    }

    try {
        // Schemes first, then the pair skin, matching the layout include order: the pair must win
        // over the scheme when it is on, and Classic must return the scheme's own roles.
        await loadCss("/clientaddon/panorama/styles/openlock_popit.css");
        await loadCss("/clientaddon/panorama/styles/openlock_schemes.css");
        await loadCss("/clientaddon/panorama/styles/openlock_pairs.css");
        await loadScript("/clientaddon/panorama/scripts/openlock_pairs.js");
        await loadScript("/clientaddon/panorama/scripts/openlock_popit.js");

        var pairTable = globalThis.OpenlockPopitPairs;
        check("the generated pair table loads in the browser", pairTable && pairTable.pairs.length === 37,
            pairTable ? pairTable.pairs.length + " pairs" : "missing table");
        check("the stylesheet is applied", getComputedStyle(document.body).backgroundColor === "rgb(18, 21, 26)",
            getComputedStyle(document.body).backgroundColor);

        var opened = show("palette", "popit-blue");
        check("the surface opens", opened.ok && opened.pair === "popit-blue", JSON.stringify(opened));

        var surface = document.getElementById("OpenlockPopit");
        check("the surface panel is in the DOM", !!surface);
        var rootPanel = surface.querySelector(".PopitRoot");
        var rowsBefore = Array.prototype.slice.call(surface.querySelectorAll(".PopitRootRow"));
        var dotsBefore = Array.prototype.slice.call(surface.querySelectorAll(".PopitPageDot"));
        var wordmark = surface.querySelector(".PopitWordmark");
        var pairChip = surface.querySelector(".PopitPairChip");
        check("the root is mounted with six rows", rowsBefore.length === 6, rowsBefore.length + " rows");
        check("the root is visible with real height",
            rootPanel && getComputedStyle(rootPanel).visibility === "visible" && rootPanel.getBoundingClientRect().height > 100,
            rootPanel ? Math.round(rootPanel.getBoundingClientRect().height) + "px" : "no root");
        check("the header carries the wordmark and pair chip", !!wordmark && !!pairChip,
            (wordmark ? wordmark.textContent : "-") + " / " + (pairChip ? pairChip.textContent.trim() : "-"));

        var child = surface.querySelector(".PopitChild");
        var childRect = child.getBoundingClientRect();
        var rootRect = rootPanel.getBoundingClientRect();
        check("the child reveals beside the root",
            getComputedStyle(child).visibility === "visible" &&
            childRect.width > 200 && childRect.height > 100 &&
            childRect.left >= rootRect.right - 1,
            "child " + Math.round(childRect.left) + "px, root right " + Math.round(rootRect.right) + "px");
        check("the open child does not overlap the root",
            childRect.left >= rootRect.right - 1 || childRect.top >= rootRect.bottom - 1,
            "overlap");
        check("the surface widens to hold both panes", Math.round(surface.getBoundingClientRect().width) === 648,
            Math.round(surface.getBoundingClientRect().width) + "px");
        check("the root shifts aside while the child is open",
            getComputedStyle(rootPanel).transform !== "none" &&
            getComputedStyle(rootPanel).transform.indexOf("-4") >= 0,
            getComputedStyle(rootPanel).transform);

        // Section change through the live UI: the root must not be rebuilt.
        var goodiesRow = byText(rowsBefore, "Goodies");
        check("the root exposes a Goodies row", !!goodiesRow);
        goodiesRow.click();
        var rowsAfter = Array.prototype.slice.call(surface.querySelectorAll(".PopitRootRow"));
        var sameNodes = rowsAfter.length === rowsBefore.length;
        if (sameNodes) {
            for (var i = 0; i < rowsAfter.length; i++) if (rowsAfter[i] !== rowsBefore[i]) sameNodes = false;
        }
        check("a section change keeps the root node instances", sameNodes, rowsAfter.length + " rows");
        check("a section change keeps the same root element", surface.querySelector(".PopitRoot") === rootPanel);
        check("a section change keeps the same dots", Array.prototype.slice.call(surface.querySelectorAll(".PopitPageDot"))
            .every(function (dot, index) { return dot === dotsBefore[index]; }));
        check("the Goodies child lists seven materials",
            surface.querySelectorAll(".PopitItem").length === 7,
            surface.querySelectorAll(".PopitItem").length + " tiles");
        check("the child stays open on the section change",
            surface.classList.contains("ChildOpen") && getComputedStyle(child).visibility === "visible");

        var back = surface.querySelector(".PopitBack");
        back.click();
        var rowsAfterBack = Array.prototype.slice.call(surface.querySelectorAll(".PopitRootRow"));
        check("Back closes the child", !surface.classList.contains("ChildOpen") &&
            getComputedStyle(child).visibility === "hidden",
            getComputedStyle(child).visibility);
        check("Back keeps the root mounted and visible",
            surface.querySelector(".PopitRoot") === rootPanel &&
            getComputedStyle(rootPanel).visibility === "visible" &&
            rowsAfterBack.length === 6);
        check("Back restores the root-only width", Math.round(surface.getBoundingClientRect().width) === 300,
            Math.round(surface.getBoundingClientRect().width) + "px");
        check("Back clears the child content", surface.querySelectorAll(".PopitItem").length === 0);

        // Persistence: pick through the tile, encode the row, decode it, reopen with the decoded id.
        var slugs = ["lbp1-yellow-fuchsia", "lbp3-candy-jar"];
        var roundTrips = [];
        for (var s = 0; s < slugs.length; s++) {
            var slug = slugs[s];
            byText(surface.querySelectorAll(".PopitRootRow"), "Palette").click();
            var tiles = Array.prototype.slice.call(surface.querySelectorAll(".PopitItemPair"));
            var tile = tiles.filter(function (item) { return item.value === slug; })[0];
            check("the palette lists the pair " + slug, !!tile, tiles.length + " tiles");
            if (!tile) continue;
            tile.click();
            check("picking " + slug + " notifies the shell", lastPair === slug, lastPair);
            check("picking " + slug + " paints the pair class", pairClasses(surface).length === 1,
                pairClasses(surface).join(" "));

            var row = globalThis.OpenlockPopit.encodeProfile({
                columns: 4, width: 356, frame: "lbp3", mode: "create", order: [], pair: slug
            });
            check("the snapshot row carries pair:" + slug, row.split(";").indexOf("pair:" + slug) >= 0, row);
            var decoded = globalThis.OpenlockPopit.decodeProfile(row);
            check("decoding restores pair " + slug, decoded.pair === slug, JSON.stringify(decoded));
            roundTrips.push({ slug: slug, row: row, decoded: decoded.pair });

            globalThis.OpenlockPopit.close();
            var reloaded = show("palette", decoded.pair);
            var reloadedSurface = document.getElementById("OpenlockPopit");
            check("a reload with the saved pair restores " + slug,
                reloaded.ok && reloaded.pair === slug &&
                reloadedSurface.classList.contains("Pair" + slug.split("-").map(function (part) {
                    return part.charAt(0).toUpperCase() + part.slice(1);
                }).join("")),
                reloaded.pair + " / " + pairClasses(reloadedSurface).join(" "));
            surface = reloadedSurface;
            rootPanel = surface.querySelector(".PopitRoot");
            child = surface.querySelector(".PopitChild");
        }

        // Role order and measured contrast, from the rendered pair.
        var chosen = pairTable.pairs.filter(function (pair) { return pair.id === "lbp1-yellow-fuchsia"; })[0];
        globalThis.OpenlockPopit.setPair("lbp1-yellow-fuchsia");
        globalThis.OpenlockPopit.openSection("palette");
        var rootStyle = getComputedStyle(rootPanel);
        var wordmarkStyle = getComputedStyle(surface.querySelector(".PopitWordmark"));
        var detailStyle = getComputedStyle(surface.querySelector(".PopitDetail"));
        var dotStyle = getComputedStyle(surface.querySelector(".PopitPageDot.On"));
        var activeRow = surface.querySelector(".PopitRootRow.Active");
        var activeStyle = getComputedStyle(activeRow);
        var backdrop = rgb("rgb(18, 21, 26)");
        var slab = composite(rgb(rootStyle.backgroundColor), backdrop);
        var accent = rgb(detailStyle.color);
        var measured = {
            pair: chosen.id,
            secondary: chosen.secondary,
            primary: chosen.primary,
            tertiary: chosen.tertiary,
            emphasis: chosen.emphasis,
            slabBackground: rootStyle.backgroundColor,
            slabBorder: rootStyle.borderTopColor,
            wordmark: wordmarkStyle.color,
            detail: detailStyle.color,
            pageDot: dotStyle.backgroundColor,
            activeRow: activeStyle.backgroundColor,
            contrast: {
                wordmarkOnSlab: contrast(slab, rgb(wordmarkStyle.color)),
                emphasisOnSlab: contrast(slab, rgb(detailStyle.color)),
                borderOnSlab: contrast(slab, rgb(rootStyle.borderTopColor)),
                pageDotOnSlab: contrast(slab, rgb(dotStyle.backgroundColor))
            }
        };
        report.details.roles = measured;
        check("secondary paints the slab background", sameColor(rootStyle.backgroundColor, hexRgb(chosen.secondary)),
            rootStyle.backgroundColor + " vs " + chosen.secondary);
        check("the slab keeps the shipped alpha", Math.abs((rgb(rootStyle.backgroundColor) || {}).a - 0.902) < 0.01,
            String((rgb(rootStyle.backgroundColor) || {}).a));
        check("primary paints the slab border", sameColor(rootStyle.borderTopColor, hexRgb(chosen.primary)),
            rootStyle.borderTopColor + " vs " + chosen.primary);
        check("tertiary paints the wordmark", sameColor(wordmarkStyle.color, hexRgb(chosen.tertiary)),
            wordmarkStyle.color + " vs " + chosen.tertiary);
        check("emphasis paints the detail ink", sameColor(detailStyle.color, hexRgb(chosen.emphasis)),
            detailStyle.color + " vs " + chosen.emphasis);
        check("primary paints the active page dot", sameColor(dotStyle.backgroundColor, hexRgb(chosen.primary)),
            dotStyle.backgroundColor + " vs " + chosen.primary);
        check("primary paints the active row", sameColor(activeStyle.backgroundColor, hexRgb(chosen.primary)) &&
            Math.abs((rgb(activeStyle.backgroundColor) || {}).a - 0.2) < 0.02,
            activeStyle.backgroundColor);
        check("the surface and its accents are distinct, measured",
            measured.contrast.wordmarkOnSlab > 1 && measured.contrast.emphasisOnSlab > 1 &&
            measured.contrast.borderOnSlab > 1 && measured.contrast.pageDotOnSlab > 1,
            JSON.stringify(measured.contrast));

        // Two shipped pairs must render as different skins, not one palette under two names.
        var blueRoot = (function () {
            globalThis.OpenlockPopit.setPair("popit-blue");
            return getComputedStyle(rootPanel).backgroundColor;
        })();
        globalThis.OpenlockPopit.setPair("lbp1-yellow-fuchsia");
        check("different pairs paint different slabs, measured",
            !sameColor(blueRoot, getComputedStyle(rootPanel).backgroundColor),
            blueRoot + " vs " + getComputedStyle(rootPanel).backgroundColor);

        // Classic: the pair paint leaves, the scheme's own ink returns, the chosen pair survives.
        var schemeWordmark = wordmarkStyle.color;
        surface.querySelector(".PopitClassicChip").click();
        var classicRoot = getComputedStyle(rootPanel);
        var classicWordmark = getComputedStyle(surface.querySelector(".PopitWordmark"));
        var classicSlab = rgb(classicRoot.backgroundColor);
        check("Classic removes the pair class", pairClasses(surface).length === 0, pairClasses(surface).join(" "));
        // Classic is not an empty slab: the scheme's own `.PopitTray` rule takes the paint back.
        check("Classic returns the scheme slab paint",
            classicSlab && classicSlab.a === 1 && !sameColor(classicRoot.backgroundColor, hexRgb(chosen.secondary)),
            classicRoot.backgroundColor + " vs pair " + chosen.secondary);
        check("Classic returns the scheme's own ink", classicWordmark.color !== schemeWordmark,
            classicWordmark.color + " vs pair " + schemeWordmark);
        check("Classic keeps the chosen pair for the saved row",
            globalThis.OpenlockPopit.pair() === "lbp1-yellow-fuchsia",
            globalThis.OpenlockPopit.pair());
        check("Classic is reported to the shell", classicEvents[classicEvents.length - 1] === true,
            JSON.stringify(classicEvents));
        surface.querySelector(".PopitClassicChip").click();
        check("leaving Classic restores the pair paint", pairClasses(surface).length === 1);

        // Reduced motion, read from computed style on the shipped rules.
        globalThis.OpenlockPopit.openSection("goodies");
        var animatedChild = getComputedStyle(child);
        var animatedDurations = animatedChild.transitionDuration;
        var animatedRoot = getComputedStyle(rootPanel).transitionDuration;
        globalThis.OpenlockPopit.setReducedMotion(true);
        var reducedChild = getComputedStyle(child);
        var reducedRoot = getComputedStyle(rootPanel).transitionDuration;
        var reducedSurface = getComputedStyle(surface).transitionDuration;
        report.details.motion = {
            animatedChild: animatedDurations,
            animatedRoot: animatedRoot,
            reducedChild: reducedChild.transitionDuration,
            reducedRoot: reducedRoot,
            reducedSurface: reducedSurface
        };
        check("the non-reduced child declares a real transition",
            animatedDurations.indexOf("0.28s") >= 0 || animatedDurations.indexOf("0.22s") >= 0,
            animatedDurations);
        check("the non-reduced root declares a real transition", animatedRoot.indexOf("0.22s") >= 0, animatedRoot);
        check("setReducedMotion suppresses the child transition", reducedChild.transitionDuration === "0s",
            reducedChild.transitionDuration);
        check("setReducedMotion suppresses the root transition", reducedRoot === "0s", reducedRoot);
        check("setReducedMotion suppresses the surface transition", reducedSurface === "0s", reducedSurface);
        check("reduced motion keeps the child open and the root mounted",
            surface.classList.contains("ChildOpen") && surface.querySelector(".PopitRoot") === rootPanel);
        globalThis.OpenlockPopit.setReducedMotion(false);
        check("motion returns when reduced motion is cleared",
            getComputedStyle(child).transitionDuration.indexOf("0.28s") >= 0,
            getComputedStyle(child).transitionDuration);

        // The shell wiring: the snapshot and the load path must call the module's own grammar.
        var shellSource = await (await fetch("/clientaddon/panorama/scripts/openlock_shell.js", { cache: "no-store" })).text();
        check("the shell snapshot uses the module's profile encoder",
            /layoutSnapshot[\s\S]{0,4000}OpenlockPopit\.encodeProfile\(popitLayout\)/.test(shellSource));
        check("the shell load path uses the module's profile decoder",
            /normalizePopitLayout[\s\S]{0,600}OpenlockPopit\.decodeProfile\(input\)/.test(shellSource));
        check("the shell still passes the saved pair to the surface",
            /popitPair = popitLayout\.pair \|\| ""/.test(shellSource));
        check("the shell exposes a reduced-motion setter that reaches the module",
            /globalThis\.OpenlockSetPopitMotion = function[\s\S]{0,400}setReducedMotion\(popitReducedMotion\)/.test(shellSource));

        report.details.roundTrips = roundTrips;
        report.ok = report.failures.length === 0;
    } catch (error) {
        report.ok = false;
        report.failures.push("probe threw: " + (error && error.stack ? error.stack : String(error)));
    }

    document.getElementById("probe-output").textContent = JSON.stringify(report, null, 2);
    document.documentElement.dataset.probeDone = "1";
})();

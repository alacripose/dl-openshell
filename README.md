# Openlock UI Shell

Openlock is a **Panorama UI shell for Deadlock**: a window manager that runs over the live game,
frames the game's own HUD panels without reparenting them, and adds a launcher bar, taskbar,
toasts, a tools view and a small desktop-style workspace. The UI shell is the primary deliverable
and the release product. It mounts as a normal `pak01_dir.vpk` addon and does not require any
server-side plugin or custom game mode.

## What the shell does

- Draws windows declared in [shell/alpha-shell/package.shspec](shell/alpha-shell/package.shspec):
  geometry, titles, lanes, opacity, pins and elevation all come from the package.
- Frames live Deadlock panels (shop, map, minimap, abilities, combat log, escape menu and the
  rest) by tracking their real rect and moving them with a CSS transform. The panel stays in the
  game's tree, so the shop's parent assertion is never violated.
- Keeps a taskbar, pinned windows, a drop grid for moving and resizing, and toast notifications
  that can open the window they name.
- Exposes a Tools window fed by the install: live build stage and VPK size when the server bridge
  is connected, the last baked record otherwise, update state, tool presence and the mounted search
  paths, plus the generated refusals list. A small non-interactive strip shows the running stage.
- Mounts windows declared by Deadworks addon packages. A package is a real shploingus
  `SHPKG002`/`SHPKG003` frame (`.shpkg`), loose or inside a VPK; the frame's digest is checked
  before its `shploingus.recipe/3` source is read. Each window's title-bar controls are the
  package's own `layout`/`behavior` projection, including whether it may be pinned.
- Includes a console that opens any declared window or loads any Panorama layout present in the
  installed game, including layouts contributed by mounted addons.

## Install

### Release install

Download `install.ps1` from the [latest release](https://github.com/alacripose/dl-openshell/releases/latest),
put it in `game/bin/win64` beside `deadlock.exe`, close Deadlock, and run it. The release script
downloads `openlock-player.vpk`, verifies its published SHA-256, installs it under
`game/citadel/addons/mods`, and adds that directory to `SearchPaths`. It does not require a
checkout, Python, or the CSDK, and it never overwrites a `pak01_dir.vpk` owned by another mod
manager.

The public landing page is [the Pages site](https://alacripose.github.io/dl-openshell/). Release
assets are built locally because compiling Panorama needs the game's CSDK; see
[tools/build_release.ps1](tools/build_release.ps1).

### Build from a checkout

Requirements: Deadlock, Python 3, the CSDK `resourcecompiler.exe`, and `CSDKCfgVPK.exe`. The game
must be closed while the search path changes, because `gameinfo.gi` is read at launch.

```powershell
./install.ps1 -DeadlockRoot 'D:\SteamLibrary\steamapps\common\Deadlock'
```

The script first runs `tools/gen_shell_data.py` against the `gameinfo.gi` and VPKs of the install
it is targeting, so the layout catalog, game palette, tools and build record describe that game
copy rather than a developer's checkout. A minimal install simply produces a smaller catalog. It
then assembles `clientaddon/`, compiles the Panorama resources, packs
`dist/openlock_ui/pak01_dir.vpk`, installs it under `game/citadel/addons/mods`, and adds that
directory to the game's `SearchPaths`. It removes an older loose-file copy and old Openlock search
paths so exactly one source is mounted, while leaving other tools' addon folders alone.

On an interactive run the installer asks for a grade: `dev` keeps every Deadlock and Deadworks
addon and shell window available, `observer` hides the shell's own chrome and windows so a
recording only shows the game (XML surfaces sent by an addon or remote operator still appear in
the toast stack), and `player` keeps saved layout schemes and loads the saved geometry
automatically at startup. Pass `-Grade dev|observer|player` to skip the prompt, or `-NoUi` for a
non-interactive run. The chosen grade is written into the same build record the shell reads.

Launch Deadlock: the shell boots from `base_hud.xml` through
[clientaddon/standalone/panorama/scripts/openlock_boot.js](clientaddon/standalone/panorama/scripts/openlock_boot.js).
No server is needed.

### Packages from other git repositories

The installer can mount prebuilt Panorama packages from any git repository. A package keeps an
`openlock.package.json` at its root:

```json
{
  "id": "example-ui",
  "name": "Example UI",
  "version": "1.2.0",
  "kind": "panorama-vpk",
  "vpk": "dist/pak01_dir.vpk",
  "target": { "gameVersion": "6821", "sourceRevision": "11170534" }
}
```

```powershell
./install.ps1 -PackageRepo https://example.invalid/example-ui.git,https://example.invalid/another.git
```

The package is cloned under `openlock-packages/`, its prebuilt VPK is verified and copied to
`game/citadel/addons/mods/packages/<id>` and that directory joins Openlock's search paths.
The installer refuses an archive whose VPK magic is wrong, a path that escapes the checkout, or a
`target` that does not match this copy's `steam.inf`. Pass `-ForcePackage` only for a known-good
mismatch, and `-PackageRef <branch-or-tag>` to pin every package checkout. Openlock never runs a
package's scripts during install, and a package cannot write fonts or `gameinfo.gi`.

### Addon windows and controls

A Deadworks addon ships windows as real shploingus packages: `SHPKG002` frames with a
`shploingus.recipe/3` source, or `SHPKG003` frames with the package's own artifacts after it. Put
the `.shpkg` under the addon's search path or inside its VPK; the server reads both. It checks the
frame's payload digest, parses the recipe with the same 13-key window grammar the shell package
uses, and sends only packages with no refusals to the client.

A window's delivered XML layout is looked up as `panorama/layout/<window-id>.xml` (or
`<record-id>.xml`) in the VPK that carries the package. The resource path is the archive path
without its `panorama/` prefix, so `panorama/layout/my_panel.xml` becomes
`file://{resources}/layout/my_panel.xml`. A loose `.shpkg` is still read and its windows are
listed, but its artifacts are not a mounted Panorama resource; ship the package and its XML in a
VPK when the window must draw. A window with no delivered layout keeps its declared content kind;
one with a layout opens as `addon-layout` and mounts the XML with `BLoadLayout`. The layout's own
controls are the addon's, so the package does not need a second control grammar.

A package's windows declare their own title-bar controls through `layout` and `behavior`: `pin` is
offered only when `pinnable` is true; `minimize`, `maximize` and `close` are offered only when
`layout` names them behind `title-position`. The shell renders that list instead of assuming every
window has all four, and the context menu follows the same list. A package with a broken digest,
unknown content or lane, missing key, duplicate id or unusable geometry is refused by archive,
line and window; none of its windows are partially mounted.

### Observer XML surfaces

In `observer` grade the shell's own chrome is hidden, but a package XML can still be sent as a
toast. The server command `openlock_observer <window-id>` sends a loaded package window to every
connected shell; the shell mounts its XML in the toast stack. The layout receives the live shell
record on the `dw_observer_data` attribute of its host panel as `openlock.observer/1` JSON:
`build`, `update`, `packages`, `windows`, `connected` and `observedAt`. A layout can read that
attribute from its parent and render live stats, or keep its own controls for external links. The
shell's close affordance is outside the XML, so a delivered surface cannot trap the observer.
`OpenlockObserverData(id)` returns the same record from the shell script.

## Regenerate the package

The UI data and the colour schemes are generated; do not hand-edit the generated files.

The installer runs this automatically. To regenerate by hand for a specific install:

```powershell
python tools/gen_shell_data.py shell/alpha-shell clientaddon/panorama/scripts/openlock_shell_data.js 'D:\SteamLibrary\steamapps\common\Deadlock\game\citadel\gameinfo.gi'
```

This reads the package and the target install and writes
[clientaddon/panorama/scripts/openlock_shell_data.js](clientaddon/panorama/scripts/openlock_shell_data.js)
and [clientaddon/panorama/styles/openlock_schemes.css](clientaddon/panorama/styles/openlock_schemes.css).
The generator records the game build, layouts, tools, update record and live-panel catalog so the
Panorama client does not need filesystem or network access.

## Schemes and mod extensions

A scheme is a `.theme` file under [shell/alpha-shell/themes](shell/alpha-shell/themes). The
**Deadlock default** scheme is read from the running game's own `@define` table and carries no UI
overrides, so the native look is always available as an option. Alpha parchment and Holo Dark are
shipped alongside it.

A mounted mod can extend any base scheme by adding `panorama/schemes/<name>.theme` to its own
search path. Loose directories and VPK archives are both scanned. Tabs are shown as `\t`:

```text
shploingus.theme/1
theme\tmy-shop-theme
\tlabel\tMy shop
\textends\tholo
\tload-order\t120
\tpanel\t#101820
\trule\t.CitadelHudHeroShop\tborder-color\trole:borderStrong
```

Extensions apply in `load-order` order, lowest first and last writer wins. A rule may target a
shell element (`.WindowTitle`) or a real Deadlock element (`.CitadelHudHeroShop`); hex,
`@defineName` and `role:<slot>` values are accepted. Selectors and properties are allowlisted, so
a theme can only paint colours and opacity, never load a resource, move a window or hide a
control.

The active scheme class is placed on both the shell root and the game HUD root. Selecting
Deadlock default removes every scheme class and restores the game's own appearance.

## Verification

The shell is exercised through `install.ps1` and a real Deadlock launch. The package
records what has actually run in [openlock.manifest.json](openlock.manifest.json); do not treat a
generated file or a successful pack as proof that the UI drew.

## Known limits

- Live panels are framed, not adopted. A panel the game has not built yet shows a "not on screen"
  state and binds when it appears. The shell reads the game's own panel tree for the catalog; it
  does not bake a panel list from the build machine's game version.
- A drag reads the pointer through `GameUI`/`$` where the shipping client exposes it. If a build
  does not expose either, the drag is refused with a toast instead of falling back to the grid.
- Scheme rules target the selectors a theme names. The game's own defaults are preserved only
  while the active scheme has no rule for that element.

## Files

- [install.ps1](install.ps1) — compile, pack and mount the UI addon.
- [clientaddon/panorama/layout/openlock_shell.xml](clientaddon/panorama/layout/openlock_shell.xml) — shell layout.
- [clientaddon/panorama/scripts/openlock_shell.js](clientaddon/panorama/scripts/openlock_shell.js) — window manager, live-panel hooks, schemes, toasts, tools.
- [clientaddon/panorama/styles/openlock_shell.css](clientaddon/panorama/styles/openlock_shell.css) — layout and base chrome.
- [shell/alpha-shell/](shell/alpha-shell/) — the display package that declares every window.
- [tools/gen_shell_data.py](tools/gen_shell_data.py) — package/data generator.
- [tools/gen_shell_theme.py](tools/gen_shell_theme.py) — scheme and mod-extension generator.
- [tools/vpk_read.py](tools/vpk_read.py) — VPK reader used by the generators.

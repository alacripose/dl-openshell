# MOTD demo addon

A copyable Deadworks addon for dl-openshell: one `shploingus.recipe/3` package that declares a
**Server MOTD** window, plus the Panorama XML and CSS that draw it. It uses the package frame and
loader dl-openshell already ships; there is no second manifest, no separate window format, and no
client script.

## What is in the example

| File | Purpose |
| --- | --- |
| `package.shspec` | The recipe: package id `motd-demo`, one window `motd-panel`, its title-bar controls and geometry. |
| `panorama/layout/motd-panel.xml` | The layout, with one line per non-empty MOTD line. |
| `panorama/styles/motd.css` | The shell palette for the surface. |
| `motd.txt` | The server message baked into the layout by the build. |
| `build.py` / `build.ps1` | Compile the XML/CSS, write the `SHPKG003` frame, pack the VPK, and install it. |

## Build and install

Requirements: the game with its CSDK `resourcecompiler.exe` and `CSDKCfgVPK.exe`, plus Python 3.
The default paths match this checkout; pass `-Game` / `-Sdk` or `--game` / `--sdk` for another
machine.

```powershell
cd examples\motd-addon
.\build.ps1
```

The build:

1. reads `motd.txt` and bakes its non-empty lines into `panorama/layout/motd-panel.xml`;
2. compiles the layout and stylesheet into `.vxml_c` / `.vcss_c`;
3. writes `dist/motd_demo/motd.shpkg` as a real `SHPKG003` frame: magic, recipe length, recipe
   SHA-256, recipe, then the artifact table carrying both source and compiled resources;
4. packs `dist/motd_demo/motd-demo.vpk` (under the repository root) with the package and the
   compiled resources at the `panorama/layout/` and `panorama/styles/` paths the loader checks;
5. copies the VPK to `game/citadel/deadworks_addons/vpks/motd-demo.vpk`.

Use `--no-install` / `-NoInstall` to stop after the VPK. Edit `motd.txt` (or pass `--motd` to
another file) and rebuild to change the message. The message is a build-time snapshot of the
server's text; this demo does not read a live file from the game client.

## Open it

Open the shell's **Mods** view and choose **Open Server MOTD** under the mounted packages, or run:

```text
addon:motd-demo:motd-panel
```

from the shell console. In observer grade the same package can be sent as a toast:

```text
openlock_observer addon:motd-demo:motd-panel
```

The window's controls come from the recipe, not from the XML: `pinnable=true` plus
`layout=title-position,minimize,maximize,close` projects Pin, Minimize, Maximize and Close, and
`behavior=drag,resize,minimize,maximize,close` lets the shell honour them.

## Deliver it live

A client that is already in the game cannot mount a new VPK resource path. The same package can
be delivered through the server instead:

```text
dl_openshell_deliver dist/motd_demo/motd-demo.vpk
```

`AddonPackages.Deliver` verifies the frame, reads the source XML and CSS, and publishes the window
with a `liveTree` in `openlock.addons/2`. The shell builds that tree with `$.CreatePanel` in the
window body, so it appears without a reconnect and every control keeps its own pointer surface.
A loose `.shpkg` works too; it has no mounted `layoutPath`, which is exactly the live case. The
root `dist/` path is relative to the repository checkout.

## Why the XML is a tree

The mounted path still exists for packages that ship only compiled resources, but it is no longer
the path this example relies on. The shell's original addon renderer was a client-side DOM tree,
which is why its windows could be clicked; the package port must keep that behaviour. `LayoutTree`
parses the XML, folds the included CSS class rules onto each node, and the client creates the
panels explicitly. Labels and images are pointer-transparent, panels and buttons are hit-testable,
and the window chrome above them is unchanged.

## Package shape

The frame is the real shploingus format:

- eight-byte magic `SHPKG003`;
- little-endian `uint32` recipe byte length;
- 32-byte SHA-256 of the recipe;
- the UTF-8 `shploingus.recipe/3` source, LF lines and a final newline;
- little-endian `uint32` artifact count;
- for each artifact: `uint16` path length, path, `uint32` byte length, bytes.

The VPK's entry names are what matter to the shell: `motd.shpkg` is discovered by the addon
loader, and `panorama/layout/motd-panel.vxml_c` is the resource the window's `layoutPath` resolves
to. Keep both in the same archive.

# MOTD demo addon

A copyable Deadworks addon for dl-openshell: one canonical `secure-shell.package/<32 hex>` directory
whose payload is a `secure-shell.surface/<32 hex>` declaration for a **Server MOTD** window, plus
the Panorama XML
and CSS used by the mounted-layout path. There is no `SHPKG` frame, no second magic, and no client
script.

## What is in the example

| File | Purpose |
| --- | --- |
| `package.surface` | The modern declaration: surface id `motd-demo`, one window `motd-panel`, its title-bar controls and geometry. |
| `panorama/layout/motd-panel.xml` | The layout, with one line per non-empty MOTD line. |
| `panorama/styles/motd.css` | The shell palette for the surface. |
| `motd.txt` | The server message baked into the layout by the build. |
| `build.py` / `build.ps1` | Compile the XML/CSS, pack the modern `.pkg` directory, build the VPK, and install them. |

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
3. packs `dist/motd_demo/motd-demo.pkg` through `tools/modern_package.py`: canonical
   `manifest.json` + `payload.bin`, BLAKE3 identity, and the `secure-shell.surface/<32 hex>` payload;
4. packs `dist/motd_demo/motd-demo.vpk` with the compiled layout and stylesheet for the mounted
   resource path;
5. copies the `.pkg` directory and the VPK to `game/citadel/deadworks_addons/vpks/`.

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

The window's controls come from the surface, not from the XML: `pinnable=true` plus
`chrome=minimize,maximize,close` projects Pin, Minimize, Maximize and Close, and
`moves=drag,resize` lets the shell honour them.

## Deliver it live

A client that is already in the game cannot mount a new VPK resource path. The same package can
be delivered through the server instead:

```text
dl_openshell_deliver dist/motd_demo/motd-demo.pkg
```

`AddonPackages.Deliver` verifies the canonical package, parses the `secure-shell.surface/<32 hex>` payload,
and publishes the window with a `liveTree` built from the surface nodes in `openlock.addons/a5d7cf25e0a40c0a06b836992556491d`.
The shell builds that tree with `$.CreatePanel` in the window body, so it appears without a
reconnect and every control keeps its own pointer surface. The root `dist/` path is relative to
the repository checkout.

## Why the XML is a tree

The mounted path still exists for packages that ship only compiled resources, but it is no longer
the path this example relies on. The shell's original addon renderer was a client-side DOM tree,
which is why its windows could be clicked; the package port must keep that behaviour. `LayoutTree`
parses the XML, folds the included CSS class rules onto each node, and the client creates the
panels explicitly. Labels and images are pointer-transparent, panels and buttons are hit-testable,
and the window chrome above them is unchanged.

## Package shape

The package is the modern object, not a frame:

- `manifest.json` — canonical JSON: `name=motd-demo`, `revision=1`, schemas
  `secure-shell.package/ff53bde81a9e26562c739676fff7d28e` and
  `secure-shell.surface/7af4f34e745ebf547b3fc71146ef314c`, entry point `surface`;
- `payload.bin` — the UTF-8 `secure-shell.surface/7af4f34e745ebf547b3fc71146ef314c` document
  from `package.surface`;
- `identity.txt` — `motd-demo@1+blake3:<64 hex>`.

The surface document is the window declaration: header, `surface`, `requires`, then `window`,
`node` and `action` rows. The addon loader discovers a directory named `*.pkg`; the VPK's
`panorama/layout/motd-panel.vxml_c` remains the mounted-layout resource for a package that also
carries compiled resources. Keep the `.pkg` directory loose: VPK entries are 32-bit and are not
the carrier for a modern package.

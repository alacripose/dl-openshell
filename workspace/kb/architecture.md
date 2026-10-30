# Architecture — dl-openshell (Openlock shell)

## What the system is

A Deadlock (Citadel / Source 2 Panorama) client-and-server mod that replaces the stock HUD and
dashboard with a window-managed desktop shell, plus the toolchain that builds, packs, installs and
audits it. Three artefacts ship from one repository:

1. **Game plugin** (`src/Openlock`, C#, `Openlock.dll`) — runs inside the game's mod host. It
   loads the shell package and layout profiles from disk, publishes UI state to players as panel
   attributes, and answers console commands.
2. **Panorama client addon** (`clientaddon/panorama`) — XML layout, CSS and JavaScript. Loaded by
   the game from a `citadel/addons` search path. Owns every pixel: window chrome, taskbar, live
   panel framing, PopIt menus, package-driven addon windows.
3. **Installer and build toolchain** (`install.ps1`, `release/install.ps1`, `tools/*`) — PowerShell
   installers that write into a game tree, and Python/PowerShell tools that generate shell data,
   themes, audio events, VPK archives, release checksums and parity evidence.

## Runtime topology

```
┌────────────────────────────── game process ──────────────────────────────┐
│  Openlock.dll (server/mod host)                                          │
│    ShellPackage  ← shell/alpha-shell/*  (recipe, cells, frames, windows)  │
│    LayoutProfiles← <game>/.../layouts/*.layout.json                      │
│    AddonPackages ← <game>/citadel/addons/**/*.shpkg | *.vpk              │
│    ShellMount    ── UI.Panel("openlock-shell").Set(recipients, key, val) │
│                          │ attributes: layout, addons, build, update,    │
│                          │ observer, paths, active, view                 │
│                          ▼                                               │
│  Panorama client (openlock_shell.js and friends), sandboxed:             │
│    no filesystem, no network, no eval; strings + panel tree only        │
└──────────────────────────────────────────────────────────────────────────┘
```

The attribute channel is the only runtime path from plugin to client. The plugin runs where the
game runs; on a listen server that is the player's own machine, on a hosted server it is the
server operator's. A client joined to a third-party server therefore receives that server's
attribute values.

## Data flows

| # | Flow | Producer | Consumer | Carrier |
|---|------|----------|----------|---------|
| F1 | Shell definition (recipe, cells, frames, declared windows) | `shell/alpha-shell/*` on disk | `ShellPackage` | file reads at plugin init |
| F2 | Layout arrangement (window rects, active tab, pinned/minimized, PopIt) | `<game>/…/layouts/*.layout.json` | `LayoutProfiles` | file read; JSON |
| F3 | Addon window sets and trees | `.shpkg` / `.vpk` found in addon search paths | `ShpPackage`, `VpkReader`, `AddonPackages` | file / archive reads |
| F4 | Published UI payloads | `ShellMount` | client shell | `UI.Panel(...).Set(recipients, key, json)` |
| F5 | Client render of addon trees | `openlock_delivery.js` | Panorama panel tree | `JSON.parse` + allowlisted `$.CreatePanel` |
| F6 | Console commands | player / server console | `OpenlockPlugin` command handlers | Citadel console |
| F7 | Layout save / load / export | client gesture → console command | `LayoutProfiles` | JSON files under `layouts/` |
| F8 | Release archive + checksum | `tools/build_release.ps1` → GitHub release | `release/install.ps1` | HTTPS download |
| F9 | Installed addon + SearchPaths mount | `release/install.ps1` | the game at launch | file copy + `gameinfo.gi` edit |
| F10 | Dev build and install | `install.ps1` | tools host / game tree | `git pull`, resourcecompiler, VPK pack, copy |
| F11 | Installer pair seeding | `tools/installer_pair.py --apply` | compatible install trees | file write of `install.ps1` + `install.cmd` |
| F12 | Parity evidence | `tools/parity_check.py`, `tools/axis_witness.py`, sandbox suites | operator | JSON + HTML reports |

## Process and privilege boundaries

- **Game process** holds the player's filesystem rights. Any path it reads is reachable by whatever
  can write that path: the player, another mod, or a downloaded addon.
- **Panorama JS** is sandboxed — no filesystem, no network, no `eval`. Its risk surface is the panel
  tree, string length, and CPU time inside a frame.
- **`install.ps1`** runs with the invoking user's authority, may `git pull --ff-only`, invokes
  `resourcecompiler.exe`, Python and the VPK packer, and deletes/creates directories under the game
  tree and a build directory.
- **`release/install.ps1`** runs with the player's authority, downloads from a configurable release
  repo, verifies SHA-256, copies a VPK into `citadel/addons/mods`, and edits `gameinfo.gi` (backing
  it up first).
- **`tools/*.py`** run on the developer machine; they read and write the working tree and report
  evidence, and `parity_check.py` additionally audits installed trees that its own discovery finds.

## Deployment model

- **Dev / tools host**: a reduced CSDK tools client (`Reduced_CSDK_10`, `Reduced_CSDK_12`, Steam
  `app_1422450` depot). `install.ps1` builds and installs into it; the plugin and addon load from
  `game/bin/win64/managed/plugins` and `game/citadel/addons`.
- **Live game client**: the release path. `build_release.ps1` emits `openshell-player.vpk` plus
  `openshell-player.sha256`; players run `release/install.ps1`, which installs into
  `citadel/addons/mods` and adds that directory to `SearchPaths`.
- **Server**: the plugin can be mounted server-side; client addon files are distributed separately.

## Build chain

```
shell/alpha-shell/*  ──gen_shell_data.py──▶  clientaddon/panorama/scripts/openlock_shell_data.js
clientaddon/panorama/*  ──resourcecompiler──▶  compiled panorama + VPK
tools/gen_shell_theme.py, gen_shell_audio.py, gen_legacy_shell.py ──▶ generated assets
tools/pack_vpk.py ──▶ pak01_dir.vpk (+ numbered shards)
tools/build_release.ps1 ──▶ openshell-player.vpk + openshell-player.sha256
```

`tools/parity_check.py` and the shell test surface (`tools/shell_test_surface.py`,
`tools/shell_sandbox_surface.py`, the Go shell port) exist to prove that what is in the worktree is
what is installed, and that the client source actually renders and clicks.

## Known structural constraints

- Panorama has no `eval`, no filesystem and no fetch; untrusted data can only become strings,
  attributes and panel nodes.
- Panel attributes are strings; JSON is the only structured carrier.
- The reduced CSDK 10 client loads a different layout root and needs a separate mount script
  (`openlock_boot_csdk10.js`); the live mount must not inherit those workarounds.
- A discovered (game-owned) window's panel id can be rewritten by the MOD between reloads, which is
  why split cells key off a durable identity rather than the raw id.
- `tools/parity_check.py` treats a drifting dev install as a refusal, so a build that is not
  reinstalled fails the gate rather than silently ageing.

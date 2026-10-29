# Release assets

Every release publishes exactly these files:

| Asset | Purpose |
| --- | --- |
| `install.cmd` | Double-click launcher. Starts `install.ps1` with a process-scoped execution-policy bypass. |
| `install.ps1` | Standalone installer. Drop it in `game/bin/win64` beside `deadlock.exe` and run it. |
| `openshell-player.vpk` | Verified Panorama archive, built in player grade. |
| `openshell-player.sha256` | SHA-256 of `openshell-player.vpk`; the installer refuses a mismatch. |
| `LICENSE` | MIT license for the release. |

Windows marks downloaded `.ps1` files, and the default `RemoteSigned` policy refuses to run them
before the first line. `install.cmd` applies `-ExecutionPolicy Bypass` for its child process only;
it is not a machine-wide policy change. Running `install.ps1` directly requires right-click →
Properties → Unblock first.

When `openshell-player.vpk` and `openshell-player.sha256` sit beside the installer, it verifies and
installs those files instead of downloading; a complete release drop works offline.

The installer writes the archive to `game/citadel/addons/mods/pak01_dir.vpk` and adds
`Game citadel/addons/mods` to `game/citadel/gameinfo.gi`. It does not install into
`citadel/addons/openlock_ui` or overwrite a VPK owned by a mod manager.

## Build

The client and CSDK are required, so the binary is built on a machine with Deadlock installed:

```powershell
./tools/build_release.ps1 -DeadlockRoot 'D:\SteamLibrary\steamapps\common\Deadlock'
```

The script runs `install.ps1 -Grade player`, copies the resulting `dist/openlock_ui/pak01_dir.vpk`
to `release/openshell-player.vpk`, and writes the checksum. It prints the `gh release create`
command but does not upload.

The release workflow only deploys `landing/` to GitHub Pages. GitHub-hosted runners cannot compile
Deadlock Panorama resources without the game, so publishing the VPK remains an explicit local step.

## MIT

The project is MIT licensed; the release page and repository must include [LICENSE](../LICENSE).

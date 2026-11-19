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
`citadel/addons/openlock_ui` or touch another addon folder, but it does replace the
`pak01_dir.vpk` at that path if one exists; move another manager's archive at that filename aside
first.

## Design contract

The release surface follows the family register in
[`openlock_modern/docs/design/`](../../openlock_modern/docs/design/): the landing page uses the
web-dark role names and the 20x20 square-in-square mark, and the installed shell uses the active
Panorama scheme as its medium role map. The shell window radius ceiling is 8 px, and a corner grip
has a 24 dp pointer target. No person has witnessed the running build's landing or shell render, so
both stay `not-implemented`. The adoption record and measured contrast are in
[docs/UI-PASS.md](../docs/UI-PASS.md) §8.

A landing-only edit does not change the player archive. Rebuild it when the shell source changes:
the landing publishes from `landing/`, while the VPK compiles locally.

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

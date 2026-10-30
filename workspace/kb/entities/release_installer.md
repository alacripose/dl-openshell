# Entity — Release installer (`release/install.ps1`)

**Availability tier:** LOW_CRITICALITY (one-shot install action; failure blocks a feature, not a
service).

## Purpose

Player-facing installer: finds a Deadlock install, obtains a player VPK, verifies it, installs it
into `citadel/addons/mods`, and adds that directory to `gameinfo.gi` `SearchPaths`.

## Trust role

Executes with the player's authority and writes into the game install. It is the only component on
the release path that *creates* the client-visible addon, so it decides what the game will load.

## Inputs

- Parameters: `-DeadlockRoot`, `-VpkPath`, `-HashPath`, `-ReleaseRepo`, `-ReleaseBase`,
  `-ReleaseTag`, `-Grade`, `-NoUi`.
- Local files beside the script: `openshell-player.vpk`, `openshell-player.sha256`.
- Otherwise remote assets from a GitHub release URL (`https://github.com/<ReleaseRepo>/releases/...`).

## Outputs

- `<game>/citadel/addons/mods/pak01_dir.vpk` (copy, then re-hashed and re-parsed).
- `gameinfo.gi` edited to carry the addon search path; prior file copied to
  `gameinfo.openlock-bak` if no backup exists.
- Shell UI progress events and console output.

## Controls observed in the KB

- Refuses while `deadlock`/`project8` is running (SearchPaths is read at launch).
- Requires `gameinfo.gi` to exist before touching anything.
- Download retries with backoff, deletes a partial file before each attempt, and refuses rather than
  installing an unverified archive.
- Requires a 64-hex SHA-256 from the checksum asset, compares it to the downloaded file, then
  re-hashes the installed copy and re-parses the VPK tree (`Test-VpkArchive`).
- Both the archive and the checksum come from the same configurable origin; the checksum is an
  integrity check, not a signature or an authenticity anchor.
- `-ReleaseBase`/`-ReleaseRepo` let the caller redirect the source; defaults are the project's own
  GitHub release.

## Constraints

- Must stay a double-click path: no mandatory parameters, no admin requirement.
- VPK parsing here is a local structural check (tree bounds, entry count), not a full parser.

# Entity — Addon discovery and mount (`src/Openlock/Shell/AddonPackages.cs`)

**Availability tier:** STANDARD (the shell's addon windows disappear if discovery fails; the game
keeps running).

## Purpose

Walks the configured and discovered addon roots for `*.shpkg` and `*.vpk`, parses every package it
finds, merges their window sets into one payload, and delivers a single package on demand
(`Deliver`, used by the console command path).

## Trust role

Decides *which* third-party files become client UI. Roots include `citadel/addons`, `addons/mods`,
`deadworks_addons/vpks` and `deadworks_mods` — directories other mods and downloaded addons also
write to.

## Inputs

- `OpenlockConfig.ClientAddonPaths` (user config), game search paths from `gameinfo.gi`, and four
  fixed game-relative addon directories.
- Package bytes from disk or from VPK entries.

## Outputs

- A `PayloadJson()` document (`openlock.addons/2`) with packages, window records and budgets.
- Refusal records per package (`result.Refuse(label, source, why)`).
- A revision counter that advances on every accepted change.

## Controls observed in the KB

- Case-insensitive de-duplication of roots, archives and entries (`seenRoots`, `seenArchives`).
- Packet size ceiling per package before parsing (`MaxPackageBytes`).
- Missing directory or unreadable package is a refusal row, not a crash.
- Payload budget: a candidate payload over `MaxPayloadChars` (4 MiB) is refused and the prior
  revision stays mounted.
- A refused v2 package leaves v1 mounted (atomic replacement).

## Constraints

- Discovery must find the shipped addon in its packed form (`pak01_dir.vpk`), so it reads the
  archive index instead of guessing from file names.
- Package identity is name+version; equal versions with different content are the client's
  revision/idempotency problem, not discovery's.

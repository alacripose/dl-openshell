# Entity — Client addon resolver (`src/Openlock/Shell/ClientAddons.cs`)

**Availability tier:** LOW_CRITICALITY.

## Purpose

Resolves the game directory, the configured addon paths, and the game's own `Game`/`addonroot`
search paths from `gameinfo.gi`, then reports which roots carry `openlock_shell`/`openlock_hud`
layouts (loose or packed).

## Trust role

Decides the *roots* that discovery is allowed to read. The game directory comes from an environment
variable or a path relative to the plugin binary; configured paths may be absolute.

## Inputs

- `OPENLOCK_GAME_DIR` (explicit override) or `AppContext.BaseDirectory/../..`.
- `OpenlockConfig.ClientAddonPaths`.
- `citadel/gameinfo.gi` search-path block.

## Outputs

- Ordered root list with source labels (`config`, `gameinfo:<root>`, fixed addon dirs).
- `ReportLines` used by the shell's `paths` view.
- Log lines naming every refused path and why.

## Controls observed in the KB

- A configured path that cannot be resolved is refused and logged, not skipped silently.
- `gameinfo.gi` parsing is line-oriented with comment stripping and brace-depth tracking; it does
  not execute anything from the file.
- `HasLayout` checks both loose files and `*_dir.vpk` archive indexes.
- Paths are normalized with `Path.GetFullPath` before comparison.

## Constraints

- Must tolerate a game tree with no `gameinfo.gi` (yields nothing, logs a refusal).
- Must not require write access.

# Entity — Client shell UI (`clientaddon/panorama/scripts/*`)

**Availability tier:** STANDARD (the shell is the product; the game runs without it).

## Purpose

Draws and drives the desktop: taskbar, window chrome, live-panel framing, drag/resize, PopIt menus,
layout application, split cells, audio cues and the CSDK 10 / live / server mounts.

## Trust role

Consumes every published attribute (F4) and every addon payload (F5). It also observes live game
panels by walking the Panorama tree (`$.GetContextPanel`, `FindChildTraverse`, attributes/classes).
It holds no filesystem or network capability.

## Inputs

- Host attributes: `dwv_addons`, `dwv_layout`, `dwv_build`, `dwv_update`, `dwv_observer`,
  `dwv_paths`, `dwv_active`, `dwv_view`, plus `dw_layout`/`dw_addons` variants read by `host.field`.
- The live Panorama tree (game panels, their ids and classes).
- Player pointer input (mouse events + a pointer poll for drags).
- `openlock_shell_data.js` — generated, repository-shipped data.

## Outputs

- Panel tree mutations (window layer, panel layer, taskbar).
- Console commands via `$.DispatchEvent("CitadelConCommand", "dw_ui openlock-shell|…")` for layout
  save/load/export and collapse/open.
- Audio events, log lines, observer notices.

## Controls observed in the KB

- Shell is pointer-driven by design: rows/buttons are plain panels with `onmouseactivate`, so the
  game's own focus/gamepad graph is never extended.
- Drag polling is bounded and only runs while a drag is active; discovery/walk work is scheduled
  across ticks with a budget.
- Game panels are not reparented; frames track rects and use transforms.
- Refusals are surfaced (split refusal, delivery refusal) rather than silent no-ops.

## Constraints

- CSDK 10 uses a different layout root and a separate mount script; the live mount must not inherit
  that workaround.
- A discovered window's raw panel id can be rewritten by the MOD between reloads, so anything keyed
  to it must resolve through a pinned identity.
- Every attribute is a string; numeric/geometry parsing must fail closed.

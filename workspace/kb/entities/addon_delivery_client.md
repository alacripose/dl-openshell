# Entity — Client addon delivery (`clientaddon/panorama/scripts/openlock_delivery.js`)

**Availability tier:** STANDARD (addon windows; a refused payload leaves prior windows mounted).

## Purpose

Consumes the `addons` attribute payload, validates it, and renders package-declared panel trees
into the shell's window layer on scheduled ticks with a per-frame time budget.

## Trust role

**Primary untrusted-input consumer.** On a third-party server the payload is authored by the server
operator, not the player. It is the boundary where remote data becomes DOM.

## Inputs

- `raw` JSON string from the host attribute (`dwv_addons`), max 4 MiB.
- Package records, window records, `liveTree` node lists.

## Outputs

- Panorama panels created via `$.CreatePanel`, with allowlisted tags, styles and attributes.
- Refusal records surfaced as shell notifications and `$.Msg` lines.
- A rendered window per `addon:`-prefixed id.

## Controls observed in the KB

- Payload must be ≤ 4 MiB and `format === "openlock.addons/2"`.
- Revision monotonicity: a lower revision is ignored as stale; an equal revision with different
  content is refused.
- Package versions may not go backwards for an already-mounted name.
- Every window id must start with `addon:` and name a delivered package; duplicate ids refused.
- Node list validated before rendering: ≤ 512 nodes, depth ≤ 24, arrays/objects type-checked.
- Tag allowlist (`Panel`, `Label`, `Image`, `TextEntry`, `ProgressBar`, `Slider`, `DropDown`);
  anything else becomes `Panel`.
- Style values containing `url(` are dropped; attributes are copied one-by-one from an allowlist
  (`placeholder`, `multiline`, `maxchars`, `html`, `src`, `value`, `enabled`, `visible`,
  `selected`, `tooltip_text`).
- Rendering is chunked (`64` nodes / `5 ms` per tick) so a large tree cannot stall the frame.

## Constraints

- No `eval`, no fetch, no filesystem in Panorama; the only capability granted to a node is the
  panel API.
- Refusal must not unmount a working previous payload.

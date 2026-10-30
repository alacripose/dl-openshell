# Entity — Layout profile store (`src/Openlock/Shell/LayoutProfiles.cs`)

**Availability tier:** LOW_CRITICALITY (losing a profile loses an arrangement, not playability).

## Purpose

Persists per-scheme window arrangements (`<scheme>.layout.json`) under the plugins' `layouts`
directory, parses `scheme@id,x,y,w,h@…` console arguments, and exports/copies a profile out.

## Trust role

Writes files whose path is derived from a player-supplied scheme string, and reads JSON back into
geometry that the client applies.

## Inputs

- Scheme strings from console commands and the UI.
- Existing `*.layout.json` files.
- Snapshot rows (`active=`, `tab=`, `pin=`, `min=`).

## Outputs

- `*.layout.json` files written atomically (temp file + replace).
- `PayloadJson(notice)` for the `layout` attribute.
- Exported copies under `layouts/exports/`.

## Controls observed in the KB

- `IsValidScheme` uses a compiled `SchemePattern`; `PathFor` re-checks and then verifies the
  resolved path is still inside the layouts directory (`StartsWith(root + separator)`), returning an
  empty string otherwise.
- Invalid scheme is refused before a read or write.
- Writes go through a temp file and `File.Move(overwrite: true)`.
- Export refuses to overwrite an existing destination (`overwrite: false`).

## Constraints

- Unknown window ids are shape-valid on purpose: the client owns which windows exist and ignores
  rows it no longer knows.
- JSON deserialization must degrade to defaults rather than throw into the game thread.

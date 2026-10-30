# Entity — Package frame parser (`src/Openlock/Shell/ShpPackage.cs`)

**Availability tier:** LOW_CRITICALITY (a refused package degrades the shell, not the game).

## Purpose

Parses `.shpkg` frames: a `SHPKG002` source frame (declared windows, tabs, pins, bar) or a
`SHPKG003` artifact frame (the same recipe plus a path→bytes table), and validates the recipe text.

## Trust role

First component to touch attacker-supplied bytes: any `.shpkg` dropped in an addon directory, or a
package embedded in a VPK authored elsewhere. Everything downstream trusts its `Rows`, `Windows`,
`Artifacts` and refusal list.

## Inputs

- A byte array from `File.ReadAllBytes`, or an entry extracted by `VpkReader`.
- Ceilings: recipe bytes, artifact count, artifact path length, artifact bytes.

## Outputs

- Records: `Rows`, `Windows` (id, title, lane, geometry, candidates), `Layers`, `Pins`, `Tabs`,
  `Bar`, `Filed`, `Artifacts`, `Refusals`.
- `SourceDigest` (SHA-256 of the payload) and `PackageDigest` (SHA-256 of the frame).

## Controls observed in the KB

- Magic must be exactly `SHPKG002`/`SHPKG003`.
- Declared payload length bounded and checked against the actual frame before slicing.
- Payload SHA-256 compared in constant time with the digest the frame declares.
- UTF-8 decoding with a decoder that rejects invalid sequences, caught as a refusal.
- 002 frames must not carry trailing bytes; 003 artifact tables must end exactly at the frame end;
  duplicate artifact paths refused.
- Artifact path must be package-relative: no leading `/`, no `\`, no empty/`.`/`..` segments.
- Any structural error becomes a `Refusal` record, never an exception escaping `LoadFile`.

## Constraints

- No filesystem writes; it parses bytes into records only.
- Refusal text is operator-facing and names file, line and reason.

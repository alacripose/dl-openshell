# Entity — Panorama layout tree reader (`src/Openlock/Shell/LayoutTree.cs`)

**Availability tier:** LOW_CRITICALITY.

## Purpose

Parses Panorama XML layout files into a node tree so the plugin can answer questions about a
layout (which panels exist, their ids/classes) without the client.

## Trust role

Parses XML that may come from an addon directory — i.e. third-party-authored text. XML has no code
execution on this path, but malformed or hostile nesting is still attacker input.

## Inputs

- XML file text from a layout file.

## Outputs

- A node tree with tag, id, classes and attributes.

## Controls observed in the KB

- Reads with an XML reader over a string; failures surface as a refusal/empty tree rather than an
  unhandled exception in the game thread.
- No entity expansion or external entity resolution is configured; content is treated as markup.

## Constraints

- Must stay tolerant of CSDK-version differences in layout roots.
- Never writes files.

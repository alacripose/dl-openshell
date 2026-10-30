# Entity — VPK reader (`src/Openlock/Shell/VpkReader.cs`)

**Availability tier:** LOW_CRITICALITY.

## Purpose

Reads Source 2 VPK directory indexes well enough to list entry paths and extract one entry, plus
locating numbered shards beside a `_dir.vpk`.

## Trust role

Second parser of file-author-controlled bytes. Used both for game addon archives and for the
release player VPK's structural check (`Test-VpkArchive` in PowerShell is a separate reader with
the same job).

## Inputs

- A `.vpk` path, or the archive bytes for a single entry.
- Archive headers: magic, version, tree size, section sizes.

## Outputs

- Entry path list (case-insensitive comparisons downstream) and entry bytes.
- Continuation paths for numbered shards.

## Controls observed in the KB

- `TryEntries` returns `false` with a named error rather than throwing; callers refuse the archive.
- Paths are resolved against a `Path.GetFullPath` base and shard names are computed from the
  archive name, not from an entry-supplied path.
- Callers cap extracted package size and treat unreadable indexes as a refusal only when the
  archive looks like a package archive.

## Constraints

- Read-only.
- Must stay tolerant of unrelated VPKs in the addon directories (e.g. official addon paks).

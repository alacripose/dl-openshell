# Entity — Installer pair seeder (`tools/installer_pair.py`)

**Availability tier:** LOW_CRITICALITY (operator tool).

## Purpose

Reads the installer pair (`install.ps1` + `install.cmd`) in every compatible install tree the
machine's own discovery knows about, and seeds a fresh pair into a tree on explicit consent.

## Trust role

Writes an executable PowerShell installer into directories it discovers. It is the component that
can turn "some install on this machine" into "an install that will run this repository's
installer next time".

## Inputs

- `PATH`-pattern discovery of tools trees and game installs (`list_installs.py` style patterns).
- `--root` extras, `--apply <tree>…` for explicit seeding, `--check`, `--json`.
- The canonical pair files in the repository.

## Outputs

- `install.ps1` and `install.cmd` written into `<tree>/game/bin/win64` via `.new` staging + atomic
  replace.
- A reading (state `absent|partial|current|stale`, compatibility, hash prefix).

## Controls observed in the KB

- Refuses to seed a tree that is not `compatible`; returns the named reason.
- Refuses when the target directory is missing.
- Stages to `<name>.new` and replaces atomically; cleans up a leftover staging file.
- `--check` exits non-zero when any seeded pair is stale, so a drift is a gate failure.

## Constraints

- Compatibility is decided by tree shape and grade, not by user identity.
- Discovery is bounded to known patterns; it does not walk the whole filesystem.

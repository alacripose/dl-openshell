# Project rules

## Test verification

A CML/Panorama test that cannot be run in the game must be verified in a visual shell
surface before it is reported as passing.

- Use `tools/shell_test_surface.py` to run the suites and write
  `docs/shell-test-surface.html`.
- Open that page in the user's browser and check every suite card. The page is the
  browser witness: command, exit status, check count and the refusal cards for anything
  that was not observed.
- The alternative surface is the Go shell port at
  `C:\Users\ala\Documents\agent_god_files\holo_shell` (`-selftest`), using this
  project's shell surface and test API.
- Headless Node output alone is not a passing verification. A test with no browser or
  Go-shell witness is **refused**, and the refusal names the missing surface.
- Do not claim a live in-game result from a fake tree. State what remains unobserved
  after the surface has been checked.

## Dev-grade installs

A dev-grade install of the shell may not drift from the worktree. Every CSDK10 tools host
and development client the machine's own discovery knows about must carry the current
source — the `sourceDigest`, the current build commit and the delivery feature markers —
not just an older commit that happens to look close.

- `tools/parity_check.py` treats a dev-grade audit cell as a **refusal** when it is absent
  or drifting; a run does not pass while a dev install lags the worktree.
- Rebuild and reinstall the dev tree instead of relaxing the comparison.
- The release game client still has its own cell and its own rules; a dev fix does not
  stand in for a live delivery.

## 1. Formats: upgraded and legacy

This project carries formats at their own revisions, and the audit tools inventory them rather than
trusting a summary: `scan_drives_reaudit.py` in `secure_shell_v2` reads dotted schema identifiers and
package magics across every project, and its register is checked rather than described.

Read here on 2026-11-04 under `C:\Users\ala\Documents\openlock` (head `6f45def`):

- identifiers: `shploingus.recipe/3`x21, `openlock.addons/2`x16, `openlock.game/1`x12, `openlock.envelope/1`x6, `shploingus.theme/1`x4, `openlock.build/1`x4, `shploingus.recipe/4`x3, `dl-enclave.pkg/1`x2, `dl-enclave.surface/1`x2, `openlock.popit-elements/1`x2, `b.length/3`x2, `openlock.observer/1`x1
- magics: `SHPKG003`x2

Upgraded versus legacy, by family:

  - `shploingus.recipe`: newest `shploingus.recipe/4`, older `shploingus.recipe/3`

A legacy value is evidence to read, never a value to convert silently: an older frame is refused by
name, and `dl-enclave` §1 and §3 own that rule for this family.

## 2. Status to the shell connection

This project's connection state, from commands on 2026-11-04, not from its own README:

| Question | Answer |
|---|---|
| Does a running unit, admitted package or drill step name this project? | `held` |
| Evidence | `tools/gen_shell_data.py` produced the admitted shell-data package |
| Layers this project keeps | `.scratch`, `tools`, `examples`, `clientaddon`, `docs` |

`held` here means the named command produced the named result. `absent` means nothing proved it yet;
it is not a judgement about the project's quality, and it changes only when a command changes it.

## 3. Resynthesizing this file

This section was appended by `secure_shell_v2/tools/resynth_agents.py`, which refuses
`agents-authority-trimmed` rather than write a file that lost a prior line. A resynthesis of this
project adds: its formats at their revisions, its connection state, and its conventions as the file
already states them. It does not delete, re-word or "tidy" an existing rule; a stale claim is
superseded by a dated line beside it.

# Entity — Build, release and evidence toolchain (`tools/*`, `release/*`)

**Availability tier:** LOW_CRITICALITY for tools; STANDARD for `parity_check` as a gate.

## Purpose

Generates client data from the shell package and the target game, packs VPKs, builds the release
archive and checksum, reads VPKs, stages update records, seeds installer pairs, and produces the
parity / witness / test-surface evidence the project treats as its verification.

## Trust role

Runs on the developer machine with the developer's authority. It reads the worktree and the game
tree and writes build output and installed trees. Its evidence is what the project accepts as
proof, so a tool that reports success without observing the surface is a trust problem, not just a
bug.

## Components

| Tool | Job | Notable behaviour |
|------|-----|-------------------|
| `gen_shell_data.py` | shell data JS from `shell/alpha-shell` + game VPKs | writes into the build tree only |
| `gen_shell_theme.py` | theme CSS from `.theme` files | deterministic generation |
| `gen_shell_audio.py` | sound event definitions | digest-stamped |
| `gen_legacy_shell.py` | CSDK 10 legacy shell entry | derived from the live shell |
| `pack_vpk.py` | VPK writer | directory + numbered shards |
| `vpk_read.py` | VPK reader | mirrors the C# reader's bounds rules |
| `build_release.ps1` | `openshell-player.vpk` + `.sha256` | checksum format `sha256sum`-compatible |
| `parity_check.py` | dev-install vs worktree audit | a drifting dev cell is a refusal |
| `axis_witness.py` | content-addressed witness rows | records digest per copy |
| `package_envelope.py` | HMAC-SHA256 envelope sign/verify | one algorithm, explicit refusals |
| `shell_test_surface.py`, `shell_sandbox_surface.py` | browser/Go-shell witness pages | refusal cards for unobserved suites |
| `installer_pair.py` | pair reading/seeding | consent-gated |
| `stage_update.py` | update record for the update window | client data, travels with the package |

## Controls observed in the KB

- Tools refuse rather than guess: missing file, wrong digest, stale install, absent surface all
  produce a named refusal and a non-zero exit.
- Release checksum is generated from the exact bytes that ship.
- Parity distinguishes a *dev-grade* cell (must match the worktree) from the release game client
  (its own cell and rules), and refuses a dev cell that lags.

## Constraints

- Must stay runnable without network access.
- Must not overwrite checked-in live assets when generating for a different game copy.

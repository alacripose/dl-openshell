# Entity — Dev installer (`install.ps1`)

**Availability tier:** LOW_CRITICALITY (developer action).

## Purpose

Builds the mod from the worktree and installs it into a tools host or game tree: generates shell
data from the target game's own VPKs, compiles Panorama resources with `resourcecompiler.exe`,
packs a VPK, copies the plugin and addon, gates on parity, and optionally boots the shell host.

## Trust role

Runs with the developer's authority and executes several external binaries. It reads repository
content and writes into a game tree. It is the widest-privilege component in the repository.

## Inputs

- Parameters incl. `-SdkRoot`, `-Update`, `-ForcePackage`, `-NoUi`, `-BootShellHost`, `-Live`,
  `-VpkOnly`, `-Compile`, `-NoRefresh`, `-NoParity`.
- The repository at `$repoRoot` (including uncommitted changes).
- The target game's `gameinfo.gi` and VPKs.
- `tools/gen_shell_data.py`, `tools/pack_vpk.py`, `tools/parity_check.py`, `resourcecompiler.exe`.

## Outputs

- A build directory under the repository, a packed VPK, plugin assembly, generated
  `openlock_shell_data.js`.
- Files written into the game tree (`citadel/addons`, `game/bin/win64/managed/plugins`).
- Deletion of build artefacts and stale loose trees under the game tree.

## Controls observed in the KB

- `git pull --ff-only` only when `git status --porcelain` is empty; a dirty worktree is left alone.
- A failed `git pull` throws instead of building an unknown revision.
- Generated data is written into the build tree, not over the checked-in live assets, so a minimal
  tools client cannot rewrite the live game's assets.
- Delete operations are scoped to computed build/installed paths (no wildcard deletes of the game).

## Constraints

- Must remain non-interactive with `-NoUi` so the sandbox suites can drive it.
- Its parity step can refuse the run; refusal is the intended outcome for a drifting install.

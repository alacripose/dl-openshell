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

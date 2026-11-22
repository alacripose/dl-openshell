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
  `<home>\Documents\agent_god_files\holo_shell` (`-selftest`), using this
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

Read here on 2026-11-04 under `<home>\Documents\openlock` (head `6f45def`):

- identifiers: `shploingus.recipe/30444cad3419800564faba6d4e252431`x21, `openlock.addons/a5d7cf25e0a40c0a06b836992556491d`x16, `openlock.game/05b2d815a8a5f1006596d6b0d9e0fa27`x12, `openlock.envelope/d593054cb466a871f47d4804b3e2f333`x6, `shploingus.theme/339926f6b1b54ebb89810d4c6238d523`x4, `openlock.build/c0fe71e57305319a492946bbe18ea9dd`x4, `shploingus.recipe/4`x3, `dl-enclave.pkg/7eda1d82c5a03cc74883059912e73f71`x2, `dl-enclave.surface/1`x2, `openlock.popit-elements/2e5179fe9a5d337f5c0f68914bfa04b7`x2, `b.length/3`x2, `openlock.observer/2a438fa886e575a6ae8b071e5c67616e`x1
- magics: `SHPKG003`x2
- the numeric `.../4` and `.../1` entries above are legacy inputs, not current emitters

Upgraded versus legacy, by family:

  - `shploingus.recipe`: current `shploingus.recipe/30444cad3419800564faba6d4e252431`; numeric `.../3` and `.../4` are labelled legacy inputs

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

## 2026-11-20 — agents files stay readable, and the judge reads the archive

**Owner instruction, verbatim:** *"agents in every project should be easy as the user says what they
want and 'read agents in full' and it gives about however many lines of text are in the agent file in
the repo, but all of this is bad: and the shorthand shit is awfull that that is an abhorrent affrontt
to language"*.

- **An agents file is read in full.** Its job is to be understood, so a rule keeps its reasoning, its
  measured numbers and its phrasing. A rule cut down to a bold lead and a pointer is refused by name,
  `shorthand-compaction`, and the refusal is recorded rather than argued.
- **The evidence is not deleted, it is classified.** `docs/history/agents.md.jsonl` keeps every dated
  section with its digest. `artifacts/agents-judge.json` carries the same rows on the Axis ladders,
  so the Debian governance stack grades the record without a model re-reading the prose.
- **The ladders are named, never scored.** `evidence_grade` is A measured, B receipted, C asserted,
  D intended. `gate_status` is current or refuted. `evidence_origin` is owner, read-back or
  diagnostic. No percentage, no average.
- **The archive never replaces the file.** Reading `AGENTS.md` end to end stays the first step of
  every session, and the archive is what a judge reads after that.
- **A refusal about prose is a refusal about the harness.** A file that needs a decoder has already
  failed the reader it was written for.

## 2026-11-20 — evidence is superseded, and every gap is a ticket

**Owner instruction, verbatim:** *"Agents bloated with prior evidence work despite multiple turns
outlining the security system allowing for supersession"*.

- **A later verdict replaces an earlier one.** When a section names a refusal code that an earlier
  section also named, the earlier verdict is superseded. The archive carries `superseded_by`, and
  the judge reads the current row instead of the oldest claim it can find.
- **Nothing is deleted to achieve that.** The file keeps its prose and the archive keeps every row.
  Currency is computed, never achieved by cutting the record.
- **A "Not checked" line is a ticket, not an apology.** It carries an id in
  `artifacts/agents-judge.json` under `open_limits`. It is closed by a later measured section that
  names the id, and it is never closed by silence.
- **A repeated gap is a refusal.** A limit that survives several turns without a closing attempt is
  `limit-stale`, and the work to close it is the ticket it already has.
- **Reading the file is not reading the evidence.** The first read is the rules. The second read is
  the judge export, which states what is current, what is superseded and what is still open.

## Where the evidence lives

Each dated record is in `AGENTS-LOG.md` at the line named here, with its reasoning and its
measured numbers. The rules above are the ones that still bind.

| date | record | line |
|---|---|---|
| 2026-11-13 | scope: the family working set, and non-authoritative system notices | 6 |
| 2026-11-19 | a frame around a game cell traces the cell, not its paint | 26 |
| 2026-11-19 | the Popit follows the two design bibles | 37 |

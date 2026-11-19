# Why each project had its package format

**A study of five trees and six formats, measured 2026-10-31.**
Scope: `openlock` (this tree), `shploingus-game` (pre-split), `shploingus-clean` (post-split),
`dl-enclave`, `agent_god_files/holo_shell`. Every claim cites the file it was read from. Nothing here
is from memory, and no format was executed: these are readings, not runs (§11).

The question this answers: **why did each project need its own package format, and what does that
imply for a secure shell that wants a dedicated upstream one?**

The short answer, stated up front so the rest can be checked against it:

> Each format exists to answer one question its owner could not answer from bytes on disk.
> Where that question is written down, the format holds and the refusals are specific.
> Where it is not written down, the format grows a second copy of itself somewhere else.

---

## 0. `.shpkg` is a sibling, not a wrapper

The frame was invented alongside the family's other formats rather than imported from one. Its magic
is a version of *itself* — `SHPKG002` and `SHPKG003` (`src/Openlock/Shell/ShpPackage.cs:31-32`) — and
the payload inside it is a `shploingus.recipe/30444cad3419800564faba6d4e252431` document, the same grammar `shploingus-clean`'s
`voxel-package` reads. The reader refuses anything that is not one of those two magics, by name:
*"package frame is not SHPKG002 or SHPKG003"* (`ShpPackage.cs:329-331`).

So the family is not one format with wrappers. It is **a set of formats that agree about the
document inside them**, which is why the same thirteen-key window grammar can be parsed by the shell
package reader and the addon reader and mean the same thing (`ShpPackage.cs`, `ShellPackage.cs`).

Two counts matter for everything below. `ShpPackage` carries **two digests**: `SourceDigest` (SHA-256
of the payload) and `PackageDigest` (SHA-256 of the whole frame) — `ShpPackage.cs:280-281`,
`workspace/kb/entities/shpkg_parser.md:25`. And the family has **no format registry**: twelve
`shploingus.*` tags and six `openlock.*` tags are declared by hand across Rust, Python, PowerShell and
JavaScript, with no single list (`dl-enclave/docs/DRIFT.md`, D-9).

Those two facts are the whole problem in miniature: **a format that can say what it is, inside a
family that has nowhere to write down that it exists.**

---

## 1. The five, on one page

| Tree | Format(s) | The question it answers | What it refuses |
|---|---|---|---|
| `shploingus-game` (pre-split) | `shploingus/package/v2` manifest + `shploingus/slice-spec/v2`, both `.shpkg`/`.shspec` | **Is this the same package?** | a spec that no package names; a package whose content identity collides |
| `shploingus-clean` (post-split) | `shploingus.recipe/30444cad3419800564faba6d4e252431`, `SHPKG002`/`SHPKG003`, mount v2 | **Can a package exist without the game?** | a foreign recipe hash; a raster the host cannot draw |
| `openlock` / dl-openshell | `.shspec`, `.cells`, `.windows`, `.shpkg`, `openlock.addons/a5d7cf25e0a40c0a06b836992556491d`, `openlock.game/05b2d815a8a5f1006596d6b0d9e0fa27`, `openlock.build/c0fe71e57305319a492946bbe18ea9dd`, optional `openlock.envelope/d593054cb466a871f47d4804b3e2f333` | **What may a third party put on my screen, and how do I take it back?** | an unsigned-but-unreadable frame; a payload over 4 MiB; a revision that goes backwards; a node tree deeper than 24 |
| `dl-enclave` | `dl-enclave.pkg/7eda1d82c5a03cc74883059912e73f71`, `dl-enclave.sig/e9c5728c3745931d112839d8cdb0ced6`, legacy `dl-enclave.surface/1` | **Who authorised this, and is it current?** | a non-zero flag; a truncated frame; a foreign version idiom; a downgrade |
| `holo_shell` | none | **What is not mine?** | — it reads Win32 state and creates no package boundary |

The rest of this document is one section per row, in that order, then the split (§7), then the
derivation (§8–§9).

---

## 2. Pre-split: `shploingus-game` — "is this the same package?"

### 2.1 The tree that made the question necessary

The pre-split tree kept **four record stores beside one emit root**: `milestones/`, `recipes/`,
`records/`, `blocks/`, plus `packages/`, `flow-specs/`, `crates/`, `references/`, `docs/`. One
directory could hold a package, the slice spec it was compiled against, and the decision that
authorised it. Nothing in a path says which of those a file is.

That is the pressure that produced
`shploingus-game/crates/diffusion-core/src/package.rs`. Its module header states the design rule
without hedging:

> Eight fields on a package are set by the compiler rather than by a caller's slice spec. Each one has
> to be told which **half** it belongs to, because the two halves do different jobs: a **content**
> field changes what package this *is*. A **provenance** field records how it was *made*.

The eight fields are partitioned explicitly: `package_name`, `slice_spec_digest`, `cites_events` and
`record_count` are **content**; `compiler_revision`, `source_corpus_digest`, `patch_set_digest` and
`declared_path` are **provenance**. The docs answer the half-question directly, which is the point —
*"a path is not content: moving a package must not change what it is."*

### 2.2 Two identities, and one of them must never be trusted

The module defines two:

- `package_content_identity` — `projection_without(projection, Half::Provenance).digest()`. What
  package this is. Two packages with the same content identity are **one package loaded twice**.
- `package_location_identity` — `projection.digest()`. This specific file. Deliberately **not
  reproducible off-machine**, and the doc says so: *"it must never be the key anything is verified
  against."*

That distinction is the single most reusable idea in the family's package history. It says out loud
that *identity* and *provenance* fail differently: a content identity that drifts breaks citation; a
location identity that is trusted breaks portability and leaks a username.

### 2.3 The defect, and why it is kept as a test

The module records its own postmortem:

> A previous revision digested the projection with **all** reserved fields removed. Since the emitter
> wrote only reserved fields, it digested an **empty projection**, and **every** package ever emitted
> shared one content identity. The duplicate guard was correct and fired on every pair of distinct
> packages.

The fix was not a guard. It was *one reserved field being declared content* — the slice spec — and
folded in. The regression test is kept as a **measurement**, not an assertion of good behaviour:

```rust
fn removing_every_reserved_field_yields_an_empty_projection_and_that_is_the_defect()
```

The tree also enforced a rule worth copying verbatim: *"a file in the search path is either a package
or a refusal, and there is no third answer."* A spec that **no** package names is refused **by name**
as unclaimed, rather than ignored.

### 2.4 Why it was abandoned, and what that means

`dl-enclave/docs/DRIFT.md` D-11 is blunt: three package designs exist, the one that separated content
from provenance is the **abandoned** one, and the one that shipped separates **nothing** — framing,
manifest, payload and proof in one object. `dl-enclave/docs/PACKAGE-FORMAT.md` §1.1 calls its own
format *"a restoration of rather than a departure from"* that abandoned design.

So the pre-split tree is not the ancestor of the format that shipped. It is the **counter-design** the
family forgot, and the reason the split did not preserve it is the reason §7 exists: the tree that
held it was never built.

---

## 3. Post-split: `shploingus-clean` — "can a package exist without the game?"

### 3.1 What the split was for

The split's own audit states the boundary it inherited and what it cost
(`shploingus-clean/docs/AUDIT-2026-10-24-where-a-package-ends-and-the-game-begins.md`):

- `voxel-package` owns the **nouns**: `recipe` (1,998 lines), `compiler` (1,906), `filing` (1,127),
  `layer` (1,182), `policy` (634) — 29,523 lines over 20 modules.
- `voxel-client` and `shploingus` own the **verbs**: `shell/` alone is 18,651 lines, `world.rs` 2,938
  — 21,589 lines, 42% of the client, *interpreting* packages.

> **The interpreter is three times the size of the thing it interprets.**

That is the split's real ledger. The format was successfully made independent of the game's *code*,
and then failed to become independent of the game's *behaviour*.

### 3.2 The five causes, in the audit's own order of weight

1. **The format stops at `Loaded`.** `voxel_package::recipe` ends at a parsed, compiled document;
   everything that acts on one needs a window, a GPU or a chain. The loader's home in the client was
   **decided**, not drifted (`docs/PLAN-2026-10-23-the-one-rig.md:680`, M10.3).
2. **A declaration's reader lands where the renderer is.** Reading rows happens in
   `shell/window.rs` / `shell/arrangement.rs`, so each new declaration lands on the verb side.
3. **A closed schema makes every capability a sibling artifact.** The layer grammar sits correctly in
   `voxel-package::layer` with **zero consumers** outside its crate and 11 tests, while the client
   grew a reader for `package.cells` the format crate did not have — *"each half of the format is
   missing the other's feature."*
4. **`voxel-package` is a governance crate with a recipe module**, not a format runtime — so the first
   caller, the mount, became the owner by default.
5. **Three whole-tree checkpoints, no feature history**, so no commit ever had to justify a boundary.

The cleanest single proof the audit offers: `package.cells` was a **format header** parsed by
`voxel-client::shell::cells`, not by `voxel-package`. It was moved on 2026-10-24 and the client
re-exports it; the refusal text and file/line did not change.

What the audit says **not** to move is as important:

> `window.rs`, `arrangement.rs`, `console.rs` are the renderer. Their size is the price of a GPU
> shell, not a boundary defect. **The defect is the readers, not the drawing.**

### 3.3 What the split did to the version rule

Post-split, the runtime accepts exactly one header:

```rust
pub const HEADER: &str = "shploingus.recipe/30444cad3419800564faba6d4e252431";
pub const ACCEPTED_VERSIONS: &[&str] = &[HEADER];   // exactly one, and that is the point
```

> *"an older header is refused rather than converted"*

Meanwhile `ala_package_designer/crates/foundry-format/src/frame.rs` writes
`shploingus.recipe/30444cad3419800564faba6d4e252431`; numeric `.../3` and `.../4` are legacy inputs read as migration evidence. So the designer writes a version the runtime
**cannot read at all, by explicit policy** — DRIFT D-2, *the reader refuses the writer*.

This is the split's characteristic failure and it is structural: **once the writer lives in a different
repository from the reader, a version ceiling stops being a policy and becomes a product defect that
neither test suite can see.** Both suites pass. Only a comparison sees it.

---

## 4. `openlock` — "what may a third party put on my screen, and how do I take it back?"

This is the only tree in the family that accepts content from **other people's packages**, and its
format set is correspondingly the widest. Each format answers one slice of that question, and the
slices are not interchangeable.

| Tag / file | Job | Why it is not the other one |
|---|---|---|
| `shploingus.recipe/30444cad3419800564faba6d4e252431` (`.shspec`) | the package: id, version, windows, the 13-key grammar | it is the document; it declares no bytes |
| `package.cells` | the drawing the package is a package *of* | a cell raster, its layers and frames **cannot be mounted** by a Panorama host — refused as *"the host draws composed panels only"* |
| `deadlock.windows` | the game's own window declarations | not a package; the game's list, not the addon's |
| `SHPKG002` / `SHPKG003` (`.shpkg`) | the frame: 8-byte magic, LE recipe length, SHA-256 of recipe, recipe, then (003) an artifact table | the recipe alone has no digest and no artifacts; the frame has both |
| `openlock.addons/a5d7cf25e0a40c0a06b836992556491d` | the **wire**: packages, windows, `liveTree`, `revision`, budgets | the frame is at rest on disk; this is what a client sees |
| `openlock.game/05b2d815a8a5f1006596d6b0d9e0fa27` | the **host's own** running-window stream | see below |
| `openlock.build/c0fe71e57305319a492946bbe18ea9dd` | the installed-build record | a version string cannot describe a dev tree |

### 4.1 Why the frame has two digests

`ShpPackage` computes `SourceDigest` over the payload and `PackageDigest` over the frame
(`ShpPackage.cs:280-281`). The landing page states the rule the reader enforces: *"Before a package's
recipe is parsed, the frame must hold. The reader checks the bytes… a mismatch refuses the whole
package before one window is read"* (`landing/index.html:578-582`). The ceilings are named in the same
place: **16 MiB package, 1 MiB recipe, 64 MiB VPK tree**.

A frame that can be checked before its payload is parsed is the minimum a host needs to refuse cheaply.
Everything else in Openlock's format set builds on that.

### 4.2 Why there is no second manifest

`examples/motd-addon/README.md:5`: a copyable addon that uses *"the loader dl-openshell already ships;
there is **no second manifest, no separate window format**."* `README.md:172-175` says the same from
the other end: an addon ships windows as **real shploingus packages**, and the shell parses the recipe
*"with the same 13-key window grammar the shell package"* uses.

This is the family's healthiest design choice, and it is stated as a refusal to duplicate rather than
as a feature. It is also, per §3.2, the choice `shploingus-clean` failed to make for `package.cells`.

### 4.3 Why the addon and game families do not share their rules

`dl-enclave/docs/PACKAGE-FORMAT.md` §2.4 tabulates the difference precisely:

| Format | Revision | Failure scope |
|---|---|---|
| `openlock.addons/a5d7cf25e0a40c0a06b836992556491d` | monotonic; every committed addon change increments it (`AddonPackages.cs:68`, `:286`) | whole set: a payload that fails validation leaves the previous windows mounted |
| `openlock.game/05b2d815a8a5f1006596d6b0d9e0fa27` | **none** | per row: an unreadable row is pushed to `refused` and opens nothing |

The reason is authored, not stylistic: **the game family's author is the host itself, not a remote package.**
A host's own stream needs no revision because there is nothing to roll back to and nothing to forge;
a remote payload needs both. `openlock.game/05b2d815a8a5f1006596d6b0d9e0fa27` has no payload cap for the same reason
(`PACKAGE-FORMAT.md` §2.4).

The caps on the remote path are specific and all refusals:

- `MaxPackages = 64`, `MaxPayloadChars = 4 * 1024 * 1024` — `AddonPackages.cs` (the old
  `MaxPackageBytes = 16 MiB` was removed on 2026-11-12; it was not a format rule, and the modern
  carrier has no package-byte cap);
- payload over budget: *"the mounted payload would be {n} characters; the client refuses more than
  {MaxPayloadChars}"* — `AddonPackages.cs:445-447`;
- the client refuses >4 MiB **before** `JSON.parse`, so a host-supplied tree cannot allocate first
  (`openlock_delivery.js:123`);
- node tree bounded to **512 nodes / depth 24** (`openlock_delivery.js:11-12`, `:99`);
- a revision that goes backwards is rejected (`openlock_delivery.js:141-142`).

### 4.4 Why a refusal must not unmount the working set

`AddonPackages.cs:19-20` states the contract in the class doc: the same package name replaces the
mounted version **only after every one of its windows has been staged successfully**, and *"a refusal
leaves the previous version untouched."* `:303` repeats it for the candidate set, and `:410` explains
the discard path: *"the previous package still mounted, rather than committed server-side and never
sent."*

This is the rule that makes a live-updating shell tolerable: **atomicity is a property of the
receiver, not of the sender.** A sender that promises atomicity cannot deliver it.

### 4.5 The build record, and why a version is not enough

`install.ps1:632` writes `format = 'openlock.build/c0fe71e57305319a492946bbe18ea9dd'` via `Write-BuildRecord` (`:583`), with stages
`prepare` / `compile` / `record` and a state of `running` / `ok` / `failed` (`:696`, `:967`, `:997`,
`:1129`). `launch.ps1:337-351` treats the record as the authority on whether an install happened:
*"install.ps1 exited cleanly but its build record is not installed/ok."* The shell renders it
(`openlock_shell.js:5229` — *"no build record yet — the next install writes shell/alpha-shell/build.json"*).

Why it exists: this repository's own AGENTS.md requires a dev-grade install not to drift from the
worktree — the `sourceDigest`, the current build commit and the delivery feature markers, not just a
version that happens to look close. **A semver string cannot carry a worktree.** A build record can.

### 4.6 The envelope, and its honest limit

`tools/package_envelope.py` is *"the axis package-security slice, not a second package format"* — the
docstring says so, and the design follows: `openlock.envelope/d593054cb466a871f47d4804b3e2f333` is **optional** by default, carries
`digest`, `authority`, `work`, `nonce`, `algorithm`, `key`, `signature`, and uses **HMAC-SHA256 under
a machine-local key** outside the checkout.

It is the only format in this document that has a documented failure mode in its own threat model:
`THREAT_MODEL.md` records that the release envelope **cannot verify a release asset** (F7), because
verifying needs the signing key and shipping it publishes the forge key.

That is the most useful thing about it. A format that names what it cannot prove is already more
secure than one that claims a property it does not implement.

### 4.7 What the delivery format did not prove

`docs/DELIVERY.md:122-123`: *"What it does not prove: the engine's real panel API, the server's
payload serialization, or that streaming a large payload never stalls a poll frame on a live client."*
Line 161 repeats the last one as **not proven this pass**, and line 6. The format is proven by the
shipped parser and a deterministic harness, not by a live round trip.

`dl-enclave` inherited that gap rather than closing it, and says so
(`PACKAGE-FORMAT.md` §2.4): *"inheriting an unproven path silently is the drift this document exists
to stop."*

---

## 5. `dl-enclave` — "who authorised this, and is it current?"

### 5.1 The four defects it was built against

`PACKAGE-FORMAT.md` §1 names them, each with a source, and this table is the clearest statement in the
family of *why a format needs more than a frame*:

| Defect | Evidence | Consequence |
|---|---|---|
| the signature is **inside** the bytes it protects | `openlock.envelope/d593054cb466a871f47d4804b3e2f333` embeds digest/signature in the `.shspec` | re-signing changes the payload: a package can never be both byte-reproducible and signed |
| **symmetric** authentication | HMAC-SHA256 under a machine key | every verifier is a forger; a grant cannot prove *who* |
| **one object holds four claims** | SHPKG003 = framing + manifest + payload + proof | a change to any claim rewrites the artifact, and the version bump breaks every reader at once |
| **no freshness** | nothing in legacy `recipe/3`, `SHPKG003` or `envelope/1` has an expiry or sequence | an old, validly signed package is indistinguishable from the current one |

### 5.2 Three objects, one invariant

Payload / metadata (TUF-shaped: root, targets, snapshot, timestamp) / attestation (legacy `sig/1` sidecar).
The rule that makes the split worth doing:

> the payload digest is computed over **payload bytes only**. Re-authorising a release — a new
> timestamp, a new targets entry, a rotated key, a re-issued attestation — leaves the payload digest
> **unchanged**.

Everything else follows from that invariant: reproducibility (§4's six obligations), third-party
comparison, and freshness that does not rewrite content.

### 5.3 The frame is inspectable and every limit is a refusal

Magic `DLEP` + frame-version + flags (non-zero **refused**, *"so a future extension cannot be silently
ignored by an old reader"*) + LE header length + TSV header + payload + a 32-byte trailer digest, so
**truncation is a refusal rather than a short read** (`PACKAGE-FORMAT.md` §3).

Limits are a table with a refusal name per row: header 1 MiB `header-oversize`, payload 2 GiB
`payload-oversize`, 4096 modules, 1 surface, 1 addon, 65536 header rows, 512 MiB per module (§3.2).

`module` paths are relative, `/`-separated, no `..`, no leading `/`, no NUL, and a path escaping the
root is **refused at the header, before any payload byte is read** — a rule inherited from
`openlock/install.ps1`'s clone refusal.

`axes 9` is **generated from the declaration**, not maintained by hand. A package whose declared axis
count disagrees is refused. This is how a format stops the D-1 class of drift (four axis declarations,
three names, two token orders) rather than documenting it.

### 5.4 Freshness is three claims, not one

A/B slots give availability rollback, not anti-rollback. The format separates:

| Property | Mechanism | Claim allowed |
|---|---|---|
| a newer release exists | `timestamp` + short expiry | `current` / `stale` |
| this is newer than installed | monotonic `release-sequence` + local high-water mark | `forward` / `rollback-refused` |
| the counter cannot be reset by restoring a disk | TPM NV counter | `anchored` / `declared` |

The third is **best-effort and reported as such**: without a TPM it prints `declared`. That is the
same discipline as §4.6, applied to hardware.

### 5.5 Migration is one-way on purpose

`dle-migrate` reads the legacy inputs and writes `dl-enclave.pkg/7eda1d82c5a03cc74883059912e73f71`; it is a **declared tool**, not a
compatibility mode. Legacy `recipe/3` and `SHPKG002/003` are read; `openlock.envelope/d593054cb466a871f47d4804b3e2f333` is **read, then
dropped** (the in-band digest is verified so a tampered legacy package cannot migrate silently);
legacy `recipe/4` is refused `schema-not-read`; `planet-*` is refused `foreign-versioning-idiom`;
`planet-package-v1` is refused `no-format-behind-domain`; VPK is `excluded-format`.

The reason there is no downgrade: *"a downgrade path is a way to get an old, unsigned package
installed."*

And the reason legacy `recipe/4` is refused rather than guessed is stated as the honest state: refusing is
exactly the D-2 failure, *"this time the refusal is named and visible instead of silent."* A named
refusal is how you keep an unknown from becoming an invention.

---

## 6. `holo_shell` — no format, and that is the correct answer

`agent_god_files/holo_shell` is a Go desktop shell over Windows LTSC. It has **no package format at
all**, and the reason is in its own directory table: `internal/platform/windows/` is the real Win32
window manager (`EnumWindows`, `SetWinEventHook`), and `internal/win32/` holds the user32/kernel32/
gdi32/dwmapi/shell32 bindings.

Its ingress is **operating-system state it did not create**. There is no untrusted document, so there
is no framing question, no digest, no revision, no capability set. Its boundary is the OS API and its
failures are API errors.

The absence is a design, not an omission: a format exists to bound what someone else may hand you.
Holo hands itself nothing. It is the only tree here whose answer to *"what is not mine?"* is
*everything the OS owns*.

One thing it does share with the rest of the family, and it is the defect side: its witness is a flow
(`-selftest` spawns Notepad and checks titlebar auto-hide/reveal), not a record. That is DRIFT D-6's
shape — *a witness a person reads* — without even a page.

---

## 7. What the pre/post split actually changed

Not the framing. `SHPKG002/003` and legacy `recipe/3` survived the split unchanged. What changed is
**ownership and direction**, and each change has a format consequence:

| | Pre-split (`shploingus-game`) | Post-split (`shploingus-clean`) |
|---|---|---|
| Who reads it | the game, in the same tree | `voxel-package`, as a library |
| Who writes it | the same compiler | `ala_package_designer`, in another repository |
| Identity computed because | four stores share one search path | citations point across a repo boundary |
| Version rule | one header, enforced locally | one header, and the writer is **past** it (D-2) |
| The format's scope | the whole product | the nouns only; the verbs stayed in the client (3×, §3.1) |
| What it gained | the content/provenance split (§2) | independence from the game's code |
| What it lost | the tree was never built | every new declaration lands in `mount.rs` by default |

Two consequences for anyone designing a successor:

1. **The split preserved the frame and lost the partition.** The content/provenance split is the more
   valuable of the two ideas — `dl-enclave` says so and restores it — and it is the one that died with
   the abandoned tree. A split that keeps bytes and drops identity has kept the cheap half.
2. **The split moved the writer out and left no owner for the reader's edge.** That is the D-2 shape.
   Any new format in this family must declare **both** edges — who writes it and who reads it — and
   what happens when they are at different versions. `dl-enclave` answers this with a declared
   migration tool and a named refusal for anything unread.

### 7.1 The gap the split never closed: nobody owns ingress

Every tree above has a format for what it **ships**. None has a format for what it **accepts** from a
peer that is not itself:

- `openlock` accepts addons through the same hashed recipe contract it produces, with the producer and consumer in
  the same repository; legacy numeric recipe ids are read and upgraded;
- `shploingus-clean` accepts packages it could not have written (legacy `recipe/4` arrives from the designer)
  and answers with a **refusal**, not an ingest format;
- `dl-enclave` accepts, but its `dl-enclave.pkg/7eda1d82c5a03cc74883059912e73f71` is also the format it produces and its own release channel; legacy numeric `pkg/1` is read and upgraded;
- `holo_shell` accepts nothing.

So the family has never had a format that exists **only** to describe what arrives from elsewhere.
That is the honest definition of an *upstream* format, and it is why the secure shell can have one
without contradicting §10.

---

## 8. What the secure shell's upstream format must carry

Derived from the six failure records above, one requirement per record. Each is paired with the refusal
that makes it enforceable — a requirement without a refusal is a paragraph.

| # | Requirement | Because | The refusal that enforces it |
|---|---|---|---|
| **R1** | One frame, one owning reader, inspectable with `head -1` and `cut -f` | D-2: the reader refuses the writer when there are two | a second reader for the same tag → `second-reader` |
| **R2** | Three objects: payload, metadata, attestation | §5.1: one object cannot be re-signed and reproduced | a signature in the payload → `signature-in-band` |
| **R3** | Content identity from the **content half only**, pinned by a rebuild test | §2.3: an untested partition collapses silently | an identity that moves when provenance changes → `identity-moved` |
| **R4** | A build record as its own object (stage, state, digest, commit, markers) | §4.5: a version string cannot describe a worktree | an install whose record disagrees with its tree → `record-drift` |
| **R5** | Attenuated capabilities inside the attestation, ⊆ the grant the receiver presents | DRIFT D-16: the only attenuation gate sits outside the format that carries authority | a package that can do more than its grant → `not-attenuated` |
| **R6** | Freshness: a short expiry **and** a monotonic sequence, as separate claims | §5.1 defect 4 | an old valid package → `rollback-refused`; an unanchored counter → reported `declared` |
| **R7** | Every limit is a named refusal, never a clamp | §5.3: TUF names oversized downloads as an attack class | a truncated or oversized frame → `header-oversize` / `payload-oversize` / `truncated` |
| **R8** | One-way declared migration; unknown inputs refused by idiom | §5.5 | `schema-not-read`, `foreign-versioning-idiom`, `no-format-behind-domain` |
| **R9** | A witness is a record (surface, command, exit, counts), not a page | DRIFT D-6 | a result with no surface → `test-surface-unwitnessed` |

**On the refusal names.** `not-attenuated`, `schema-not-read`, `foreign-versioning-idiom`,
`no-format-behind-domain`, `header-oversize`, `payload-oversize` and `rollback-refused` exist in
`dl-enclave`; `test-surface-unwitnessed` exists in `secure-shell`'s S3. `second-reader`,
`signature-in-band`, `identity-moved`, `record-drift` and `truncated` are **proposed by this
document** and are implemented nowhere. Naming which is which is the point: an invented refusal that
reads like an existing one is how a document starts lying.

Two more follow from the split rather than from a defect:

| # | Requirement | Because |
|---|---|---|
| **R10** | The format's scope is the **nouns**; every verb has a declared owner, so a new declaration cannot land in the renderer by default | §3.2 cause 2, and the audit's own step 3: *"either a `voxel-package-mount` crate that takes a `Renderer` trait, or an explicit rule in the plan"* |
| **R11** | The format is a row in a **generated** table; a tag with no declaration is not in the table | DRIFT D-9 (no registry), and `dl-enclave`'s doc-lint |

R10 is the one the family keeps failing, and it is the cheapest to hold: the rule is *"a package
declaration's reader lives in the package crate; only the drawing lives in the client."* Every tree
that wrote that rule down kept it; every tree that wrote only the boundary kept losing readers.

---

## 9. What it must refuse

Stated as refusals, because that is the family's convention and because a requirement is only as good
as the thing it will not do:

1. **A second wire for rules it already declares.** `PACKAGE-FORMAT.md` §2.4: *"a second wire format
   would be a second place the same rules are declared."* There is no `dl-enclave.stream/1`.
2. **A third window format.** secure-shell's own S3 already refuses it: *"a third `secure-shell.*`
   window format"*, and S3-C's adapter *"is a consumer, not a second origin."*
3. **A signature inside the bytes it protects** (D-3, §5.1).
4. **Symmetric authentication on anything that carries authority.** Correct trade for a single-operator
   mod loader; wrong for a host that issues grants (§5.1).
5. **A version bump that orphans its reader without a named migration** (D-2, §3.3).
6. **A format that stops at `Loaded`**, leaving the interpreter to grow three times its size (§3.1).
7. **Mounting a raster the host cannot draw.** Openlock's model: refuse by file and line — *"the host
   draws composed panels only; a cell raster, its layers and frames cannot be mounted here"* — and do
   **not** invent a renderer to make the declaration true.
8. **A manifest nothing validates.** `docs/GROUND-TRUTH.md:14`: `openlock.manifest.json` is *"not read
   by Deadworks"* — it *"describes the plugin for tooling and humans."* A hand-kept manifest that
   nothing checks is a document, not a declaration.
9. **A witness a person glances at** (§6, D-6).
10. **A format with no stated limit on what it cannot prove.** §4.6 is the positive counter-example:
    name the failure mode in the threat model rather than let a reader assume the property.

---

## 10. The conflict with the recorded decisions, and how it resolves

`secure-shell/docs/DECISIONS.md` records, on 2026-10-31:

> The mount path is **mount v2**: legacy `dl-enclave.surface/1` + `surface.mount/2`, vendored from
> `dl-enclave` at `262ba89`. **No new package format.** Alternatives rejected: a new JSON package
> format; `openlock.addons/a5d7cf25e0a40c0a06b836992556491d`.

and S3's ruling refuses *"a third `secure-shell.*` window format."* A request for a dedicated upstream
format therefore cannot be read as "add a fourth window format" without contradicting a recorded
decision.

The evidence resolves it by object, not by wording:

- **A delivery/display format** is what the client reads to draw. secure-shell already owns that
  decision: the Debian server owns the stream, the forked Openlock window manager owns the window
  manager, and the client **never mounts a package itself** (DECISIONS 2026-10-31; §S3 ruling).
  No new format is needed here, and none should be added.
- **An upstream/ingest format** is what the **server** accepts before it mounts anything. That is the
  gap §7.1 identifies: no member of the family has one, because every member's accept path is its own
  emit path. A format that exists only to describe *what arrives* is not a second display format and
  does not touch the S3 ruling.

So the derivation stands, with one condition: **the upstream format must terminate at the server's
mount, and the client must never learn its tag.** If the client ever parses it, it has become a second
delivery format and the S3 refusal applies.

### 10.1 One recorded decision needs narrowing, and that is the user's to make

`DECISIONS.md` also records: *"The pre-split `shploingus-game/{milestones,recipes,records,blocks}`
tree is **not a format source**. The post-split `shploingus-clean` tree is."*

That is correct about **artifact kinds** — the four legacy directories are not the vocabulary a new
format should inherit. It is not correct about **design**: the only content/provenance partition in the
family lives in that tree (`diffusion-core/src/package.rs`), `dl-enclave` calls its own format a
restoration of it (D-11, §1.1), and the ruling as written would forbid reading the one document that
explains why the shipped format cannot be re-signed.

The narrow wording that keeps both true: **the pre-split tree is not an artifact-kind source; it is a
design source, read for the partition and the two identities, never for its file names.** That is a
change to a user-owned decision, so this document proposes it and does not apply it.

---

## 11. What remains unread, and what is not claimed

- **legacy `shploingus.recipe/4`** — the designer writes it; no survey has read its grammar. `dl-enclave`
  refuses it `schema-not-read` for the same reason (§5.5). Not guessed here.
- **`planet-package-v1`** — declared, unused, *"a domain tag with no structure"* (D-11). Its
  `domain`+`u16` idiom is a third versioning scheme (D-13) and is not evaluated here.
- **`ala_package_designer`** — read only through DRIFT D-2's two quoted lines, not directly.
- **No format in this document was executed.** The refusals quoted are the readers' own; the test
  counts are the projects' own; the live limits (4 MiB, 512 nodes, 16 MiB) are read from the source,
  not measured.
- **The delivery round trip remains unproven** (§4.7, D-6): the console writes succeeded at the Win32
  layer and the engine executed none of them. Nothing here upgrades that to a live result.

---

## 12. Evidence index

| Claim | Read from |
|---|---|
| two magics, two digests, frame refusal | `src/Openlock/Shell/ShpPackage.cs:31-32, 280-281, 329-331`; `workspace/kb/entities/shpkg_parser.md:25` |
| no second manifest / no separate window format | `examples/motd-addon/README.md:5`; `README.md:41-42, 172-175` |
| frame before recipe; 16/1/64 MiB ceilings | `landing/index.html:578-583` |
| atomic replacement, 64 packages, 4 MiB, refusal leaves previous | `src/Openlock/Shell/AddonPackages.cs:19-20, 29, 35, 68, 286, 303, 345-348, 410, 445-447` |
| 4 MiB before parse, 512 nodes / depth 24, revision monotonic | `clientaddon/panorama/scripts/openlock_delivery.js:9, 11-12, 99, 123, 141-142, 233` |
| what delivery did not prove | `docs/DELIVERY.md:6, 122-123, 152-161` |
| build record format, stages, launch authority | `install.ps1:583, 632, 696, 967, 997, 1129`; `launch.ps1:337-351`; `openlock_shell.js:5229` |
| envelope is not a second format; cannot verify a release | `tools/package_envelope.py` (docstring); `workspace/kb/THREAT_MODEL.md` F7 |
| manifest not read by Deadworks | `docs/GROUND-TRUTH.md:14` |
| content/provenance halves, two identities, empty-projection defect | `shploingus-game/crates/diffusion-core/src/package.rs` (module header + `package_content_identity`, `package_location_identity`, tests) |
| three designs, best abandoned | `dl-enclave/docs/DRIFT.md` D-11 |
| reader refuses writer; version idioms; no registry | `dl-enclave/docs/DRIFT.md` D-2, D-9, D-13 |
| four defects of the old carrier; three objects; invariant | `dl-enclave/docs/PACKAGE-FORMAT.md` §1, §1.1, §2 |
| frame layout, flags, trailer, limits | `dl-enclave/docs/PACKAGE-FORMAT.md` §3, §3.2 |
| determinism obligations; freshness claims; migration | `dl-enclave/docs/PACKAGE-FORMAT.md` §4, §5, §6 |
| addon family vs game family revision and failure scope (numeric names in the cited source are legacy) | `dl-enclave/docs/PACKAGE-FORMAT.md` §2.4 |
| format nouns vs client verbs, five causes, what not to move | `shploingus-clean/docs/AUDIT-2026-10-24-where-a-package-ends-and-the-game-begins.md` §2.1–§3 |
| no Win32 boundary, no package format, `-selftest` flow | `agent_god_files/holo_shell/README.md` |
| "no new package format"; no third window format; pre-split not a format source | `secure-shell/docs/DECISIONS.md` (2026-10-31 rows) |
| adapter is a consumer, not a second origin | `secure-shell/docs/SELECTIONS.md` §S3-C |

---

## 13. The modern carrier (2026-11-12)

**Owner correction.** `dl-enclave` predates `secure_shell_v2`, `openlock_modern` and `db-mc-indev`,
but its package family now uses the same hash-pinned contract: `dl-enclave.pkg/7eda1d82c5a03cc74883059912e73f71`
is the current id for the enclave reader and emitter. A numeric `dl-enclave.pkg/1` is a read-only
migration input. There is no `SHPKG004`.

**The numeric suffix is not a version.** The owner's 2026-11-12 correction: *"nothing should use the
/1 fucking thing"* and *"every fucking legacy goddamn package is going to be upgraded eventually why
would I want you to only add something for /1"*. A counter can mean two different grammars at `/1`,
so modern ids are `family/<32 hex>` over the contract. Any `family/<digits>` is a legacy migration
id; it is read and rewritten on emission. There is no `/1` special case.

The modern package is the Secure Shell canonical object, not a magic-prefixed frame:

- `manifest.json` is canonical JSON (sorted keys, compact separators, UTF-8);
- `payload.bin` is a separate byte object;
- identity is `name@<revision>+blake3:<64 lowercase hex>`;
- the digest preimage starts with the hashed package id
  `secure-shell.package/ff53bde81a9e26562c739676fff7d28e`, then each field's 8-byte big-endian
  length and the field, for the kept canonical manifest and the payload;
- framing, encryption, signature, timestamps and chunking are outside the preimage; the stream is
  transport, not identity;
- a numeric package id (`secure-shell.package/1`, `secure-shell.package/2`, ...) is a legacy
  migration id. It is read, but it is never emitted as current. The same rule applies to every
  format family: the suffix is a 32-hex contract hash, not a counter.

There is no 32-bit length. Payload lengths and all cumulative arithmetic are 64-bit, and the
Restore's declared ceiling is 64 GiB. The old 4 GiB boundary is not a format limit and is not
carried forward.

| Path | Role |
|---|---|
| `tools/modern_package.py` | the packer: canonical manifest, BLAKE3 streaming, `--surface`, file-index or 4 GiB + 1 proof payload |
| `src/Openlock/Shell/ModernPackage.cs` | the reader: canonical manifest validation, exact declared length, streamed BLAKE3 identity, 64 GiB refusal |
| `src/Openlock/Shell/FormatId.cs` | the shared `family/<32 hex>` rule; numeric suffixes are legacy and are read, never emitted as current |
| `src/Openlock/Shell/SurfaceDocument.cs` | the closed `secure-shell.surface/<32 hex>` reader and refusal vocabulary |
| `src/Openlock/Shell/AddonPackages.cs` | real addon discovery/mount of `.pkg` directories, surface-to-window projection, read-only legacy fallback |
| `tools/tests/packagetests` | 59 checks: 4 GiB + 1 round trip, identity, wrong-length refusal, modern-surface discovery/order, numeric legacy upgrade, refusals, and unchanged legacy fixtures |

`SHPKG002`/`SHPKG003` remain readable byte-for-byte through `ShpPackage`; nothing about them was
rewritten. `VpkReader` still records 32-bit entries, so a package above 4 GiB is a loose modern
object, not a VPK entry.

## 14. Modern addon surfaces (2026-11-12)

A modern addon package is a directory named `*.pkg` containing the canonical object above. Its
manifest declares both `secure-shell.package/ff53bde81a9e26562c739676fff7d28e` and
`secure-shell.surface/7af4f34e745ebf547b3fc71146ef314c`; `payload.bin` is the exact UTF-8 surface
document, and the manifest `name` must equal the surface's declared id. The reader verifies the
BLAKE3 identity before it reads the payload, so a surface read implies a verified package.

The surface schema is closed and tab-separated, ported from `dl-enclave/tools/port/src/surface.mjs`:

- header `secure-shell.surface/7af4f34e745ebf547b3fc71146ef314c`;
- a numeric header (`dl-enclave.surface/1`, `dl-enclave.surface/7`, `secure-shell.surface/2`, ...)
  is read as a legacy migration input and is rewritten to the hashed header on emission;
- a different 32-hex header is refused `format-hash-mismatch`;
- `surface<TAB>id` and `requires<TAB>observe|act|admin`;
- `window` rows with 17 columns: the kind `window`, id, title, lane, rule, x, y, width, height,
  min width, min height, pinnable, pinned, chrome, moves, theme role, content;
- `node` rows with 7 columns: the kind `node`, window, id, parent, kind, role, value;
- `action` rows with 5 columns: the kind `action`, window, verb, tool, target.

The reader refuses a blank or unknown row, a missing or foreign schema id, a missing header, a duplicate
window or node id, an unknown lane/rule/theme/node kind, a broken parent/target, an invalid
geometry, a pinned-but-not-pinnable window, and more than 256 windows / 512 nodes per window /
16 actions per window. Refusal names use `duplicate-window`, `surface-schema`, `surface-id`,
`surface-capability`, `geometry-invalid`, `unknown-node-parent`, `node-depth`, and
`surface-declared-id` for a manifest/surface id mismatch. Nothing is mounted from a parse that
returned a refusal.

Window projection keeps every declaration field: geometry and minimum, lane, theme role,
pinnable, `rule`, `pinned`, `requires`, all node and action rows. Chrome becomes
`title-position,<chrome>` and moves plus chrome become the behavior policy, the same projection
the legacy recipe path used. Node rows also become the window's structural `LiveTree`; a `@slot`
value is a data placeholder, not literal text.

Legacy frames remain a read-only decoder (`ShpPackage`); the demo packer now emits a `.pkg`, and
the delivery-proof generator was removed with the scratch harness because it refused to write a
legacy frame. Tests may synthesize a legacy fixture to prove the decoder, but no production path
emits `SHPKG002` or `SHPKG003`.

The id rule is family-agnostic and is in `src/Openlock/Shell/FormatId.cs`: any
`family/<digits>` is a legacy id, any `family/<32 lowercase hex>` is a hashed id, and a hash this
reader did not compute is `format-hash-mismatch`. There is no `/1` special case. The surface
packer rewrites a numeric surface header to the current hashed header; the package reader accepts
a numeric package schema as a migration input, while every emitter writes the hashed id. This is
the path every legacy package family takes when it is upgraded: parse the old numeric id, record
it as legacy, and write the hashed id for the same contract.

Run the suite after building `src/Openlock`:

```text
dotnet run --project tools/tests/packagetests -- .
```

It uses the tracked legacy fixture and modern tree under `tools/tests/fixtures`, and deletes the
4 GiB + 1 proof payload after the round trip.

## 15. The Popit pair table (2026-11-19)

`shell/alpha-shell/popit-pairs.json` is a vendored data table, not a package format: it carries
`format: openlock.popit-pairs/3080abf5e17bdee04de3bc0b0b5d43ab`, the default pair and 37 entries
read from the Popit Forge pair data, each with `id`, `name`, `game`, `primary`, `secondary`,
`tertiary`, `emphasis` and the Popit Forge revision it came from. `tools/gen_popit_pairs.py`
validates every slug and `#RRGGBB` value, refuses a duplicate id or a default that is not a pair,
and emits `clientaddon/panorama/scripts/openlock_pairs.js` and
`clientaddon/panorama/styles/openlock_pairs.css`. `--check` makes the generated pair files stale on
any drift, so nothing hand-copies a hex value.

The roles are the ones LBP3 ships: `secondary` paints the Popit slab background, `primary` the
highlight/selected accent, `tertiary` the menu accent and `emphasis` the emphasised text. Ink is
computed from `primary` by relative luminance (dark ink above 0.55, warm ink below). Panorama
requires `#RRGGBBAA`, so the generator appends `E6` to the slab colour.

A pair is not a second palette. It writes only the Popit slab, title, chips, selected rows and
emphasis ink; the shell's ground, ink and single selection accent are not in the preimage. The
chosen id is persisted as `pair:<slug>` in the same `popit=` layout row as the surface
arrangement, and `LayoutProfiles.PopitPairPattern` refuses anything that is not a lowercase slug.
`tools/popit_parity.py` checks the data, the generated classes, the role order and the persistence
path, and writes `artifacts/receipts/popit-parity.json`.


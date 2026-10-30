KB_SNAPSHOT: UNPINNED

# Threat Model — dl-openshell (Openlock shell)

## System Overview Summary

A Deadlock (Citadel / Panorama) client-and-server mod with three artefacts built from one repository:
a C# game plugin (`src/Openlock`) that loads shell definitions, layout profiles and third-party
`.shpkg`/`.vpk` addon packages and publishes JSON payloads to players as panel attributes; a
Panorama client addon (`clientaddon/panorama`) that renders those payloads and owns the visible
desktop; and an installer/toolchain that builds, packs, verifies and installs the thing into a game
tree. The only runtime channel from plugin to client is the string attribute channel. The only
runtime channel from the outside world into the client is whatever the server operator chooses to
publish on that channel, plus whatever a package writer dropped in an addon directory. See
[architecture.md](architecture.md).

## Deployment Intent

**Intent: PRODUCTION**

The five-check gate was run from scratch against this KB (`SYNC_OCCURRED = true`; no prior verdict
was inherited):

| Check | Result | Evidence |
|-------|--------|----------|
| 1. No entity is CRITICAL/STANDARD availability | **FALSE** | `addon_discovery`, `shell_mount`, `client_shell_ui`, `addon_delivery_client` are STANDARD |
| 2. No externally reachable service / deployment descriptor | **FALSE** | `release/install.ps1` downloads release assets over HTTPS from GitHub (F8) |
| 3. No installable package or runtime entrypoint | **FALSE** | `Openlock.dll` is a runtime plugin entrypoint; release ships an installer + VPK |
| 4. All KB paths under test/sample dirs | **FALSE** | paths live under `src/`, not `test`/`examples` |
| 5. No real untrusted input into privileged logic | **FALSE** | server-authored payloads and on-disk third-party packages cross into the client/plugin |

One failing check is enough; five fail. This is a shipped product installed into players' game
clients and distributed as a release archive, so `PRODUCTION`.

## Trust Boundaries

### TB1 — Release origin → player installer

`https://github.com/<ReleaseRepo>/releases/…` and anything a caller sets with `-ReleaseBase`, into
[release/install.ps1](../../release/install.ps1) ([release_installer](entities/release_installer.md)).
Crossing: HTTPS bytes, a checksum asset, and a VPK whose structure is then re-parsed. The archive
and its checksum share one origin and one trust anchor.

### TB2 — Addon directories → plugin package parsers

Any file matching `*.shpkg` or `*.vpk` under the discovered roots (`citadel/addons`,
`addons/mods`, `deadworks_addons/vpks`, `deadworks_mods`, config paths) is read by
[addon_discovery](entities/addon_discovery.md), parsed by [shpkg_parser](entities/shpkg_parser.md)
and [vpk_reader](entities/vpk_reader.md). Those roots are shared with other mods and with anything
the player downloaded. Crossing: attacker-authored binary frames and recipe text into the game
process, and from there into the client's window set.

### TB3 — Game server → client shell (the main runtime boundary)

`UI.Panel("openlock-shell").Set(recipients, key, json)` in [shell_mount](entities/shell_mount.md)
delivers `addons`, `layout`, `build`, `update`, `observer`, `paths`, `active`, `view` to every
recipient client (F4). The client reads those as `dwv_*` attributes in
[client_shell_ui](entities/client_shell_ui.md) and
[addon_delivery_client](entities/addon_delivery_client.md). On a hosted server the author of those
strings is the server operator, not the player.

### TB4 — Player console → layout store

Console commands (`dw_ui openlock-shell|…`, layout save/load/reset/export) carry a scheme string
into [layout_profiles](entities/layout_profiles.md), which derives a filename from it and writes
JSON under the plugin's `layouts` directory (F7).

### TB5 — Installer authority → game tree

[release_installer](entities/release_installer.md) and [dev_installer](entities/dev_installer.md)
write into the game tree: a VPK into `citadel/addons/mods`, a search-path edit into `gameinfo.gi`,
plugin binaries into `managed/plugins`, plus build-tree deletes. [installer_pair](entities/installer_pair.md)
additionally writes an executable `install.ps1`/`install.cmd` into discovered install trees.

### TB6 — Worktree → running build (supply chain inside the repo)

[dev_installer](entities/dev_installer.md) may `git pull --ff-only` when the worktree is clean, then
compiles and packs whatever that revision contains and installs it. [build_toolchain](entities/build_toolchain.md)
generates the client data and the release checksum from the same worktree.

## Threat Actors & Vectors

### A1 — Malicious or compromised game server operator (remote, unauthenticated by the player)

Reach: TB3 only. Can set any attribute value on the shell panel for connected clients: arbitrary
JSON for addon payloads, arbitrary layout rows, arbitrary `observer`/`paths`/`build` text. Cannot
execute code in the client, cannot touch the filesystem. Goals available to them: spoof the shell's
own notifications (observer/build/update text), inject or replace addon windows, move/resize the
player's windows, inflate payloads to consume frame time, make the shell unusable on that server.
This is the actor with the widest remote reach and the least visibility to the player.

### A2 — Malicious addon author (local file drop, third-party mod package)

Reach: TB2. Can place a `.shpkg`/`.vpk` in a shared addon directory and have the plugin parse it at
startup or on delivery. Can choose frame bytes, recipe rows, artifact paths, window ids, geometry,
and the content of every node in a declared tree. Goal: get their UI into the player's shell, claim
another package's window ids, exhaust parser/renderer budgets, or exploit a parser bug to escape
the data model.

### A3 — Network attacker on the release download path

Reach: TB1. Can serve or modify a release asset if they control DNS/TLS termination, a mirror named
by `-ReleaseBase`, or the release itself. The checksum is fetched from the same origin, so it
constrains corruption, not substitution. Goal: get an arbitrary VPK installed into the player's
`citadel/addons/mods`.

### A4 — Local user with write access to the game tree

Reach: TB2, TB5. Already owns the machine and the game files, so this is a *lower*-value actor for
confidentiality/integrity of their own install, but a relevant one for other accounts on a shared
machine and for what a compromised tree can make the installer or the plugin do on next run.

### A5 — Malicious dependency or upstream revision

Reach: TB6. Can change the worktree the dev installer builds, the code the plugin runs, and the
bytes the release checksum covers. Goal: persist code in every future build.

### A6 — Player-issued command with hostile arguments

Reach: TB4 (and the console command handlers). Goal: read/write outside the layouts directory,
overwrite an unrelated file, or make the plugin throw inside the game thread.

## High-Risk Assets

| Asset | Why it matters | Availability tier |
|-------|----------------|-------------------|
| The player's game install (`gameinfo.gi`, `citadel/addons/mods`) | survives the session; a bad edit breaks the game, not just the mod | STANDARD |
| Client shell availability (frame time, window layer) | a payload storm or malformed tree can make the client unusable on a server | STANDARD |
| Addon window set / package identity | spoofing or shadowing another package's windows is a UI-integrity break | STANDARD |
| Layout profiles and split cells | player-authored state; loss is recoverable but visible | LOW_CRITICALITY |
| Release archive authenticity | the only path that puts code in front of every player | STANDARD |
| Developer machine and build outputs | widest privilege in the system (`resourcecompiler`, Python, `git pull`, deletes) | STANDARD |
| Parity / witness evidence | the project's own definition of "verified"; forged evidence is worse than none | LOW_CRITICALITY |

## Surface Inventory and Existing Controls

| Boundary | Entry points | Controls present in the KB | Residual question (for the researcher stage) |
|----------|--------------|---------------------------|----------------------------------------------|
| TB1 | release asset URL, checksum asset, `-VpkPath`/`-HashPath`, `-ReleaseBase` | SHA-256 required and format-checked; hash re-checked after copy; VPK tree re-parsed; game-running guard; refuses on download failure | Is the checksum's provenance separated from the archive's? What does `Test-VpkArchive` actually bound? |
| TB2 | frame magic/length/digest, artifact table, recipe rows, window ids, geometry | magic equality; length vs frame; constant-time digest compare; strict UTF-8; trailing-byte checks; path allowlist (`..`, `\`, absolute); size ceilings; per-package byte cap | Do recipe parsing and window ids have the same rigour as the frame? Is the artifact path ever turned into a filesystem path? |
| TB3 | `addons` JSON, node trees, `layout` rows, `observer`/`paths`/`build`/`update` text | 4 MiB cap; 512 node / 24 depth caps; tag allowlist; style `url(` rejection; attribute allowlist; revision monotonicity; package-version monotonicity; chunked render; **layout 4 MiB cap and finite-rect validation (F1/F2); observer layout path restricted to `file://{resources}/layout/` (F3)** | Layout *provenance* remains: a server can still rearrange windows and inject split cells (F5). `view`/`refusal`/`body` churn still forces bounded work per poll (F6). |
| TB4 | scheme string in console command | regex validation; containment check after `GetFullPath`; atomic write; no-overwrite export | Does every read path (load/reset/export) go through `PathFor`? What happens on a symlinked layouts dir? |
| TB5 | game tree paths, `gameinfo.gi` splice, install targets, delete scopes | existence checks; backup before edit; hash after copy; parity gate; scoped deletes | Is the `gameinfo.gi` edit idempotent and reversible? Can a crafted existing file make the splice wrong? |
| TB6 | worktree, generated data, release bytes, parity cells | clean-tree check before pull; generated data written to build tree; digest-stamped outputs; dev-cell refusal on drift | Is any generated artifact trusted without re-deriving its digest? Can a stale witness still read as current? |

## Trust Assumptions Worth Testing

1. **Panorama grants no ambient capability.** If a payload can only produce panels, strings and
   styles, the client is a display surface, not an execution surface; the model's severity depends
   on this holding for every attribute consumer (`html`, `src`, `tooltip_text`, `SetAttributeString`).
2. **The plugin is the only authority on window identity.** A client-side id that a server or a
   package can choose is a naming decision, not a security control.
3. **A checksum from the same origin is integrity, not authenticity.** The release path currently
   has no out-of-band signature; the model treats a compromised origin as equivalent to a
   compromised release. The repository's package envelope (`tools/package_envelope.py`) does not
   change this: it is HMAC-SHA256 over recipe text with a machine-local key, so a player's machine
   would refuse every signed package as `untrusted-key`, and shipping the key with the installer
   would let anyone forge. See F7.
4. **Discovery roots are shared writable space.** Anything a player can download into
   `citadel/addons` reaches a parser running in the game process.
5. **Evidence tools are honest.** Parity/witness output is accepted as proof; a tool that reports a
   surface it did not observe would invalidate the project's verification claims rather than a
   running feature.

## Findings From This Pass

Evidence is the code in `clientaddon/panorama/scripts/` and the assertions in
`.scratch/chrome-test.js` that drive the real shell with a host panel whose attributes a server
would author. Each fixed finding has a named refusal and a passing assertion.

### F1 — the layout attribute had no size bound (fixed)

`parseLayoutPayload` accepted any string and ran `JSON.parse` synchronously in the 0.5 s poll,
while the addon and observer channels already refused > 4 MiB. A server could hold the frame with
a multi-megabyte `layout` value on every change. Fixed with `MAX_LAYOUT_CHARS = 4 * 1024 * 1024`,
a check **before** parsing, and the refusal `Layout payload refused — payload is larger than 4 MiB
or is not text`; the previously applied profiles stay mounted because the payload is rejected
whole. Assertion: `a layout payload over 4 MiB is refused before it is parsed`.

### F2 — saved geometry was coerced, not validated (fixed)

`out[id] = { x: Number(rect.x) || 0, … }` turned `NaN` into `0` and accepted `"Infinity"`
(truthy) and negative or enormous widths. `applyRect` then stored that rect and the layout pass
clamped it, so a hostile profile could silently move a window to the origin or to an impossible
size. Fixed with `savedRect`: four finite numbers, `w`/`h` ≥ 1, all within ±1 000 000 px; a profile
that declares one is refused whole as `Layout profile refused — <scheme> (window — <fact>)`, kept
out of `layoutProfiles`, and listed in the Refusals view. `__proto__` as a scheme or window id is
refused for the same reason (F4). Assertions: `a non-finite saved rect refuses the layout profile
by name`, `the refusal says which fact failed`.

Addon window records do not share this hole: `num()` maps any non-finite value to 0,
`ensureGeometry` defaults those to 16/64/480/440, `setRect` floors width and height, and the layout
pass refuses an oversized participant by name ("needs W×H in … after the shell reserves its
edges"). A huge finite value is therefore a refused layout, not an arbitrary rect.

### F3 — an observer layout path reached `BLoadLayout` unfiltered (fixed)

The observer payload is server-authored; its node `tree` went through the delivery allowlist, but
its `layout` string was passed straight to `surface.BLoadLayout(...)`, so a server could point the
client at any read path. Fixed with `observerLayoutPath`: the value must be non-empty, ≤ 512
characters, contain no `\` or `..`, and start with `file://{resources}/layout/`. Otherwise the
surface is not loaded and the refusal is `Observer XML refused — <fact>: <path prefix>`. The
package producer (`AddonPackages.LayoutPathFor`) only ever emits that prefix, so the allowlist
does not narrow legitimate use. Assertions: `an observer layout path outside the resources layout
directory is not loaded`, `the observer refusal names the missing prefix`, and the positive case
`an observer layout path inside the resources layout directory still loads`.

### F4 — prototype keys were accepted as names (fixed)

A JSON object can carry an own `"__proto__"` key. Assigning it as a scheme or window id mutates
the object's prototype instead of adding a row, so the row vanished and the map gained a foreign
prototype. Both are now refused by name. The legacy (unwrapped) profile shape also skips its own
`active`/`tab`/`pinned`/`minimized`/`popit` keys instead of reading them as window rows.

### F5 — layout provenance is not distinguishable (modelled, not fixed)

The client has no local store: the plugin owns `layouts/*.json`, and the attribute that carries
profiles is the same one a server can author. A server can therefore rearrange a player's windows,
split any panel window by injecting `cell:` rows, and have that arrangement written into the
player's profile on their next Save. Impact is UI integrity and persisted state pollution, not code
execution. Fixing it needs a client-side provenance marker or a client-local store, which is a
window-manager change this pass deliberately did not make.

### F6 — churn and dead inputs (modelled)

`layoutrequest`, `view`, `refusal` and `body` are in the poll signature: a server changing them
forces a save or a re-render per poll (bounded, no unbounded allocation). `active` is guarded by
`windowById`, and `observer.window` reaches `openWindow`, which refuses an id it does not know by
name. Split keys (`openlock_split.stableKey`) are derived from kind/name/class and sanitized to
`[A-Za-z0-9_]`, truncated at 64 characters, so a server-authored window id cannot smuggle
punctuation into a cell key; only the derived key is used. `paths`, `layoutexport` and
`observer.body` are display text only. Note that
`dwv_build` and `dwv_update` are published by `ShellMount.PublishBuildStatus` but **never read** by
the client — the update window uses the generated `data.update` record, so a server cannot drive
the restart path. Those two attributes are dead surface, not a vulnerability.

### F7 — the release envelope cannot verify a release asset (answered, not applied)

`tools/package_envelope.py` is HMAC-SHA256 over the recipe *text* with a machine-local key outside
the checkout; a signed package on a machine without that key is refused `untrusted-key`. Three
reasons it cannot verify `openshell-player.vpk` for players:

1. **Symmetric authority.** Verifying needs the signing key. Shipping it inside the installer or
   the signed asset publishes the forge key; a player who can read the installer can sign anything.
2. **Wrong payload.** The envelope covers the file's lines with the envelope block removed — a
   recipe document. A VPK is binary, and the player archive has no recipe lines to sign.
3. **Work is not authority.** The nonce proves leading zero bits were spent, which raises the cost
   of grinding a replacement and binds the statement to a digest; it does not say *who* signed.

The release path correctly keeps SHA-256 as an integrity check and does not pretend it is
authenticity. If authenticity is required, the shape is an asymmetric detached signature (e.g.
Ed25519) with the public key pinned in `release/install.ps1`, plus a digest published outside the
release origin — not this envelope, whose trust model is "the machine that holds the key already
trusts itself".

## Out of Scope for This Pass

- The game engine's own Panorama/Citadel vulnerabilities.
- Steam, GitHub and the CDN as infrastructure (assumed functional, not assumed honest).
- Anti-cheat or DRM interactions.
- Multiplayer fairness or server-authoritative game logic outside the shell's UI channel.

# Live delivery — what was observed, and where

This file records the evidence for the live-package path: versioned replacement, atomic
apply-or-reject, observer toasts that carry a live tree, and a node renderer that honours the
attributes it used to drop. It is deliberately split into **observed in the running client**,
**observed in the deterministic harness**, and **not proven**, because this pass could not
reproduce the live exchange end to end. No claim here goes past its evidence.

The shipped code is `clientaddon/panorama/scripts/openlock_delivery.js` (payload parsing, version
gate, atomic window set, observer payloads, chunked node renderer) and the delivery hooks in
`clientaddon/panorama/scripts/openlock_shell.js`. Both are packed into the installed VPK; no
proof hook or scratch artifact is in the package.

## 1. The bounded live attempt (this pass)

Harness: the hidden dedicated server (`deadworks.exe -dedicated -console`, private window) and
the hidden client on the private desktop (`D:\SteamLibrary\...\deadlock.exe -windowed -noborder`,
launched with `.scratch/launch-client-hidden.py`). No synthetic mouse or keyboard input was sent
to the game. The three commands were written by one long-lived console attach
(`.scratch/proof-exchange.py`) so the server's console input handle was never detached between
them:

```text
attached to 29144; plan is [(6, 'dl_openshell_deliver .../proof-v1.shpkg'),
                            (34, 'dl_openshell_deliver .../proof-v2.shpkg'),
                            (62, 'openlock_observer addon:proof-ui:proof-panel')]
t=6s  wrote=154 ok=1 :: dl_openshell_deliver .../proof-v1.shpkg
t=34s wrote=154 ok=1 :: dl_openshell_deliver .../proof-v2.shpkg
t=62s wrote=90  ok=1 :: openlock_observer addon:proof-ui:proof-panel
```

The writes succeeded at the Win32 layer, but the engine's command loop executed none of them. The
client log for the whole session contains exactly one delivery, and it is the server's own
package, not the proof package:

```text
13:17:19 [PanoramaScript] [Openlock] delivery: applied revision 1 packages=1 +1 ~0 -0 window=addon:motd-demo:motd-panel
```

No `delivery: applied` line for `proof-ui` exists, no `chrome frame: addon:proof-ui:proof-panel`
line exists, and the proof hook's own probes — the shell catalog every second for 90 s — never see
the window:

```text
13:16:46 [PanoramaScript] [Openlock] PROOF hook fired windows=348 expanded=0
13:16:47 [PanoramaScript] [Openlock] PROOF probe windows=348 tries=0
13:17:19 [PanoramaScript] [Openlock] PROOF probe windows=349 tries=30
13:18:19 [PanoramaScript] [Openlock] PROOF probe windows=351 tries=90
```

`docs/delivery-exchange-final.png` is the capture taken at the end of that session: the shell is
mounted, the game is in the hero-select state, and there is no proof window and no observer toast
— the observer command was never executed either.

The same shape appeared in the pass immediately before this one: the only delivery the client
ever logged was the server's automatic `motd-demo` push at shell mount, and none of the three
proof commands executed. The server's own log repeats
`CTextConsoleWin::GetLine: !GetNumberOfConsoleInputEvents` for the whole run, i.e. its console
input handle is not readable. Earlier passes did get commands through (the captures in §3 are
from those runs, and the server log then read `addon delivered live from …proof-v3.shpkg: 1
window(s), revision 3`); the last two passes could not, and per the bounded instruction the
harness was not repaired again.

**So: the v1 → v2 window swap and the observer toast were NOT observed in the running client in
this pass.** They were observed in the deterministic harness (§2), and the observer toast was
observed in an earlier live pass (§3).

## 2. Deterministic harness over the same module

`.scratch/test_delivery.js` runs `clientaddon/panorama/scripts/openlock_delivery.js` in Node with
a small fake panel API, so the payload parsing, version gate, atomic window set, node attribute
mapping and render log are the same code the client runs.

```text
$ node .scratch/test_delivery.js
delivery harness: PASS
info: render addon:addon:proof-ui:proof-panel nodes=6 images=1 progress=25 hidden=1 disabled=0 selected=1
info: render addon:addon:proof-ui:proof-panel nodes=6 images=1 progress=75 hidden=1 disabled=1 selected=1
info: render slider nodes=1 images=0 progress=50 hidden=0 disabled=0 selected=0
```

What it asserts:

- v1 is **added** (`added=1`) and its title, image `src`, `value`, `visible` and `enabled` land on
  the created panels; children keep source order.
- v2 with the same window id is **updated in place** (`updated=1`, window count still 1), the
  title and image `src` are replaced, `value="0.75"` becomes `progress=75` (and `0.25` becomes
  `progress=25`), `visible="false"` collapses the panel, and `enabled="false"` disables the
  button — the render log reads `progress=75 … hidden=1 disabled=1 selected=1`.
- The determinate fill the renderer draws for a progress value is 75% wide
  (`ProgressFill`, `style.width === "75%"`); the engine value is set as well.
- An invalid window set (a second window that names no delivered package) is refused and the
  window catalog is **unchanged** — atomic apply-or-reject.
- An observer payload carrying a `tree` reaches the host with the tree intact; an observer
  attribute larger than 4 MiB is refused **before** `JSON.parse`, so a host-supplied tree cannot
  spend the frame parsing it.
- A `Slider` with a `value` still gets the scaled value but **no** determinate fill child: only a
  `ProgressBar` is given one.
- A refused replacement that fails halfway through the catalog write is rolled back: the window
  catalog, its index and the per-window signatures are restored together, so re-delivering the
  previous content is correctly a no-op rather than an update. (The harness forces the write to
  throw with a proxy; a malformed payload alone is rejected before it touches the catalog.)
- A payload carrying a package record with **no windows** applies cleanly, adds no window and
  reports a zero window delta — the client half of a successful zero-window delivery.

The server half is `.scratch/deliverytest` (a scratch console over the compiled plugin):

```text
$ dotnet run --project .scratch/deliverytest/deliverytest.csproj -c Release
...
ok   a zero-window package reports success, not a refusal
ok   refusal records stay bounded by the package ceiling
ok   the bounded set keeps the newest refusals (64 of 80)
server delivery harness: PASS
```

It covers v1→v2 replacement, an older version refused with v2 left mounted, a refused replacement
not republished, a zero-window package reported as success (`added=0`, `changed=true`, empty
reason, revision advanced), and 80 invalid-name refusals kept at the 64-package ceiling instead of
growing without bound.

What it does not prove: the engine's real panel API, the server's payload serialization, or that
streaming a large payload never stalls a poll frame on a live client.

## 3. Live evidence from earlier passes

`docs/delivery-observer-toast.png` (live client, earlier pass). The toast stack shows the package
update result and the observer toast carries the window's live tree:

- `Packages updated — 2 package(s) · 0 added · 1 updated · 0 removed`: an already-mounted package
  was replaced in place; nothing was added or removed.
- `Delivery proof / observer XML · proof-ui` with the package's own XML inside it: kicker, title
  `v3 · refreshed package`, a Deadlock warning icon (an `Image` with a `s2r://` source), a
  progress element, the `v3 · 75%` readout and a control.

`docs/delivery-observer-toast-v2.png` (live client, earlier pass): the same toast path carrying
the first v2 tree (`v2 · replaced in place`, `2 added`), i.e. the observer surface renders the
delivered window's source tree rather than a mounted layout path.

Observed live in those passes:

- In-place replacement of a mounted package (`updated=1`, `added=0`) and the observer surface
  then rendering the **new** revision's tree.
- The observer payload carrying a live tree; the toast renders that tree, including an image
  source and a `0.75` progress value, with no JS exception in the client log.
- The engine's own `ProgressBar` fill is not styled by a package, so in those captures the bar
  reads as an empty trough; the 75% value is legible only through the package's own readout
  text. The determinate `ProgressFill` added in this pass has **not** been captured live.
- The delivered **window's** own content (as opposed to the observer toast) was never captured
  live; only the observer toast and the update result were.

## 4. Proven / not proven

| Behaviour | Evidence |
|---|---|
| v1 → v2 replacement in place, same window id | harness (deterministic); live in an earlier pass at the package level (`0 added · 1 updated`) |
| Atomic apply-or-reject, catalog unchanged on refusal | harness only |
| Node attributes: `src`, `value`, `enabled`, `visible`, `selected`, source order | harness only (0.25→25, 0.75→75, `hidden=1`, `disabled=1`) |
| Observer toast carries and renders a live tree with an image and a 0.75 value | live capture, earlier pass; harness for the payload path |
| Determinate 75% fill visible on screen | not proven — harness only |
| Streaming a large payload without stalling the shell | not proven this pass (module is chunked; no live measurement) |
| v1 → v2 swap in the proof window on this final pass | not observed — the console channel executed none of the commands |

## 5. Delivery hardening in this pass

Closing the review of the delivery state machine changed the following. Each line names what was
wrong and what now holds:

- **Rollback restored the window array but not the signatures, and the snapshot was shallow.**
  Updated records are now replaced in the catalog rather than copied onto in place, and a rollback
  restores the catalog, index, signatures, revision and applied versions together. Verified by the
  forced-write harness case above.
- **Refusal records could grow the package list past its 64-package ceiling.** `CommitRefusal` now
  drops the oldest refusal-only record at the ceiling and never a mounted package. Verified: 80
  invalid-name deliveries leave 64 records and revision 80.
- **The delivery notice named `Windows.LastOrDefault()`.** It now names the first window of the
  package the delivery changed (`AddonPackages.LastChangedWindow`), or no window for a refusal.
  Verified in the server harness.
- **The observer attribute persisted, so a later shell mount could replay the last toast.**
  `Show`/`Open` clear `observer` when they mount the shell. The one-shot channel therefore survives
  a remount as a clear attribute, not as a stale toast. Not observed live in this pass (no client
  mount was attempted).
- **A live delivery had no payload size ceiling matching the client's 4 MiB.** `Add` now serializes
  the candidate payload for live deliveries and refuses the package before committing when the
  result would exceed 4 MiB, so the previous version stays mounted and the client is not locked to
  an unparseable payload. Compile-checked and reviewed; not exercised (no 4 MiB package was built).
- **`CmdDeliver` called a zero-window success a refusal.** `DeliverAddon` now returns `delivered`,
  and the command distinguishes a committed zero-window package from a refusal. The state-level
  half is in the server harness; the reply branch is compile-checked.

## 6. Installed archive

The final install contains the source above with no proof markers:

```text
D:\SteamLibrary\steamapps\common\Deadlock\game\citadel\addons\mods\pak01_dir.vpk
sha256 eb31e9c71cac75099f12d44bb085e11283ba309606535199855955c7180a3d52
panorama/scripts/openlock_shell.js     262,025 bytes   no "PROOF", no "proof-ui"
panorama/scripts/openlock_shell.vjs_c  262,857 bytes   no "PROOF", no "proof-ui"
panorama/scripts/openlock_delivery.js   25,619 bytes   "applied revision", "ProgressFill", 4 MiB observer bound
worktree source digest 7810624dbd0cf245782b841699c98c576b388d7fbfd16ccc8c51e05d14bd4c91
```

`python tools/parity_check.py --install D:\SteamLibrary\steamapps\common\Deadlock` reports
`parity PASS` with the install holding `sha eb31e9c71cac; hash matches the built archive; commit
628d7b7+; installer record installed/ok; mount present` and the live reading matching the current
source. The one drift line is the unrelated `Reduced_CSDK_10` tools tree, which carries an older
build.

The scratch packages (`proof-v1.shpkg`, `proof-v2.shpkg`), the exchange driver and the harness
live in `.scratch/` and are not packed into the archive. No `deadlock.exe` or `deadworks.exe`
process was left running after the install.

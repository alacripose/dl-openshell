# UI pass — the design contract, measured

This pass squares the shell's look with the design record the project already carries:
`ala_package_designer`'s Holo palette, `shploingus-clean`'s MD1 / TouchWiz / iOS 6 lineages
(`docs/UI-SPEC.md` §8, `docs/HYPERGRILLING.md` H-7.26 and H-16.1), and the token buckets in
`crates/voxel-ui/src/lib.rs` (MD1 rule / MD1 example / platform translation / project extension).

There is no platinum-tier predicate in this repository. This file records the bars this pass can
measure and the bars it does not claim, rather than inventing a tier.

## 1. Two axes, not one theme list

A **scheme** is the palette. A **form** is the chrome language: radius, border weight, control
shape, title typography and tab-strip treatment. A `.theme` file declares both (`form` is a row),
the generator emits one `.Scheme<Id>` palette block and one `.Form<Form>` geometry block, and
`openlock_shell.js` puts both classes on the shell root and the game HUD root.

| Scheme | Form | Source | Measured ink/body | Muted/body | Accent/body |
|---|---|---|---|---:|---:|---:|
| `deadlock` | `deadlock` | `citadel_base_styles.vcss_c` | game palette | — | — |
| `alpha` | `alpha` | original shell palette | — | — | — |
| `holo` | `holo` | `ala_package_designer` `theme.rs` + `look.rs` | — | — | — |
| `material` | `material` | MD1 dark values, 8 dp grid, 2 dp radius | 18.73:1 | 8.64:1 | 5.10:1 |
| `ios` | `ios` | HIG (iOS 6 era) / SpringBoard | 18.29:1 | 9.45:1 | 6.60:1 |
| `touchwiz` | `touchwiz` | TouchWiz Nature UX surface + colour intent | 18.56:1 | 9.31:1 | 10.61:1 |

The contrast column is WCAG 2.1 arithmetic on the declared hex values (`min 4.5:1`). The forms
keep the 30 dp chrome height this shell already uses; the 48 dp MD1 row is a touch target and this
shell is pointer-driven. That translation is stated in the form block instead of being passed off
as an MD1 example.

## 2. Popit layers are schema, not a second UI

A window can carry one contextual tool layer. The layer is declared beside the window in
`package.shspec`:

```text
layer	inventory
	title	Inventory tools
	surface	ring
	hint	Select a tool, then a slot.
	action	trees	Crafting trees	trees
	action	picker	Picker	picker
	action	reconcile	Reconcile
```

`surface` is `grid` (the renderer accepts the older `ring`/`bar` declarations but draws the same
tool grid). `action` is `id`, `label` and an optional target window. Both the C# reader
(`ShellPackage` / `ShpPackage`) and the generator validate that the window exists, the actions are
unique, and an action's target is declared. The client routes the chosen action as
`layer:<window>:<action>`; a server or tools instance can answer it through the same `dw_ui`
channel.

The surface itself is `clientaddon/panorama/scripts/openlock_popit.js`, included in
`openlock_shell.xml` beside `openlock_audio.js`; `openlock_shell.js` only supplies geometry, the
open-window rectangles and the action callback, so the surface can change without growing the
shell. It is a real panel, not a ring of text rows:

- **Frames are shape schemas.** `shell/alpha-shell/forms/popit.form` declares the LBP3 rounded
  hexagon (six edge segments over a 53 px plate whose corner radius meets the 45-degree chamfers),
  the LBP1 bubble, the LBP2 flat block, the PSP page, the Vita card and the Karting beam card.
  Each version is a class on `.PopitFrame`/`.PopitTail`; the frame badge cycles them.
- **Colour stays in palettes.** `tools/gen_shell_theme.py` emits only colour roles for
  `.PopitPlate`, `.PopitTail`, `.PopitHexEdge`, `.PopitTile` and their states. No `.theme` and no
  form other than `popit.form` declares a Popit radius, size or silhouette.
- **Tiles are Deadlock art.** `iconFor` resolves `s2r://panorama/images/...` textures by action id
  and then by label; the tile is an `Image` plus a label, with `Hover` and a single `Selected`
  state. The CREATE/PLAY pill is local to the surface and never sends a game mode.
- **Overlap is a refusal.** `place` clamps six candidates to the screen box and tests each against
  every other open floating window; if all collide it calls the shell's refusal path instead of
  drawing over the other window.

`docs/popit-elements.json` (`openlock.popit-elements/1`) is the machine-readable inventory: every
implemented element has a stable `popit.*` id, the file that supplies it, the selector or symbol,
the source section of the Popit comparison document, and its acceptance line. The requirement
ratchet can build on that list instead of re-deriving the surface.

### Popit proof

The surface was opened by a proof-only boot hook on the private desktop build, captured, and the
hook removed before the final install (no synthetic mouse or keyboard input). Client log:

```text
[PanoramaScript] [Openlock] shell ready: alpha-shell v1-alpha commit=628d7b7 src=9767b33a278f game=6821 windows=348 refusals=9
[PanoramaScript] [Openlock] popit: open lbp3 5 tile(s) at 904,150 form=popit
[PanoramaScript] [Openlock] PROOF status {"visible":true,"frame":"lbp3","mode":"create","actions":5,"rows":2,"placed":{"x":904,"y":150}}
```

No `JS Exception`, `PanoramaScript` error or Popit warning followed the open. The capture,
[`docs/popit-surface.png`](popit-surface.png), shows the LBP3 frame with its tail, the frame badge,
the CREATE/PLAY pill, five Deadlock-art tiles, the selected first tile and the detail/hint lines.
The final install removes the boot hook; `openlock_popit.js`, `popit.form` and the generated
Popit palette rules are byte-identical between the proof build and the installed archive. The
archive the surface was captured on was SHA-256
`766B71C6EDFA413A5A2F7E2A071101005DDB0164CF1D3E7B000114ADD2D4D880`; the final campaign archive
(`D:\SteamLibrary\steamapps\common\Deadlock\game\citadel\addons\mods\pak01_dir.vpk`) is
`eb31e9c71cac75099f12d44bb085e11283ba309606535199855955c7180a3d52`, matching
`dist/openlock_ui/pak01_dir.vpk`. It still contains `panorama/scripts/openlock_popit.js`
(17,628 bytes, byte-identical to source) and the six `pre-transform-rotate2d` shape rules,
declares all five Popit layers as `surface grid`, and contains no `PROOF` marker in
`openlock_shell.js`.

## 3. Picker

The Picker window is a Popit tool (`action picker … picker`). It starts a pointer-capturing
overlay, streams the live HUD in bounded chunks, highlights the smallest panel under the cursor,
and on click records the panel's current `transform`, size, opacity and colour values. The window
then edits only that panel; `Restore selected panel` puts the captured values back. The overlay
exists only while scrubbing, so no game input passes through it at any other time.

## 4. Performance

`window performance` (`content performance`) is an ordinary declared window. It draws a
57 px panel graph from the measured UI frame interval, counters for polls / applies / style writes
/ skipped writes / HUD scans, a per-window mean/max apply-cost table, and the last entries of a
64-line bounded ring. Refusals, live package merges, scheme changes, Picker edits and slow
applies (over 8 ms, throttled) write to that ring; `$.Msg` is reserved for warnings and refusals.
Opening the window can therefore not be the reason a frame is missed.

The measured before/after for the idle/open stalls, including the log lines and the installed VPK
hash, is in [`docs/SHELL-IDLE-PERF.md`](SHELL-IDLE-PERF.md).

## 5. Delivery

The client consumes two host attributes every poll:

- `addons` — `openlock.addons/2` JSON. New windows join the catalog, changed windows update in
  place, removed package windows close. A window with a `liveTree` is built with `$.CreatePanel`;
  a compiled-only package keeps `BLoadLayout`. Neither path mounts a new resource.
- `observer` — a notice (`title`, `body`, `window`, `layout`, `attention`). The toast stack is
  present in every grade. An optional `layout` is mounted inside the toast; a `window` makes the
  toast open that window. `openlock_toast` sends a plain notice; `openlock_observer` sends a
  package window.

The evidence for the live path — which behaviour was observed in a running client and which only
in the Node harness — is in [`DELIVERY.md`](DELIVERY.md), including the captures and the installed
archive hash.

## 6. UI audio

The shell speaks four cues, not an ambient bed: `select` for opening or choosing, `place` for a
value that landed, `refuse` for a declined action, and `notify` for an observer or package update.
They are the ala-cities reference's four `Sound` variants, synthesized deterministically by
`tools/gen_shell_audio.py` and compiled into the addon instead of being sampled at runtime.

Panorama can only play a named soundevent, so the generator writes both halves: four mono WAVs
and `soundevents/openlock_ui.vsndevts` with `Openlock.UI.{Select,Place,Refuse,Notify}`. The
soundevent file must carry the KV3 header, and its `vsnd_files` rows must name the compiled
`.vsnd`, not the `.wav` source; both mistakes are checked by `gen_shell_audio.py --self-test`
before the installer accepts the build. The runtime layer is
`clientaddon/panorama/scripts/openlock_audio.js`: one 40 ms throttle per cue, and a missing
`PlayUISoundEvent` leaves the shell silent rather than refusing a layout.

The four cues are deliberately closed. A Popit hover, tab change or picker scrub that needs its
own character is a design decision for the next surface pass, not a fifth variant smuggled into
the existing table.

## 7. Bars not claimed

- **Keyboard reachability / gamepad focus** is still not implemented: the shell is pointer-only by
  design so it never inserts a second focus graph into Deadlock's control suite.
- **Reduced motion** has no user-facing switch yet; the idle-chrome animation is unchanged.
- **Live rendering**: the Popit surface was rendered and captured on the proof client (see §2),
  including the LBP3 shape and the icon grid. The other five frame variants and the picker are not
  captured yet; the C# build, generator, schema check and source-level click check cover them only
  statically.
- **Audio mix** is not measured on a device. The samples are bounded and the compiled soundevents
  load, but perceived loudness against Deadlock's own UI remains a listening check.

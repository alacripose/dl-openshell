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

## 2. Popit is the cell editor

The Popit is not a second shell and it is not a CREATE/PLAY menu. It is the editing layer for a
window or a live HUD cell, modelled on the systems inside the games: the Popit Cursor selects and
highlights an object in the player's colour, the Goodies Bag applies materials, Stickers &
Decorations apply a decoration tinted by that colour, the Tools Bag carries the Tweak values and
Player Color changes the surface's colour. The references used for this model are listed in
`docs/popit-elements.json`; the old comparison PDF and its invented hexagon/tail/frame-badge
inventory are not used.

The surface is `clientaddon/panorama/scripts/openlock_popit.js`. It follows the two design
bibles, `POPIT-RE-AUDIT-v5` and `OPENLOCK-CONFLUENT-DREAMS-INTERLINE-REV06`:

- **Root and child.** The root is one persistent instrument: wordmark, pair chip, Classic chip,
  the selected target and six section rows (Cursor, Palette, Goodies, Stickers, Tools, Color).
  Opening a section reveals a contextual child beside it; opening another section replaces the
  child body only. Back closes the child and leaves the root mounted, so the surface never swaps
  one page out for another.
- **Cursor section.** Lists only targets the shell can bind to a live panel or cell. It does not
  list package windows the game has not drawn. Choosing a row retargets the editor.
- **Cursor halo.** A hit-test-free `.PopitCursorHalo` outlines the selected cell's measured
  rectangle in the current Player Colour. This is the hover/selection state, not another window.
- **Palette section.** All 37 player colours from the Popit Forge table, vendored as
  `shell/alpha-shell/popit-pairs.json` under `openlock.popit-pairs/3080abf5e17bdee04de3bc0b0b5d43ab`
  and generated into JS and CSS by `tools/gen_popit_pairs.py`. Tiles are grouped by the game each
  pair shipped in and carry the three-colour band. The chosen pair is a class on the surface;
  Classic removes it and the scheme's own roles return. The LBP3 role order is honoured:
  `secondary` is the menu background, `primary` the highlight/selected accent, `tertiary` the menu
  accent and `emphasis` the emphasised text.
- **Goodies Bag.** Paper, Card, Glass, Tint, Ink, Accent and Bare become recorded inline writes on
  the selected panel: background, border, radius and opacity. The theme's roles supply every
  colour; the module has no hex literal.
- **Stickers & Decorations.** Edge, Stitch, Tag and Corners write a border treatment in the
  Player Colour. Stitch uses a dashed edge; Tag uses a left band; Corners sets the top-left
  radius and two edges.
- **Tools Bag.** Corners, border width and opacity are separate buttons; Restore this cell removes
  every Popit write and returns the panel to the values captured before the first edit.
- **Player Color.** The scheme's roles plus Default; the chosen role recolours the halo, the
  decoration and the active tool accent.
- **Persistence.** A cell's style travels in its own layout row as the fixed alphabet
  `m[0-6]c[0-6]d[0-4]r(-1|0|6|12|18)b(-1|0|1|2|3)o(-1|75|90|100)`. The chosen pair travels in the
  same `popit=` row as `pair:<slug>`. The C# `LayoutProfiles.PopitStylePattern` accepts only that
  alphabet and `PopitPairPattern` validates the slug, so a profile can never inject CSS.
- **Motion.** The child reveals over 220-280 ms with the root shifting aside. `setReducedMotion()`
  in the module and `OpenlockSetPopitMotion()` in the shell are the real suppression path: the
  same state and order remain and only the transitions stop.

The old `.PopitFrame`, `.PopitTail`, `.PopitHexEdge`, `.PopitPlate`, `.PopitTile`, mode-pill,
spine and tray selectors are gone from the module, the form and the theme generator. The form
declares `.PopitRoot` and `.PopitChild` with a crowned per-corner approximation. Panorama cannot
 draw the bibles' single Bezier contour, so that gap is named in `forms/popit.form` and in the
parity gate's `not-implemented` line instead of being passed off as the contour.

**Proof state.** The Node harness (`tools/tests/popit-test.js`, 65 checks) proves the persistent
root, the child reveal and Back, the 37-pair Palette, Classic, reduced motion, target selection,
material/decoration/tweak/colour edits, the profile alphabet and the profile row grammar. The
dashboard harness (59 checks) proves the same surface opens from the dashboard, paints the live
fake HUD panel and writes the style and pair into the saved row. `tools/popit_parity.py` holds
386 declared facts across the elements inventory, the pair roles and the persistence path, and
`tools/ui_prose.py --check` reports no hits in the three scripts this rework owns.

**Browser witness (2026-11-19).** `node tools/browser_probe.js` drives the shipped module in
headless Chromium through a Panorama-to-DOM host (`tools/browser/panorama-dom-host.js`), with
`tools/browser/popit-probe.html` serving the real scripts and the real translated stylesheets. It
reports 59 checks: the root element and its six rows keep the same node instances across a
section change, the child reveals beside the root and Back hides only the child, two pair slugs
round-trip through `encodeProfile`/`decodeProfile` into a reload, the LBP3 roles render as
`secondary` slab / `primary` border and selected states / `tertiary` wordmark / `emphasis` detail,
Classic returns the scheme's slab, and `setReducedMotion` turns the computed child, root and
surface transition durations to `0s` while the normal path reads `0.22s`/`0.28s`. Measured
contrast on the slab for `lbp1-yellow-fuchsia`: wordmark 1.05:1, emphasis 3.22:1, border and page
dot 3.82:1. The source pair sets that ratio; the role mapping is correct, the palette is not
silently retuned to pass a contrast target. Receipt: `artifacts/receipts/browser-probe.json`.

The landing page was measured in the same browser at 1280x900 and 420x900: no local console
errors or failed local requests, the Popit root (272x315) and child (314x282 / 352x271) render
non-zero and do not overlap, the eight pair bands are 12 px tall with three computed colours
each, and the four control-plane rows are present. The browser witness is a Chromium DOM, not
the Deadlock client: no person has witnessed this surface in the built client, and the old
CREATE/PLAY capture and its VPK hash describe a design that no longer exists.

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

- `addons` — `openlock.addons/a5d7cf25e0a40c0a06b836992556491d` JSON. New windows join the catalog, changed windows update in
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
- **Reduced motion** has a Popit suppression path (`OpenlockSetPopitMotion`), but no user-facing
  switch and no profile row yet; the idle-chrome animation is unchanged.
- **Live rendering**: the new Popit cell editor has not been seen in a built client. The Node
  harnesses and the headless browser probe cover the root/child behaviour, the pair palette, the
  computed role colours and the landing page, and the C# parser covers the saved alphabet and
  pair slug; the rendered crown, the in-game transitions and the halo/item contrast in Deadlock
  remain unwitnessed. The browser witness above records the measured DOM result.
- **Contrast**: the palette is not retuned. `lbp1-yellow-fuchsia` measures a 1.05:1 wordmark on
  its slab in the browser probe, which is the source pair's own ratio; a later palette pass would
  have to change the pair table, not the role mapping.
- **Audio mix** is not measured on a device. The samples are bounded and the compiled soundevents
  load, but perceived loudness against Deadlock's own UI remains a listening check.

## 8. Family design adoption (2026-11-12)

The visual authority is now the family register and synthesis in
`C:\Users\ala\Documents\openlock_modern\docs\design\`: `family-design-tokens.json`,
`FAMILY-BRAND-SYNTHESIS.md` and `tools/family_design_audit.py`. The register holds the palette and
mark values; this repository reads them from there. No person has looked at the built surface, so
the audit's render row is `not-implemented`.

**Landing (web dark).** `landing/index.html` names the roles `ground`, `surface`, `raised`, `line`,
`line-strong`, `ink`, `muted`, `dim`, `faint`, `attention`, `verified`, `refused` and `telemetry`;
gold is the landing's attention accent and the CUA interaction purple is not used here. The mark is
the 20x20 square-in-square (1.5 px outer stroke, 8x8 filled centre, 2 px radii, 8 px clear space).
The page uses Archivo / IBM Plex Mono, a 64 px app bar, the 8 dp structural grid, the 3/4 px web
control/panel radii, the 8 px shell-window ceiling and the `app-bar` (0 2px 8px) and `menu`
(0 8px 24px) elevation tiers. The page stays dark: the register declares a light set, but no one
has rendered it.

**Family package target.** The family section names the shell repos and the legacy-to-modern package
pipeline. Every project's old carrier (`SHPKG002`, `SHPKG003`, `shploingus.recipe/30444cad3419800564faba6d4e252431`,
`openlock.envelope/d593054cb466a871f47d4804b3e2f333`, `V4PKG001`, `V4PKG002`) is an import input behind a read-only decoder. The
decoder writes an explicit compatibility record, `dle-migrate` records source and target identity,
the old digest, the new `name@rev+blake3` identity, lost fields, actor and ticket, and only the modern
carrier is emitted. The modern carrier is `dl-enclave.pkg/7eda1d82c5a03cc74883059912e73f71`; `goose.mod/0aae19884ea41415867d1385deea60e3`, `goose.vanilla/109e73f54aaaa7e072bbcb452569ebde` and
`goose.client/d6f8a8b171f8c253b095d99f92e95b4a` are module schemas inside that one carrier. BLAKE3 covers canonical content only, with
framing, encryption, the revision and the Debian signature outside the preimage. The migration is
one-way. Legacy `shploingus.recipe/4`, `planet-*`, `planet-package-v1`, VPK and compiled assets are
refused by name rather than converted. This is the target pipeline in `db-mc-indev/AGENTS.md` §11,
`dl-enclave/docs/PACKAGE-FORMAT.md` §6, `secure_shell_v2/docs/SECURE-SHELL-RESTORE@1.ARCHITECTURE.md`
§5–§7 and §12.8, and `SECURE-SHELL-RESTORE@1.FORMAT-IMPORT-AUDIT.md` §5; `dle-migrate` remains on the
Phase 1 work list.

**Panorama (game medium).** The scheme files remain the medium's role map. Measured against each
scheme's body colour:

| Scheme | Ink/body | Muted/body | Accent/body |
|---|---:|---:|---:|
| `alpha` | 15.33:1 | 6.66:1 | 9.91:1 |
| `material` | 18.73:1 | 8.64:1 | 5.10:1 |

All exceed the 4.5:1 floor. The base window radius is now 8 (the family ceiling); forms may declare
a smaller corner (MD1 keeps 2, iOS 6 keeps 6). The four corner grips have a 24 dp pointer target and
opt back into hit-testing because a live-panel frame is pointer-transparent. The 30 dp title strip
translates the family app-bar grammar for a pointer-dense game surface; it does not use the web
64 px bar or a fetched font.

**What changed for the window manager.** A split clears the parent's composited transform before
measuring components; a move anchors on the layout pass's placed content and writes only position;
a resize writes both axes from the requested content rect; a player-placed window is arbitrated in
shell space, so the layout adds the reserved bar once. `tools/check_shell_clicks.py` asserts that
the old `frameRecord.rect` start path is gone. The browser witness also found
that the four taskbar right-cluster controls still carried the retired absolute
`ignore-parent-flow` / right-margin rules inside the new flow wrapper. Removing those rules makes
the wrapper own real pixels: `tools/browser_shell_check.py` reaches Dashboard, Windows, the build
label and the clock at 1280x900, 1024x768 and 900x1000, sees five frames with four 24 dp grips each,
refuses a forced `game-*` frame by name, and reports the four unsigned envelopes.

**Bars not claimed.** The family audit does not inspect the rendered page or the game. No person
has witnessed this build's landing or shell render; the agent browser result above is a witness of
the HTML shell, not a person's look at the installed client. The Popit tray uses the form's rounded
slab geometry; the MD1/iOS/TouchWiz forms keep their own declared control geometry.

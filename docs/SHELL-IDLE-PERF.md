# Shell idle performance — measured before/after

This is the checkable record for the "the game hangs every few seconds and when the shell is
opened" defect. The numbers come from Deadlock's own console (`console.log`), the shell's
Performance window (`frameTick` + 30 s `perf summary`), and the shell's own warn ring. No
synthetic mouse or keyboard input was used: the proof client runs on its own desktop
(`.scratch/launch-client-hidden.py`) and a proof-only build opened the shell after boot.

## What was wrong

All three causes were in the shell's scanning/scheduling path, not in rendering.

1. **A synchronous content-bounds walk on every bind and HUD move.** `contentBounds` read several
   native properties on every node of a subtree of up to 700 panels. The log showed a single
   `apply minimap 330.0 ms` and, at shell open, `UI stalled 2817ms` from `DW_BOOTSTRAP`. Binding
   ten windows in one call could hold the UI thread for seconds.
2. **Full HUD class/token sweeps in automatic paths.** Auto-frame retries, pinned frames and
   preloaded frames each performed `findInHud`'s whole-HUD walk for a class that was not on screen:
   `find class:CitadelHudHeroShop 236.0 ms guard 1398`, `find class:CitadelHudMap 152.0 ms`.
   Discovery also re-walked an idle HUD every 3.5 s.
3. **The poll could die.** A HUD panel deleted mid-walk threw
   `Uncaught Underlying panel is deleted!` inside the scheduled callback, and the next
   `$.Schedule(0.5, poll)` never ran, so the shell went quiet.

## What changed

- `contentBounds` is now a resumable scan (`queueContentScan` / `contentPump`): at most ~4 ms per
  tick, one node at a time, with a per-panel-shape cache (5 s TTL) and a pure-move shortcut that
  carries the cached content rect when the HUD slides without resizing. Frames draw with their
  natural rect first and refine off the frame (`content … (measuring)`).
- Discovery is gated by the HUD's top-level structure signature; an unchanged HUD pays one cheap
  signature read, not a walk.
- `findInHud` checks the discovery id index before any class sweep, and automatic binds
  (preloaded, pinned, `autoFrame`) pass `cheap`, which never runs a whole-HUD class or token sweep.
  Choosing a window clears `preloaded`, so an explicit player request still gets the exhaustive
  bind.
- `findInHud` guards `FindChildTraverse` results before calling `HasClass` (this client returned a
  non-panel host value and threw `byId.HasClass is not a function`).
- `scanPopups` looks up `PopupManager` by id only and bounds its subtree walk; it no longer sweeps
  ~1400 panels every 8 s for a manager that is not there.
- `poll` is now `pollOnce` plus a wrapper whose `finally`/catch always reschedules; a torn-down
  panel can no longer end the shell's poll loop.

## Before

Pre-fix build, shell open. Sources: `.scratch/console.before.log` (07:10 session) and
`.scratch/console.after4.log` (08:44 session), both from the same client and addon.

| Reading | Value | Log |
|---|---:|---|
| UI frame warning at open | **54.1 ms** | `console.before.log` `perf warn: ui frame 54.1 ms` |
| Engine average frame | **67.51 ms** | `console.before.log` `Avg Frame: 67.51ms` |
| UI thread stalls at open | **1296 / 5955 / 2834 / 3415 ms** | `console.after4.log` `DW_BOOTSTRAP UI stalled …` |
| Class sweep at open | **139.0 ms** (236.0 ms in the later run) | `find class:CitadelHudHeroShop … guard 1370` |
| Single bind apply | **255.0 ms** (330.0 ms in the later run) | `apply minimap 255.0 ms` |

The audit reading for this defect was `Avg Frame 63.81 ms`, 30% of frames over 17.5 ms; the 07:10
and 08:44 logs above are the same failure.

## After

Fixed build, shell opened by the proof hook, 31 s of samples with the shell open and idle
(`.scratch/proof-after.log`). Client boot `09:47:33`, shell open `09:48:31`.

| Reading | Value | Log |
|---|---:|---|
| UI frame mean | **3.9 ms** | `perf summary: ui mean 3.9 ms peak 5.2 ms over 16.7 ms 0% samples 31` |
| UI frame peak | **5.2 ms** | same line |
| Samples over 16.7 ms | **0%** | same line |
| Engine average frame | **16.02 ms** | `Avg Frame: 16.02ms, Avg Idle: 0.00ms - 3840 frames` |
| UI stalls at open | **none** | no `DW_BOOTSTRAP UI stalled` |
| Excessive frames at open | **none** | no `Excessive frame time` |
| JS exceptions | **none** | no `JS Exception` |
| First bind | **< 8 ms** | no `perf warn: apply …`; `shell framed 'quickbuy' … content 304×883 (measuring)` |
| HUD discovery at open | 27 ms once, then 2 ms | `hud walk: 4 surface(s) of 125 panel(s) visited 27.0 ms` |

The two 3.8/3.9 ms summaries with `samples 1` are the first second after the Performance window
opened; the `samples 31` line is the steady 30 s reading. The poll kept its cadence
(`polls 124 → 184`) across the open, which is the regression that used to end it.

## How to re-check

With the shell open and idle, read the Performance window (`content performance`) or tail the
client log:

```bash
f='/d/SteamLibrary/steamapps/common/Deadlock/game/citadel/console.log'
grep -E 'perf summary|UI stalled|Excessive frame|JS Exception' "$f" | tail -20
```

A healthy run prints `perf summary: ui mean … over 16.7 ms 0%` with no `UI stalled`,
`Excessive frame time` or `JS Exception` since the shell opened.

## Build identity

The numbers above were measured on installed VPK SHA-256
`AF4B74C61AC854311F80809D3CC122CC113687FCECEBCBB4FDBF416CA2031502`, matching
`dist/openlock_ui/pak01_dir.vpk`. The shipped script contains no `PROOF-ONLY` or `MEASURE-AUTOOPEN`
hook. The proof run used the same source plus an 8-line boot hook that opened the shell and the
Performance window; that hook is not in the installed archive.

The later Popit surface pass rebuilt the same source into VPK SHA-256
`766B71C6EDFA413A5A2F7E2A071101005DDB0164CF1D3E7B000114ADD2D4D880`; the final campaign archive is
`eb31e9c71cac75099f12d44bb085e11283ba309606535199855955c7180a3d52`. Those passes change the
on-demand Popit and live-delivery modules, not `pollOnce`/`frameTick` or the HUD scan path, and
the idle numbers have not been re-measured against the final archive.

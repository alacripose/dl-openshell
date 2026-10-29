# Ground truth for the dl-openshell plugin

Gathered 2026-10-28. Everything below was read from the named source; nothing is from memory.

---

## 1. The two reference systems (conventions only)

`ala_package_designer` and `shploingus-clean` were read for **how a package is structured, named,
versioned and loaded**, not for their domain.

| Convention | Where it comes from | What dl-openshell took |
|---|---|---|
| A package is a declared document with an explicit identity and version | `ala_package_designer/packages/designer-shell.shspec` header `shploingus.recipe/4` + `package designer-shell v1` | `openlock.manifest.json` with `id`, `version`, `target` |
| Packages are named for the row they implement, not for a file | `.shspec`: `row DSGN-0001 the designer's own shell…` | The plugin is named for its mode (`dl-openshell`), and every tunable is declared, not implied |
| Content-addressed build identity | `shploingus-clean/packages/BLD-0056-a99c4703…f049.shpkg` (`BLD-<sequence>-<sha256>`) | `deploy.ps1` prints the DLL's SHA-256 and refuses when the manifest version and assembly version disagree |
| "Refuse, never default" | `shploingus-clean/README.md`, rule 1 | An unmapped spirit item is named on the console and left alone, never replaced by a guess |

Not taken: their domains (evidence graphs, voxel worlds), their build systems, their Rust layout.

---

## 2. Deadworks: what it documents, and what the loader actually is

### Distribution and load path

From `Deadworks-net/docs` → `docs/getting-started/developers/setup.md`:

> Deadworks loads compiled plugin DLLs from:
> `Deadlock/game/bin/win64/managed/plugins/`
> Copy the full build output to the `Deadlock/game/bin/win64/managed/plugins/` folder.
> Deadworks loads plugins when the server starts. Editing a plugin DLL while the server is running
> hot-reloads it.

From `docs/getting-started/server-admins/install-plugins.md`:

> 1. Copy the plugin's `.dll` file, and any other `.dll` files it comes with, into
>    `game\bin\win64\managed\plugins\`.
> 2. Start the server, or, if it's running, wait a moment: Deadworks loads new and changed plugins
>    without a restart.

> `dw_plugin list`
> `dw_plugin disable <Plugin>` / `dw_plugin enable <Plugin>`
> The setting is remembered across restarts.

### Manifest / descriptor

**There is none.** Nothing in the docs or the runtime defines a manifest file. From
`docs/getting-started/developers/first-plugin.md`:

> A plugin is a class that inherits from `DeadworksPluginBase`. The only thing it must have is a `Name`.

Discovery is: every DLL under `managed/plugins/` whose exported types implement
`IDeadworksPlugin` (§ `managed/DeadworksManaged.Api/IDeadworksPlugin.cs`). `openlock.manifest.json`
in this repo therefore describes the plugin for tooling and humans; it is **not** read by Deadworks.

### Language, entry point, config

- C# on .NET 10 (`docs/getting-started/developers/setup.md`: *".NET 10.0 SDK or later"*). Installed
  here: **10.0.400**.
- Entry point: `public sealed class OpenlockPlugin : DeadworksPluginBase`, `Name` required,
  `OnLoad(bool isReload)` / `OnUnload()`.
- Config: from `docs/features/configuration.md`, `[PluginConfig]` creates
  `game/bin/win64/configs/<PluginClass>/<PluginClass>.jsonc` on first load; reload with
  `dw_reloadconfig <Plugin>`.
- ConVars: from `docs/features/convars.md`, read with `ConVar.Find(name)` and *"Do this in
  `OnStartupServer`, because it runs every time a map starts."*

### API used by each modifier

| Modifier | API | Source |
|---|---|---|
| Hero abilities disabled | `OnAbilityAttempt(AbilityAttemptEvent)`, `args.BlockAllAbilities()` | `Events/AbilityAttemptEvent.cs`: *"Set bits in this mask to block those buttons from being processed by the ability system."* Items have a separate mask (`InputButton.AllItems`), so item actives keep working |
| Gravity / friction | `ConVar.Find("sv_gravity"|"sv_friction").SetFloat` | `ConVar.cs`: *"Unlike typing a value in the console, the Set methods here also work on cheat-protected cvars while `sv_cheats` is off."* |
| Spirit → strength | `CCitadelBaseAbility.IsItem` / `.AbilityName` / `.SubclassVData`, `SchemaAccessor<byte>("CitadelAbilityVData","m_eItemSlotType")`, `CCitadelPlayerPawn.RemoveItem` / `.AddItem` | `Entities/CCitadelAbilityComponent.cs`, `Entities/SchemaAccessor.cs`, `Entities/CCitadelPlayerPawn.cs` |
| Mode reporting | `[Command("openlock")]`, `Caller.Reply` | `examples/plugins/*`, `docs/features/commands.md` |

---

## 3. The installed game

- Install root: `D:\SteamLibrary\steamapps\common\Deadlock`
- Real game layout: `game\citadel\` (paks `pak01_000.vpk`…, `gameinfo.gi`, `cfg\`, `addons\`),
  binaries expected under `game\bin\win64\`.
- Modding traces already present: `gameinfo.gi.grimoire-bak` and `game\citadel\grimoire\`
  (Grimoire mod manager), `addons\mods.txt`.
- `.NET` SDKs: `10.0.101`, `10.0.400`.
- **Deadworks is not installed**: no `deadworks.exe`, no `game\bin\win64\managed\` anywhere on D:.

### Symbols, from the schema dump of this exact build

Source: `https://s2v.app/SchemaExplorer/llms.txt` → `deadlock.json`, `revision 11170534`,
`version_date Oct 26 2026` (the user's paks are dated Oct 26). Offsets are Windows memory layout.

| Symbol | Field / value | Offset |
|---|---|---|
| `sv_gravity` | default `"800"`, `float32`, flags `notify,release,replicated` | — |
| `sv_friction` | default `"4"`, `float32`, flags `notify,release,replicated` | — |
| `CitadelAbilityVData` | `m_eItemSlotType` (`EItemSlotTypes_t`) | `0x29` |
| `CitadelItemVData` | `m_iItemTier` (`EModTier_t`), parent `CitadelAbilityVData` | `0x1074` |
| `CModifierVData` | `m_vecScriptValues` (`ModifierScriptValue_t`) | `0x3b0` |
| `ModifierScriptValue_t` | `m_eModifierValue` (`EModifierValue`), `m_value` (`CModifierLevelFloat`, `float[4]`) | `0x0`, `0x8` |

`EItemSlotTypes_t`: `WeaponMod=0, Armor=1, Tech=2, Universal=3, …` — **spirit is `Tech=2`**, which is
what `SpiritRework` tests.

`EModifierValue` names the stats the mode is about: `WEAPON_POWER=166`, `HEALTH_MAX=45`,
`TECH_POWER=168`, `BULLET_DAMAGE_INCREASE=21`, `HEALTH_REGEN_PER_SECOND=51`, `STAMINA=163`.

> "gravity is reduced by 200" therefore means 800 → 600 on this build, and "friction is set to 2"
> means 4 → 2. Both are the engine's defaults, captured as a baseline at first apply and restored on
> `OnUnload`.

---

## 4. What blocks a modifier on this build

1. **Nothing has been run in game.** Deadworks is not installed, so the plugin has been compiled and
   staged but never loaded. See README → Verification.
2. **Item stats cannot be rewritten through the public API.** `ItemInfo` exposes only imbue
   behaviour (`Exists`, `GetImbueEffects`, `CanBeImbued`); there is no documented setter for an
   item's stat values. The deeper surface exists in the schema — `CModifierVData.m_vecScriptValues`
   maps `EModifierValue` → `CModifierLevelFloat` — but reaching it means walking raw VData pointers
   whose per-item identity is not exposed by the SDK. The current implementation therefore *swaps the
   item* for real weapon/vitality items rather than editing its stats. Consequence: the shop still
   lists the spirit item, and its tooltip still shows spirit values; the swap happens on ownership.
3. **Passive hero innates are not "abilities that cast".** `BlockAllAbilities` stops input-driven
   casts; it does not remove an innate already applied to the pawn.
4. **Client-side display lag.** ConVars are `replicated`, so gravity/friction reach the client, but
   nothing has confirmed it visually on this build.

---

## 5. The gamemode's name

OpenLock is the author's umbrella mod codename, not a name invented here. Public statements are on
X under `@alacripose`, which is login-walled for individual posts; the accessible evidence is the
Patreon page (*"the codename OpenLock covers a lot more…"*) and a search snippet of
`x.com/alacripose/status/2048312992811647410` (*"ol_plains in primelock, in deadlock, and in
openlock, fully cross compatible…"*). The plugin therefore ships under `dl-openshell` and names the mode
through `ModeName`.

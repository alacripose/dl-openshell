using DeadworksManaged.Api;
using Openlock.Modifiers;
using Openlock.Shell;

namespace Openlock;

/// <summary>
/// Openlock: a Deadworks game mode in which hero abilities are disabled, gravity is reduced,
/// friction is lowered, and spirit items are reworked into strength items.
/// </summary>
public sealed class OpenlockPlugin : DeadworksPluginBase
{
    public const string Version = "0.7.0";

    public override string Name => "dl-openshell";

    [PluginConfig]
    public OpenlockConfig Config { get; set; } = new();

    private readonly WorldTuning _world = new();
    private readonly SpiritToStrength _strength = new();
    private readonly MovementNormalization _movement = new();
    private readonly AggregateWatch _watch = new();
    private readonly AbilityLearningGate _learning = new();
    private readonly AbilityHudHide _abilityHud = new();
    private ClientAddons _addons = new();
    private readonly Dictionary<int, float> _upgradeNotices = [];
    private readonly HashSet<string> _loggedBlocks = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _loggedAdds = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<nint> _pendingReconcile = [];
    private readonly ShellMount _shell;
    private bool _startupApplied;
    private bool _initialReconcileDone;

    private static readonly SchemaAccessor<int> _itemTier =
        new("CitadelItemVData"u8, "m_iItemTier"u8);

    public OpenlockPlugin() => _shell = new ShellMount(this);

    public ClientAddons Addons => _addons;
    public IReadOnlyList<string> AddonReport => _addons.ReportLines;
    public IReadOnlyList<ShellPackage.Refusal> ShellRefusals => _shell.Refusals;
    public IReadOnlyList<ShellPackage.Window> ShellWindows => _shell.Windows;
    public string StrengthSummary => _strength.Summary;

    // --- Lifecycle -------------------------------------------------------

    public override void OnLoad(bool isReload)
    {
        Log.Banner($"{Config.ModeName} {(isReload ? "reloaded" : "loaded")} v{Version}");
        Log.Write($"[dl-openshell] log file: {Log.Path}");
        Log.Write(
            $"[dl-openshell]   abilities={(Config.DisableHeroAbilities ? "disabled" : "on")} " +
            $"gravity=-{Config.GravityReduction} friction={Config.Friction} " +
            $"spirit->strength={(Config.SpiritItemsBecomeStrength ? "on" : "off")}");

        // Deadworks loads plugins without a usable Assembly.Location, so resolve from the process
        // base directory (game/bin/win64) where the plugin folder actually lives.
        var pluginDir = Path.Combine(AppContext.BaseDirectory, "managed", "plugins");
        if (!Directory.Exists(pluginDir))
            pluginDir = Path.GetDirectoryName(typeof(OpenlockPlugin).Assembly.Location) ?? ".";

        var recipePath = Path.Combine(pluginDir, "patches", "openlock.baselines.shspec");
        var recipe = PatchRecipe.Load(recipePath);
        if (recipe is null)
        {
            Log.Write($"[dl-openshell] recipe missing at {recipePath}; no base values are declared or applied.");
        }
        else
        {
            recipe.Report(recipePath, name => ConVar.Find(name)?.GetFloat());
        }

        _addons = ClientAddons.Resolve(Config);
        foreach (var line in _addons.ReportLines)
            Log.Write($"[dl-openshell] addon {line}");
        _abilityHud.Installed = _addons.HudInstalled;

        _shell.Load(Path.Combine(pluginDir, "shell", "alpha-shell"));
        _shell.Register();

        // A reload replaces this instance, so anyone already in the world still holds the previous
        // instance's panel. Re-mount for them here; OnClientFullConnect only fires for new joins.
        if (isReload)
        {
            foreach (var controller in Players.GetAll())
            {
                if (controller.IsBot)
                    continue;

                _shell.Show(controller);
                _abilityHud.Show(controller, AbilityHudHidden);
            }
        }

        ApplyMode();
    }

    public override void OnUnload()
    {
        // A hot reload unloads this instance and loads a new one. Restoring here would undo the
        // conversion and wipe the state file, which is exactly how earlier builds doubled stats on
        // every reload. The converted values and their state stay; only an explicit mode-off
        // (or a disable in config) restores the shipped baselines.
        _world.Restore();
        Log.Write(
            $"[dl-openshell] {Config.ModeName} unloaded (reload-safe): converted stats and their state are kept.");
    }

    public override void OnStartupServer()
    {
        _startupApplied = false;
        ApplyMode();
    }

    public override void OnConfigReloaded()
    {
        if (!Config.Enabled || !Config.SpiritItemsBecomeStrength)
            _strength.RestoreAll("config changed");

        if (!Config.DisableHeroAbilities)
            _learning.OpenAll();

        if (!AbilityHudHidden)
            _abilityHud.SetHidden(false);

        ApplyMode();
    }

    public override void OnClientFullConnect(ClientFullConnectEvent args)
    {
        if (args.Controller is { } controller)
        {
            _shell.Show(controller);
            _abilityHud.Show(controller, AbilityHudHidden);
        }
    }

    public override void OnClientDisconnect(ClientDisconnectedEvent args) =>
        _abilityHud.Forget(args.Slot);

    private bool AbilityHudHidden => Config.Enabled && Config.DisableHeroAbilities && Config.HideAbilityHud;

    public override void OnPawnHeroInitialized(CCitadelPlayerPawn pawn)
    {
        if (!Config.Enabled || !Config.SpiritItemsBecomeStrength)
            return;

        _pendingReconcile.Add(pawn.Handle);
    }

    // --- Modifier 1: hero abilities disabled ------------------------------

    public override void OnAbilityAttempt(AbilityAttemptEvent args)
    {
        if (!Config.Enabled || !Config.DisableHeroAbilities)
            return;

        AbilityLockout.Apply(args);

        var pressed = args.ChangedButtons & AbilityLockout.HeroAbilityInputs;
        if (pressed != 0 && _loggedBlocks.Add($"{args.PlayerSlot}|{pressed}"))
            Log.Write($"[dl-openshell] ability input blocked slot={args.PlayerSlot} buttons={pressed}");
    }

    // --- Modifier 1b: ability points cannot be spent ----------------------

    /// <summary>
    /// The upgrade spend is an ability-point deduction. Stopping it here means the purchase never
    /// completes and the points stay in the player's wallet, with a message saying why — instead of
    /// allowing the upgrade and reverting it. Positive grants are refused too: points nobody can
    /// spend would only advertise an affordance this mode has removed.
    /// </summary>
    public override HookResult OnModifyCurrency(ModifyCurrencyEvent args)
    {
        if (!Config.Enabled || !Config.DisableHeroAbilities)
            return HookResult.Continue;

        if (args.CurrencyType != ECurrencyType.EAbilityPoints)
            return HookResult.Continue;

        // Points keep accruing on level-up, so the HUD still shows the currency the mode will not
        // let the player spend. Refusing the grant as well would just hide the reason.
        if (args.Amount >= 0)
        {
            NotifyUpgradeBlocked(args.Pawn);
            return HookResult.Continue;
        }

        NotifyUpgradeBlocked(args.Pawn);
        Log.Write(
            $"[dl-openshell] ability point SPEND REFUSED: {args.Amount:+#;-#;0} " +
            $"source={args.Source} spendOnly={args.SpendOnly} " +
            $"player={args.Pawn.Controller?.PlayerName ?? "?"}");

        return HookResult.Stop;
    }

    private void NotifyUpgradeBlocked(CCitadelPlayerPawn pawn)
    {
        var controller = pawn.Controller;
        if (controller is null || controller.IsBot)
            return;

        var now = GlobalVars.CurTime;
        if (_upgradeNotices.TryGetValue(controller.Slot, out var last) && now - last < 3f)
            return;

        _upgradeNotices[controller.Slot] = now;
        controller.HudAnnounce(Config.ModeName, "Ability upgrades are disabled in this mode.");
    }

    // --- Per-frame work ---------------------------------------------------

    public override void OnGameFrame(bool simulating, bool firstTick, bool lastTick)
    {
        // The shell is a menu surface as much as a match surface. Its build/addon status and the
        // client addon readiness sample must run while the client is in a menu, where a player
        // installs or inspects a build; the simulation-only work below stays gated.
        _shell.Tick();

        if (!simulating || !Config.Enabled)
            return;

        _watch.Tick();
        _abilityHud.Tick();

        // The engine's own learning gate: with it closed the upgrade never happens, so there is
        // nothing to revert afterwards. Innates are outside the four hero ability slots.
        if (Config.DisableHeroAbilities)
        {
            foreach (var controller in Players.GetAll())
            {
                var pawn = controller.GetHeroPawn();
                if (pawn is not null)
                    _learning.Apply(pawn, prevent: true);
            }
        }

        // Heroes that already existed when the plugin loaded (the player mid-match) get their owned
        // spirit items converted once, so the rework applies without needing a respawn.
        if (!_initialReconcileDone && Config.SpiritItemsBecomeStrength)
        {
            _initialReconcileDone = true;
            foreach (var controller in Players.GetAll())
            {
                var pawn = controller.GetHeroPawn();
                if (pawn is not null)
                    _strength.Reconcile(pawn, Config, "startup");
            }
        }

        if (Config.SpiritItemsBecomeStrength && _pendingReconcile.Count > 0)
        {
            foreach (var handle in _pendingReconcile)
            {
                var pawn = FindPawnByHandle(handle);
                if (pawn is null)
                    continue;

                _strength.Reconcile(pawn, Config, "item change");
            }

            _pendingReconcile.Clear();
        }

        if (Config.NormalizeMovement)
        {
            foreach (var controller in Players.GetAll())
            {
                var pawn = controller.GetHeroPawn();
                if (pawn is not null)
                    _movement.Apply(pawn, Config.BaseMoveSpeed, Config.SprintBonus, Config.MaxStamina);
            }
        }
    }

    private static CCitadelPlayerPawn? FindPawnByHandle(nint handle)
    {
        foreach (var controller in Players.GetAll())
        {
            var pawn = controller.GetHeroPawn();
            if (pawn is not null && pawn.Handle == handle)
                return pawn;
        }

        return null;
    }

    private void ApplyMode()
    {
        if (!Config.Enabled)
            return;

        _world.Apply(Config.GravityReduction, Config.Friction);

        if (!_startupApplied)
        {
            _startupApplied = true;
            Log.Write(
                $"[dl-openshell] world applied and read back: {Config.ModeName} " +
                $"gravity={_world.AppliedGravity} friction={_world.AppliedFriction}");
        }
    }

    // --- Modifier 4: spirit worth moved onto strength ---------------------

    public override HookResult OnAddModifier(AddModifierEvent args)
    {
        if (!Config.Enabled || !Config.SpiritItemsBecomeStrength)
            return HookResult.Continue;

        var item = args.Ability?.SubclassVData?.Name ?? "<no ability>";
        var modifierName = args.ModifierVData.Name;

        if (_loggedAdds.Add(item + "|" + modifierName))
            Log.Write($"[dl-openshell] modifier add {item} via {modifierName}");

        if (string.IsNullOrEmpty(item) || !item.StartsWith("upgrade_", StringComparison.OrdinalIgnoreCase))
            return HookResult.Continue;

        var owner = args.ModifierProperty.Owner as CCitadelPlayerPawn;
        if (owner is not null)
            _pendingReconcile.Add(owner.Handle);

        return HookResult.Continue;
    }

    // --- Engine evidence --------------------------------------------------

    public override void OnModifierEvent(ModifierEvent args)
    {
        if (args.Event != EModifierEvent.AbilityExecuted || args.Caster is not CCitadelPlayerPawn)
            return;

        var ability = args.Ability?.Ability;
        Log.Write($"[dl-openshell] engine: hero ability executed ability={ability?.AbilityName ?? "?"}");
    }

    // --- Commands ---------------------------------------------------------

    [Command("openlock", Description = "Report the dl-openshell game mode's state")]
    public void CmdStatus(Caller caller)
    {
        caller.Reply($"[{Config.ModeName}] v{Version} — {(Config.Enabled ? "enabled" : "disabled")}");
        caller.Reply($"[dl-openshell] hero abilities: {(Config.DisableHeroAbilities ? "disabled" : "enabled")}");
        caller.Reply(
            $"[dl-openshell] world: gravity={(int)(_world.AppliedGravity ?? 0)}, " +
            $"friction={_world.AppliedFriction?.ToString() ?? "unset"}");
        caller.Reply($"[dl-openshell] spirit->strength: {_strength.Summary}");
    }

    /// <summary>
    /// The mode's server-side shell. Works from the server console or chat, and every verb is
    /// recorded in the log so an operator can see what was done and to whom.
    /// </summary>
    [Command("openlock_ctl", Description = "dl-openshell shell: status | steady | repair | restore")]
    public void CmdShell(Caller caller, string verb = "status") => Shell(caller, verb);

    [Command("openlock-ctl", Description = "dl-openshell shell: status | steady | repair | restore")]
    public void CmdShellDashed(Caller caller, string verb = "status") => Shell(caller, verb);

    private void Shell(Caller caller, string verb)
    {
        var command = (verb ?? "status").Trim().ToLowerInvariant();
        Log.Write($"[dl-openshell] shell '{command}' by {caller.Name}");

        switch (command)
        {
            case "status":
                CmdStatus(caller);
                return;

            case "steady":
            case "repair":
            {
                var touched = 0;
                foreach (var controller in Players.GetAll())
                {
                    var pawn = controller.GetHeroPawn();
                    if (pawn is null)
                        continue;

                    _strength.Reconcile(pawn, Config, $"shell {command}");
                    touched++;
                }

                caller.Reply($"[dl-openshell] {command}: {touched} hero(es) reconciled");
                return;
            }

            case "restore":
                _strength.RestoreAll("shell restore");
                caller.Reply("[dl-openshell] restored every hero to their captured baseline");
                return;

            default:
                caller.Reply("[dl-openshell] usage: openlock_ctl status|steady|repair|restore");
                return;
        }
    }

    [Command("openlock_layout", Description = "dl-openshell layout profiles: status | save")]
    public void CmdLayout(Caller caller, string verb = "status")
    {
        var command = (verb ?? "status").Trim().ToLowerInvariant();
        switch (command)
        {
            case "save":
                _shell.RequestLayoutSave();
                caller.Reply("[dl-openshell] layout save requested from connected shells");
                return;

            case "status":
                caller.Reply($"[dl-openshell] layout profiles: {_shell.LayoutDirectory}");
                return;

            default:
                caller.Reply("[dl-openshell] usage: openlock_layout status|save");
                return;
        }
    }

    [Command("openlock-layout", Description = "dl-openshell layout profiles: status | save")]
    public void CmdLayoutDashed(Caller caller, string verb = "status") => CmdLayout(caller, verb);

    [Command("openlock_observer", Description = "Show a package XML observer surface on connected shells")]
    public void CmdObserver(Caller caller, string windowId = "")
    {
        var id = (windowId ?? "").Trim();
        if (id.Length == 0)
        {
            var available = _shell.AddonWindows.Where(w => !string.IsNullOrEmpty(w.LayoutPath)).Take(12)
                .Select(w => w.Id).ToArray();
            caller.Reply(available.Length == 0
                ? "[dl-openshell] no package XML observer surface is loaded"
                : "[dl-openshell] usage: openlock_observer <window-id>; available: " + string.Join(", ", available));
            return;
        }

        var sent = _shell.ShowObserver(id);
        caller.Reply(sent == 0
            ? $"[dl-openshell] observer XML '{id}' is not a loaded package window with a mounted XML layout"
            : $"[dl-openshell] observer XML '{id}' sent to {sent} shell(s)");
    }

    [Command("openlock-observer", Description = "Show a package XML observer surface on connected shells")]
    public void CmdObserverDashed(Caller caller, string windowId = "") => CmdObserver(caller, windowId);

    /// <summary>
    /// The live bridge. Deadworks and Deadlock cannot mount a new resource path while a client is
    /// running, so a package is read here, its XML becomes a node tree in the addon payload, and
    /// every connected shell builds the windows itself. Nothing is written into the game tree.
    /// </summary>
    [Command("dl_openshell_deliver", Description = "Deliver a .shpkg or addon VPK to connected shells live")]
    public void CmdDeliver(Caller caller, string path = "")
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            caller.Reply("[dl-openshell] usage: dl_openshell_deliver <path-to.shpkg-or-addon.vpk>");
            return;
        }

        var added = _shell.DeliverAddon(path.Trim().Trim('"'), out var why);
        caller.Reply(added == 0
            ? $"[dl-openshell] live delivery refused: {why}"
            : $"[dl-openshell] delivered {added} window(s) live; connected shells rebuild the payload now");
    }

    [Command("dl-openshell-deliver", Description = "Deliver a .shpkg or addon VPK to connected shells live")]
    public void CmdDeliverDashed(Caller caller, string path = "") => CmdDeliver(caller, path);

    // Existing packages and scripts may still call the old names; they are aliases, not a second path.
    [Command("openshell_deliver", Description = "Alias for dl_openshell_deliver")]
    public void CmdDeliverAlias(Caller caller, string path = "") => CmdDeliver(caller, path);

    [Command("openlock_deliver", Description = "Alias for dl_openshell_deliver")]
    public void CmdDeliverLegacy(Caller caller, string path = "") => CmdDeliver(caller, path);

    [Command("openlock_ui", Description = "dl-openshell shell panel: open | hide")]
    public void CmdUi(Caller caller, string verb = "open")
    {
        if (caller.Player is not { } controller)
            return;

        if ((verb ?? "open").Trim().Equals("hide", StringComparison.OrdinalIgnoreCase))
        {
            _shell.Collapse(controller);
            caller.Reply("[dl-openshell] shell hidden; cursor returned");
            return;
        }

        _shell.Open(controller);
        caller.Reply("[dl-openshell] shell open; press Hide to return the cursor");
    }

    [Command("openlock-ui", Description = "dl-openshell shell panel: open | hide")]
    public void CmdUiDashed(Caller caller, string verb = "open") => CmdUi(caller, verb);

    // --- Shell surface ----------------------------------------------------

    public string StatusLine() =>
        $"{(Config.Enabled ? "on" : "off")} · {_strength.Summary} · abilities " +
        $"{(Config.DisableHeroAbilities ? "locked" : "on")} · gravity {_world.AppliedGravity?.ToString("0") ?? "?"}";

    public void ToggleModeFromShell()
    {
        Config.Enabled = !Config.Enabled;

        if (Config.Enabled)
        {
            ApplyMode();
            _abilityHud.SetHidden(AbilityHudHidden);
        }
        else
        {
            _learning.OpenAll();
            _abilityHud.SetHidden(false);
            _strength.RestoreAll("shell off");
            _world.Restore();
        }

        Log.Write($"[dl-openshell] shell toggled mode -> {Config.Enabled}");
    }

    public void ReconcileAll(string reason)
    {
        var touched = 0;
        foreach (var controller in Players.GetAll())
        {
            var pawn = controller.GetHeroPawn();
            if (pawn is null)
                continue;

            _strength.Reconcile(pawn, Config, reason);
            touched++;
        }

        Log.Write($"[dl-openshell] {reason}: {touched} hero(es) reconciled");
    }

    public void RestoreAllFromShell()
    {
        _strength.RestoreAll("shell restore");
        Log.Write("[dl-openshell] shell restore: every hero returned to their captured baseline");
    }

    [Command("openlock_mode", Description = "Turn the dl-openshell mode on or off")]
    public void CmdMode(Caller caller, string state)
    {
        var on = state is "on" or "1" or "true" or "enable";
        var off = state is "off" or "0" or "false" or "disable";
        if (!on && !off)
        {
            caller.Reply("[dl-openshell] use /openlock_mode on|off");
            return;
        }

        Config.Enabled = on;
        if (on)
        {
            ApplyMode();
            _abilityHud.SetHidden(AbilityHudHidden);
        }
        else
        {
            _learning.OpenAll();
            _abilityHud.SetHidden(false);
            _strength.RestoreAll("mode off");
            _world.Restore();
        }

        Log.Write($"[dl-openshell] mode toggled -> {on} by {caller.Name}");
        caller.Reply($"[dl-openshell] mode {(on ? "on" : "off")}");
    }

    [Command("openlock_hud", Description = "Hide or show the ability HUD in this mode: on | off")]
    public void CmdHud(Caller caller, string state = "on")
    {
        var value = (state ?? "on").Trim().ToLowerInvariant();
        Config.HideAbilityHud = value is "on" or "1" or "true" or "hide";

        if (Config.Enabled && Config.DisableHeroAbilities && Config.HideAbilityHud)
            _abilityHud.SetHidden(true);
        else
            _abilityHud.SetHidden(false);

        Log.Write($"[dl-openshell] ability HUD hiding set to {Config.HideAbilityHud} by {caller.Name}");
        caller.Reply(
            $"[dl-openshell] ability HUD hiding {(Config.HideAbilityHud ? "on" : "off")}" +
            (Config.Enabled && Config.DisableHeroAbilities ? "" : " (mode is off, so nothing is hidden)"));
    }

    [Command("openlock-hud", Description = "Hide or show the ability HUD in this mode: on | off")]
    public void CmdHudDashed(Caller caller, string state = "on") => CmdHud(caller, state);

    [Command("openlock_give", Description = "Verification: grant an item to yourself")]
    public void CmdGive(Caller caller, string item)
    {
        var pawn = caller.Player?.GetHeroPawn();
        var granted = pawn?.AddItem(item);

        Log.Write(granted is not null
            ? $"[dl-openshell] give: {item} -> {caller.Name}"
            : $"[dl-openshell] give: failed for {item} for {caller.Name}");

        caller.Reply(granted is not null
            ? $"[dl-openshell] granted {item}"
            : $"[dl-openshell] could not grant {item}");

        if (granted is not null && pawn is not null)
            _pendingReconcile.Add(pawn.Handle);
    }

    [Command("openlock_probe", Description = "Verification: read hero stats and the spirit conversion from the engine")]
    public void CmdProbe() => Probe();

    // Deadlock renders underscores as dashes in chat, and the chat suggestion hands back the
    // dashed spelling, so both spellings have to be real commands.
    [Command("openlock-probe", Description = "Verification: read hero stats and the spirit conversion from the engine")]
    public void CmdProbeDashed() => Probe();

    private void Probe()
    {
        Log.Banner("probe");

        var seen = false;
        foreach (var controller in Players.GetAll())
        {
            if (controller.IsBot)
                continue;

            var pawn = controller.GetHeroPawn();
            if (pawn is null)
                continue;

            seen = true;

            if (Config.SpiritItemsBecomeStrength)
                _strength.Reconcile(pawn, Config, "probe");

            Log.Write(
                $"[dl-openshell] probe slot={controller.Slot} name={controller.PlayerName} hero={pawn.HeroID} " +
                $"level={pawn.Level} health={pawn.Health}/{pawn.MaxHealth} engineMax={pawn.GetMaxHealth()}");

            Log.Write(HeroBonuses.Read(pawn, out var w, out var a, out var t)
                ? $"[dl-openshell]   resolved bonuses: weapon={w:0.##} armor={a:0.##} tech={t:0.##}"
                : "[dl-openshell]   resolved bonuses: hero upgrade bonuses modifier NOT found");

            foreach (var ability in pawn.AbilityComponent.Abilities)
            {
                var vdata = ability.SubclassVData;
                if (vdata is null || !ability.IsItem)
                    continue;

                Log.Write(
                    $"[dl-openshell]   item {vdata.Name} slot={ability.AbilitySlot} " +
                    $"tier={_itemTier.Get(vdata.Handle)} spirit={SpiritToStrength.IsSpirit(vdata)} " +
                    $"upgrades=0b{ability.UpgradeBits:b5}");
            }
        }

        if (!seen)
            Log.Write("[dl-openshell] probe: no player has a hero in the world");
    }
}

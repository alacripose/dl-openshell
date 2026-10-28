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

    public override string Name => "Openlock";

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
        Log.Write($"[Openlock] log file: {Log.Path}");
        Log.Write(
            $"[Openlock]   abilities={(Config.DisableHeroAbilities ? "disabled" : "on")} " +
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
            Log.Write($"[Openlock] recipe missing at {recipePath}; no base values are declared or applied.");
        }
        else
        {
            recipe.Report(recipePath, name => ConVar.Find(name)?.GetFloat());
        }

        _addons = ClientAddons.Resolve(Config);
        foreach (var line in _addons.ReportLines)
            Log.Write($"[Openlock] addon {line}");
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
            $"[Openlock] {Config.ModeName} unloaded (reload-safe): converted stats and their state are kept.");
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
            Log.Write($"[Openlock] ability input blocked slot={args.PlayerSlot} buttons={pressed}");
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
            $"[Openlock] ability point SPEND REFUSED: {args.Amount:+#;-#;0} " +
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
        controller.HudAnnounce("OPENLOCK", "Ability upgrades are disabled in this mode.");
    }

    // --- Per-frame work ---------------------------------------------------

    public override void OnGameFrame(bool simulating, bool firstTick, bool lastTick)
    {
        if (!simulating || !Config.Enabled)
            return;

        _watch.Tick();
        _abilityHud.Tick();
        _shell.Tick();

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
                $"[Openlock] world applied and read back: {Config.ModeName} " +
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
            Log.Write($"[Openlock] modifier add {item} via {modifierName}");

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
        Log.Write($"[Openlock] engine: hero ability executed ability={ability?.AbilityName ?? "?"}");
    }

    // --- Commands ---------------------------------------------------------

    [Command("openlock", Description = "Report the Openlock game mode's state")]
    public void CmdStatus(Caller caller)
    {
        caller.Reply($"[{Config.ModeName}] v{Version} — {(Config.Enabled ? "enabled" : "disabled")}");
        caller.Reply($"[OPENLOCK] hero abilities: {(Config.DisableHeroAbilities ? "disabled" : "enabled")}");
        caller.Reply(
            $"[OPENLOCK] world: gravity={(int)(_world.AppliedGravity ?? 0)}, " +
            $"friction={_world.AppliedFriction?.ToString() ?? "unset"}");
        caller.Reply($"[OPENLOCK] spirit->strength: {_strength.Summary}");
    }

    /// <summary>
    /// The mode's server-side shell. Works from the server console or chat, and every verb is
    /// recorded in the log so an operator can see what was done and to whom.
    /// </summary>
    [Command("openlock_ctl", Description = "Openlock shell: status | steady | repair | restore")]
    public void CmdShell(Caller caller, string verb = "status") => Shell(caller, verb);

    [Command("openlock-ctl", Description = "Openlock shell: status | steady | repair | restore")]
    public void CmdShellDashed(Caller caller, string verb = "status") => Shell(caller, verb);

    private void Shell(Caller caller, string verb)
    {
        var command = (verb ?? "status").Trim().ToLowerInvariant();
        Log.Write($"[Openlock] shell '{command}' by {caller.Name}");

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

                caller.Reply($"[OPENLOCK] {command}: {touched} hero(es) reconciled");
                return;
            }

            case "restore":
                _strength.RestoreAll("shell restore");
                caller.Reply("[OPENLOCK] restored every hero to their captured baseline");
                return;

            default:
                caller.Reply("[OPENLOCK] usage: openlock_ctl status|steady|repair|restore");
                return;
        }
    }

    [Command("openlock_layout", Description = "Openlock layout profiles: status | save")]
    public void CmdLayout(Caller caller, string verb = "status")
    {
        var command = (verb ?? "status").Trim().ToLowerInvariant();
        switch (command)
        {
            case "save":
                _shell.RequestLayoutSave();
                caller.Reply("[OPENLOCK] layout save requested from connected shells");
                return;

            case "status":
                caller.Reply($"[OPENLOCK] layout profiles: {_shell.LayoutDirectory}");
                return;

            default:
                caller.Reply("[OPENLOCK] usage: openlock_layout status|save");
                return;
        }
    }

    [Command("openlock-layout", Description = "Openlock layout profiles: status | save")]
    public void CmdLayoutDashed(Caller caller, string verb = "status") => CmdLayout(caller, verb);

    [Command("openlock_ui", Description = "Openlock shell panel: open | hide")]
    public void CmdUi(Caller caller, string verb = "open")
    {
        if (caller.Player is not { } controller)
            return;

        if ((verb ?? "open").Trim().Equals("hide", StringComparison.OrdinalIgnoreCase))
        {
            _shell.Collapse(controller);
            caller.Reply("[OPENLOCK] shell hidden; cursor returned");
            return;
        }

        _shell.Open(controller);
        caller.Reply("[OPENLOCK] shell open; press Hide to return the cursor");
    }

    [Command("openlock-ui", Description = "Openlock shell panel: open | hide")]
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

        Log.Write($"[Openlock] shell toggled mode -> {Config.Enabled}");
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

        Log.Write($"[Openlock] {reason}: {touched} hero(es) reconciled");
    }

    public void RestoreAllFromShell()
    {
        _strength.RestoreAll("shell restore");
        Log.Write("[Openlock] shell restore: every hero returned to their captured baseline");
    }

    [Command("openlock_mode", Description = "Turn the Openlock mode on or off")]
    public void CmdMode(Caller caller, string state)
    {
        var on = state is "on" or "1" or "true" or "enable";
        var off = state is "off" or "0" or "false" or "disable";
        if (!on && !off)
        {
            caller.Reply("[OPENLOCK] use /openlock_mode on|off");
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

        Log.Write($"[Openlock] mode toggled -> {on} by {caller.Name}");
        caller.Reply($"[OPENLOCK] mode {(on ? "on" : "off")}");
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

        Log.Write($"[Openlock] ability HUD hiding set to {Config.HideAbilityHud} by {caller.Name}");
        caller.Reply(
            $"[OPENLOCK] ability HUD hiding {(Config.HideAbilityHud ? "on" : "off")}" +
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
            ? $"[Openlock] give: {item} -> {caller.Name}"
            : $"[Openlock] give: failed for {item} for {caller.Name}");

        caller.Reply(granted is not null
            ? $"[OPENLOCK] granted {item}"
            : $"[OPENLOCK] could not grant {item}");

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
                $"[Openlock] probe slot={controller.Slot} name={controller.PlayerName} hero={pawn.HeroID} " +
                $"level={pawn.Level} health={pawn.Health}/{pawn.MaxHealth} engineMax={pawn.GetMaxHealth()}");

            Log.Write(HeroBonuses.Read(pawn, out var w, out var a, out var t)
                ? $"[Openlock]   resolved bonuses: weapon={w:0.##} armor={a:0.##} tech={t:0.##}"
                : "[Openlock]   resolved bonuses: hero upgrade bonuses modifier NOT found");

            foreach (var ability in pawn.AbilityComponent.Abilities)
            {
                var vdata = ability.SubclassVData;
                if (vdata is null || !ability.IsItem)
                    continue;

                Log.Write(
                    $"[Openlock]   item {vdata.Name} slot={ability.AbilitySlot} " +
                    $"tier={_itemTier.Get(vdata.Handle)} spirit={SpiritToStrength.IsSpirit(vdata)} " +
                    $"upgrades=0b{ability.UpgradeBits:b5}");
            }
        }

        if (!seen)
            Log.Write("[Openlock] probe: no player has a hero in the world");
    }
}

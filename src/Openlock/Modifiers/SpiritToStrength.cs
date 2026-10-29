using DeadworksManaged.Api;

namespace Openlock.Modifiers;

/// <summary>
/// Modifier 4: a spirit item the hero owns is worth points by its tier, and those points land on the
/// hero's strength stats — weapon and vitality — while the tech contribution is cancelled.
///
/// <para>
/// <b>Why absolute targets.</b> The conversion is expressed as <c>baseline + worth</c>, never as
/// "current + worth". The baseline is the engine's own pre-conversion value for that hero, captured
/// once and persisted. Applying therefore converges: a reload, a respawn, a re-buy or a second call
/// computes the same target and writes nothing when the engine already holds it.
/// </para>
///
/// <para>
/// <b>Why the state survives a reload.</b> Deadworks hot-reloads a plugin by unloading the old
/// instance and loading a new one. An unload therefore must not restore or clear state: the engine
/// values stay converted, and the state file tells the new instance those values are its own. Only
/// an explicit mode-off restores the shipped baselines.
/// </para>
/// </summary>
public sealed class SpiritToStrength
{
    private static readonly SchemaAccessor<float> _weapon =
        new("CCitadel_Modifier_HeroUpgradeBonuses"u8, "m_flWeaponPower"u8);
    private static readonly SchemaAccessor<float> _armor =
        new("CCitadel_Modifier_HeroUpgradeBonuses"u8, "m_flArmorPower"u8);
    private static readonly SchemaAccessor<float> _tech =
        new("CCitadel_Modifier_HeroUpgradeBonuses"u8, "m_flTechPower"u8);

    private static readonly SchemaAccessor<int> _maxHealthField =
        new("CBaseEntity"u8, "m_iMaxHealth"u8);

    private static readonly SchemaAccessor<int> _itemTier =
        new("CitadelItemVData"u8, "m_iItemTier"u8);

    private static readonly SchemaAccessor<byte> _slotType =
        new("CitadelAbilityVData"u8, "m_eItemSlotType"u8);

    private const int SpiritSlot = 2;

    public sealed class State
    {
        public float BaselineWeapon { get; set; }
        public float BaselineArmor { get; set; }
        public float BaselineTech { get; set; }
        public int BaselineHealth { get; set; }
        public float Worth { get; set; }

        // Read from state files written before baselines were captured; used once to reconstruct a
        // baseline for heroes converted by those earlier builds.
        public float WeaponAdded { get; set; }
        public float ArmorAdded { get; set; }
        public float TechRemoved { get; set; }
        public int HealthAdded { get; set; }
    }

    private static readonly string StatePath = ResolveStatePath();
    private readonly Dictionary<string, State> _states = LoadStates();

    public int Conversions { get; private set; }
    public float TotalWeapon { get; private set; }
    public float TotalVitality { get; private set; }

    public static int TierOf(CEntitySubclassVDataBase vdata) => _itemTier.Get(vdata.Handle);

    public static bool IsSpirit(CEntitySubclassVDataBase vdata) =>
        _slotType.Get(vdata.Handle) == SpiritSlot;

    private static string ResolveStatePath()
    {
        var dir = Path.Combine(AppContext.BaseDirectory, "managed", "plugins");
        return Path.Combine(Directory.Exists(dir) ? dir : ".", "openlock.state.json");
    }

    private static Dictionary<string, State> LoadStates()
    {
        try
        {
            if (!File.Exists(StatePath))
                return [];

            var states = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, State>>(
                File.ReadAllText(StatePath));

            return states ?? [];
        }
        catch (Exception ex)
        {
            Log.Write($"[dl-openshell] conversion state unreadable ({ex.GetType().Name}); starting empty");
            return [];
        }
    }

    /// <summary>Writes the whole file through a temp file, so a reader never sees a partial write.</summary>
    private static void SaveStates(Dictionary<string, State> states)
    {
        try
        {
            var temp = StatePath + ".tmp";
            File.WriteAllText(temp, System.Text.Json.JsonSerializer.Serialize(states));
            File.Move(temp, StatePath, overwrite: true);
        }
        catch (Exception ex)
        {
            Log.Write($"[dl-openshell] conversion state not saved ({ex.GetType().Name})");
        }
    }

    // SteamID is stable across reloads and reconnects; a bot has none, so 0 is used and the hero id
    // keeps bots of different heroes apart. A controller-less hero falls back to the same key shape.
    private static string KeyOf(CCitadelPlayerPawn pawn) =>
        $"{pawn.Controller?.PlayerSteamId ?? 0UL}|{pawn.HeroID}";

    public bool TechIsLive(CCitadelPlayerPawn pawn, out string detail)
    {
        detail = "";

        if (!HeroBonuses.TryFind(pawn, out var modifier))
        {
            detail = "no hero upgrade bonuses modifier";
            return false;
        }

        var before = _tech.Get(modifier.Handle);
        var probe = before + 1f;
        _tech.Set(modifier.Handle, probe);
        var readBack = _tech.Get(modifier.Handle);
        _tech.Set(modifier.Handle, before);
        var restored = _tech.Get(modifier.Handle);

        detail = $"tech {before:0.##} -> wrote {probe:0.##} -> read {readBack:0.##} -> restored {restored:0.##}";
        return MathF.Abs(readBack - probe) < 0.001f && MathF.Abs(restored - before) < 0.001f;
    }

    /// <summary>
    /// Brings one hero's converted stats to their target. Idempotent: the target depends only on the
    /// captured baseline and the spirit items currently owned, so repeated calls write nothing.
    /// </summary>
    public void Reconcile(CCitadelPlayerPawn pawn, OpenlockConfig config, string reason)
    {
        if (!HeroBonuses.TryFind(pawn, out var modifier))
        {
            Log.Write($"[dl-openshell] conversion ({reason}) REFUSED: no hero upgrade bonuses modifier on {pawn.HeroID}");
            return;
        }

        var key = KeyOf(pawn);
        var owned = new List<(string Name, int Tier)>();
        var worth = 0f;

        foreach (var ability in pawn.AbilityComponent.Abilities)
        {
            var vdata = ability.SubclassVData;
            if (vdata is null || !ability.IsItem || !IsSpirit(vdata))
                continue;

            var tier = TierOf(vdata);
            owned.Add((vdata.Name, tier));
            worth += config.WorthOfTier(tier);
        }

        var fresh = !_states.TryGetValue(key, out var state);
        state ??= new State();

        // A state file from an earlier build has no baseline. Reconstruct it by undoing the deltas
        // that build recorded, and say so: any application it failed to record cannot be undone.
        if (!fresh && state.BaselineWeapon == 0f && state.BaselineArmor == 0f
            && state.BaselineTech == 0f && state.BaselineHealth == 0
            && (state.WeaponAdded != 0f || state.ArmorAdded != 0f || state.HealthAdded != 0))
        {
            var curWeapon = _weapon.Get(modifier.Handle);
            var curArmor = _armor.Get(modifier.Handle);
            var curTech = _tech.Get(modifier.Handle);
            var curHealth = _maxHealthField.Get(pawn.Handle);

            state.BaselineWeapon = curWeapon - state.WeaponAdded;
            state.BaselineArmor = curArmor - state.ArmorAdded;
            state.BaselineTech = curTech + state.TechRemoved;
            state.BaselineHealth = curHealth - state.HealthAdded;

            Log.Write(
                $"[dl-openshell] repair {pawn.Controller?.PlayerName ?? $"hero {pawn.HeroID}"}: " +
                $"legacy state reconstructed (undid recorded deltas) weapon {curWeapon:0.##}->{state.BaselineWeapon:0.##}, " +
                $"vitality {curArmor:0.##}->{state.BaselineArmor:0.##}, tech {curTech:0.##}->{state.BaselineTech:0.##}, " +
                $"maxhealth {curHealth}->{state.BaselineHealth}; unrecorded applications cannot be undone");

            state.WeaponAdded = state.ArmorAdded = state.TechRemoved = 0f;
            state.HealthAdded = 0;
            fresh = true;
        }

        if (fresh)
        {
            // Capture what the engine had before this hero was ever converted.
            state.BaselineWeapon = _weapon.Get(modifier.Handle);
            state.BaselineArmor = _armor.Get(modifier.Handle);
            state.BaselineTech = _tech.Get(modifier.Handle);
            state.BaselineHealth = _maxHealthField.Get(pawn.Handle);
            Log.Write(
                $"[dl-openshell] conversion ({reason}) {pawn.Controller?.PlayerName ?? $"hero {pawn.HeroID}"} " +
                $"baseline captured: weapon={state.BaselineWeapon:0.##} armor={state.BaselineArmor:0.##} " +
                $"tech={state.BaselineTech:0.##} maxhealth={state.BaselineHealth}");
        }

        var targetWeapon = state.BaselineWeapon + worth * config.WeaponPowerScale;
        var targetArmor = state.BaselineArmor + worth * config.VitalityScale;
        var techRemoval = MathF.Min(worth, MathF.Max(0f, state.BaselineTech));
        var targetTech = state.BaselineTech - techRemoval;
        var targetHealth = state.BaselineHealth + (int)MathF.Round(worth * config.HealthPerPoint);

        var weaponBefore = _weapon.Get(modifier.Handle);
        var armorBefore = _armor.Get(modifier.Handle);
        var techBefore = _tech.Get(modifier.Handle);
        var healthBefore = _maxHealthField.Get(pawn.Handle);

        if (fresh)
        {
            var techLive = TechIsLive(pawn, out var techDetail);
            Log.Write($"[dl-openshell] conversion ({reason}) tech instrument {(techLive ? "LIVE" : "DEAD")}: {techDetail}");
        }

        var changed = false;

        if (MathF.Abs(weaponBefore - targetWeapon) > 0.001f)
        {
            _weapon.Set(modifier.Handle, targetWeapon);
            changed = true;
        }

        if (MathF.Abs(armorBefore - targetArmor) > 0.001f)
        {
            _armor.Set(modifier.Handle, targetArmor);
            changed = true;
        }

        if (MathF.Abs(techBefore - targetTech) > 0.001f)
        {
            _tech.Set(modifier.Handle, targetTech);
            changed = true;
        }

        if (healthBefore != targetHealth)
        {
            _maxHealthField.Set(pawn.Handle, targetHealth);
            changed = true;
        }

        var weaponAfter = _weapon.Get(modifier.Handle);
        var armorAfter = _armor.Get(modifier.Handle);
        var techAfter = _tech.Get(modifier.Handle);
        var healthAfter = _maxHealthField.Get(pawn.Handle);

        var items = owned.Count == 0 ? "none" : string.Join(", ", owned.Select(i => $"{i.Name}(T{i.Tier})"));

        var verified =
            MathF.Abs(weaponAfter - targetWeapon) < 0.001f &&
            MathF.Abs(armorAfter - targetArmor) < 0.001f &&
            MathF.Abs(techAfter - targetTech) < 0.001f &&
            healthAfter == targetHealth;

        if (!changed)
        {
            Log.Write(
                $"[dl-openshell] conversion ({reason}) STEADY {pawn.Controller?.PlayerName ?? $"hero {pawn.HeroID}"} " +
                $"items=[{items}] worth={worth:0.##} | weapon={weaponAfter:0.##} vitality={armorAfter:0.##} " +
                $"tech={techAfter:0.##} maxhealth={healthAfter}");
        }
        else
        {
            Log.Write(
                $"[dl-openshell] conversion ({reason}) {pawn.Controller?.PlayerName ?? $"hero {pawn.HeroID}"} " +
                $"items=[{items}] worth={worth:0.##} | " +
                $"weapon {weaponBefore:0.##}->{weaponAfter:0.##} (target {targetWeapon:0.##}), " +
                $"vitality {armorBefore:0.##}->{armorAfter:0.##} (target {targetArmor:0.##}), " +
                $"tech {techBefore:0.##}->{techAfter:0.##} (cancelled {techRemoval:0.##}), " +
                $"maxhealth {healthBefore}->{healthAfter} (target {targetHealth}) | " +
                $"readback {(verified ? "OK" : "MISMATCH")}");
        }

        if (!verified)
            return;

        state.Worth = worth;
        _states[key] = state;
        SaveStates(_states);

        if (changed)
        {
            Conversions++;
            TotalWeapon += weaponAfter - state.BaselineWeapon;
            TotalVitality += armorAfter - state.BaselineArmor;
        }
    }

    /// <summary>Returns one hero to the exact baseline captured before conversion.</summary>
    public void Restore(CCitadelPlayerPawn pawn, string reason, bool force = false)
    {
        var key = KeyOf(pawn);
        if (!_states.TryGetValue(key, out var state))
            return;

        if (!HeroBonuses.TryFind(pawn, out var modifier))
        {
            Log.Write($"[dl-openshell] restore ({reason}) deferred: no bonuses modifier on {pawn.HeroID}");
            return;
        }

        var before = (_weapon.Get(modifier.Handle), _armor.Get(modifier.Handle), _tech.Get(modifier.Handle), _maxHealthField.Get(pawn.Handle));

        _weapon.Set(modifier.Handle, state.BaselineWeapon);
        _armor.Set(modifier.Handle, state.BaselineArmor);
        _tech.Set(modifier.Handle, state.BaselineTech);
        _maxHealthField.Set(pawn.Handle, state.BaselineHealth);

        Log.Write(
            $"[dl-openshell] restore ({reason}) {pawn.Controller?.PlayerName ?? $"hero {pawn.HeroID}"}: " +
            $"weapon {before.Item1:0.##}->{_weapon.Get(modifier.Handle):0.##} (baseline {state.BaselineWeapon:0.##}), " +
            $"vitality {before.Item2:0.##}->{_armor.Get(modifier.Handle):0.##} (baseline {state.BaselineArmor:0.##}), " +
            $"tech {before.Item3:0.##}->{_tech.Get(modifier.Handle):0.##} (baseline {state.BaselineTech:0.##}), " +
            $"maxhealth {before.Item4}->{_maxHealthField.Get(pawn.Handle)} (baseline {state.BaselineHealth})");

        _states.Remove(key);
        SaveStates(_states);
    }

    public void RestoreAll(string reason)
    {
        foreach (var controller in Players.GetAll())
        {
            var pawn = controller.GetHeroPawn();
            if (pawn is not null)
                Restore(pawn, reason);
        }

        // Only clear what could not be restored (hero left the world); their state stays on disk.
        SaveStates(_states);
    }

    public string Summary =>
        $"{Conversions} conversion(s), weapon {TotalWeapon:+0.##;-0.##;0}, vitality {TotalVitality:+0.##;-0.##;0}";
}

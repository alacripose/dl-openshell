using DeadworksManaged.Api;

namespace Openlock;

/// <summary>
/// The mode's tunables. Written to <c>game/bin/win64/configs/OpenlockPlugin/OpenlockPlugin.jsonc</c>
/// on first load.
/// </summary>
public sealed class OpenlockConfig : IConfig
{
    /// <summary>Master switch for every modifier. Off restores the world ConVars and the item values.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Name shown in chat and in the load banner.</summary>
    public string ModeName { get; set; } = "dl-openshell";

    /// <summary>
    /// Client addon roots, checked before the game's own search paths. Empty means "use the game's
    /// configured search paths only" — Grimoire is neither required nor consulted. A listed root
    /// that does not exist, or lacks the shell layout, is refused by path.
    /// </summary>
    public string[] ClientAddonPaths { get; set; } = [];

    // 1. Hero abilities disabled.
    /// <summary>Block all hero ability input, including alt-cast. Item actives stay usable.</summary>
    public bool DisableHeroAbilities { get; set; } = true;

    /// <summary>
    /// Collapse the game's ability bar and upgrade affordances while the mode is on. Separate from
    /// <see cref="DisableHeroAbilities"/> so a player can keep the bar visible if they prefer it.
    /// Requires the client UI addon; when it is missing the bar stays visible and the refusal is
    /// logged rather than pretending otherwise.
    /// </summary>
    public bool HideAbilityHud { get; set; } = true;

    // 2. Gravity reduced by 200.
    /// <summary>Subtracted from the engine's <c>sv_gravity</c> baseline (800 on this build, so 600).</summary>
    public float GravityReduction { get; set; } = 200f;

    // 3. Friction set to 2.
    /// <summary>Value written to <c>sv_friction</c>. Engine default is 4 on this build.</summary>
    public float Friction { get; set; } = 2f;

    /// <summary>
    /// *Off* by default. Writing <c>m_flMaxspeed</c> every frame fought the engine's own movement
    /// recomputation and mangled sprint in play, so it stays off until it is driven by a declared
    /// patch recipe with the shipped baselines instead of a hard-coded constant.
    /// </summary>
    public bool NormalizeMovement { get; set; }

    /// <summary>Base walk speed in m/s, written to the pawn's movement services each frame.</summary>
    public float BaseMoveSpeed { get; set; } = 10f;

    /// <summary>Added to <see cref="BaseMoveSpeed"/> while the hero is sprinting.</summary>
    public float SprintBonus { get; set; } = 2f;

    /// <summary>Stamina the hero can hold. Written to the engine's stamina resource.</summary>
    public float MaxStamina { get; set; } = 2f;

    /// <summary>
    /// Stamina regen the original build used. This build exposes no writable regen rate
    /// (<c>AbilityResource_t.m_flPrevRegenRate</c> is a read-back of the engine's own value), so
    /// this is reported as unsupported rather than applied.
    /// </summary>
    public float StaminaRegen { get; set; } = 1.25f;

    // 4. Spirit items reworked into strength items.
    /// <summary>Convert owned spirit items' worth into weapon and vitality stats.</summary>
    public bool SpiritItemsBecomeStrength { get; set; } = true;

    /// <summary>Worth of a tier 1 spirit item, in spirit points.</summary>
    public float Tier1Worth { get; set; } = 10f;

    /// <summary>Worth of a tier 2 spirit item.</summary>
    public float Tier2Worth { get; set; } = 20f;

    /// <summary>Worth of a tier 3 spirit item.</summary>
    public float Tier3Worth { get; set; } = 30f;

    /// <summary>Worth of a tier 4 spirit item.</summary>
    public float Tier4Worth { get; set; } = 40f;

    /// <summary>Multiplier applied to converted worth when it lands on weapon power.</summary>
    public float WeaponPowerScale { get; set; } = 1f;

    /// <summary>Multiplier applied to converted worth when it lands on the vitality (armor) stat.</summary>
    public float VitalityScale { get; set; } = 1f;

    /// <summary>Max health granted per converted spirit point. 0 leaves max health alone.</summary>
    public float HealthPerPoint { get; set; } = 3f;

    public float WorthOfTier(int tier) => tier switch
    {
        1 => Tier1Worth,
        2 => Tier2Worth,
        3 => Tier3Worth,
        4 => Tier4Worth,
        _ => 0f,
    };

    public void Validate()
    {
        if (string.IsNullOrWhiteSpace(ModeName)
            || string.Equals(ModeName, "OPENLOCK", StringComparison.OrdinalIgnoreCase)
            || string.Equals(ModeName, "OPENSHELL", StringComparison.OrdinalIgnoreCase))
            ModeName = "dl-openshell";

        GravityReduction = Math.Clamp(GravityReduction, 0f, 800f);
        Friction = Math.Clamp(Friction, 0f, 100f);
        WeaponPowerScale = Math.Clamp(WeaponPowerScale, 0f, 10f);
        VitalityScale = Math.Clamp(VitalityScale, 0f, 10f);
        HealthPerPoint = Math.Clamp(HealthPerPoint, 0f, 100f);
        Tier1Worth = Math.Clamp(Tier1Worth, 0f, 500f);
        Tier2Worth = Math.Clamp(Tier2Worth, 0f, 500f);
        Tier3Worth = Math.Clamp(Tier3Worth, 0f, 500f);
        Tier4Worth = Math.Clamp(Tier4Worth, 0f, 500f);
        BaseMoveSpeed = Math.Clamp(BaseMoveSpeed, 0f, 100f);
        SprintBonus = Math.Clamp(SprintBonus, 0f, 100f);
        MaxStamina = Math.Clamp(MaxStamina, 0f, 20f);
        StaminaRegen = Math.Clamp(StaminaRegen, 0f, 20f);
    }
}

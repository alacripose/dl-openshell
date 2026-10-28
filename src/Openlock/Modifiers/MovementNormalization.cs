using DeadworksManaged.Api;

namespace Openlock.Modifiers;

/// <summary>
/// Normalizes every hero's base movement to the same numbers the original Openlock build used:
/// 10 m/s walk, sprint 2 m/s above that, 2 stamina, 1.25 stamina regen.
///
/// <para>
/// The engine has no hero-level "base speed" field to write. What it has is
/// <c>CBasePlayerPawn.m_pMovementServices</c> (a pointer to the pawn's
/// <c>CPlayer_MovementServices</c>) whose <c>m_flMaxspeed</c> is the cap the movement code uses
/// that tick; the game recomputes it from items, buffs and sprint. So the normalization is a
/// per-frame write of that one field, reasserted after the game recomputes it, with sprint read
/// back from the sprint ability's own <c>m_bSprinting</c> flag rather than guessed.
/// </para>
///
/// <para>
/// Stamina is two numbers on <c>AbilityResource_t</c>: <c>m_flMaxValue</c> and, for the current
/// value, <c>m_flCurrentValue</c>. Regen has no writable schema field on this build - only
/// <c>m_flPrevRegenRate</c>, which is a read-back of the rate the engine last used - so the
/// configured regen value is reported as unsupported instead of silently claimed.
/// </para>
/// </summary>
public sealed class MovementNormalization
{
    private static readonly SchemaAccessor<nint> _movementServices =
        new("CBasePlayerPawn"u8, "m_pMovementServices"u8);

    private static readonly SchemaAccessor<float> _maxSpeed =
        new("CPlayer_MovementServices"u8, "m_flMaxspeed"u8);

    private static readonly SchemaAccessor<bool> _sprinting =
        new("CCitadel_Ability_Sprint"u8, "m_bSprinting"u8);

    public int Writes { get; private set; }
    public float? LastEngineSpeed { get; private set; }
    public float? LastTargetSpeed { get; private set; }
    public bool? LastSprinting { get; private set; }
    public float? StaminaMax { get; private set; }

    /// <summary>Applies the normalized speed and stamina to one hero for this frame.</summary>
    public void Apply(CCitadelPlayerPawn pawn, float walk, float sprintBonus, float stamina)
    {
        nint services = _movementServices.Get(pawn.Handle);
        if (services == 0)
            return;

        bool sprinting = IsSprinting(pawn);
        float target = sprinting ? walk + sprintBonus : walk;
        float current = _maxSpeed.Get(services);

        LastEngineSpeed = current;
        LastTargetSpeed = target;
        LastSprinting = sprinting;

        // Reassert only when the engine has drifted from the target; writing every tick would
        // send a network state change for a value that did not change.
        if (MathF.Abs(current - target) > 0.01f)
        {
            _maxSpeed.Set(services, target);
            Writes++;
        }

        var resource = pawn.AbilityComponent.ResourceStamina;
        if (MathF.Abs(resource.MaxValue - stamina) > 0.001f)
        {
            resource.MaxValue = stamina;
            if (resource.CurrentValue > stamina)
                pawn.SetStamina(stamina);
        }

        StaminaMax = resource.MaxValue;
    }

    public (float Speed, bool Sprinting, float Stamina, float StaminaMax)? Read(CCitadelPlayerPawn pawn)
    {
        nint services = _movementServices.Get(pawn.Handle);
        if (services == 0)
            return null;

        var resource = pawn.AbilityComponent.ResourceStamina;
        return (_maxSpeed.Get(services), IsSprinting(pawn), resource.CurrentValue, resource.MaxValue);
    }

    private static bool IsSprinting(CCitadelPlayerPawn pawn)
    {
        foreach (var ability in pawn.AbilityComponent.Abilities)
        {
            var name = ability.SubclassVData?.Name;
            if (name is null || !name.Contains("sprint", StringComparison.OrdinalIgnoreCase))
                continue;

            return _sprinting.Get(ability.Handle);
        }

        return false;
    }
}

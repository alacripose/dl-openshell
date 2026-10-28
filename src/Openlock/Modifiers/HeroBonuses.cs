using DeadworksManaged.Api;

namespace Openlock.Modifiers;

/// <summary>
/// Reads the engine's resolved hero bonus numbers straight off the pawn's own
/// <c>CCitadel_Modifier_HeroUpgradeBonuses</c> instance: weapon power, armor power and tech power.
///
/// <para>
/// Item VData is not the carrier — <c>modifier_intrinsic_base</c> came back with an empty
/// <c>m_vecScriptValues</c> on this build, so rewriting it changed nothing. These three fields are
/// what the engine actually resolves onto the hero. Read-only: nothing here grants, removes or
/// mutates anything.
/// </para>
/// </summary>
public static class HeroBonuses
{
    private static readonly SchemaAccessor<float> _weapon = new("CCitadel_Modifier_HeroUpgradeBonuses"u8, "m_flWeaponPower"u8);
    private static readonly SchemaAccessor<float> _armor = new("CCitadel_Modifier_HeroUpgradeBonuses"u8, "m_flArmorPower"u8);
    private static readonly SchemaAccessor<float> _tech = new("CCitadel_Modifier_HeroUpgradeBonuses"u8, "m_flTechPower"u8);

    private static bool IsUpgradeBonuses(string name)
    {
        Span<char> buffer = stackalloc char[name.Length];
        var n = 0;
        foreach (var c in name)
        {
            if (c == '_')
                continue;
            buffer[n++] = char.ToLowerInvariant(c);
        }

        return buffer[..n].SequenceEqual("modifierheroupgradebonuses");
    }

    /// <summary>Finds the pawn's own hero upgrade-bonuses modifier instance.</summary>
    public static bool TryFind(CCitadelPlayerPawn pawn, out CBaseModifier modifier)
    {
        modifier = null!;

        var props = pawn.ModifierProp;
        if (props is null)
            return false;

        foreach (var candidate in props.Modifiers)
        {
            var name = candidate.SubclassVData?.Name;
            if (name is null || !IsUpgradeBonuses(name))
                continue;

            modifier = candidate;
            return true;
        }

        return false;
    }

    /// <summary>Reads the resolved hero bonus numbers off the pawn's own modifier instance.</summary>
    public static bool Read(CCitadelPlayerPawn pawn, out float weapon, out float armor, out float tech)
    {
        weapon = armor = tech = float.NaN;

        if (!TryFind(pawn, out var modifier))
            return false;

        weapon = _weapon.Get(modifier.Handle);
        armor = _armor.Get(modifier.Handle);
        tech = _tech.Get(modifier.Handle);
        return true;
    }
}

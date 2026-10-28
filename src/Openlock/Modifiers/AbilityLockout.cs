using DeadworksManaged.Api;

namespace Openlock.Modifiers;

/// <summary>
/// Modifier 1: hero abilities disabled. <see cref="AbilityAttemptEvent.BlockedButtons"/> is the
/// engine's own pre-execution mask, so a blocked ability never runs and never starts its cooldown.
///
/// <c>AllAbilities</c> alone is only Ability1–Ability4; the alt-cast and held-ability bits are
/// separate, so they are blocked explicitly. Item actives use <see cref="InputButton.AllItems"/> and
/// stay usable on purpose: the mode removes hero kits, not the shop.
///
/// <para>
/// Innates are deliberately <b>not</b> blocked. Sprint and the stamina dash live in that mask, and a
/// playtest with the mode on showed movement breaking the moment they were blocked: the player held
/// sprint, every tick was refused, and the hero could not move normally. Those are movement, not the
/// hero kit this mode removes.
/// </para>
/// </summary>
public static class AbilityLockout
{
    public const InputButton HeroAbilityInputs =
        InputButton.AllAbilities |
        InputButton.AbilityHeld |
        InputButton.AltCast;

    public static void Apply(AbilityAttemptEvent args) => args.BlockedButtons |= HeroAbilityInputs;
}

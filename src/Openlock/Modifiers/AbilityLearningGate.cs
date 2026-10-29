using DeadworksManaged.Api;

namespace Openlock.Modifiers;

/// <summary>
/// Refuses ability learning and upgrading at the engine's own gate.
///
/// <para>
/// <c>CCitadelPlayerPawn.m_arrPreventAbilityLearning</c> is the server's per-hero "cannot learn or
/// upgrade" switch: four bools, one per hero ability, networked <c>LocalPlayerExclusive</c> so the
/// client's upgrade affordance sees them. Writing them is a refusal at the source — the spend never
/// happens — rather than letting an upgrade through and reverting it afterwards.
/// </para>
///
/// <para>
/// Only the four signature slots are covered. Innates (sprint, dash, stamina) and item actives are
/// untouched: this mode removes the hero kit, not movement and not the shop.
/// </para>
/// </summary>
public sealed class AbilityLearningGate
{
    private const int HeroAbilitySlots = 4;

    private static readonly SchemaArrayAccessor<bool> _prevent =
        new("CCitadelPlayerPawn"u8, "m_arrPreventAbilityLearning"u8);

    private readonly Dictionary<nint, bool> _applied = [];

    /// <summary>Closes or opens the gate on one pawn. Idempotent; logs only on a real change.</summary>
    public void Apply(CCitadelPlayerPawn pawn, bool prevent)
    {
        if (_applied.TryGetValue(pawn.Handle, out var current) && current == prevent)
            return;

        for (var i = 0; i < HeroAbilitySlots; i++)
            _prevent.Set(pawn.Handle, i, prevent);

        _applied[pawn.Handle] = prevent;
        Log.Write(
            $"[dl-openshell] learning gate {(prevent ? "closed" : "opened")} for " +
            $"{(string.IsNullOrEmpty(pawn.Controller?.PlayerName) ? $"hero {pawn.HeroID}" : pawn.Controller!.PlayerName)} " +
            $"({HeroAbilitySlots} hero ability slots)");
    }

    /// <summary>Opens the gate on every pawn this gate has touched, including disconnected ones.</summary>
    public void OpenAll()
    {
        foreach (var (handle, applied) in _applied)
        {
            if (!applied)
                continue;

            for (var i = 0; i < HeroAbilitySlots; i++)
                _prevent.Set(handle, i, false);
        }

        if (_applied.Values.Any(v => v))
            Log.Write($"[dl-openshell] learning gate opened on {_applied.Count} pawn(s)");

        _applied.Clear();
    }
}

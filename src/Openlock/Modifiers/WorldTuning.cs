using DeadworksManaged.Api;

namespace Openlock.Modifiers;

/// <summary>
/// Modifiers 2 and 3: world gravity and friction, written to the engine's own ConVars.
/// The baseline is captured the first time the mode applies, so "reduced by 200" means 200
/// below the value the engine shipped with, not below whatever a previous mode left behind.
/// </summary>
public sealed class WorldTuning
{
    private const string GravityVar = "sv_gravity";
    private const string FrictionVar = "sv_friction";

    private float? _gravityBaseline;
    private float? _frictionBaseline;

    public bool IsApplied { get; private set; }
    public float? AppliedGravity { get; private set; }
    public float? AppliedFriction { get; private set; }

    public void Apply(float gravityReduction, float friction)
    {
        var gravity = ConVar.Find(GravityVar);
        var frictionVar = ConVar.Find(FrictionVar);

        if (gravity is null || frictionVar is null)
        {
            Console.WriteLine(
                $"[Openlock] world tuning refused: {(gravity is null ? GravityVar : FrictionVar)} not found on this build.");
            return;
        }

        _gravityBaseline ??= gravity.GetFloat();
        _frictionBaseline ??= frictionVar.GetFloat();

        var target = MathF.Max(0f, _gravityBaseline.Value - gravityReduction);
        gravity.SetFloat(target);
        frictionVar.SetFloat(friction);

        // Read back rather than trusting the write: the value the engine actually holds is the
        // only evidence that the modifier is in effect.
        AppliedGravity = gravity.GetFloat();
        AppliedFriction = frictionVar.GetFloat();
        IsApplied = true;
    }

    /// <summary>Puts both ConVars back to the values captured before the mode first ran.</summary>
    public void Restore()
    {
        if (_gravityBaseline is { } gravity)
            ConVar.Find(GravityVar)?.SetFloat(gravity);

        if (_frictionBaseline is { } friction)
            ConVar.Find(FrictionVar)?.SetFloat(friction);

        IsApplied = false;
    }
}

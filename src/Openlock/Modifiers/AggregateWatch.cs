using DeadworksManaged.Api;

namespace Openlock.Modifiers;

/// <summary>
/// Logs every change to a hero's engine-resolved bonuses: weapon power, armor power, tech power and
/// max health, read off the hero's own <c>CCitadel_Modifier_HeroUpgradeBonuses</c> instance.
///
/// <para>
/// This is how the spirit item's carrier gets named. Buying an item changes those four numbers in
/// one step; the log line records the before and after values and the delta, so the field that
/// actually moved is evidence rather than a guess. It only runs for real players, needs no console
/// and survives a disconnect.
/// </para>
/// </summary>
public sealed class AggregateWatch
{
    private sealed class Snapshot
    {
        public float Weapon, Armor, Tech, Health;
        public bool Valid;
    }

    private readonly Dictionary<nint, Snapshot> _last = [];

    public int Changes { get; private set; }

    public void Tick()
    {
        foreach (var controller in Players.GetAll())
        {
            if (controller.IsBot)
                continue;

            var pawn = controller.GetHeroPawn();
            if (pawn is null)
                continue;

            if (!HeroBonuses.Read(pawn, out var weapon, out var armor, out var tech))
                continue;

            var health = pawn.GetMaxHealth();
            if (!_last.TryGetValue(pawn.Handle, out var previous) || !previous.Valid)
            {
                _last[pawn.Handle] = new Snapshot
                {
                    Weapon = weapon, Armor = armor, Tech = tech, Health = health, Valid = true,
                };
                continue;
            }

            var dWeapon = weapon - previous.Weapon;
            var dArmor = armor - previous.Armor;
            var dTech = tech - previous.Tech;
            var dHealth = health - previous.Health;

            if (MathF.Abs(dWeapon) < 0.01f && MathF.Abs(dArmor) < 0.01f
                && MathF.Abs(dTech) < 0.01f && MathF.Abs(dHealth) < 0.01f)
                continue;

            Changes++;
            Log.Write(
                $"[Openlock] aggregate changed player={controller.PlayerName} " +
                $"hero={pawn.HeroID} | " +
                $"weapon {previous.Weapon:0.##}->{weapon:0.##} ({dWeapon:+0.##;-0.##;0}) | " +
                $"armor {previous.Armor:0.##}->{armor:0.##} ({dArmor:+0.##;-0.##;0}) | " +
                $"tech {previous.Tech:0.##}->{tech:0.##} ({dTech:+0.##;-0.##;0}) | " +
                $"maxhealth {previous.Health:0.##}->{health:0.##} ({dHealth:+0.##;-0.##;0})");

            previous.Weapon = weapon;
            previous.Armor = armor;
            previous.Tech = tech;
            previous.Health = health;
        }
    }
}

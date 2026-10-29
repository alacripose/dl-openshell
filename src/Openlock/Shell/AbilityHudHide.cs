using DeadworksManaged.Api;
using DeadworksManaged.Api.UI;

namespace Openlock.Shell;

/// <summary>
/// Collapses the game's ability HUD while the mode is on, through the client addon
/// <c>openlock_hud</c>. Only the ability bar and its upgrade affordances are targeted: the shop, the
/// Openlock shell and the rest of the HUD are left alone.
///
/// <para>
/// The addon is a normal Panorama layout loaded with <see cref="UIPanel.LoadXml"/>. Its script walks
/// up to the HUD root, finds the declared ability panels by id and sets <c>visibility: collapse</c>;
/// it restores the previous value when the server sends <c>hud=1</c>. The server drives that through
/// <see cref="UIPanel.Set"/>, which reaches the addon as a <c>dwv_hud</c> attribute.
/// </para>
///
/// <para>
/// If the client has no such layout mounted, the addon reports <see cref="AddonState.Failed"/> and
/// this class logs the refusal — the ability HUD then stays visible rather than pretending it hid.
/// </para>
/// </summary>
public sealed class AbilityHudHide
{
    public const string PanelId = "openlock-hud";
    public const string LayoutPath = "file://{resources}/layout/openlock_hud.xml";

    private const float RetrySeconds = 10f;

    /// <summary>Set from addon discovery: when no resolved path carries this layout, do not ask.</summary>
    public bool Installed { get; set; } = true;

    private readonly HashSet<int> _requested = [];
    private readonly HashSet<int> _awaited = [];
    private readonly Dictionary<int, float> _lastAttempt = [];

    public void Show(CCitadelPlayerController controller, bool hidden)
    {
        if (controller.IsBot)
            return;

        if (!Installed)
        {
            Log.Write(
                $"[dl-openshell] ability HUD REFUSED for {controller.PlayerName}: {LayoutPath} is not in any resolved " +
                "addon path; the game's ability HUD stays visible");
            return;
        }

        UI.Panel(PanelId).LoadXml(controller.Recipients, LayoutPath);
        _requested.Add(controller.Slot);
        _awaited.Add(controller.Slot);
        _lastAttempt[controller.Slot] = GlobalVars.CurTime;

        UI.Panel(PanelId).Set(controller.Recipients, "hud", hidden ? "0" : "1");

        Log.Write(
            $"[dl-openshell] ability HUD addon requested for {controller.PlayerName}: " +
            $"{LayoutPath}, hud={(hidden ? "collapsed" : "visible")}");
    }

    /// <summary>Sends the hide/show state to every real player that already has the addon loaded.</summary>
    public void SetHidden(bool hidden)
    {
        foreach (var controller in Players.GetAll())
        {
            if (controller.IsBot)
                continue;

            if (!_requested.Contains(controller.Slot))
            {
                Show(controller, hidden);
                continue;
            }

            UI.Panel(PanelId).Set(controller.Recipients, "hud", hidden ? "0" : "1");
            Log.Write(
                $"[dl-openshell] ability HUD {(hidden ? "collapsed" : "restored")} for {controller.PlayerName}");
        }
    }

    public void Forget(int slot)
    {
        _requested.Remove(slot);
        _awaited.Remove(slot);
        _lastAttempt.Remove(slot);
    }

    /// <summary>Reads back the client's addon status once, so a missing or broken addon is in the log.</summary>
    public void Tick()
    {
        if (_awaited.Count == 0)
            return;

        foreach (var slot in _awaited.ToArray())
        {
            var state = UI.Addon(slot, PanelId);
            if (state is AddonState.Unknown)
                continue;

            _awaited.Remove(slot);

            if (state is AddonState.Failed)
            {
                Log.Write(
                    $"[dl-openshell] ability HUD REFUSED slot={slot}: {LayoutPath} is not mounted on that client; " +
                    "the game's ability HUD stays visible (no silent fallback)");

                // The addon may be deployed after the client joined. Retry at a human rate rather
                // than streaming a load at a panel that isn't there.
                var now = GlobalVars.CurTime;
                if (_lastAttempt.TryGetValue(slot, out var last) && now - last < RetrySeconds)
                    continue;

                var controller = Players.FromSlot(slot);
                if (controller is null)
                    continue;

                _lastAttempt[slot] = now;
                _awaited.Add(slot);
                UI.Panel(PanelId).LoadXml(controller.Recipients, LayoutPath);
                UI.Panel(PanelId).Set(controller.Recipients, "hud", "0");
                Log.Write($"[dl-openshell] ability HUD retry requested for slot={slot}");
                continue;
            }

            Log.Write($"[dl-openshell] ability HUD addon {state} for slot={slot}");
        }
    }
}

using DeadworksManaged.Api;
using DeadworksManaged.Api.UI;

namespace Openlock.Shell;

/// <summary>
/// The single owner of mounting the shell package on the client: it sends the package state to the
/// Panorama layout and resolves each window's declared content through <see cref="ShellContent"/>.
///
/// <para>
/// Parsing belongs to <see cref="ShellPackage"/>; content resolution to <see cref="ShellContent"/>;
/// drawing and the window manager to the addon. This class only keeps the two in step. A window is
/// opened by sending its id and the layout/refusal that content resolved to, so the client never
/// guesses what a content id means.
/// </para>
/// </summary>
public sealed class ShellMount
{
    public const string RootPanel = "openlock-shell";
    public const string LayoutPath = "file://{resources}/layout/openlock_shell_server.xml";

    private readonly OpenlockPlugin _plugin;
    private readonly HashSet<int> _announced = [];
    private readonly Dictionary<int, AddonState> _lastState = [];

    private ShellPackage? _package;
    private LayoutProfiles? _layouts;
    private string _active = "";
    private bool _addonFailedLogged;

    public ShellMount(OpenlockPlugin plugin) => _plugin = plugin;

    public bool Mounted => _package is not null;
    public IReadOnlyList<ShellPackage.Refusal> Refusals => _package?.Refusals ?? [];
    public IReadOnlyList<ShellPackage.Window> Windows => _package?.Windows ?? [];
    public string LayoutDirectory => _layouts?.DirectoryPath ?? "";

    public void Load(string root)
    {
        _package = ShellPackage.Load(root);
        _layouts = new LayoutProfiles(root);
        _active = _package.Tabs.FirstOrDefault() ?? _package.Windows.FirstOrDefault()?.Id ?? "";

        Log.Write(
            $"[Openlock] shell {_package.Name} {_package.Version}: {_package.Windows.Count} windows, " +
            $"{_package.Tabs.Count} tabs, bar {_package.Bar ?? "none"}, {_package.Filed.Count} filed, " +
            $"{_package.Pins.Count} pins, {_package.Refusals.Count} refusal(s)");
        Log.Write($"[Openlock] layout profiles: {_layouts.DirectoryPath}");

        foreach (var refusal in _package.Refusals)
            Log.Write($"[Openlock] shell REFUSED {Rel(root, refusal.File)}:{refusal.Line} {refusal.Subject}: {refusal.Why}");
    }

    public void Register()
    {
        if (_package is null)
            return;

        foreach (var window in _package.Windows)
        {
            var id = window.Id;
            UI.Panel(RootPanel).On("view:" + id, e =>
            {
                _active = id;
                SendWindow(id, e.Caller);
            });
        }

        UI.Panel(RootPanel).On("steady", e => _plugin.ReconcileAll("shell reconcile"));
        UI.Panel(RootPanel).On("mountlog", e => Log.Write($"[Openlock] client mount: {e.ArgAt(0)}"));
        UI.Panel(RootPanel).On("restore", e => _plugin.RestoreAllFromShell());

        UI.Panel(RootPanel).On("layout", e => SaveLayout(e));
        UI.Panel(RootPanel).On("layout-applied", e =>
            Log.Write(
                $"[Openlock] layout APPLIED by {NameOf(e.Caller)}: scheme={e.ArgAt(0, "?")} " +
                $"windows={e.ArgAt(1, "?")} ignored={e.ArgAt(2, "?")}"));
        UI.Panel(RootPanel).On("layout-load", e => LoadLayout(e));
        UI.Panel(RootPanel).On("layout-reset", e => ResetLayout(e));

        UI.Panel(RootPanel).On("mode", e =>
        {
            _plugin.ToggleModeFromShell();
            SendWindow(_active, e.Caller);
        });

        UI.ClientResync += slot =>
        {
            var controller = Players.FromSlot(slot);
            if (controller is not null)
                Show(controller);
        };
    }

    /// <summary>Mounts the shell for one player. The addon is not requested when discovery refused it.</summary>
    public void Show(CCitadelPlayerController controller)
    {
        if (_package is null)
            return;

        if (!_plugin.Addons.ShellInstalled)
        {
            Log.Write(
                $"[Openlock] shell REFUSED for {controller.PlayerName}: {LayoutPath} is not in any resolved addon path " +
                "(see the path report above); no panel is drawn rather than a guessed one");
            return;
        }

        _active = _package.Tabs.FirstOrDefault() ?? _package.Windows.FirstOrDefault()?.Id ?? "";
        UI.Panel(RootPanel).LoadXml(controller.Recipients, LayoutPath);
        UI.Panel(RootPanel).Set(controller.Recipients, "paths", string.Join("\n", _plugin.AddonReport));
        PublishLayout(controller);
        SendWindow(_active, controller);
        Log.Write($"[Openlock] shell mounted for {controller.PlayerName}: active '{_active}', {_package.Windows.Count} windows declared");
    }

    public void Open(CCitadelPlayerController? controller)
    {
        if (controller is null || _package is null)
            return;

        if (!_plugin.Addons.ShellInstalled)
        {
            Log.Write($"[Openlock] shell open REFUSED for {controller.PlayerName}: addon layout not present in any search path");
            return;
        }

        _active = _package.Tabs.FirstOrDefault() ?? _package.Windows.FirstOrDefault()?.Id ?? "";
        UI.Panel(RootPanel).LoadXml(controller.Recipients, LayoutPath);
        UI.Panel(RootPanel).Set(controller.Recipients, "paths", string.Join("\n", _plugin.AddonReport));
        PublishLayout(controller);
        SendWindow(_active, controller);
    }

    public void Collapse(CCitadelPlayerController? controller)
    {
        if (controller is null)
            return;

        UI.Panel(RootPanel).Set(controller.Recipients, "active", "");
        Log.Write($"[Openlock] shell hidden for {controller.PlayerName}");
    }

    /// <summary>Reads back the client's addon status once, so a broken addon is in the log.</summary>
    public void Tick()
    {
        if (_package is null)
            return;

        foreach (var controller in Players.GetAll())
        {
            if (controller.IsBot || !_plugin.Addons.ShellInstalled)
                continue;

            var state = UI.Addon(controller.Slot, RootPanel);
            if (!_lastState.TryGetValue(controller.Slot, out var previous) || previous != state)
            {
                _lastState[controller.Slot] = state;
                Log.Write($"[Openlock] shell addon state for {controller.PlayerName}: {previous} -> {state}");
            }
            if (state is AddonState.Failed)
            {
                if (_addonFailedLogged)
                    continue;

                _addonFailedLogged = true;
                Log.Write(
                    $"[Openlock] shell REFUSED slot={controller.Slot}: {LayoutPath} did not mount on that client; " +
                    "the shell stays closed (no silent substitute)");
                continue;
            }

            // State set before the layout existed is buffered but only labels are replayed, so the
            // window is sent again as soon as the script reports that it is receiving updates.
            if (state is AddonState.Ready && _announced.Add(controller.Slot))
            {
                PublishLayout(controller);
                SendWindow(_active, controller);
                Log.Write($"[Openlock] shell addon ready for {controller.PlayerName}; active '{_active}' re-sent");
            }
        }
    }

    private void SaveLayout(UIEvent e)
    {
        if (_layouts is null)
            return;

        var caller = e.Caller;
        var raw = e.ArgAt(0);
        Log.Write(
            $"[Openlock] layout SAVE raw args={e.Args.Length} len={raw.Length} " +
            $"text='{(raw.Length > 300 ? raw[..300] + "…" : raw)}'");
        if (!_layouts.TryParse(raw, out var scheme, out var windows, out var why))
        {
            Log.Write($"[Openlock] layout SAVE REFUSED by {NameOf(caller)}: {why}");
            PublishLayout(caller, "layout not saved: " + why);
            return;
        }

        if (!_layouts.Save(scheme, windows, out why))
        {
            Log.Write($"[Openlock] layout SAVE FAILED scheme={scheme} by {NameOf(caller)}: {why}");
            PublishLayout(caller, "layout not saved: " + why);
            return;
        }

        Log.Write(
            $"[Openlock] layout saved scheme={scheme} windows={windows.Count} " +
            $"file={_layouts.PathFor(scheme)} by {NameOf(caller)}");
        if (caller is not null)
            UI.Panel(RootPanel).Set(caller.Recipients, "layoutrequest", "");
        PublishLayout(caller, $"layout saved · {scheme} · {windows.Count} windows");
    }

    private void LoadLayout(UIEvent e)
    {
        if (_layouts is null)
            return;

        var scheme = (e.ArgAt(0) ?? "").Trim().ToLowerInvariant();
        if (!LayoutProfiles.IsValidScheme(scheme))
        {
            Log.Write($"[Openlock] layout LOAD REFUSED by {NameOf(e.Caller)}: invalid scheme '{scheme}'");
            PublishLayout(e.Caller, "layout not loaded: invalid scheme");
            return;
        }

        var exists = _layouts.HasProfile(scheme);
        Log.Write($"[Openlock] layout load scheme={scheme} exists={exists} by {NameOf(e.Caller)}");
        PublishLayout(e.Caller, exists
            ? $"layout loaded · {scheme}"
            : $"no saved layout for '{scheme}'; package defaults remain");
    }

    private void ResetLayout(UIEvent e)
    {
        if (_layouts is null)
            return;

        var scheme = (e.ArgAt(0) ?? "").Trim().ToLowerInvariant();
        if (!LayoutProfiles.IsValidScheme(scheme))
        {
            Log.Write($"[Openlock] layout RESET REFUSED by {NameOf(e.Caller)}: invalid scheme '{scheme}'");
            PublishLayout(e.Caller, "layout not reset: invalid scheme");
            return;
        }

        if (!_layouts.Reset(scheme, out var why))
        {
            Log.Write($"[Openlock] layout RESET FAILED scheme={scheme} by {NameOf(e.Caller)}: {why}");
            PublishLayout(e.Caller, "layout not reset: " + why);
            return;
        }

        Log.Write($"[Openlock] layout reset scheme={scheme} by {NameOf(e.Caller)}");
        PublishLayout(e.Caller, $"layout reset · {scheme} · package defaults");
    }

    private void PublishLayout(CCitadelPlayerController? controller, string? notice = null)
    {
        if (controller is null || _layouts is null)
            return;

        UI.Panel(RootPanel).Set(controller.Recipients, "layout", _layouts.PayloadJson(notice));
    }

    /// <summary>
    /// Asks each connected shell to publish its current geometry through the same layout event
    /// the Save button uses. This is the operator path for verifying persistence without moving
    /// a window by hand.
    /// </summary>
    public void RequestLayoutSave()
    {
        var request = "save:" + DateTime.UtcNow.Ticks.ToString();
        var sent = 0;
        foreach (var controller in Players.GetAll())
        {
            if (controller.IsBot)
                continue;

            UI.Panel(RootPanel).Set(controller.Recipients, "layoutrequest", request);
            sent++;
        }

        Log.Write($"[Openlock] layout save requested for {sent} connected shell(s)");
    }

    private static string NameOf(CCitadelPlayerController? controller) =>
        controller?.PlayerName ?? "console";

    private void SendWindow(string windowId, CCitadelPlayerController? controller)
    {
        if (controller is null || _package is null)
            return;

        var window = _package.WindowById(windowId);
        if (window is null)
            return;

        var resolution = ShellContent.Resolve(window.Content);
        var recipients = controller.Recipients;

        UI.Panel(RootPanel).Set(recipients, "active", windowId);
        UI.Panel(RootPanel).Set(recipients, "view", resolution.Type == ShellContent.ViewType.Host ? resolution.Target : "");
        UI.Panel(RootPanel).Set(recipients, "body", resolution.Type == ShellContent.ViewType.Own
            ? ShellContent.Payload(resolution.Target, _plugin, controller)
            : "");
        UI.Panel(RootPanel).Set(recipients, "refusal", resolution.Mounted
            ? ""
            : $"package.shspec:{window.ContentLine}  content '{window.Content}' — {resolution.Why}");
    }

    private static string Rel(string root, string path)
    {
        try
        {
            return Path.GetRelativePath(root, path);
        }
        catch
        {
            return path;
        }
    }
}

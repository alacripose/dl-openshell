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
    public const string LayoutPath = "file://{resources}/layout/openlock_shell.xml";

    private readonly OpenlockPlugin _plugin;
    private readonly HashSet<int> _announced = [];

    private ShellPackage? _package;
    private string _active = "";
    private bool _addonFailedLogged;

    public ShellMount(OpenlockPlugin plugin) => _plugin = plugin;

    public bool Mounted => _package is not null;
    public IReadOnlyList<ShellPackage.Refusal> Refusals => _package?.Refusals ?? [];
    public IReadOnlyList<ShellPackage.Window> Windows => _package?.Windows ?? [];

    public void Load(string root)
    {
        _package = ShellPackage.Load(root);
        _active = _package.Tabs.FirstOrDefault() ?? _package.Windows.FirstOrDefault()?.Id ?? "";

        Log.Write(
            $"[Openlock] shell {_package.Name} {_package.Version}: {_package.Windows.Count} windows, " +
            $"{_package.Tabs.Count} tabs, bar {_package.Bar ?? "none"}, {_package.Filed.Count} filed, " +
            $"{_package.Pins.Count} pins, {_package.Refusals.Count} refusal(s)");

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
        UI.Panel(RootPanel).On("restore", e => _plugin.RestoreAllFromShell());

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
                SendWindow(_active, controller);
                Log.Write($"[Openlock] shell addon ready for {controller.PlayerName}; active '{_active}' re-sent");
            }
        }
    }

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

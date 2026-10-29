using System.Text.Json;
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
    private readonly HashSet<string> _registeredAddonIds = new(StringComparer.OrdinalIgnoreCase);

    private BuildStatus _build = new("");
    private AddonPackages _addons = new();
    private string _lastBuildLog = "";

    private ShellPackage? _package;
    private LayoutProfiles? _layouts;
    private string _active = "";
    private bool _addonFailedLogged;

    public ShellMount(OpenlockPlugin plugin) => _plugin = plugin;

    public bool Mounted => _package is not null;
    public IReadOnlyList<ShellPackage.Refusal> Refusals => _package?.Refusals ?? [];
    public IReadOnlyList<ShellPackage.Window> Windows => _package?.Windows ?? [];
    public IReadOnlyList<ShpPackage.Window> AddonWindows => _addons.Windows;
    public string LayoutDirectory => _layouts?.DirectoryPath ?? "";

    public void Load(string root)
    {
        _package = ShellPackage.Load(root);
        _layouts = new LayoutProfiles(root);
        _build = new BuildStatus(root);
        _build.Poll();
        _addons = AddonPackages.Discover(_plugin.Config);
        _active = _package.Tabs.FirstOrDefault() ?? _package.Windows.FirstOrDefault()?.Id ?? "";

        Log.Write(
            $"[dl-openshell] shell {_package.Name} {_package.Version}: {_package.Windows.Count} windows, " +
            $"{_package.Tabs.Count} tabs, bar {_package.Bar ?? "none"}, {_package.Filed.Count} filed, " +
            $"{_package.Pins.Count} pins, {_package.Refusals.Count} refusal(s)");
        Log.Write($"[dl-openshell] layout profiles: {_layouts.DirectoryPath}");
        Log.Write(
            $"[dl-openshell] addon packages: {_addons.Packages.Count} package(s), {_addons.Windows.Count} window(s), " +
            $"{_addons.RefusalCount} refusal(s)");
        foreach (var package in _addons.Packages)
            Log.Write($"[dl-openshell] addon package {package.Id} {package.Version}: {package.WindowIds.Count} window(s) at {package.Archive}");
        foreach (var package in _addons.Packages)
            foreach (var refusal in package.Refusals)
                Log.Write($"[dl-openshell] addon REFUSED {refusal.File}:{refusal.Line} {refusal.Subject}: {refusal.Why}");

        foreach (var refusal in _package.Refusals)
            Log.Write($"[dl-openshell] shell REFUSED {Rel(root, refusal.File)}:{refusal.Line} {refusal.Subject}: {refusal.Why}");
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

        // Addon windows are opened by the same view event as package windows. Registering them
        // here is what lets a click inside an addon layout reach the server without a second
        // routing table owned by the addon.
        foreach (var window in _addons.Windows)
            RegisterAddonWindow(window);

        UI.Panel(RootPanel).On("steady", e => _plugin.ReconcileAll("shell reconcile"));
        UI.Panel(RootPanel).On("mountlog", e => Log.Write($"[dl-openshell] client mount: {e.ArgAt(0)}"));
        UI.Panel(RootPanel).On("restore", e => _plugin.RestoreAllFromShell());

        UI.Panel(RootPanel).On("layout", e => SaveLayout(e));
        UI.Panel(RootPanel).On("layout-applied", e =>
            Log.Write(
                $"[dl-openshell] layout APPLIED by {NameOf(e.Caller)}: scheme={e.ArgAt(0, "?")} " +
                $"windows={e.ArgAt(1, "?")} ignored={e.ArgAt(2, "?")}"));
        UI.Panel(RootPanel).On("layout-load", e => LoadLayout(e));
        UI.Panel(RootPanel).On("layout-reset", e => ResetLayout(e));
        UI.Panel(RootPanel).On("layer", e => HandleLayerAction(e));
        UI.Panel(RootPanel).On("pick", e =>
            Log.Write($"[dl-openshell] picker selected '{e.ArgAt(0, "?")}' by {NameOf(e.Caller)}"));

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

    private void RegisterAddonWindow(ShpPackage.Window window)
    {
        if (!_registeredAddonIds.Add(window.Id))
            return;

        var id = window.Id;
        UI.Panel(RootPanel).On("view:" + id, e =>
        {
            _active = id;
            SendWindow(id, e.Caller);
        });
    }

    /// <summary>
    /// Adds a package after launch and pushes it to every connected shell. A live package's source
    /// XML travels as a node tree in the same addon payload a mounted package uses, so the client
    /// builds it with CreatePanel and does not need a new resource path or a reconnect.
    /// </summary>
    public int DeliverAddon(string path, out string why, out bool delivered)
    {
        var added = _addons.Deliver(path, out why, out var changed);
        // A zero-window package still commits state (the payload revision must advance and any
        // previous version is replaced), so `delivered` cannot be inferred from the window count.
        delivered = changed && string.IsNullOrEmpty(why);
        if (!changed)
            return 0;

        foreach (var window in _addons.Windows)
            RegisterAddonWindow(window);

        var sent = 0;
        // A refused package still republishes (it carries the refusal record), but its notice
        // must not claim a delivery: `changed` with a reason is exactly the refusal path, and
        // `added` there is 0 windows.
        var refused = !string.IsNullOrEmpty(why);
        // The window the delivery changed, not the catalog's last entry: after a replacement the
        // last entry can belong to another package, and the toast would open the wrong surface.
        var changedWindow = refused ? "" : _addons.LastChangedWindow;
        var notice = JsonSerializer.Serialize(new
        {
            title = refused ? "Package refused" : "Package delivered",
            body = refused ? why : Path.GetFileName(path) + "  ·  " + added + " window(s) are live",
            revision = _addons.Revision,
            window = changedWindow,
            layout = "",
            attention = false,
        });

        foreach (var controller in Players.GetAll())
        {
            if (controller.IsBot)
                continue;

            PublishAddons(controller);
            UI.Panel(RootPanel).Set(controller.Recipients, "observer", notice);
            sent++;
        }

        Log.Write(refused
            ? $"[dl-openshell] addon delivery refused from {path}: {why}"
            : $"[dl-openshell] addon delivered live from {path}: {added} window(s), revision {_addons.Revision}, to {sent} shell(s)");
        return added;
    }

    /// <summary>Mounts the shell for one player. The addon is not requested when discovery refused it.</summary>
    public void Show(CCitadelPlayerController controller)
    {
        if (_package is null)
            return;

        if (!_plugin.Addons.ShellInstalled)
        {
            Log.Write(
                $"[dl-openshell] shell REFUSED for {controller.PlayerName}: {LayoutPath} is not in any resolved addon path " +
                "(see the path report above); no panel is drawn rather than a guessed one");
            return;
        }

        _active = _package.Tabs.FirstOrDefault() ?? _package.Windows.FirstOrDefault()?.Id ?? "";
        // The observer attribute is a one-shot toast channel, not state. Reset it before the panel
        // loads so the shell's first poll cannot replay the last notice, and a later mount finds
        // the channel empty rather than showing the same toast again.
        UI.Panel(RootPanel).Set(controller.Recipients, "observer", "");
        UI.Panel(RootPanel).LoadXml(controller.Recipients, LayoutPath);
        UI.Panel(RootPanel).Set(controller.Recipients, "paths", string.Join("\n", _plugin.AddonReport));
        PublishLayout(controller);
        PublishBuildStatus(controller);
        PublishAddons(controller);
        SendWindow(_active, controller);
        Log.Write($"[dl-openshell] shell mounted for {controller.PlayerName}: active '{_active}', {_package.Windows.Count} + {_addons.Windows.Count} addon window(s), " +
            $"{_package.Layers.Count} tool layer(s)");
    }

    public void Open(CCitadelPlayerController? controller)
    {
        if (controller is null || _package is null)
            return;

        if (!_plugin.Addons.ShellInstalled)
        {
            Log.Write($"[dl-openshell] shell open REFUSED for {controller.PlayerName}: addon layout not present in any search path");
            return;
        }

        _active = _package.Tabs.FirstOrDefault() ?? _package.Windows.FirstOrDefault()?.Id ?? "";
        UI.Panel(RootPanel).Set(controller.Recipients, "observer", "");
        UI.Panel(RootPanel).LoadXml(controller.Recipients, LayoutPath);
        UI.Panel(RootPanel).Set(controller.Recipients, "paths", string.Join("\n", _plugin.AddonReport));
        PublishLayout(controller);
        PublishBuildStatus(controller);
        PublishAddons(controller);
        SendWindow(_active, controller);
    }

    /// <summary>
    /// Opens a delivered package XML as an observer surface. The shell decides how to present it:
    /// observer grade mounts it in the toast stack, dev grade opens its window. The record is the
    /// same package window the addon loader validated, never a caller-supplied layout path.
    /// </summary>
    public int ShowObserver(string windowId)
    {
        var window = _addons.WindowById(windowId);
        if (window is null || (string.IsNullOrEmpty(window.LayoutPath) && window.LiveTree is not { Count: > 0 }))
            return 0;

        // An observer surface is a toast that carries the package's XML, not a hijack of the
        // player's active window. The shell's toast stack is present in every grade, so an
        // observer package is visible even when the shell's own chrome is hidden.
        var notice = JsonSerializer.Serialize(new
        {
            title = window.Title,
            body = "observer XML  ·  " + (window.AddonName.Length > 0 ? window.AddonName : windowId),
            window = windowId,
            layout = window.LayoutPath,
            tree = window.LiveTree,
            attention = false,
        });

        var sent = 0;
        foreach (var controller in Players.GetAll())
        {
            if (controller.IsBot)
                continue;

            UI.Panel(RootPanel).Set(controller.Recipients, "observer", notice);
            sent++;
        }

        Log.Write(sent > 0
            ? $"[dl-openshell] observer XML '{windowId}' sent to {sent} shell(s) at " +
              (window.LiveTree is { Count: > 0 } ? "its live source tree" : window.LayoutPath)
            : $"[dl-openshell] observer XML '{windowId}' has no connected shell");
        return sent;
    }

    /// <summary>
    /// A server owner or a connected tools instance can send a notice without inventing a
    /// window: the same observer attribute carries it, and the shell's toast stack is visible in
    /// every grade. A window id makes the toast open that window; an empty id leaves it a notice.
    /// </summary>
    public int Notify(string title, string body, string windowId = "", bool attention = false)
    {
        var notice = JsonSerializer.Serialize(new
        {
            title,
            body,
            window = windowId,
            layout = "",
            attention,
        });

        var sent = 0;
        foreach (var controller in Players.GetAll())
        {
            if (controller.IsBot)
                continue;

            UI.Panel(RootPanel).Set(controller.Recipients, "observer", notice);
            sent++;
        }
        return sent;
    }

    /// <summary>
    /// A Popit action is package data, not a command name: the server validates the window and
    /// the action before it acts, and names an unknown pair instead of guessing at its meaning.
    /// The client has already opened any local target; this is the server half of the routing.
    /// </summary>
    private void HandleLayerAction(UIEvent e)
    {
        var raw = e.ArgAt(0, "");
        var at = raw.LastIndexOf(':');
        if (at <= 0 || at == raw.Length - 1)
        {
            Log.Write($"[dl-openshell] popit REFUSED by {NameOf(e.Caller)}: '{raw}' is not window:action");
            return;
        }

        var windowId = raw[..at];
        var actionId = raw[(at + 1)..];
        IReadOnlyList<ShpPackage.Layer> layers;
        if (_package?.WindowById(windowId) is { } packageWindow)
            layers = packageWindow.Layers;
        else if (_addons.WindowById(windowId) is { } addonWindow)
            layers = addonWindow.Layers;
        else
        {
            Log.Write($"[dl-openshell] popit REFUSED by {NameOf(e.Caller)}: no window '{windowId}'");
            return;
        }

        var action = layers.SelectMany(layer => layer.Actions)
            .FirstOrDefault(candidate => string.Equals(candidate.Id, actionId, StringComparison.Ordinal));
        if (action is null)
        {
            Log.Write($"[dl-openshell] popit REFUSED by {NameOf(e.Caller)}: " +
                $"window '{windowId}' declares no action '{actionId}'");
            return;
        }

        Log.Write($"[dl-openshell] popit action {windowId}/{actionId} from {NameOf(e.Caller)}");
        switch (actionId)
        {
            case "reconcile":
                _plugin.ReconcileAll("popit");
                break;
            case "restore":
                _plugin.RestoreAllFromShell();
                break;
        }
    }

    public void Collapse(CCitadelPlayerController? controller)
    {
        if (controller is null)
            return;

        UI.Panel(RootPanel).Set(controller.Recipients, "active", "");
        Log.Write($"[dl-openshell] shell hidden for {controller.PlayerName}");
    }

    /// <summary>Reads back the client's addon status once, so a broken addon is in the log.</summary>
    public void Tick()
    {
        if (_package is null)
            return;

        var buildChanged = _build.Poll();
        if (buildChanged)
        {
            if (!string.Equals(_build.BuildJson, _lastBuildLog, StringComparison.Ordinal))
            {
                _lastBuildLog = _build.BuildJson;
                Log.Write(_build.HasBuild
                    ? $"[dl-openshell] build status published ({_build.BuildJson.Length} bytes)"
                    : "[dl-openshell] build status cleared; shell uses its baked record");
            }
        }

        foreach (var controller in Players.GetAll())
        {
            if (controller.IsBot || !_plugin.Addons.ShellInstalled)
                continue;

            var state = UI.Addon(controller.Slot, RootPanel);
            if (!_lastState.TryGetValue(controller.Slot, out var previous) || previous != state)
            {
                _lastState[controller.Slot] = state;
                Log.Write($"[dl-openshell] shell addon state for {controller.PlayerName}: {previous} -> {state}");
            }
            if (state is AddonState.Failed)
            {
                if (_addonFailedLogged)
                    continue;

                _addonFailedLogged = true;
                Log.Write(
                    $"[dl-openshell] shell REFUSED slot={controller.Slot}: {LayoutPath} did not mount on that client; " +
                    "the shell stays closed (no silent substitute)");
                continue;
            }

            // State set before the layout existed is buffered but only labels are replayed, so the
            // window is sent again as soon as the script reports that it is receiving updates.
            if (state is AddonState.Ready && _announced.Add(controller.Slot))
            {
                PublishLayout(controller);
                PublishBuildStatus(controller);
                PublishAddons(controller);
                SendWindow(_active, controller);
                Log.Write($"[dl-openshell] shell addon ready for {controller.PlayerName}; active '{_active}' re-sent");
            }

            if (buildChanged)
                PublishBuildStatus(controller);
        }
    }

    private void SaveLayout(UIEvent e)
    {
        if (_layouts is null)
            return;

        var caller = e.Caller;
        var raw = e.ArgAt(0);
        Log.Write(
            $"[dl-openshell] layout SAVE raw args={e.Args.Length} len={raw.Length} " +
            $"text='{(raw.Length > 300 ? raw[..300] + "…" : raw)}'");
        if (!_layouts.TryParse(raw, out var scheme, out var windows, out var why))
        {
            Log.Write($"[dl-openshell] layout SAVE REFUSED by {NameOf(caller)}: {why}");
            PublishLayout(caller, "layout not saved: " + why);
            return;
        }

        if (!_layouts.Save(scheme, windows, out why))
        {
            Log.Write($"[dl-openshell] layout SAVE FAILED scheme={scheme} by {NameOf(caller)}: {why}");
            PublishLayout(caller, "layout not saved: " + why);
            return;
        }

        Log.Write(
            $"[dl-openshell] layout saved scheme={scheme} windows={windows.Count} " +
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
            Log.Write($"[dl-openshell] layout LOAD REFUSED by {NameOf(e.Caller)}: invalid scheme '{scheme}'");
            PublishLayout(e.Caller, "layout not loaded: invalid scheme");
            return;
        }

        var exists = _layouts.HasProfile(scheme);
        Log.Write($"[dl-openshell] layout load scheme={scheme} exists={exists} by {NameOf(e.Caller)}");
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
            Log.Write($"[dl-openshell] layout RESET REFUSED by {NameOf(e.Caller)}: invalid scheme '{scheme}'");
            PublishLayout(e.Caller, "layout not reset: invalid scheme");
            return;
        }

        if (!_layouts.Reset(scheme, out var why))
        {
            Log.Write($"[dl-openshell] layout RESET FAILED scheme={scheme} by {NameOf(e.Caller)}: {why}");
            PublishLayout(e.Caller, "layout not reset: " + why);
            return;
        }

        Log.Write($"[dl-openshell] layout reset scheme={scheme} by {NameOf(e.Caller)}");
        PublishLayout(e.Caller, $"layout reset · {scheme} · package defaults");
    }

    private void PublishLayout(CCitadelPlayerController? controller, string? notice = null)
    {
        if (controller is null || _layouts is null)
            return;

        UI.Panel(RootPanel).Set(controller.Recipients, "layout", _layouts.PayloadJson(notice));
    }

    /// <summary>
    /// Sends the installer's own records. Empty values are deliberate: they clear a stale
    /// attribute and let the shell fall back to the record baked into its package.
    /// </summary>
    private void PublishBuildStatus(CCitadelPlayerController controller)
    {
        // Both fields are always sent. The poll only calls this when a record changed (or a
        // client just mounted), and a per-client cache here would let one player's update
        // suppress another player's.
        UI.Panel(RootPanel).Set(controller.Recipients, "build", _build.BuildJson);
        UI.Panel(RootPanel).Set(controller.Recipients, "update", _build.UpdateJson);
    }

    private void PublishAddons(CCitadelPlayerController controller)
    {
        UI.Panel(RootPanel).Set(controller.Recipients, "addons", _addons.PayloadJson());
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

        Log.Write($"[dl-openshell] layout save requested for {sent} connected shell(s)");
    }

    private static string NameOf(CCitadelPlayerController? controller) =>
        controller?.PlayerName ?? "console";

    private void SendWindow(string windowId, CCitadelPlayerController? controller)
    {
        if (controller is null || _package is null)
            return;

        // Addon windows are already in the client's addon payload. Sending a content resolution
        // for them would replace their own layout with a refusal from the shell's content table.
        if (_addons.WindowById(windowId) is not null)
        {
            UI.Panel(RootPanel).Set(controller.Recipients, "active", windowId);
            UI.Panel(RootPanel).Set(controller.Recipients, "view", "");
            UI.Panel(RootPanel).Set(controller.Recipients, "body", "");
            UI.Panel(RootPanel).Set(controller.Recipients, "refusal", "");
            return;
        }

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

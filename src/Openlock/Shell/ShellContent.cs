using DeadworksManaged.Api;
using Openlock.Modifiers;

namespace Openlock.Shell;

/// <summary>
/// The single resolver between a window's declared <c>content</c> id and something the client can
/// actually mount. Host views are layouts the game already ships; our views are rendered by the
/// client addon from the payload this class builds; a content id with neither is refused with the
/// package line that declared it.
/// </summary>
public static class ShellContent
{
    public enum ViewType
    {
        Host,
        Own,
        Refused,
    }

    public sealed record Resolution(ViewType Type, string Target, string Why)
    {
        public bool Mounted => Type != ViewType.Refused;
    }

    /// <summary>content id -> the layout the game ships for it, or our own view.</summary>
    private static readonly Dictionary<string, Resolution> Table = new(StringComparer.OrdinalIgnoreCase)
    {
        // Real Deadlock screens. The path is the compiled layout the game itself loads.
        ["inventory"] = new(ViewType.Host, "file://{resources}/layout/citadel_hud_hero_shop.xml", ""),
        ["trees"] = new(ViewType.Host, "file://{resources}/layout/citadel_shop_mods_build.xml", ""),
        ["map-plan"] = new(ViewType.Host, "file://{resources}/layout/hud_minimap.xml", ""),
        ["tools"] = new(ViewType.Host, "file://{resources}/layout/citadel_hud_top_bar.xml", ""),
        ["console"] = new(ViewType.Host, "file://{resources}/layout/console.xml", ""),
        ["minimap"] = new(ViewType.Host, "file://{resources}/layout/hud_minimap.xml", ""),
        ["abilities"] = new(ViewType.Host, "file://{resources}/layout/hud_abilities.xml", ""),
        ["quickbuy"] = new(ViewType.Host, "file://{resources}/layout/hud_quickbuy.xml", ""),
        ["combat-log"] = new(ViewType.Host, "file://{resources}/layout/citadel_hud_combat_log.xml", ""),
        ["game-settings"] = new(ViewType.Host, "file://{resources}/layout/hud_escape_menu.xml", ""),
        ["hero-select"] = new(ViewType.Host, "file://{resources}/layout/citadel_hero_grid.xml", ""),

        // Ours: these are built from this plugin's own state.
        ["ledger"] = new(ViewType.Own, "ledger", ""),
        ["docs"] = new(ViewType.Own, "docs", ""),
        ["mods"] = new(ViewType.Own, "mods", ""),
        ["settings"] = new(ViewType.Own, "settings", ""),
        ["log"] = new(ViewType.Own, "log", ""),
        ["readout"] = new(ViewType.Own, "readout", ""),
        ["table"] = new(ViewType.Own, "table", ""),
        ["notifications"] = new(ViewType.Own, "notifications", ""),
        ["api-viewer"] = new(ViewType.Own, "api-viewer", ""),
        ["world-view"] = new(ViewType.Own, "world-view", ""),
        ["performance"] = new(ViewType.Own, "performance", ""),
        ["picker"] = new(ViewType.Own, "picker", ""),
        ["updates"] = new(ViewType.Own, "updates", ""),
        ["repo"] = new(ViewType.Own, "repo", ""),
        ["landing"] = new(ViewType.Own, "landing", ""),
        ["ui-tree"] = new(ViewType.Own, "ui-tree", ""),
        // The plan beside the verdicts: every load the package asked for, its state, and the
        // GitHub addon store rows that are available. Built from the generated wish list.
        ["wishes"] = new(ViewType.Own, "wishes", ""),

        // Declared, but no mountable source exists on this build.
        ["streamer"] = new(
            ViewType.Refused,
            "",
            "no streamer source exists on this build; there is nothing to mount"),
    };

    public static Resolution Resolve(string content)
    {
        if (content.StartsWith("file://", StringComparison.OrdinalIgnoreCase))
            return new Resolution(ViewType.Host, content, "");

        return Table.TryGetValue(content, out var found)
            ? found
            : new Resolution(ViewType.Refused, "", $"no mounted source for content '{content}'");
    }

    /// <summary>The declared windows whose content the host cannot mount, with the declaring line.</summary>
    public static IEnumerable<(string Window, int Line, string Content, string Why)> Refusals(ShellPackage package)
    {
        foreach (var window in package.Windows)
        {
            if (string.IsNullOrWhiteSpace(window.Content))
            {
                yield return (window.Id, window.Line, "", "window declares no content");
                continue;
            }

            var resolution = Resolve(window.Content);
            if (!resolution.Mounted)
                yield return (window.Id, window.ContentLine, window.Content, resolution.Why);
        }
    }

    /// <summary>
    /// Builds the lines an own view renders. One builder, so the client never invents content the
    /// server did not resolve. Header lines start with '#'; the addon styles those as headings.
    /// </summary>
    public static string Payload(string view, OpenlockPlugin plugin, CCitadelPlayerController? controller)
    {
        var lines = new List<string>();
        var pawn = controller?.GetHeroPawn();

        switch (view)
        {
            case "mods":
                lines.Add("#client addon paths");
                lines.AddRange(plugin.AddonReport);
                break;

            case "settings":
                lines.Add("#world");
                lines.Add($"gravity target {plugin.Config.GravityReduction:0} · friction {plugin.Config.Friction:0}");
                lines.Add("#hero");
                lines.Add($"abilities {(plugin.Config.DisableHeroAbilities ? "locked" : "enabled")} · ability HUD {(plugin.Config.HideAbilityHud ? "hidden" : "shown")}");
                lines.Add("#conversion");
                lines.Add($"spirit -> strength {(plugin.Config.SpiritItemsBecomeStrength ? "on" : "off")} · worth T1 {plugin.Config.Tier1Worth:0} / T2 {plugin.Config.Tier2Worth:0} / T3 {plugin.Config.Tier3Worth:0} / T4 {plugin.Config.Tier4Worth:0}");
                break;

            case "inventory":
                lines.Add("#owned items");
                if (pawn is null)
                {
                    lines.Add("no hero in the world");
                }
                else
                {
                    var items = pawn.AbilityComponent.Abilities
                        .Where(a => a.IsItem && a.SubclassVData is not null)
                        .Select(a => a.SubclassVData!)
                        .ToArray();

                    foreach (var item in items)
                        lines.Add($"{item.Name} · tier {ItemTier(item.Handle)} · {(SpiritToStrength.IsSpirit(item) ? "spirit" : "weapon/vitality")}");

                    if (items.Length == 0)
                        lines.Add("no items owned");
                }

                break;

            case "trees":
                lines.Add("#crafting worth, by tier");
                lines.Add($"T1 {plugin.Config.Tier1Worth:0} spirit -> strength");
                lines.Add($"T2 {plugin.Config.Tier2Worth:0}");
                lines.Add($"T3 {plugin.Config.Tier3Worth:0}");
                lines.Add($"T4 {plugin.Config.Tier4Worth:0}");
                lines.Add("#converted");
                lines.Add(plugin.StrengthSummary);
                break;

            case "ledger":
            case "docs":
                lines.Add("#conversion ledger");
                lines.Add(plugin.StrengthSummary);
                lines.Add("#world");
                lines.Add(plugin.StatusLine());
                break;

            case "readout":
                lines.Add("#mode");
                lines.Add(plugin.StatusLine());
                lines.Add("#players");
                foreach (var player in Players.GetAll())
                {
                    if (player.IsBot)
                        continue;

                    var hero = player.GetHeroPawn();
                    lines.Add(hero is null
                        ? $"{player.PlayerName}: no hero"
                        : $"{player.PlayerName}: {hero.HeroID} · {hero.Health}/{hero.MaxHealth} hp · level {hero.Level}");
                }

                break;

            case "table":
                lines.Add("#package refusals");
                foreach (var refusal in plugin.ShellRefusals)
                    lines.Add($"{Path.GetFileName(refusal.File)}:{refusal.Line}  {refusal.Subject} — {refusal.Why}");
                break;

            case "log":
                lines.Add("#log");
                lines.AddRange(Tail(Log.Path, 12));
                break;

            case "notifications":
                lines.Add("#recent notices");
                foreach (var line in Tail(Log.Path, 40).Where(l => l.Contains("REFUSED", StringComparison.OrdinalIgnoreCase)
                             || l.Contains("blocked", StringComparison.OrdinalIgnoreCase)).TakeLast(8))
                    lines.Add(line);
                break;

            case "api-viewer":
                lines.Add("#deadworks api");
                lines.Add("namespace DeadworksManaged.Api · plugin base IDeadworksPlugin");
                lines.Add("lifecycle: OnLoad(isReload) · OnUnload · OnPrecacheResources");
                lines.Add("content addons: ContentAddons · DeadworksManaged.Api.ContentAddons.Refresh");
                lines.Add("world: Server.MapName · Server.GetMapList() · Server.ChangeLevel(map)");
                lines.Add("entities: SchemaAccessor<T> · EntityDataRegistry · CBaseEntity subclasses");
                lines.Add("config: PluginConfigAttribute · ConVar.Find(name)?.GetString()");
                lines.Add("ui: UI.Panel(panel).Set(recipients, key, json) · UIEvent.ClientEvent");
                lines.Add("#openlock plugin");
                lines.Add($"version {OpenlockPlugin.Version} · mounted shell layout openlock_shell.xml");
                break;

            case "world-view":
            {
                var hostname = (ConVar.Find("hostname")?.GetString() ?? "")
                    .ReplaceLineEndings(" ").Trim();
                var maps = Server.GetMapList();

                lines.Add("#current server");
                lines.Add($"hostname {(string.IsNullOrWhiteSpace(hostname) ? "(not set)" : hostname)}");
                lines.Add($"map {(string.IsNullOrWhiteSpace(Server.MapName) ? "(none)" : Server.MapName)}");
                lines.Add($"state {(Server.IsChangingLevel ? "changing level" : "running")} · {Players.GetAll().Count(p => !p.IsBot)} player(s)");

                lines.Add("#maps the server can load");
                if (maps.Count == 0)
                    lines.Add("no maps reported by the engine");
                foreach (var map in maps)
                    lines.Add(map.Equals(Server.MapName, StringComparison.OrdinalIgnoreCase) ? $"{map} · current" : map);

                lines.Add("#mounted client content");
                var addons = plugin.AddonReport;
                if (addons.Count == 0)
                    lines.Add("no client addon paths resolved");
                foreach (var addon in addons)
                    lines.Add(addon);
                break;
            }

            case "console":
                lines.Add("#declared windows");
                foreach (var window in plugin.ShellWindows)
                    lines.Add($"{window.Id} · {window.Title} · content {window.Content}");
                break;

            default:
                lines.Add("#no payload");
                lines.Add($"'{view}' has no server payload builder");
                break;
        }

        return string.Join("\n", lines);
    }

    private static readonly SchemaAccessor<int> _tier = new("CitadelItemVData"u8, "m_iItemTier"u8);

    private static int ItemTier(nint handle) => _tier.Get(handle);

    private static IEnumerable<string> Tail(string path, int count)
    {
        try
        {
            return File.Exists(path) ? File.ReadLines(path).TakeLast(count).ToArray() : ["log file missing"];
        }
        catch (Exception ex)
        {
            return [$"log unreadable: {ex.Message}"];
        }
    }
}

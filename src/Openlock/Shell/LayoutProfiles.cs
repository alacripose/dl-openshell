using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Openlock.Shell;

/// <summary>
/// Reads and writes per-scheme window geometry beside the shell package.
///
/// <para>
/// The client sends one complete snapshot after a move, resize, save or reset. This class is the
/// only writer: it validates the scheme and every window id/rectangle, keeps the final path inside
/// its profile directory, and replaces the file through a temporary file. A profile that cannot be
/// parsed is reported as a notice and ignored; it never takes the shell down or becomes a partial
/// set of windows.
/// </para>
/// </summary>
public sealed class LayoutProfiles
{
    public const string ProfileFormat = "openlock.layout/1";
    public const string PayloadFormat = "openlock.layouts/1";

    private const int MaxWindows = 400;
    private const int MaxProfileBytes = 256 * 1024;
    private const int MaxProfiles = 64;
    private const int MaxStateIds = 64;
    private const int MaxPopitOrder = 32;
    private const int MinPopitWidth = 240;
    private const int MaxPopitWidth = 900;
    private static readonly string[] PopitFrames = ["lbp1", "lbp2", "lbp3", "psp", "vita", "karting"];
    private static readonly string[] PopitModes = ["create", "play"];
    private const int MaxCoordinate = 20000;
    private const int MinWindowWidth = 120;
    private const int MaxWindowWidth = 16000;
    private const int MinWindowHeight = 64;
    private const int MaxWindowHeight = 9000;
    // A cell is a component inside a window; a HUD ability icon can be 24-64 px.
    private const int MinCellSide = 16;

    private static readonly Regex SchemePattern = new(
        "^[a-z0-9][a-z0-9_-]{0,31}$",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    // A nested cell id is `cell:<root>:<key>[:<key>...]`, so it is longer than a whole-window
    // id. The path is still a fixed set of safe characters and never becomes a file name.
    private static readonly Regex WindowPattern = new(
        "^[A-Za-z0-9_.:-]{1,192}$",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
    };

    private readonly string _directory;

    public LayoutProfiles(string packageRoot)
    {
        _directory = Path.Combine(packageRoot, "layouts");
    }

    public string DirectoryPath => _directory;

    public sealed class Rect
    {
        public int X { get; set; }
        public int Y { get; set; }
        public int W { get; set; }
        public int H { get; set; }
    }

    /// <summary>
    /// How the Popit surface arranges itself: the frame it is drawn in, how wide it is, how many
    /// tiles a row holds and the order of the tiles. The surface is the shell's own menu on a
    /// build whose game dashboard is empty, so its arrangement belongs to the saved layout beside
    /// the window rectangles.
    /// </summary>
    public sealed class PopitLayout
    {
        public int Columns { get; set; } = 4;
        public int Width { get; set; } = 356;
        public string Frame { get; set; } = "lbp3";
        public string Mode { get; set; } = "create";
        public List<string> Order { get; set; } = [];
    }

    public sealed class LayoutState
    {
        public string Active { get; set; } = "";
        public string Tab { get; set; } = "";
        public List<string> Pinned { get; set; } = [];
        public List<string> Minimized { get; set; } = [];
        public PopitLayout? Popit { get; set; }
    }

    public sealed class Profile
    {
        public string Format { get; set; } = "";
        public string Scheme { get; set; } = "";
        public string Updated { get; set; } = "";
        public string Active { get; set; } = "";
        public string Tab { get; set; } = "";
        public List<string> Pinned { get; set; } = [];
        public List<string> Minimized { get; set; } = [];
        public PopitLayout? Popit { get; set; }
        public Dictionary<string, Rect> Windows { get; set; } = [];
    }

    /// <summary>What the payload publishes for one scheme: geometry plus the arrangement state.</summary>
    public sealed class Snapshot
    {
        public Dictionary<string, Rect> Windows { get; set; } = [];
        public string Active { get; set; } = "";
        public string Tab { get; set; } = "";
        public List<string> Pinned { get; set; } = [];
        public List<string> Minimized { get; set; } = [];
        public PopitLayout? Popit { get; set; }
    }

    public static bool IsValidScheme(string? scheme) =>
        !string.IsNullOrWhiteSpace(scheme) && SchemePattern.IsMatch(scheme);

    /// <summary>The fixed profile path for a scheme, or an empty string when it would leave the directory.</summary>
    public string PathFor(string scheme)
    {
        var normalized = (scheme ?? "").Trim().ToLowerInvariant();
        if (!IsValidScheme(normalized))
            return "";

        try
        {
            var root = Path.GetFullPath(_directory);
            var path = Path.GetFullPath(Path.Combine(root, normalized + ".layout.json"));
            var prefix = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                + Path.DirectorySeparatorChar;
            return path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? path : "";
        }
        catch
        {
            return "";
        }
    }

    /// <summary>
    /// Parses <c>scheme@id,x,y,w,h@...</c> plus optional <c>active=</c>, <c>tab=</c>,
    /// <c>pin=</c> and <c>min=</c> rows. Rows use '@' because the snapshot travels through
    /// CitadelConCommand, where ';' starts a second console command and truncates it. Unknown
    /// window ids are shape-valid here: the client owns which windows exist, and it ignores
    /// profile rows it no longer knows.
    /// </summary>
    public bool TryParse(
        string? argument,
        out string scheme,
        out Dictionary<string, Rect> windows,
        out LayoutState state,
        out string why)
    {
        scheme = "";
        windows = [];
        state = new LayoutState();
        why = "";

        var text = (argument ?? "").Trim();
        if (text.Length == 0)
        {
            why = "empty layout argument";
            return false;
        }

        var split = text.IndexOf('@');
        if (split <= 0)
        {
            why = "layout argument has no scheme separator";
            return false;
        }

        scheme = text[..split].Trim().ToLowerInvariant();
        if (!IsValidScheme(scheme))
        {
            why = $"scheme '{scheme}' is not a safe profile name";
            return false;
        }

        var body = text[(split + 1)..];
        if (body.Length == 0)
        {
            why = "layout snapshot has no windows";
            return false;
        }

        var rows = body.Split('@', StringSplitOptions.RemoveEmptyEntries);
        if (rows.Length == 0)
        {
            why = "layout snapshot has no windows";
            return false;
        }

        if (rows.Length > MaxWindows)
        {
            why = $"layout snapshot has {rows.Length} rows; the limit is {MaxWindows}";
            return false;
        }

        foreach (var row in rows)
        {
            // State rows have no comma. They name the taskbar tab, the focused window and the
            // windows the player kept pinned or minimized, so a restored layout is the whole
            // arrangement rather than only a set of rectangles.
            var equals = row.IndexOf('=');
            if (equals > 0 && row.IndexOf(',') < 0)
            {
                var key = row[..equals].Trim().ToLowerInvariant();
                var value = row[(equals + 1)..].Trim();
                if (key is "active" or "tab")
                {
                    if (value.Length > 0 && !WindowPattern.IsMatch(value))
                    {
                        why = $"layout {key} '{value}' is not a safe window id";
                        return false;
                    }

                    if (key == "active") state.Active = value;
                    else state.Tab = value;
                    continue;
                }

                if (key is "pin" or "min")
                {
                    if (!WindowPattern.IsMatch(value))
                    {
                        why = $"layout {key} '{value}' is not a safe window id";
                        return false;
                    }

                    var list = key == "pin" ? state.Pinned : state.Minimized;
                    if (!list.Contains(value, StringComparer.OrdinalIgnoreCase))
                    {
                        list.Add(value);
                        if (list.Count > MaxStateIds)
                        {
                            why = $"layout has more than {MaxStateIds} {key} rows";
                            return false;
                        }
                    }
                    continue;
                }

                if (key == "popit")
                {
                    // The Popit surface is the shell's own menu; its arrangement is saved with
                    // the desktop it belongs to, not in a second file the shell cannot find.
                    if (!TryParsePopit(value, out var popit, out why))
                        return false;
                    state.Popit = popit;
                    continue;
                }

                why = $"layout row '{row}' is not id,x,y,w,h or a known state row";
                return false;
            }

            var fields = row.Split(',');
            if (fields.Length != 5)
            {
                why = $"layout row '{row}' is not id,x,y,w,h";
                return false;
            }

            var id = fields[0].Trim();
            if (!WindowPattern.IsMatch(id))
            {
                why = $"window id '{id}' is not a safe profile key";
                return false;
            }

            if (!TryInt(fields[1], out var x) || !TryInt(fields[2], out var y)
                || !TryInt(fields[3], out var w) || !TryInt(fields[4], out var h))
            {
                why = $"layout row for '{id}' has a non-integer coordinate";
                return false;
            }

            if (!ValidRect(id, x, y, w, h))
            {
                why = $"layout row for '{id}' is outside the allowed geometry";
                return false;
            }

            windows[id] = new Rect { X = x, Y = y, W = w, H = h };
        }

        return windows.Count > 0;
    }

    /// <summary>
    /// Reads one <c>popit=</c> row: <c>columns:4;width:356;frame:lbp3;mode:create;order:a+b</c>.
    /// The order is a <c>+</c> list because a comma already separates a rectangle row.
    /// </summary>
    private static bool TryParsePopit(string value, out PopitLayout popit, out string why)
    {
        popit = new PopitLayout();
        why = "";

        if (value.Length == 0)
        {
            why = "layout popit row is empty";
            return false;
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var part in value.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var split = part.IndexOf(':');
            if (split <= 0)
            {
                why = $"popit field '{part}' is not key:value";
                return false;
            }

            var key = part[..split].Trim().ToLowerInvariant();
            var field = part[(split + 1)..].Trim();
            if (!seen.Add(key))
            {
                why = $"popit field '{key}' appears twice";
                return false;
            }

            switch (key)
            {
                case "columns":
                    if (!TryInt(field, out var columns) || columns < 1 || columns > 4)
                    {
                        why = $"popit columns '{field}' is not 1..4";
                        return false;
                    }

                    popit.Columns = columns;
                    break;

                case "width":
                    if (!TryInt(field, out var width) || width < MinPopitWidth || width > MaxPopitWidth)
                    {
                        why = $"popit width '{field}' is not {MinPopitWidth}..{MaxPopitWidth}";
                        return false;
                    }

                    popit.Width = width;
                    break;

                case "frame":
                    var frame = field.ToLowerInvariant();
                    if (!PopitFrames.Contains(frame, StringComparer.Ordinal))
                    {
                        why = $"popit frame '{field}' is not one of {string.Join(", ", PopitFrames)}";
                        return false;
                    }

                    popit.Frame = frame;
                    break;

                case "mode":
                    var mode = field.ToLowerInvariant();
                    if (!PopitModes.Contains(mode, StringComparer.Ordinal))
                    {
                        why = $"popit mode '{field}' is not one of {string.Join(", ", PopitModes)}";
                        return false;
                    }

                    popit.Mode = mode;
                    break;

                case "order":
                    if (field.Length == 0)
                        break;
                    var ids = field.Split('+', StringSplitOptions.RemoveEmptyEntries);
                    if (ids.Length > MaxPopitOrder)
                    {
                        why = $"popit order has {ids.Length} tiles; the limit is {MaxPopitOrder}";
                        return false;
                    }

                    foreach (var id in ids)
                    {
                        if (!WindowPattern.IsMatch(id))
                        {
                            why = $"popit order tile '{id}' is not a safe window id";
                            return false;
                        }

                        if (!popit.Order.Contains(id, StringComparer.OrdinalIgnoreCase))
                            popit.Order.Add(id);
                    }

                    break;

                default:
                    why = $"popit field '{key}' is not one of columns, width, frame, mode, order";
                    return false;
            }
        }

        return true;
    }

    private static bool ValidPopit(PopitLayout popit, out string why)
    {
        why = "";
        if (popit.Columns < 1 || popit.Columns > 4)
        {
            why = $"popit columns {popit.Columns} is not 1..4";
            return false;
        }

        if (popit.Width < MinPopitWidth || popit.Width > MaxPopitWidth)
        {
            why = $"popit width {popit.Width} is not {MinPopitWidth}..{MaxPopitWidth}";
            return false;
        }

        if (!PopitFrames.Contains(popit.Frame ?? "", StringComparer.Ordinal))
        {
            why = $"popit frame '{popit.Frame}' is not one of {string.Join(", ", PopitFrames)}";
            return false;
        }

        if (!PopitModes.Contains(popit.Mode ?? "", StringComparer.Ordinal))
        {
            why = $"popit mode '{popit.Mode}' is not one of {string.Join(", ", PopitModes)}";
            return false;
        }

        var order = popit.Order ?? [];
        if (order.Count > MaxPopitOrder)
        {
            why = $"popit order has {order.Count} tiles; the limit is {MaxPopitOrder}";
            return false;
        }

        if (order.Any(id => !WindowPattern.IsMatch(id)))
        {
            why = "popit order names an unsafe tile id";
            return false;
        }

        return true;
    }

    /// <summary>Writes one scheme profile, replacing any previous snapshot with an atomic move.</summary>
    public bool Save(
        string scheme,
        IReadOnlyDictionary<string, Rect> windows,
        LayoutState state,
        out string why)
    {
        why = "";
        var path = PathFor(scheme);
        if (path.Length == 0)
        {
            why = "profile path is outside the layout directory";
            return false;
        }

        if (windows.Count == 0 || windows.Count > MaxWindows)
        {
            why = $"profile has {windows.Count} windows; expected 1..{MaxWindows}";
            return false;
        }

        if (!EnsureWritable(out why))
            return false;

        foreach (var pair in windows)
        {
            if (!WindowPattern.IsMatch(pair.Key) || !ValidRect(
                    pair.Key, pair.Value.X, pair.Value.Y, pair.Value.W, pair.Value.H))
            {
                why = $"window '{pair.Key}' has invalid geometry";
                return false;
            }
        }

        if ((state.Active.Length > 0 && !WindowPattern.IsMatch(state.Active))
            || (state.Tab.Length > 0 && !WindowPattern.IsMatch(state.Tab))
            || state.Pinned.Count > MaxStateIds
            || state.Minimized.Count > MaxStateIds
            || state.Pinned.Any(id => !WindowPattern.IsMatch(id))
            || state.Minimized.Any(id => !WindowPattern.IsMatch(id)))
        {
            why = "arrangement state names an unsafe window id";
            return false;
        }

        if (state.Popit is not null && !ValidPopit(state.Popit, out why))
            return false;

        try
        {
            var profile = new Profile
            {
                Format = ProfileFormat,
                Scheme = scheme.Trim().ToLowerInvariant(),
                Updated = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture),
                Active = state.Active,
                Tab = state.Tab,
                Pinned = [.. state.Pinned],
                Minimized = [.. state.Minimized],
                Popit = state.Popit is null
                    ? null
                    : new PopitLayout
                    {
                        Columns = state.Popit.Columns,
                        Width = state.Popit.Width,
                        Frame = state.Popit.Frame,
                        Mode = state.Popit.Mode,
                        Order = [.. state.Popit.Order],
                    },
                Windows = windows.ToDictionary(pair => pair.Key, pair => new Rect
                {
                    X = pair.Value.X,
                    Y = pair.Value.Y,
                    W = pair.Value.W,
                    H = pair.Value.H,
                }),
            };

            var json = JsonSerializer.Serialize(profile, JsonOptions);
            if (json.Length > MaxProfileBytes)
            {
                why = $"profile is {json.Length} bytes; the limit is {MaxProfileBytes}";
                return false;
            }

            if (File.Exists(path) && IsLink(path))
            {
                why = "destination profile is a link";
                return false;
            }

            var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllText(temp, json);
                File.Move(temp, path, overwrite: true);
            }
            finally
            {
                TryDelete(temp);
            }

            return true;
        }
        catch (Exception error)
        {
            why = error.Message;
            return false;
        }
    }

    /// <summary>
    /// Writes one scheme profile without arrangement state. Kept for callers that only need
    /// geometry (the install-time tests and console snapshots).
    /// </summary>
    public bool Save(string scheme, IReadOnlyDictionary<string, Rect> windows, out string why) =>
        Save(scheme, windows, new LayoutState(), out why);

    /// <summary>
    /// Copies a saved profile into <c>layouts/exports</c> as a portable file. The copy has the
    /// same validated contents; the timestamp is in the file name so two exports cannot
    /// overwrite each other.
    /// </summary>
    public bool Export(string scheme, out string path, out string why)
    {
        path = "";
        why = "";
        var source = PathFor(scheme);
        if (source.Length == 0)
        {
            why = "profile path is outside the layout directory";
            return false;
        }

        try
        {
            if (!File.Exists(source))
            {
                why = $"no saved layout for '{scheme}' to export";
                return false;
            }

            if (IsLink(source))
            {
                why = "profile is a link";
                return false;
            }

            var info = new FileInfo(source);
            if (info.Length > MaxProfileBytes)
            {
                why = $"profile is {info.Length} bytes; the limit is {MaxProfileBytes}";
                return false;
            }

            var exportDirectory = Path.Combine(_directory, "exports");
            if (Directory.Exists(exportDirectory) && IsLink(exportDirectory))
            {
                why = "export directory is a link";
                return false;
            }

            Directory.CreateDirectory(exportDirectory);
            var stamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff", CultureInfo.InvariantCulture);
            var destination = Path.Combine(exportDirectory,
                scheme.Trim().ToLowerInvariant() + "-" + stamp + ".layout.json");
            File.Copy(source, destination, overwrite: false);
            path = destination;
            return true;
        }
        catch (Exception error)
        {
            why = error.Message;
            return false;
        }
    }

    public bool Reset(string scheme, out string why)
    {
        why = "";
        var path = PathFor(scheme);
        if (path.Length == 0)
        {
            why = "profile path is outside the layout directory";
            return false;
        }

        try
        {
            if (!File.Exists(path))
                return true;

            File.Delete(path);
            return true;
        }
        catch (Exception error)
        {
            why = error.Message;
            return false;
        }
    }

    public bool HasProfile(string scheme) => File.Exists(PathFor(scheme));

    /// <summary>The payload the shell reads from the host attribute: profiles plus plain notices.</summary>
    public string PayloadJson(string? notice = null)
    {
        var profiles = new Dictionary<string, Snapshot>(StringComparer.OrdinalIgnoreCase);
        var notices = new List<string>();

        try
        {
            if (Directory.Exists(_directory))
            {
                if (IsLink(_directory))
                {
                    notices.Add("layout profile directory is a link; profiles were not read");
                }
                else
                {
                    foreach (var file in Directory.EnumerateFiles(_directory, "*.layout.json")
                                 .OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
                    {
                        if (profiles.Count >= MaxProfiles)
                        {
                            notices.Add($"more than {MaxProfiles} layout profiles; the rest were ignored");
                            break;
                        }

                        var name = Path.GetFileName(file);
                        var scheme = name[..^".layout.json".Length];
                        if (!IsValidScheme(scheme))
                        {
                            notices.Add($"{name}: ignored because its file name is not a safe scheme");
                            continue;
                        }

                        var profile = ReadProfile(file, scheme, out var why);
                        if (profile is null)
                        {
                            notices.Add($"{name}: ignored ({why})");
                            continue;
                        }

                        profiles[scheme] = new Snapshot
                        {
                            Windows = profile.Windows,
                            Active = profile.Active ?? "",
                            Tab = profile.Tab ?? "",
                            Pinned = profile.Pinned ?? [],
                            Minimized = profile.Minimized ?? [],
                            Popit = profile.Popit,
                        };
                    }
                }
            }
        }
        catch (Exception error)
        {
            notices.Add("layout profiles were not read: " + error.Message);
        }

        if (!string.IsNullOrWhiteSpace(notice))
            notices.Add(notice);

        return JsonSerializer.Serialize(
            new { format = PayloadFormat, profiles, notices },
            JsonOptions);
    }

    private Profile? ReadProfile(string path, string scheme, out string why)
    {
        why = "";
        try
        {
            if (IsLink(path))
            {
                why = "profile is a link";
                return null;
            }

            var info = new FileInfo(path);
            if (info.Length > MaxProfileBytes)
            {
                why = $"profile is {info.Length} bytes; the limit is {MaxProfileBytes}";
                return null;
            }

            var profile = JsonSerializer.Deserialize<Profile>(File.ReadAllText(path), JsonOptions);
            if (profile is null)
            {
                why = "profile is empty";
                return null;
            }

            if (!string.Equals(profile.Format, ProfileFormat, StringComparison.Ordinal))
            {
                why = $"unknown profile format '{profile.Format}'";
                return null;
            }

            if (!string.Equals(profile.Scheme, scheme, StringComparison.OrdinalIgnoreCase))
            {
                why = $"profile names scheme '{profile.Scheme}' but the file is '{scheme}'";
                return null;
            }

            if (profile.Windows is null || profile.Windows.Count == 0 || profile.Windows.Count > MaxWindows)
            {
                why = $"profile has {profile.Windows?.Count ?? 0} windows; expected 1..{MaxWindows}";
                return null;
            }

            profile.Active ??= "";
            profile.Tab ??= "";
            profile.Pinned ??= [];
            profile.Minimized ??= [];
            if (profile.Popit is not null && !ValidPopit(profile.Popit, out why))
                return null;
            if ((profile.Active.Length > 0 && !WindowPattern.IsMatch(profile.Active))
                || (profile.Tab.Length > 0 && !WindowPattern.IsMatch(profile.Tab))
                || profile.Pinned.Count > MaxStateIds
                || profile.Minimized.Count > MaxStateIds
                || profile.Pinned.Any(id => !WindowPattern.IsMatch(id))
                || profile.Minimized.Any(id => !WindowPattern.IsMatch(id)))
            {
                why = "arrangement state names an unsafe window id";
                return null;
            }

            foreach (var pair in profile.Windows)
            {
                if (!WindowPattern.IsMatch(pair.Key) || !ValidRect(
                        pair.Key, pair.Value.X, pair.Value.Y, pair.Value.W, pair.Value.H))
                {
                    why = $"window '{pair.Key}' has invalid geometry";
                    return null;
                }
            }

            return profile;
        }
        catch (Exception error)
        {
            why = error.Message;
            return null;
        }
    }

    private bool EnsureWritable(out string why)
    {
        why = "";
        try
        {
            if (File.Exists(_directory))
            {
                why = "layout profile path is a file";
                return false;
            }

            if (Directory.Exists(_directory) && IsLink(_directory))
            {
                why = "layout profile directory is a link";
                return false;
            }

            Directory.CreateDirectory(_directory);
            return true;
        }
        catch (Exception error)
        {
            why = error.Message;
            return false;
        }
    }

    // A split cell is a component of a window, not a whole window: an ability icon or a stat
    // label may be far smaller than the 120x64 minimum a normal window keeps. The relaxed
    // floor is keyed by the id prefix so a normal window cannot shrink below the old bar.
    private static bool ValidRect(string id, int x, int y, int w, int h)
    {
        var cell = id.StartsWith("cell:", StringComparison.Ordinal);
        var minWidth = cell ? MinCellSide : MinWindowWidth;
        var minHeight = cell ? MinCellSide : MinWindowHeight;
        return Math.Abs(x) <= MaxCoordinate
            && Math.Abs(y) <= MaxCoordinate
            && w >= minWidth
            && w <= MaxWindowWidth
            && h >= minHeight
            && h <= MaxWindowHeight;
    }

    private static bool TryInt(string value, out int result) =>
        int.TryParse(value.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out result);

    private static bool IsLink(string path)
    {
        try
        {
            return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
        }
        catch
        {
            return false;
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
                File.Delete(path);
        }
        catch
        {
            // A leftover temporary file is not worth turning a successful save into a failure.
        }
    }
}

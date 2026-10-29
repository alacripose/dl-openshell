using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;

namespace Openlock.Shell;

/// <summary>
/// The one reader for a shploingus package frame and its <c>shploingus.recipe/3</c> source.
///
/// <para>
/// The frame is the format the shploingus build writes: <c>SHPKG002</c> is an eight-byte magic,
/// a little-endian payload length, a SHA-256 of the payload, and the recipe source;
/// <c>SHPKG003</c> appends the package's own artifacts after the source. The recipe grammar is
/// the 13-key window grammar from <c>crates/voxel-package/src/recipe.rs</c>, not a second
/// manifest. A package that carries a bad digest, a truncated artifact table, an unknown key,
/// or a missing required key is refused with the file and line that declared it.
/// </para>
///
/// <para>
/// The controls on a window are not a separate row in the format. The real shell derives them
/// from the window's <c>layout</c> and <c>behavior</c> policies: a window with no
/// <c>title-position</c> has no title bar, and a bar carries pin, minimize, maximize and close
/// only when the matching policy permits them. <see cref="Window.Controls"/> is that
/// projection, so the plugin and the shell cannot disagree about which controls exist.
/// </para>
/// </summary>
public sealed class ShpPackage
{
    public const string RecipeHeader = "shploingus.recipe/3";
    public const string MagicSource = "SHPKG002";
    public const string MagicArtifacts = "SHPKG003";

    private const int Head = 44;
    private const int MaxRecipeBytes = 1_048_576;
    private const int MaxWindows = 256;
    private const int MaxRows = 256;
    private const int MaxValueBytes = 256;
    private const int MaxRowTextBytes = 4096;
    private const int MaxArtifacts = 1024;
    private const int MaxArtifactPath = 256;
    private const int MaxArtifactBytes = 4 * 1024 * 1024;

    private static readonly string[] WindowFields =
    [
        "title", "content", "lane", "extent", "geometry", "min-size", "opacity",
        "elevation", "theme-role", "pinnable", "layout", "behavior", "record-id",
    ];

    private static readonly HashSet<string> Contents = new(StringComparer.Ordinal)
    {
        "world-view", "readout", "table", "log", "console", "ledger", "api-viewer",
        "shaper-panel", "mods", "map-plan", "tools", "inventory", "trees", "settings",
        "streamer", "notifications",
    };

    private static readonly HashSet<string> Lanes = new(StringComparer.Ordinal)
    {
        "frame", "control", "tab", "world", "beacon", "motion",
    };

    private static readonly HashSet<string> Extents = new(StringComparer.Ordinal)
    {
        "square-pixels", "cubic-world-units",
    };

    private static readonly HashSet<string> LayoutTokens = new(StringComparer.Ordinal)
    {
        "minimize", "maximize", "close", "title-position",
    };

    private static readonly HashSet<string> BehaviorTokens = new(StringComparer.Ordinal)
    {
        "drag", "resize", "maximize", "minimize", "close",
    };

    private static readonly UTF8Encoding Utf8 = new(false, true);

    public sealed class Control
    {
        [JsonPropertyName("kind")]
        public string Kind { get; set; } = "";

        [JsonPropertyName("label")]
        public string Label { get; set; } = "";
    }

    public sealed class Window
    {
        [JsonPropertyName("id")]
        public string Id { get; set; } = "";

        [JsonPropertyName("title")]
        public string Title { get; set; } = "";

        [JsonPropertyName("content")]
        public string Content { get; set; } = "";

        [JsonPropertyName("lane")]
        public string Lane { get; set; } = "";

        [JsonPropertyName("extent")]
        public string Extent { get; set; } = "";

        [JsonIgnore]
        public int[] Geometry { get; set; } = [0, 0, 0, 0];

        [JsonIgnore]
        public int[] MinSize { get; set; } = [0, 0];

        [JsonPropertyName("x")]
        public int X => Geometry.Length > 0 ? Geometry[0] : 0;

        [JsonPropertyName("y")]
        public int Y => Geometry.Length > 1 ? Geometry[1] : 0;

        [JsonPropertyName("width")]
        public int Width => Geometry.Length > 2 ? Geometry[2] : 0;

        [JsonPropertyName("height")]
        public int Height => Geometry.Length > 3 ? Geometry[3] : 0;

        [JsonPropertyName("minWidth")]
        public int MinWidth => MinSize.Length > 0 ? MinSize[0] : 0;

        [JsonPropertyName("minHeight")]
        public int MinHeight => MinSize.Length > 1 ? MinSize[1] : 0;

        [JsonPropertyName("opacity")]
        public int Opacity { get; set; } = 930;

        [JsonPropertyName("elevation")]
        public int Elevation { get; set; }

        [JsonPropertyName("theme-role")]
        public string ThemeRole { get; set; } = "";

        [JsonPropertyName("pinnable")]
        public bool Pinnable { get; set; }

        [JsonPropertyName("layout")]
        public string Layout { get; set; } = "none";

        [JsonPropertyName("behavior")]
        public string Behavior { get; set; } = "none";

        [JsonPropertyName("record-id")]
        public string RecordId { get; set; } = "";

        /// <summary>
        /// The mounted Panorama layout this window draws, when the package or its VPK delivered
        /// one. The path is package-relative and is only set by the addon loader after it has
        /// checked that the archive really carries it. A window without one keeps its declared
        /// content kind.
        /// </summary>
        [JsonPropertyName("layoutPath")]
        public string LayoutPath { get; set; } = "";

        /// <summary>
        /// The package's source XML as a node tree, with its CSS classes already resolved. The
        /// shell builds this itself, so a package delivered after the client loaded still draws
        /// and keeps its controls clickable without a mounted resource path.
        /// </summary>
        [JsonPropertyName("liveTree")]
        public List<LayoutTree.Node>? LiveTree { get; set; }

        /// <summary>
        /// The shell's content selector. A delivered XML layout or a live node tree wins over the
        /// package's closed content kind, because the package's window is then drawn by that XML.
        /// </summary>
        [JsonPropertyName("view")]
        public string View => string.IsNullOrEmpty(LayoutPath) && LiveTree is not { Count: > 0 }
            ? Content
            : "addon-layout";

        /// <summary>The package that declared this window, set by the addon loader.</summary>
        [JsonPropertyName("addon")]
        public string Addon { get; set; } = "";

        [JsonPropertyName("addonName")]
        public string AddonName { get; set; } = "";

        /// <summary>
        /// The title-bar controls this window is allowed, in the real shell's order:
        /// pin, minimize, maximize, close. Empty when the layout permits no title bar.
        /// </summary>
        [JsonPropertyName("controls")]
        public List<Control> Controls { get; } = [];

        [JsonIgnore]
        public bool HasTitleBar => HasToken(Layout, "title-position");

        public bool Permits(string behavior) => HasToken(Behavior, behavior);

        internal void ProjectControls()
        {
            Controls.Clear();
            if (!HasTitleBar)
                return;

            if (Pinnable)
                Controls.Add(new Control { Kind = "pin", Label = "Pin" });
            if (HasToken(Layout, "minimize"))
                Controls.Add(new Control { Kind = "minimize", Label = "Minimize" });
            if (HasToken(Layout, "maximize"))
                Controls.Add(new Control { Kind = "maximize", Label = "Maximize" });
            if (HasToken(Layout, "close"))
                Controls.Add(new Control { Kind = "close", Label = "Close" });
        }

        internal static bool HasToken(string policies, string token) =>
            policies.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Contains(token, StringComparer.Ordinal);
    }

    public sealed record Row(string Id, string Text);

    public sealed record Refusal(string File, int Line, string Subject, string Why);

    public string File { get; private set; } = "";
    public string Magic { get; private set; } = "";
    public string Name { get; private set; } = "";
    public string Version { get; private set; } = "";
    public string Source { get; private set; } = "";
    public string SourceDigest { get; private set; } = "";
    public string PackageDigest { get; private set; } = "";

    public List<Row> Rows { get; } = [];
    public List<Window> Windows { get; } = [];
    public List<string> Pins { get; } = [];
    public List<string> Tabs { get; } = [];
    public List<string> Bar { get; } = [];
    public List<(string Window, string Tab)> Filed { get; } = [];
    public List<Refusal> Refusals { get; } = [];
    public Dictionary<string, byte[]> Artifacts { get; } = new(StringComparer.Ordinal);

    public Window? WindowById(string id) =>
        Windows.FirstOrDefault(w => string.Equals(w.Id, id, StringComparison.OrdinalIgnoreCase));

    public static ShpPackage LoadFile(string path)
    {
        try
        {
            return Parse(System.IO.File.ReadAllBytes(path), path);
        }
        catch (Exception exception) when (exception is IOException
            or UnauthorizedAccessException
            or InvalidDataException
            or ArgumentException)
        {
            var refused = new ShpPackage { File = path };
            refused.Refusals.Add(new Refusal(path, 1, "package", exception.Message));
            return refused;
        }
    }

    public static ShpPackage Parse(byte[] frame, string file)
    {
        var package = new ShpPackage { File = file };
        package.ReadFrame(frame);
        return package;
    }

    private void ReadFrame(byte[] frame)
    {
        if (frame.Length < Head)
        {
            Refusals.Add(new Refusal(File, 1, "frame", "package frame is shorter than its own header"));
            return;
        }

        Magic = Encoding.ASCII.GetString(frame, 0, 8);
        if (Magic != MagicSource && Magic != MagicArtifacts)
        {
            Refusals.Add(new Refusal(File, 1, Magic, "package frame is not SHPKG002 or SHPKG003"));
            return;
        }

        var length = BitConverter.ToUInt32(frame, 8);
        if (length > MaxRecipeBytes || Head + (long)length > frame.Length)
        {
            Refusals.Add(new Refusal(File, 1, "frame", $"package declares {length} payload bytes and the frame ends first"));
            return;
        }

        var sourceEnd = Head + (int)length;
        var source = frame[Head..sourceEnd];
        var declared = frame[12..44];
        var actual = SHA256.HashData(source);
        if (!CryptographicOperations.FixedTimeEquals(actual, declared))
        {
            Refusals.Add(new Refusal(File, 1, "frame", "package payload does not match the digest the frame declares"));
            return;
        }

        SourceDigest = Convert.ToHexString(actual).ToLowerInvariant();
        PackageDigest = Convert.ToHexString(SHA256.HashData(frame)).ToLowerInvariant();
        try
        {
            Source = Utf8.GetString(source);
        }
        catch (DecoderFallbackException)
        {
            Refusals.Add(new Refusal(File, 1, "recipe", "recipe is not UTF-8"));
            return;
        }

        if (Magic == MagicArtifacts)
            ReadArtifacts(frame, sourceEnd);
        else if (sourceEnd != frame.Length)
            Refusals.Add(new Refusal(File, 1, "frame", "SHPKG002 carries bytes after its recipe"));

        ParseRecipe();
    }

    private void ReadArtifacts(byte[] frame, int at)
    {
        if (at + 4 > frame.Length)
        {
            Refusals.Add(new Refusal(File, 1, "artifacts", "package carries no artifact count after its recipe"));
            return;
        }

        var count = BitConverter.ToUInt32(frame, at);
        at += 4;
        if (count > MaxArtifacts)
        {
            Refusals.Add(new Refusal(File, 1, "artifacts", $"package declares {count} artifacts; the ceiling is {MaxArtifacts}"));
            return;
        }

        for (var i = 0; i < count; i++)
        {
            if (at + 2 > frame.Length)
            {
                Refusals.Add(new Refusal(File, 1, "artifacts", "artifact table ends before a path"));
                return;
            }

            var pathLength = BitConverter.ToUInt16(frame, at);
            at += 2;
            if (pathLength > MaxArtifactPath || at + pathLength > frame.Length)
            {
                Refusals.Add(new Refusal(File, 1, "artifacts", $"artifact path of {pathLength} bytes is outside the frame or the ceiling"));
                return;
            }

            string path;
            try
            {
                path = Utf8.GetString(frame, at, pathLength);
            }
            catch (DecoderFallbackException)
            {
                Refusals.Add(new Refusal(File, 1, "artifacts", "artifact path is not UTF-8"));
                return;
            }
            at += pathLength;

            if (at + 4 > frame.Length)
            {
                Refusals.Add(new Refusal(File, 1, "artifacts", $"artifact {path} ends before its length"));
                return;
            }

            var bytes = BitConverter.ToUInt32(frame, at);
            at += 4;
            if (bytes > MaxArtifactBytes || at + (long)bytes > frame.Length)
            {
                Refusals.Add(new Refusal(File, 1, "artifacts", $"artifact {path} has {bytes} bytes and the frame ends first"));
                return;
            }

            if (!WellFormedArtifactPath(path))
            {
                Refusals.Add(new Refusal(File, 1, "artifacts", $"{path} is not a package-relative artifact path"));
            }
            else if (!Artifacts.TryAdd(path, frame[at..(at + (int)bytes)]))
            {
                Refusals.Add(new Refusal(File, 1, "artifacts", $"artifact {path} appears twice"));
            }

            at += (int)bytes;
        }

        if (at != frame.Length)
            Refusals.Add(new Refusal(File, 1, "artifacts", $"package carries {frame.Length - at} bytes after its artifact table"));
    }

    private static bool WellFormedArtifactPath(string path) =>
        path.Length > 0
        && path.Length <= MaxArtifactPath
        && !path.StartsWith('/')
        && !path.Contains('\\')
        && path.Split('/').All(part => part.Length > 0 && part != "." && part != "..");

    private void ParseRecipe()
    {
        if (!Source.EndsWith('\n') || Source.Contains('\r'))
            Refusals.Add(new Refusal(File, 1, "recipe", "recipe requires LF lines and a final newline"));

        var lines = Source.Split('\n');
        if (lines.Length == 0 || lines[0] != RecipeHeader)
        {
            Refusals.Add(new Refusal(File, 1, lines.Length == 0 ? "<empty>" : lines[0], "unknown recipe schema"));
            return;
        }

        if (lines.Length < 2)
        {
            Refusals.Add(new Refusal(File, 2, "package", "package row is missing"));
            return;
        }

        var package = lines[1].Split('\t');
        if (package.Length == 3 && package[0] == "package"
            && IsIdentifier(package[1]) && IsIdentifier(package[2]))
        {
            Name = package[1];
            Version = package[2];
        }
        else
        {
            Refusals.Add(new Refusal(File, 2, "package", "package row requires `package`, a canonical name and a canonical version"));
        }

        var cursor = 2;
        while (cursor < lines.Length)
        {
            var line = lines[cursor];
            var lineNumber = cursor + 1;
            cursor++;

            if (line.Length == 0 || IsComment(line))
                continue;

            if (line.StartsWith("row\t", StringComparison.Ordinal))
            {
                ReadRow(line, lineNumber);
                continue;
            }

            var fields = line.Split('\t');
            switch (fields[0])
            {
                case "window" when fields.Length == 2 && IsIdentifier(fields[1]):
                    if (Windows.Count >= MaxWindows)
                    {
                        Refusals.Add(new Refusal(File, lineNumber, "window", $"recipe declares more than {MaxWindows} windows"));
                        break;
                    }
                    var window = ReadWindow(lines, ref cursor, fields[1]);
                    if (window is not null)
                        Windows.Add(window);
                    break;

                case "pin" when fields.Length == 2 && IsIdentifier(fields[1]):
                    Pins.Add(fields[1]);
                    break;

                case "tab" when fields.Length == 2 && IsIdentifier(fields[1]):
                    Tabs.Add(fields[1]);
                    break;

                case "bar" when fields.Length == 2 && IsIdentifier(fields[1]):
                    Bar.Add(fields[1]);
                    break;

                case "filed" when fields.Length == 3 && IsIdentifier(fields[1]) && IsIdentifier(fields[2]):
                    Filed.Add((fields[1], fields[2]));
                    break;

                case "ballot" when fields.Length == 2 && IsIdentifier(fields[1]):
                    SkipBallot(lines, ref cursor);
                    break;

                default:
                    Refusals.Add(new Refusal(File, lineNumber, fields[0], "unexpected row; expected window, row, ballot, tab, bar, filed or pin"));
                    break;
            }
        }

        CheckStructure();
    }

    private Window? ReadWindow(string[] lines, ref int cursor, string id)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var blockLine = cursor - 1;
        var windowErrors = new List<Refusal>();

        while (cursor < lines.Length)
        {
            var line = lines[cursor];
            if (line.Length == 0 || IsComment(line))
            {
                cursor++;
                continue;
            }

            if (!line.StartsWith('\t'))
                break;

            var body = line.TrimStart('\t');
            var fields = body.Split('\t');
            var key = fields[0];

            // The real reader ignores an unknown key inside a window; the package's own
            // extensions (`panel`, `scale`) ride that rule. They are not a second grammar.
            if (!WindowFields.Contains(key, StringComparer.Ordinal))
            {
                cursor++;
                continue;
            }

            cursor++;
            var lineNumber = cursor;
            if (!seen.Add(key))
            {
                windowErrors.Add(new Refusal(File, lineNumber, id, $"duplicate key {key}"));
                continue;
            }

            if (fields.Length < 2 || fields[1].Length > MaxValueBytes)
            {
                windowErrors.Add(new Refusal(File, lineNumber, id, $"{key} needs a value of at most {MaxValueBytes} bytes"));
                continue;
            }

            values[key] = fields[1];
        }

        foreach (var required in WindowFields)
        {
            if (!values.TryGetValue(required, out var value) || value.Length == 0)
                windowErrors.Add(new Refusal(File, blockLine + 1, id, $"{required} is required"));
        }

        if (windowErrors.Count > 0)
        {
            Refusals.AddRange(windowErrors);
            return null;
        }

        if (!Contents.Contains(values["content"]))
            windowErrors.Add(new Refusal(File, blockLine + 1, id, $"unknown content kind {values["content"]}"));
        if (!Lanes.Contains(values["lane"]))
            windowErrors.Add(new Refusal(File, blockLine + 1, id, $"unknown lane {values["lane"]}"));
        if (!Extents.Contains(values["extent"]))
            windowErrors.Add(new Refusal(File, blockLine + 1, id, $"unknown extent {values["extent"]}"));

        var geometry = ParseNumbers(values["geometry"], 4, "geometry", id, blockLine + 1, windowErrors);
        var minSize = ParseNumbers(values["min-size"], 2, "min-size", id, blockLine + 1, windowErrors);
        var opacity = ParseRange(values["opacity"], 930, 1000, "opacity", id, blockLine + 1, windowErrors);
        var elevation = ParseRange(values["elevation"], 0, 4, "elevation", id, blockLine + 1, windowErrors);

        if (!IsIdentifier(values["theme-role"]))
            windowErrors.Add(new Refusal(File, blockLine + 1, id, "theme-role is not a canonical identifier"));
        if (!IsIdentifier(values["record-id"]))
            windowErrors.Add(new Refusal(File, blockLine + 1, id, "record-id is not a canonical identifier"));
        if (!TryBool(values["pinnable"], out var pinnable))
            windowErrors.Add(new Refusal(File, blockLine + 1, id, "pinnable must be true or false"));
        if (!TryPolicy(values["layout"], LayoutTokens, out _))
            windowErrors.Add(new Refusal(File, blockLine + 1, id, "layout names chrome the window may not have"));
        if (!TryPolicy(values["behavior"], BehaviorTokens, out _))
            windowErrors.Add(new Refusal(File, blockLine + 1, id, "behavior names a behaviour the window may not have"));

        if (windowErrors.Count > 0)
        {
            Refusals.AddRange(windowErrors);
            return null;
        }

        var window = new Window
        {
            Id = id,
            Title = values["title"],
            Content = values["content"],
            Lane = values["lane"],
            Extent = values["extent"],
            Geometry = geometry,
            MinSize = minSize,
            Opacity = opacity,
            Elevation = elevation,
            ThemeRole = values["theme-role"],
            Pinnable = pinnable,
            Layout = values["layout"],
            Behavior = values["behavior"],
            RecordId = values["record-id"],
        };
        window.ProjectControls();
        return window;
    }

    private void ReadRow(string line, int lineNumber)
    {
        var fields = line.Split('\t', 3);
        if (fields.Length != 3)
        {
            Refusals.Add(new Refusal(File, lineNumber, "row", "a row is `row<TAB>id<TAB>text`"));
            return;
        }

        var id = fields[1];
        var text = fields[2];
        if (!IsRowIdentifier(id))
        {
            Refusals.Add(new Refusal(File, lineNumber, id, "row id is not an id the record uses"));
            return;
        }
        if (text.Trim().Length == 0 || text.Contains('\t') || Utf8.GetByteCount(text) > MaxRowTextBytes)
        {
            Refusals.Add(new Refusal(File, lineNumber, id, "row text must be one non-empty line within the ceiling"));
            return;
        }
        if (Rows.Any(row => row.Id == id))
        {
            Refusals.Add(new Refusal(File, lineNumber, id, "row is declared twice"));
            return;
        }
        if (Rows.Count >= MaxRows)
        {
            Refusals.Add(new Refusal(File, lineNumber, id, $"recipe declares more than {MaxRows} rows"));
            return;
        }

        Rows.Add(new Row(id, text));
    }

    private static void SkipBallot(string[] lines, ref int cursor)
    {
        while (cursor < lines.Length)
        {
            var line = lines[cursor];
            if (line.Length == 0 || IsComment(line))
            {
                cursor++;
                continue;
            }
            if (!line.StartsWith('\t'))
                break;
            cursor++;
        }
    }

    private void CheckStructure()
    {
        var duplicateWindows = Windows
            .GroupBy(w => w.Id, StringComparer.OrdinalIgnoreCase)
            .Where(group => group.Count() > 1)
            .Select(group => group.Key);
        foreach (var id in duplicateWindows)
            Refusals.Add(new Refusal(File, 1, id, "two windows share an id"));

        foreach (var pin in Pins)
        {
            var window = WindowById(pin);
            if (window is null)
                Refusals.Add(new Refusal(File, 1, pin, "pin names a window that is not declared"));
            else if (!window.Pinnable)
                Refusals.Add(new Refusal(File, 1, pin, "pin names a window that declares pinnable=false"));
        }

        foreach (var tab in Tabs)
            if (WindowById(tab) is null)
                Refusals.Add(new Refusal(File, 1, tab, "tab names a window that is not declared"));

        var entries = Tabs.Concat(Bar).ToArray();
        foreach (var entry in entries)
            if (WindowById(entry) is null)
                Refusals.Add(new Refusal(File, 1, entry, "the bar names a window that is not declared"));
        if (entries.Distinct(StringComparer.Ordinal).Count() != entries.Length)
            Refusals.Add(new Refusal(File, 1, "bar", "one window is both a tab and a bar entry, or is entered twice"));

        foreach (var (window, tab) in Filed)
        {
            if (WindowById(window) is null)
                Refusals.Add(new Refusal(File, 1, window, "filed names a window that is not declared"));
            if (!Tabs.Contains(tab, StringComparer.Ordinal))
                Refusals.Add(new Refusal(File, 1, tab, "filed names a tab that is not declared"));
            if (Tabs.Contains(window, StringComparer.Ordinal) || Bar.Contains(window, StringComparer.Ordinal))
                Refusals.Add(new Refusal(File, 1, window, "a window has one home, and the bar already opens it"));
        }

        var filedWindows = Filed.Select(f => f.Window).ToArray();
        if (filedWindows.Distinct(StringComparer.Ordinal).Count() != filedWindows.Length)
            Refusals.Add(new Refusal(File, 1, "filed", "one window is filed under two tabs"));

        if (Windows.Count == 0 && Rows.Count == 0)
            Refusals.Add(new Refusal(File, 1, "recipe", "recipe declares no window and no row"));
    }

    private int[] ParseNumbers(string text, int count, string key, string id, int line, List<Refusal> errors)
    {
        var parts = text.Split(' ');
        if (parts.Length != count)
        {
            errors.Add(new Refusal(File, line, id, $"{key} needs {count} integers"));
            return new int[count];
        }

        var values = new int[count];
        for (var i = 0; i < count; i++)
        {
            if (!TryNumber(parts[i], out var value) || value > int.MaxValue)
            {
                errors.Add(new Refusal(File, line, id, $"{key} contains {parts[i]}, which is not a canonical integer"));
                return new int[count];
            }
            values[i] = (int)value;
        }
        return values;
    }

    private int ParseRange(string text, int low, int high, string key, string id, int line, List<Refusal> errors)
    {
        if (!TryNumber(text, out var value) || value < low || value > high)
        {
            errors.Add(new Refusal(File, line, id, $"{key} {text} is outside {low}..={high}"));
            return 0;
        }
        return (int)value;
    }

    private static bool TryNumber(string text, out uint value)
    {
        value = 0;
        if (text.Length == 0 || !text.All(char.IsAsciiDigit))
            return false;
        return uint.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out value)
            && value.ToString(CultureInfo.InvariantCulture) == text;
    }

    private static bool TryBool(string text, out bool value)
    {
        switch (text)
        {
            case "true": value = true; return true;
            case "false": value = false; return true;
            default: value = false; return false;
        }
    }

    private static bool TryPolicy(string text, HashSet<string> permitted, out string normalized)
    {
        normalized = "none";
        if (text == "none")
            return true;
        var tokens = text.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (tokens.Length == 0 || tokens.Any(token => !permitted.Contains(token)))
            return false;
        normalized = string.Join(',', tokens);
        return true;
    }

    private static bool IsComment(string line) =>
        line.TrimStart('\t').TrimStart().StartsWith('#');

    private static bool IsIdentifier(string text) =>
        text.Length is > 0 and <= 64
        && text.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c == '-');

    private static bool IsRowIdentifier(string text)
    {
        if (text.Length is 0 or > 64)
            return false;

        var dash = text.LastIndexOf('-');
        if (dash < 0)
        {
            var split = text.TakeWhile(char.IsAsciiLetter).Count();
            return split > 0 && split <= 32 && split < text.Length
                && text[..split].All(char.IsAsciiLetter)
                && text[split..].All(char.IsAsciiDigit);
        }

        var kind = text[..dash];
        var number = text[(dash + 1)..];
        return kind.Length is > 0 and <= 32
            && kind.All(char.IsAsciiLetter)
            && number.Length is > 0 and <= 8
            && number.All(char.IsAsciiDigit);
    }
}

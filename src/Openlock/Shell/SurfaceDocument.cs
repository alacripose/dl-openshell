using System.Text;

namespace Openlock.Shell;

/// <summary>
/// `secure-shell.surface/&lt;32 hex&gt;`: the window declaration that travels inside a modern
/// package.
///
/// <para>
/// The row grammar is the family's surface module from
/// `dl-enclave/tools/port/src/surface.mjs` and `dl-enclave/docs/PACKAGE-FORMAT.md` §2.5, but the
/// header is hash-pinned, not a counter. A legacy numeric header (for example
/// `dl-enclave.surface/1`) is read as a migration input and is upgraded on emission; a different
/// hash is a different grammar and is refused. It is a closed tab-separated document: a header,
/// `surface` and `requires` rows, then `window`, `node` and `action` rows. A row the reader does
/// not know is a refusal, not something to skip; a surface that is partially understood must
/// never become a partially mounted window set.
/// </para>
///
/// <para>
/// The parser has no package identity concept. <see cref="ModernPackage"/> verifies the canonical
/// package first, and <see cref="AddonPackages"/> then checks that this surface's id matches the
/// manifest name. That is deliberate: a surface read always implies a verified payload.
/// </para>
/// </summary>
public sealed class SurfaceDocument
{
    public static readonly string CurrentFormat = FormatId.Hash("secure-shell.surface", SurfaceFormatPreimage());
    public static string Schema => CurrentFormat;
    public const int MaxBytes = 1_048_576;
    public const int MaxBytesPerWindow = 512;
    public const int MaxWindows = 256;
    public const int MaxDepth = 24;
    public const int MaxActions = 16;

    private static readonly string[] Lanes =
        ["frame", "control", "tab", "world", "beacon", "motion"];

    private static readonly string[] Rules =
    [
        "fill", "full-bleed", "centre", "centre-wide", "right-dock", "right-lower",
        "right-stack", "bottom-strip", "bottom-left", "small-right",
    ];

    private static readonly string[] ThemeRoles = ["surface", "hud"];

    private static readonly string[] TypeRoles =
        ["micro", "small", "body", "lead", "title", "display", "mono"];

    private static readonly string[] NodeKinds =
        ["pane", "row", "field", "label", "list", "table", "chart"];

    private static readonly string[] Chrome = ["minimize", "maximize", "close"];

    private static readonly string[] Moves = ["drag", "resize"];

    private static readonly string[] Capabilities = ["observe", "act", "admin"];

    private static readonly Dictionary<string, int> CapabilityRank = new(StringComparer.Ordinal)
    {
        ["observe"] = 0,
        ["act"] = 1,
        ["admin"] = 2,
    };

    public sealed record Refusal(string Code, string Subject, string Why, int Line)
    {
        public string Describe => $"{Code}: {Subject}: {Why} (line {Line})";
    }

    public sealed class Window
    {
        public string Id = "";
        public string Title = "";
        public string Lane = "";
        public string Rule = "";
        public int X, Y, Width, Height, MinWidth, MinHeight;
        public bool Pinnable, Pinned;
        public string Chrome = "none";
        public string Moves = "none";
        public string ThemeRole = "";
        public string Content = "";
        public int Line;
    }

    public sealed class Node
    {
        [System.Text.Json.Serialization.JsonPropertyName("window")]
        public string Window { get; set; } = "";

        [System.Text.Json.Serialization.JsonPropertyName("id")]
        public string Id { get; set; } = "";

        [System.Text.Json.Serialization.JsonPropertyName("parent")]
        public string Parent { get; set; } = "-";

        [System.Text.Json.Serialization.JsonPropertyName("kind")]
        public string Kind { get; set; } = "";

        [System.Text.Json.Serialization.JsonPropertyName("role")]
        public string Role { get; set; } = "";

        [System.Text.Json.Serialization.JsonPropertyName("value")]
        public string Value { get; set; } = "-";

        [System.Text.Json.Serialization.JsonIgnore]
        public int Line { get; set; }
    }

    public sealed class Action
    {
        [System.Text.Json.Serialization.JsonPropertyName("window")]
        public string Window { get; set; } = "";

        [System.Text.Json.Serialization.JsonPropertyName("verb")]
        public string Verb { get; set; } = "";

        [System.Text.Json.Serialization.JsonPropertyName("tool")]
        public string Tool { get; set; } = "";

        [System.Text.Json.Serialization.JsonPropertyName("target")]
        public string Target { get; set; } = "-";

        [System.Text.Json.Serialization.JsonIgnore]
        public int Line { get; set; }
    }

    public static bool AcceptsSchema(string id) =>
        FormatId.SameFamily(id, CurrentFormat)
        && (id == CurrentFormat || FormatId.IsNumeric(id));

    public string Id { get; private set; } = "";
    public string Format { get; private set; } = "";
    public bool UsesLegacyFormat { get; private set; }
    public string Requires { get; private set; } = "";
    public string Source { get; private set; } = "";
    public List<string> Comments { get; } = [];
    public List<Window> Windows { get; } = [];
    public List<Node> Nodes { get; } = [];
    public List<Action> Actions { get; } = [];

    /// <summary>
    /// The contract the surface id pins. A parser change that adds or removes a refusal changes
    /// this text and therefore the id; there is no counter to bump and no way for an old reader
    /// to accept the new grammar by comparing a literal.
    /// </summary>
    private static string SurfaceFormatPreimage() =>
        "family\tsecure-shell.surface\n"
        + "legacy-family\tdl-enclave.surface\n"
        + "legacy-schema\t1\n"
        + "reader\tsecure-shell.surface.reader.v1\n"
        + "refusal\taction-count\nrefusal\tduplicate-window\nrefusal\tformat-hash-mismatch\n"
        + "refusal\tformat-id-legacy-emitted\nrefusal\tgeometry-invalid\nrefusal\tnode-count\n"
        + "refusal\tnode-depth\nrefusal\tpin-not-pinnable\nrefusal\tsurface-capability\n"
        + "refusal\tsurface-id\nrefusal\tsurface-oversize\nrefusal\tsurface-schema\n"
        + "refusal\tunknown-lane\nrefusal\tunknown-node-kind\nrefusal\tunknown-node-parent\n"
        + "refusal\tunknown-node-role\nrefusal\tunknown-rule\nrefusal\tunknown-theme-role\n"
        + "refusal\twindow-count\n";

    /// <summary>
    /// Parses one complete surface document. Every refusal names the schema row and line that
    /// produced it; no caller may mount the partial result.
    /// </summary>
    public static bool TryParse(string text, string source, out SurfaceDocument document, out Refusal refusal)
    {
        document = new SurfaceDocument { Source = source };
        refusal = null!;

        if (Encoding.UTF8.GetByteCount(text) > MaxBytes)
        {
            refusal = new Refusal("surface-oversize", source,
                $"surface is over {MaxBytes} bytes", 1);
            return false;
        }

        var lines = text.Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n')
            .Split('\n')
            .ToList();
        if (lines.Count > 0 && lines[^1].Length == 0)
            lines.RemoveAt(lines.Count - 1);

        var index = 0;
        while (index < lines.Count && lines[index].StartsWith('#'))
        {
            document.Comments.Add(lines[index]);
            index++;
        }

        if (index >= lines.Count)
        {
            refusal = new Refusal("surface-schema", source,
                $"line {index + 1}: document ends before its header", index + 1);
            return false;
        }
        var declaredFormat = lines[index];
        var formatMatch = FormatId.Classify(declaredFormat, CurrentFormat);
        if (formatMatch == FormatId.Match.Mismatch)
        {
            refusal = new Refusal("format-hash-mismatch", declaredFormat,
                $"this reader computes {CurrentFormat}", index + 1);
            return false;
        }
        if (formatMatch == FormatId.Match.NotFormat)
        {
            refusal = new Refusal("surface-schema", source,
                $"line {index + 1}: expected {CurrentFormat}", index + 1);
            return false;
        }
        document.Format = declaredFormat;
        document.UsesLegacyFormat = formatMatch == FormatId.Match.Legacy;
        index++;

        if (!ReadField(lines, ref index, "surface", out var id, out refusal))
            return false;
        if (!ReadField(lines, ref index, "requires", out var requires, out refusal))
            return false;
        if (!IdPattern(id))
        {
            refusal = new Refusal("surface-id", id, "not a [a-z0-9-]{1,64} id", index - 1);
            return false;
        }
        if (!Capabilities.Contains(requires, StringComparer.Ordinal))
        {
            refusal = new Refusal("surface-capability", id,
                $"unknown requires '{requires}'", index - 1);
            return false;
        }
        document.Id = id;
        document.Requires = requires;

        var windowIds = new HashSet<string>(StringComparer.Ordinal);
        var nodesByWindow = new Dictionary<string, Dictionary<string, int>>(StringComparer.Ordinal);
        var actionCounts = new Dictionary<string, int>(StringComparer.Ordinal);

        while (index < lines.Count)
        {
            var line = lines[index];
            var lineNumber = index + 1;
            if (line.Length == 0)
            {
                refusal = new Refusal("surface-schema", source,
                    $"line {lineNumber}: blank row", lineNumber);
                return false;
            }

            var columns = line.Split('\t');
            switch (columns[0])
            {
                case "window":
                {
                    if (columns.Length != 17)
                    {
                        refusal = new Refusal("surface-schema", source,
                            $"line {lineNumber}: window row has {columns.Length} columns, expected 17",
                            lineNumber);
                        return false;
                    }

                    if (!ParseBool(columns[11], out var pinnable)
                        || !ParseBool(columns[12], out var pinned))
                    {
                        return Fail(out refusal, "surface-schema", columns[1],
                            "pinnable/pinned is not true or false", lineNumber);
                    }

                    var window = new Window
                    {
                        Id = columns[1],
                        Title = columns[2],
                        Lane = columns[3],
                        Rule = columns[4],
                        Pinnable = pinnable,
                        Pinned = pinned,
                        Chrome = columns[13],
                        Moves = columns[14],
                        ThemeRole = columns[15],
                        Content = columns[16],
                        Line = lineNumber,
                    };

                    if (!IdPattern(window.Id))
                        return Fail(out refusal, "surface-id", window.Id, "not an id", lineNumber);
                    if (!windowIds.Add(window.Id))
                        return Fail(out refusal, "duplicate-window", window.Id, "declared twice", lineNumber);
                    if (!TitleText(window.Title))
                        return Fail(out refusal, "surface-schema", window.Id,
                            "title is not 1..64 bytes without a control character", lineNumber);
                    if (!Lanes.Contains(window.Lane, StringComparer.Ordinal))
                        return Fail(out refusal, "unknown-lane", window.Id, window.Lane, lineNumber);
                    if (!Rules.Contains(window.Rule, StringComparer.Ordinal))
                        return Fail(out refusal, "unknown-rule", window.Id, window.Rule, lineNumber);

                    if (!TryInt(columns[5], out window.X)
                        || !TryInt(columns[6], out window.Y)
                        || !TryInt(columns[7], out window.Width)
                        || !TryInt(columns[8], out window.Height)
                        || !TryInt(columns[9], out window.MinWidth)
                        || !TryInt(columns[10], out window.MinHeight))
                    {
                        return Fail(out refusal, "geometry-invalid", window.Id,
                            "negative or non-integer geometry", lineNumber);
                    }
                    if (window.MinWidth > window.Width || window.MinHeight > window.Height)
                        return Fail(out refusal, "geometry-invalid", window.Id, "min > default", lineNumber);
                    if (!Tokens(window.Chrome, Chrome) || !Tokens(window.Moves, Moves))
                        return Fail(out refusal, "surface-schema", window.Id,
                            $"chrome '{window.Chrome}' or moves '{window.Moves}'", lineNumber);
                    if (!ThemeRoles.Contains(window.ThemeRole, StringComparer.Ordinal))
                        return Fail(out refusal, "unknown-theme-role", window.Id, window.ThemeRole, lineNumber);
                    if (!IdPattern(window.Content))
                        return Fail(out refusal, "surface-schema", window.Id,
                            $"content '{window.Content}' is not an id", lineNumber);
                    if (window.Pinned && !window.Pinnable)
                        return Fail(out refusal, "pin-not-pinnable", window.Id, "pinned but not pinnable", lineNumber);

                    if (document.Windows.Count >= MaxWindows)
                        return Fail(out refusal, "window-count", id,
                            $"{document.Windows.Count + 1} windows", lineNumber);

                    nodesByWindow[window.Id] = new Dictionary<string, int>(StringComparer.Ordinal);
                    actionCounts[window.Id] = 0;
                    document.Windows.Add(window);
                    break;
                }
                case "node":
                {
                    if (columns.Length != 7)
                    {
                        refusal = new Refusal("surface-schema", source,
                            $"line {lineNumber}: node row has {columns.Length} columns, expected 7",
                            lineNumber);
                        return false;
                    }

                    var node = new Node
                    {
                        Window = columns[1],
                        Id = columns[2],
                        Parent = columns[3],
                        Kind = columns[4],
                        Role = columns[5],
                        Value = columns[6],
                        Line = lineNumber,
                    };
                    if (!windowIds.Contains(node.Window))
                        return Fail(out refusal, "surface-schema", $"{node.Window}/{node.Id}",
                            "node names an undeclared window", lineNumber);

                    var nodes = nodesByWindow[node.Window];
                    if (!IdPattern(node.Id) || nodes.ContainsKey(node.Id))
                        return Fail(out refusal, "surface-schema", $"{node.Window}/{node.Id}",
                            "node id is not an id or is declared twice", lineNumber);

                    var depth = 1;
                    if (node.Parent != "-")
                    {
                        if (!nodes.TryGetValue(node.Parent, out var parentDepth))
                            return Fail(out refusal, "unknown-node-parent", $"{node.Window}/{node.Id}",
                                $"parent '{node.Parent}' has not been declared", lineNumber);
                        depth = parentDepth + 1;
                    }
                    if (depth > MaxDepth)
                        return Fail(out refusal, "node-depth", $"{node.Window}/{node.Id}", $"depth {depth}", lineNumber);
                    if (!NodeKinds.Contains(node.Kind, StringComparer.Ordinal))
                        return Fail(out refusal, "unknown-node-kind", $"{node.Window}/{node.Id}", node.Kind, lineNumber);
                    if (!ThemeRoles.Contains(node.Role, StringComparer.Ordinal)
                        && !TypeRoles.Contains(node.Role, StringComparer.Ordinal))
                        return Fail(out refusal, "unknown-node-role", $"{node.Window}/{node.Id}", node.Role, lineNumber);
                    if (node.Value != "-")
                    {
                        if (node.Value.StartsWith('@'))
                        {
                            if (!IdPattern(node.Value[1..]))
                                return Fail(out refusal, "surface-schema", $"{node.Window}/{node.Id}",
                                    $"slot '{node.Value}'", lineNumber);
                        }
                        else if (Encoding.UTF8.GetByteCount(node.Value) > 256
                                 || node.Value.Any(c => c is '\t' or '\n' or '\r'))
                        {
                            return Fail(out refusal, "surface-schema", $"{node.Window}/{node.Id}",
                                "literal exceeds 256 bytes or contains a control", lineNumber);
                        }
                    }
                    if (nodes.Count >= MaxBytesPerWindow)
                        return Fail(out refusal, "node-count", node.Window,
                            $"{MaxBytesPerWindow + 1} nodes", lineNumber);

                    nodes[node.Id] = depth;
                    document.Nodes.Add(node);
                    break;
                }
                case "action":
                {
                    if (columns.Length != 5)
                    {
                        refusal = new Refusal("surface-schema", source,
                            $"line {lineNumber}: action row has {columns.Length} columns, expected 5",
                            lineNumber);
                        return false;
                    }

                    var action = new Action
                    {
                        Window = columns[1],
                        Verb = columns[2],
                        Tool = columns[3],
                        Target = columns[4],
                        Line = lineNumber,
                    };
                    if (!windowIds.Contains(action.Window))
                        return Fail(out refusal, "surface-schema", $"{action.Window}/{action.Verb}",
                            "action names an undeclared window", lineNumber);
                    if (!IdPattern(action.Verb) || !IdPattern(action.Tool))
                        return Fail(out refusal, "surface-schema", $"{action.Window}/{action.Verb}",
                            "verb or tool is not an id", lineNumber);
                    if (action.Target != "-" && !nodesByWindow[action.Window].ContainsKey(action.Target))
                        return Fail(out refusal, "surface-schema", $"{action.Window}/{action.Verb}",
                            $"target '{action.Target}' is not a row in the window", lineNumber);

                    actionCounts[action.Window]++;
                    if (actionCounts[action.Window] > MaxActions)
                        return Fail(out refusal, "action-count", action.Window,
                            $"{actionCounts[action.Window]} actions", lineNumber);
                    document.Actions.Add(action);
                    break;
                }
                default:
                    refusal = new Refusal("surface-schema", source,
                        $"line {lineNumber}: unknown row '{columns[0]}'", lineNumber);
                    return false;
            }

            index++;
        }

        if (document.Windows.Count == 0)
        {
            refusal = new Refusal("surface-schema", source,
                "surface declares no windows", 1);
            return false;
        }

        return true;
    }

    private static bool Fail(out Refusal refusal, string code, string subject, string why, int line)
    {
        refusal = new Refusal(code, subject, why, line);
        return false;
    }

    private static bool ReadField(List<string> lines, ref int index, string key,
        out string value, out Refusal refusal)
    {
        refusal = null!;
        value = "";
        if (index >= lines.Count)
        {
            refusal = new Refusal("surface-schema", key,
                $"line {index + 1}: document ends before '{key}'", index + 1);
            return false;
        }
        var columns = lines[index].Split('\t');
        if (columns.Length != 2 || columns[0] != key)
        {
            refusal = new Refusal("surface-schema", key,
                $"line {index + 1}: expected {key}<TAB>value", index + 1);
            return false;
        }
        value = columns[1];
        index++;
        return true;
    }

    private static bool TryInt(string text, out int value) =>
        int.TryParse(text, System.Globalization.NumberStyles.None,
            System.Globalization.CultureInfo.InvariantCulture, out value) && value >= 0;

    private static bool ParseBool(string text, out bool value)
    {
        value = text == "true";
        return text is "true" or "false";
    }

    private static bool Tokens(string text, string[] allowed)
    {
        if (text == "none")
            return true;
        var parts = text.Split(',', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length > 0
            && parts.Distinct(StringComparer.Ordinal).Count() == parts.Length
            && parts.All(part => allowed.Contains(part, StringComparer.Ordinal));
    }

    private static bool TitleText(string text) =>
        text.Length > 0
        && Encoding.UTF8.GetByteCount(text) <= 64
        && !text.Any(c => c is '\t' or '\n' or '\r');

    private static bool IdPattern(string text) =>
        text.Length is > 0 and <= 64
        && text.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c == '-');
}

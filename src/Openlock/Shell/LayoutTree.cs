using System.Text;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace Openlock.Shell;

/// <summary>
/// Turns a package's Panorama XML and CSS into the node tree the shell builds with
/// <c>$.CreatePanel</c>. This is the live path: the server can send the tree in the addon
/// payload, so a window does not need a VPK mounted in the game's resource paths.
///
/// <para>
/// Only the layout subset a shell window owns is accepted: the root's children, minus
/// <c>&lt;styles&gt;</c> and <c>&lt;scripts&gt;</c>. Class rules from the package's included
/// stylesheets are merged onto each node in source order, then an inline <c>style</c>
/// attribute, which is the same cascade order Panorama uses. The client applies the resulting
/// properties directly; it does not evaluate selectors, load a stylesheet or trust a script.
/// </para>
/// </summary>
public static class LayoutTree
{
    private const int MaxNodes = 512;
    private const int MaxDepth = 24;
    private const int MaxText = 4096;
    private const int MaxXmlBytes = 256 * 1024;
    private const int MaxCssBytes = 128 * 1024;

    private static readonly Regex CssBlock = new(
        @"(?<selector>[^{}]+)\{(?<body>[^{}]*)\}",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly HashSet<string> Tags = new(StringComparer.Ordinal)
    {
        "Panel", "Label", "Button", "Image", "TextEntry", "ProgressBar", "Slider", "DropDown",
    };

    private static readonly HashSet<string> Attributes = new(StringComparer.Ordinal)
    {
        "src", "tooltip_text", "placeholder", "enabled", "visible", "selected", "value",
        "maxchars", "multiline", "html",
    };

    // Layout properties a live package may set. Anything that could load a resource, run a
    // transition from an arbitrary URL or cover the shell itself is deliberately absent.
    private static readonly HashSet<string> StyleNames = new(StringComparer.Ordinal)
    {
        "width", "height", "min-width", "min-height", "max-width", "max-height",
        "padding", "padding-left", "padding-right", "padding-top", "padding-bottom",
        "margin", "margin-left", "margin-right", "margin-top", "margin-bottom",
        "background-color", "color", "font-size", "font-weight", "font-family",
        "letter-spacing", "text-transform", "text-align", "line-height",
        "flow-children", "horizontal-align", "vertical-align", "opacity", "visibility",
        "white-space", "border", "border-radius", "border-color", "border-width",
        "align", "wash-color", "brightness",
    };

    public sealed class Node
    {
        [JsonPropertyName("tag")]
        public string Tag { get; set; } = "Panel";

        [JsonPropertyName("id")]
        public string Id { get; set; } = "";

        [JsonPropertyName("class")]
        public string Class { get; set; } = "";

        [JsonPropertyName("text")]
        public string Text { get; set; } = "";

        [JsonPropertyName("attrs")]
        public Dictionary<string, string> Attrs { get; set; } = [];

        [JsonPropertyName("styles")]
        public Dictionary<string, string> Styles { get; set; } = [];

        [JsonPropertyName("children")]
        public List<Node> Children { get; set; } = [];
    }

    /// <summary>
    /// Reads a window's source XML and its included CSS. A package that carries only compiled
    /// <c>.vxml_c</c> resources has no live tree; the caller keeps the mounted-path behaviour.
    /// </summary>
    public static List<Node>? Read(
        ShpPackage package,
        ShpPackage.Window window,
        string localId,
        IReadOnlyCollection<string>? archiveEntries,
        string? archivePath,
        out string why)
    {
        why = "";
        foreach (var name in new[] { localId, window.RecordId })
        {
            if (string.IsNullOrWhiteSpace(name))
                continue;

            var xml = ReadResource(package, archiveEntries, archivePath,
                $"panorama/layout/{name}.xml", $"layout/{name}.xml");
            if (xml is null)
                continue;

            var text = Encoding.UTF8.GetString(xml);
            var css = ReadCss(package, archiveEntries, archivePath, text);
            var tree = Parse(text, css, out why);
            if (tree.Count > 0)
                return tree;
        }

        return null;
    }

    /// <summary>Parses one layout source. Exposed for the package proof and focused checks.</summary>
    public static List<Node> Parse(string xml, string css, out string why)
    {
        why = "";
        if (Encoding.UTF8.GetByteCount(xml) > MaxXmlBytes)
        {
            why = "layout XML is larger than the live ceiling";
            return [];
        }

        XDocument document;
        try
        {
            document = XDocument.Parse(xml, LoadOptions.None);
        }
        catch (Exception exception)
        {
            why = "layout XML did not parse: " + exception.Message;
            return [];
        }

        var classes = ParseCss(css);
        var nodes = new List<Node>();
        var count = 0;
        foreach (var element in document.Root?.Elements() ?? [])
        {
            if (element.Name.LocalName is "styles" or "scripts")
                continue;

            if (element.Name.LocalName is "include")
                continue;

            var node = Build(element, classes, 0, ref count);
            if (node is not null)
                nodes.Add(node);
        }

        if (nodes.Count == 0)
            why = "layout XML declared no drawable nodes";
        return nodes;
    }

    private static Node? Build(XElement element, Dictionary<string, Dictionary<string, string>> classes,
        int depth, ref int count)
    {
        if (depth > MaxDepth || count >= MaxNodes)
            return null;

        count++;
        var tag = Tags.Contains(element.Name.LocalName) ? element.Name.LocalName : "Panel";
        var node = new Node
        {
            Tag = tag,
            Id = Attribute(element, "id"),
            Class = Attribute(element, "class"),
            Text = Attribute(element, "text"),
        };

        if (node.Text.Length > MaxText)
            node.Text = node.Text[..MaxText];

        foreach (var attribute in element.Attributes())
        {
            if (Attributes.Contains(attribute.Name.LocalName))
                node.Attrs[attribute.Name.LocalName] = attribute.Value;
        }

        foreach (var name in node.Class.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (!classes.TryGetValue(name, out var rule))
                continue;
            foreach (var (key, value) in rule)
                node.Styles[key] = value;
        }

        MergeInlineStyles(Attribute(element, "style"), node.Styles);

        foreach (var child in element.Elements())
        {
            if (child.Name.LocalName is "styles" or "scripts" or "include")
                continue;

            var built = Build(child, classes, depth + 1, ref count);
            if (built is not null)
                node.Children.Add(built);
        }

        return node;
    }

    private static string Attribute(XElement element, string name) =>
        element.Attribute(name)?.Value ?? "";

    private static string ReadCss(ShpPackage package, IReadOnlyCollection<string>? archiveEntries,
        string? archivePath, string xml)
    {
        if (!xml.Contains("<styles", StringComparison.Ordinal))
            return "";

        var styles = new List<string>();
        var total = 0;
        foreach (var include in xml.Split("<include", StringSplitOptions.RemoveEmptyEntries).Skip(1))
        {
            var marker = "src=\"";
            var at = include.IndexOf(marker, StringComparison.Ordinal);
            if (at < 0)
                continue;

            at += marker.Length;
            var end = include.IndexOf('"', at);
            if (end < 0)
                continue;

            var src = include[at..end];
            var resource = src.StartsWith("file://{resources}/", StringComparison.OrdinalIgnoreCase)
                ? src["file://{resources}/".Length..]
                : src;
            if (!resource.EndsWith(".css", StringComparison.OrdinalIgnoreCase))
                continue;

            var bytes = ReadResource(package, archiveEntries, archivePath,
                $"panorama/{resource}", resource);
            if (bytes is null)
                continue;

            if (total + bytes.Length > MaxCssBytes)
                break;

            total += bytes.Length;
            styles.Add(Encoding.UTF8.GetString(bytes));
        }

        return string.Join("\n", styles);
    }

    private static byte[]? ReadResource(ShpPackage package, IReadOnlyCollection<string>? archiveEntries,
        string? archivePath, params string[] candidates)
    {
        foreach (var path in candidates)
        {
            if (package.Artifacts.TryGetValue(path, out var artifact))
                return artifact;

            if (archiveEntries is null || archivePath is null)
                continue;

            if (!archiveEntries.Any(entry => string.Equals(entry, path, StringComparison.OrdinalIgnoreCase)))
                continue;

            var bytes = VpkReader.ReadEntry(archivePath, path);
            if (bytes is not null)
                return bytes;
        }

        return null;
    }

    private static Dictionary<string, Dictionary<string, string>> ParseCss(string css)
    {
        var classes = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);
        if (string.IsNullOrWhiteSpace(css))
            return classes;

        foreach (Match block in CssBlock.Matches(css))
        {
            var selectors = block.Groups["selector"].Value.Trim();
            var body = block.Groups["body"].Value;

            var names = new List<string>();
            var simple = true;
            foreach (var selector in selectors.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
            {
                if (!selector.StartsWith('.') || selector.Length < 2
                    || selector.Contains(' ') || selector.Contains(':') || selector.Contains('>'))
                {
                    simple = false;
                    break;
                }

                names.Add(selector[1..]);
            }

            if (!simple || names.Count == 0)
                continue;

            var rule = ParseDeclarations(body);
            if (rule.Count == 0)
                continue;

            foreach (var name in names)
            {
                if (!classes.TryGetValue(name, out var existing))
                    classes[name] = existing = new Dictionary<string, string>(StringComparer.Ordinal);

                foreach (var (key, value) in rule)
                    existing[key] = value;
            }
        }

        return classes;
    }

    private static Dictionary<string, string> ParseDeclarations(string body)
    {
        var rule = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var declaration in body.Split(';', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            var colon = declaration.IndexOf(':');
            if (colon <= 0)
                continue;

            var name = declaration[..colon].Trim().ToLowerInvariant();
            var value = declaration[(colon + 1)..].Trim();
            if (!StyleNames.Contains(name) || value.Length == 0)
                continue;

            if (value.Contains("url(", StringComparison.OrdinalIgnoreCase)
                || value.Contains('{') || value.Contains('}'))
                continue;

            if (name is "padding" or "margin")
            {
                // Panorama's style object takes the four edges, not the CSS box shorthand.
                var parts = value.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                var edges = parts.Length switch
                {
                    1 => new[] { parts[0], parts[0], parts[0], parts[0] },
                    2 => new[] { parts[0], parts[1], parts[0], parts[1] },
                    3 => new[] { parts[0], parts[1], parts[2], parts[1] },
                    4 => new[] { parts[0], parts[1], parts[2], parts[3] },
                    _ => [],
                };
                if (edges.Length == 4)
                {
                    rule[$"{name}-top"] = edges[0];
                    rule[$"{name}-right"] = edges[1];
                    rule[$"{name}-bottom"] = edges[2];
                    rule[$"{name}-left"] = edges[3];
                }

                continue;
            }

            rule[name] = value;
        }

        return rule;
    }

    private static void MergeInlineStyles(string inline, Dictionary<string, string> styles)
    {
        if (string.IsNullOrWhiteSpace(inline))
            return;

        foreach (var (key, value) in ParseDeclarations(inline))
            styles[key] = value;
    }
}

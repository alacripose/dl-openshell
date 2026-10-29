namespace Openlock.Shell;

/// <summary>
/// The single owner of reading a shploingus display package: the <c>shploingus.recipe/3</c>
/// <c>package.shspec</c>, its <c>package.cells</c> declaration, and the <c>frames/*.frame</c> records.
///
/// <para>
/// Nothing here mounts or draws. Every record that the host cannot represent is turned into a
/// <see cref="Refusal"/> carrying the file and the line it was written on, so the mount can print it
/// as a refusal rather than flattening it into something plausible.
/// </para>
/// </summary>
public sealed class ShellPackage
{
    public sealed class Window
    {
        public string Id = "";
        public string Title = "";
        public string Content = "";
        public int ContentLine;
        public string Lane = "";
        public int X, Y, Width, Height;
        public int Opacity = 930;
        public string ThemeRole = "surface";
        public bool Pinnable;
        public string RecordId = "";
        public string Extent = "";
        public string Behavior = "";
        public string LayoutFlags = "";
        public int MinWidth, MinHeight;
        public int Elevation = 1;
        public int Line;
        public int BehaviorLine;
        public List<(string Label, string Command)> Controls = [];
    }

    public sealed record Refusal(string File, int Line, string Subject, string Why);

    public string Format { get; private set; } = "";
    public string Name { get; private set; } = "";
    public string Version { get; private set; } = "";

    public List<Window> Windows { get; } = [];
    public List<string> Tabs { get; } = [];
    public string? Bar { get; private set; }
    public List<(string Window, string Tab)> Filed { get; } = [];
    public List<string> Pins { get; } = [];
    public List<Refusal> Refusals { get; } = [];

    public string CellsFormat { get; private set; } = "";
    public int CellsVersion { get; private set; } = -1;

    public Window? WindowById(string id) =>
        Windows.FirstOrDefault(w => string.Equals(w.Id, id, StringComparison.OrdinalIgnoreCase));

    public static ShellPackage Load(string root)
    {
        var package = new ShellPackage();
        package.ReadRecipe(Path.Combine(root, "package.shspec"));
        package.ReadCells(Path.Combine(root, "package.cells"));
        package.ReadFrames(Path.Combine(root, "frames"));
        package.ReadDeadlockWindows(Path.Combine(root, "deadlock.windows"));
        return package;
    }

    private void ReadRecipe(string path)
    {
        if (!File.Exists(path))
        {
            Refusals.Add(new Refusal(path, 1, "package.shspec", "file is missing"));
            return;
        }

        ReadRecipeText(path, File.ReadAllText(path), resolveContent: true);
    }

    /// <summary>
    /// Reads a recipe that arrives as bytes rather than as a folder (a package inside a VPK).
    /// Content ids are not resolved here: the addon loader validates the layout path it is
    /// actually allowed to mount, and a content table for shell views would be a second answer.
    /// </summary>
    public static ShellPackage ParseRecipe(string file, string text)
    {
        var package = new ShellPackage();
        package.ReadRecipeText(file, text, resolveContent: false);
        return package;
    }

    private void ReadRecipeText(string path, string text, bool resolveContent)
    {
        var lines = text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        if (lines.Length == 0 || !lines[0].StartsWith("shploingus.recipe/", StringComparison.Ordinal))
        {
            Refusals.Add(new Refusal(path, 1, lines.FirstOrDefault() ?? "<empty>", "unknown recipe header"));
            return;
        }

        Format = lines[0];
        Window? current = null;

        for (var i = 1; i < lines.Length; i++)
        {
            var raw = lines[i];
            var line = i + 1;
            if (raw.Length == 0 || raw.TrimStart().StartsWith('#'))
                continue;

            if (raw.StartsWith('\t'))
            {
                if (current is not null)
                    ApplyWindowField(current, raw.TrimStart('\t').Split('\t'), line);
                continue;
            }

            var parts = raw.Split('\t');
            switch (parts[0])
            {
                case "package":
                    Name = parts.Length > 1 ? parts[1] : "";
                    Version = parts.Length > 2 ? parts[2] : "";
                    break;

                case "window":
                    current = new Window
                    {
                        Id = parts.Length > 1 ? parts[1] : $"window-{line}",
                        Line = line,
                    };
                    Windows.Add(current);
                    break;

                case "tab":
                    if (parts.Length > 1)
                        Tabs.Add(parts[1]);
                    break;

                case "bar":
                    if (parts.Length > 1)
                        Bar = parts[1];
                    break;

                case "filed":
                    if (parts.Length > 2)
                        Filed.Add((parts[1], parts[2]));
                    break;

                case "pin":
                    if (parts.Length > 1)
                        Pins.Add(parts[1]);
                    break;

                case "row":
                    // A row names a cell data frame; frames are refused in ReadFrames with their file
                    // and line, so the row itself carries no mountable content here.
                    break;
            }
        }

        // A declared window's behavior is delivered by the client's window manager: the title bar
        // moves it, the corner grip resizes it, and the buttons minimize, maximize and close it.
        // Nothing in `behavior` is refused, so this list holds only records the client genuinely
        // cannot draw.

        // Content is resolved by one owner. A content id with no mounted source is a refusal on
        // the line that declared it, not a label that pretends the window has content.
        if (resolveContent)
        {
            foreach (var (window, line, content, why) in ShellContent.Refusals(this))
                Refusals.Add(new Refusal(path, line, window, $"content '{content}': {why}"));
        }
    }

    private static void ApplyWindowField(Window window, string[] fields, int line)
    {
        if (fields.Length < 2)
            return;

        var value = fields[1];
        switch (fields[0])
        {
            case "title": window.Title = value; break;
            case "content": window.Content = value; window.ContentLine = line; break;
            case "lane": window.Lane = value; break;
            case "behavior": window.Behavior = value; window.BehaviorLine = line; break;
            case "layout": window.LayoutFlags = value; break;
            case "extent": window.Extent = value; break;
            case "elevation":
                if (int.TryParse(value, out var elevation))
                    window.Elevation = elevation;
                break;
            case "min-size":
                var min = value.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (min.Length == 2 && int.TryParse(min[0], out var minW) && int.TryParse(min[1], out var minH))
                {
                    window.MinWidth = minW;
                    window.MinHeight = minH;
                }

                break;
            case "geometry":
                var numbers = value.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (numbers.Length == 4 && int.TryParse(numbers[0], out var x) && int.TryParse(numbers[1], out var y)
                    && int.TryParse(numbers[2], out var w) && int.TryParse(numbers[3], out var h))
                {
                    window.X = x;
                    window.Y = y;
                    window.Width = w;
                    window.Height = h;
                }

                break;
            case "opacity":
                if (int.TryParse(value, out var opacity))
                    window.Opacity = opacity;
                break;
            case "theme-role": window.ThemeRole = value; break;
            case "pinnable": window.Pinnable = value.Equals("true", StringComparison.OrdinalIgnoreCase); break;
            case "record-id": window.RecordId = value; break;
            case "control":
                if (fields.Length >= 3 && fields[1].Trim().Length > 0 && fields[2].Trim().Length > 0)
                    window.Controls.Add((fields[1].Trim(), fields[2].Trim()));
                break;
        }
    }

    /// <summary>
    /// One window per real game layout the catalog names. The content is the layout path itself, so
    /// the resolver mounts the game's own panel; a layout that fails to load is refused by the
    /// client at that window's line.
    /// </summary>
    private void ReadDeadlockWindows(string path)
    {
        if (!File.Exists(path))
        {
            Refusals.Add(new Refusal(path, 1, "deadlock.windows", "catalog is missing; no game window is reachable"));
            return;
        }

        var lines = File.ReadAllLines(path);
        if (lines.FirstOrDefault() != "shploingus.deadlock/1")
        {
            Refusals.Add(new Refusal(path, 1, lines.FirstOrDefault() ?? "<empty>", "unknown deadlock window header"));
            return;
        }

        var position = 0;
        for (var i = 1; i < lines.Length; i++)
        {
            var raw = lines[i];
            if (raw.Length == 0 || raw[0] == '#' || !raw.StartsWith("window\t", StringComparison.Ordinal))
                continue;

            var fields = raw.Split('\t');
            if (fields.Length < 4)
                continue;

            var slot = position++ % 10;
            Windows.Add(new Window
            {
                Id = fields[1],
                Title = fields[2],
                Content = fields[3],
                ContentLine = i + 1,
                Line = i + 1,
                Lane = "game",
                X = 16 + slot * 48,
                Y = 48 + slot * 32,
                Width = 480,
                Height = 440,
                MinWidth = 240,
                MinHeight = 192,
                Opacity = 930,
                ThemeRole = "surface",
                Behavior = "close",
            });
        }
    }

    private void ReadCells(string path)
    {
        if (!File.Exists(path))
        {
            Refusals.Add(new Refusal(path, 1, "package.cells", "file is missing"));
            return;
        }

        var lines = File.ReadAllLines(path);
        CellsFormat = lines.FirstOrDefault() ?? "";

        if (CellsFormat != "shploingus.cells/1")
        {
            Refusals.Add(new Refusal(path, 1, CellsFormat, "unknown cells header"));
            return;
        }

        for (var i = 1; i < lines.Length; i++)
        {
            var parts = lines[i].Split('\t');
            if (parts.Length >= 2 && parts[0] == "cells" && int.TryParse(parts[1], out var version))
            {
                CellsVersion = version;
                Refusals.Add(new Refusal(
                    path,
                    i + 1,
                    $"cells {version}",
                    "the host draws composed panels only; a cell raster, its layers and frames cannot be mounted here"));
                return;
            }
        }
    }

    private void ReadFrames(string directory)
    {
        if (!Directory.Exists(directory))
            return;

        foreach (var file in Directory.GetFiles(directory, "*.frame").OrderBy(f => f, StringComparer.Ordinal))
        {
            var lines = File.ReadAllLines(file);
            var header = lines.FirstOrDefault() ?? "";
            if (header != "shploingus.cellframe/1")
            {
                Refusals.Add(new Refusal(file, 1, header, "unknown cellframe header"));
                continue;
            }

            var id = "";
            var line = 2;
            var why = "cell data frame: fields, shapers and projections cannot be drawn as a Deadworks panel";

            for (var i = 1; i < lines.Length; i++)
            {
                var raw = lines[i];
                var parts = raw.TrimStart('\t').Split('\t');
                if (parts.Length >= 2 && parts[0] == "frame" && id.Length == 0)
                {
                    id = parts[1];
                    line = i + 1;
                }

                if (parts.Length >= 2 && parts[0] == "shaper")
                {
                    why = $"cell data frame: shaper '{parts[1]}' and its projection cannot be drawn as a Deadworks panel";
                    line = i + 1;
                    break;
                }
            }

            Refusals.Add(new Refusal(file, line, string.IsNullOrEmpty(id) ? Path.GetFileName(file) : id, why));
        }
    }
}

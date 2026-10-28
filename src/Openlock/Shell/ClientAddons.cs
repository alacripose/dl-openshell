namespace Openlock.Shell;

/// <summary>
/// Finds the client half of the shell the way the game itself would: through the
/// <c>SearchPaths</c> block in <c>game/citadel/gameinfo.gi</c>, plus any directories the user
/// names in <c>ClientAddonPaths</c>. Grimoire is not consulted and not required.
///
/// <para>
/// A path is accepted only when it exists and carries the expected layout
/// (<c>panorama/layout/openlock_shell</c> for the shell, <c>openlock_hud</c> for the ability HUD).
/// A listed path that is missing, or present without that layout, is reported by path — there is no
/// fallback to a guessed directory.
/// </para>
/// </summary>
public sealed class ClientAddons
{
    public sealed record Candidate(string Path, string Source, bool Exists, bool HasShell, bool HasHud)
    {
        public string Report =>
            $"{Path}  [{Source}]  exists={Exists} shell={HasShell} hud={HasHud}";
    }

    private readonly List<Candidate> _candidates = [];

    public IReadOnlyList<Candidate> Candidates => _candidates;
    public bool ShellInstalled => _candidates.Any(c => c.HasShell);
    public bool HudInstalled => _candidates.Any(c => c.HasHud);
    public IReadOnlyList<string> ReportLines => _candidates.Select(c => c.Report).ToArray();

    public static ClientAddons Resolve(OpenlockConfig config)
    {
        var addons = new ClientAddons();
        var gameDir = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", ".."));
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // A user-named path wins over discovery: if it names a directory, that directory is
        // checked, and a bad entry is refused instead of being skipped silently.
        foreach (var raw in config.ClientAddonPaths ?? [])
        {
            var path = ResolvePath(gameDir, raw);
            if (path is null)
            {
                Log.Write($"[Openlock] addon REFUSED path '{raw}': not an absolute path and no game directory to resolve it against");
                continue;
            }

            if (!seen.Add(path))
                continue;

            addons.Add(path, "config");
        }

        foreach (var (path, source) in GameSearchPaths(gameDir))
        {
            if (!seen.Add(path))
                continue;

            addons.Add(path, source);
        }

        return addons;
    }

    private void Add(string path, string source)
    {
        var exists = Directory.Exists(path);
        var shell = exists && HasLayout(path, "openlock_shell");
        var hud = exists && HasLayout(path, "openlock_hud");
        _candidates.Add(new Candidate(path, source, exists, shell, hud));

        if (!exists)
            Log.Write($"[Openlock] addon REFUSED path '{path}' ({source}): directory does not exist");
        else if (!shell && !hud)
            Log.Write($"[Openlock] addon REFUSED path '{path}' ({source}): no panorama/layout/openlock_shell or openlock_hud");
        else
            Log.Write($"[Openlock] addon found at '{path}' ({source}): shell={shell} hud={hud}");
    }

    /// <summary>
    /// Whether a search path carries a layout, loose or packed. The shipped addon is one
    /// <c>pak01_dir.vpk</c> (install-client.ps1 packs it), so a discovery that only walked the
    /// filesystem would refuse the very install it just wrote. The archive's own index is read
    /// instead of guessing from its name.
    /// </summary>
    private static bool HasLayout(string root, string name)
    {
        var layout = Path.Combine(root, "panorama", "layout");
        if (File.Exists(Path.Combine(layout, name + ".xml")) || File.Exists(Path.Combine(layout, name + ".vxml_c")))
            return true;

        // Only the directory archive indexes files; the numbered shards beside it hold data.
        foreach (var archive in Directory.EnumerateFiles(root, "*_dir.vpk", SearchOption.TopDirectoryOnly))
        {
            var index = VpkIndex.Read(archive);
            if (index.Contains($"panorama/layout/{name}.xml") || index.Contains($"panorama/layout/{name}.vxml_c"))
                return true;
        }

        return false;
    }

    private static string? ResolvePath(string gameDir, string raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
            return null;

        var value = raw.Trim();
        return Path.IsPathRooted(value) ? Path.GetFullPath(value) : Path.GetFullPath(Path.Combine(gameDir, value));
    }

    /// <summary>Reads the game's own <c>Game</c>/<c>addonroot</c> search paths from gameinfo.gi.</summary>
    private static IEnumerable<(string Path, string Source)> GameSearchPaths(string gameDir)
    {
        var gameinfo = Path.Combine(gameDir, "citadel", "gameinfo.gi");
        if (!File.Exists(gameinfo))
        {
            Log.Write($"[Openlock] addon discovery REFUSED: no gameinfo.gi at '{gameinfo}'");
            yield break;
        }

        var inSearchPaths = false;
        var depth = 0;
        foreach (var raw in File.ReadLines(gameinfo))
        {
            var line = StripComment(raw).Trim();
            if (line.Length == 0)
                continue;

            if (line.StartsWith("SearchPaths", StringComparison.OrdinalIgnoreCase))
            {
                inSearchPaths = true;
                depth = line.Count(c => c == '{') - line.Count(c => c == '}');
                continue;
            }

            if (!inSearchPaths)
                continue;

            depth += line.Count(c => c == '{') - line.Count(c => c == '}');
            if (depth <= 0)
            {
                inSearchPaths = false;
                continue;
            }

            var parts = line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2)
                continue;

            if (!parts[0].Equals("Game", StringComparison.OrdinalIgnoreCase)
                && !parts[0].Equals("addonroot", StringComparison.OrdinalIgnoreCase))
                continue;

            var relative = parts[1].Replace('/', '\\');
            yield return (Path.GetFullPath(Path.Combine(gameDir, relative)), $"gameinfo:{parts[0]}");
        }
    }

    private static string StripComment(string line)
    {
        var slash = line.IndexOf("//", StringComparison.Ordinal);
        return slash >= 0 ? line[..slash] : line;
    }

    /// <summary>
    /// The file list of a VPK directory archive. Only names are needed: a search path that carries
    /// the layout is a candidate whether the file is loose or packed, and the archive is written by
    /// the same tool the install script uses.
    /// </summary>
    private static class VpkIndex
    {
        private static readonly Dictionary<string, (DateTime Stamp, HashSet<string> Names)> Cache = [];

        public static HashSet<string> Read(string path)
        {
            try
            {
                var stamp = File.GetLastWriteTimeUtc(path);
                if (Cache.TryGetValue(path, out var cached) && cached.Stamp == stamp)
                    return cached.Names;

                var names = Parse(path);
                Cache[path] = (stamp, names);
                return names;
            }
            catch (Exception ex)
            {
                // An archive this reader cannot index is simply not a candidate; a search path that
                // carries no readable layout is reported by the path, once, above.
                Log.Write($"[Openlock] addon ignored archive '{path}': unreadable VPK index ({ex.Message})");
                return [];
            }
        }

        private static HashSet<string> Parse(string path)
        {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            using var stream = File.OpenRead(path);
            using var reader = new BinaryReader(stream);

            if (reader.ReadUInt32() != 0x55aa1234)
                throw new InvalidDataException("not a VPK");

            var version = reader.ReadUInt32();
            var treeSize = reader.ReadUInt32();
            if (version == 2)
            {
                reader.ReadUInt32(); // file data section size
                reader.ReadUInt32(); // archive md5 section size
                reader.ReadUInt32(); // other md5 section size
                reader.ReadUInt32(); // signature section size
            }

            var tree = reader.ReadBytes((int)treeSize);
            var pos = 0;

            while (pos < tree.Length)
            {
                var ext = ReadString(tree, ref pos);
                if (ext.Length == 0)
                    break;

                while (true)
                {
                    var dir = ReadString(tree, ref pos);
                    if (dir.Length == 0)
                        break;

                    while (true)
                    {
                        var name = ReadString(tree, ref pos);
                        if (name.Length == 0)
                            break;

                        pos += 18; // crc, preload, archive index, offset, length, terminator
                        names.Add($"{dir.TrimEnd('/')}/{name}.{ext}");
                    }
                }
            }

            return names;
        }

        private static string ReadString(byte[] tree, ref int pos)
        {
            var end = Array.IndexOf(tree, (byte)0, pos);
            if (end < 0)
                end = tree.Length;

            var value = System.Text.Encoding.UTF8.GetString(tree, pos, end - pos);
            pos = end + 1;
            return value;
        }
    }
}

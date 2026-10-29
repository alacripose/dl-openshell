using System.Text.Json;
using System.Text.RegularExpressions;

namespace Openlock.Shell;

/// <summary>
/// Discovers real shploingus packages and hands their windows to the shell.
///
/// <para>
/// A package is a <c>SHPKG002</c>/<c>SHPKG003</c> frame: the frame's payload is the exact
/// <c>shploingus.recipe/3</c> source and its SHA-256 is checked before a byte of it is read.
/// The loader looks for those frames as <c>.shpkg</c> files, and for <c>.shpkg</c> entries
/// inside a VPK. It never parses a raw <c>package.shspec</c> out of an archive and it never
/// invents a manifest path: the frame is the package.
/// </para>
///
/// <para>
/// A package that refuses any part of its recipe contributes no window. The refusal is kept
/// with the package and printed by the mount; a partial recipe would be a second, more
/// plausible package than the one the build actually produced.
/// </para>
/// </summary>
public sealed class AddonPackages
{
    public const string PayloadFormat = "openlock.addons/2";
    public const string PackageExtension = ".shpkg";

    private const int MaxPackages = 64;
    private const long MaxPackageBytes = 16 * 1024 * 1024;

    private static readonly Regex NumberedShard = new(
        @"_\d{3}\.vpk$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public sealed class PackageRecord
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public string Version { get; set; } = "";
        public string Archive { get; set; } = "";
        public string Source { get; set; } = "";
        public string Digest { get; set; } = "";
        public List<string> Artifacts { get; set; } = [];
        public List<string> WindowIds { get; set; } = [];
        public List<ShpPackage.Refusal> Refusals { get; set; } = [];
    }

    private readonly List<PackageRecord> _packages = [];
    private readonly List<ShpPackage.Window> _windows = [];
    private readonly Dictionary<string, ShpPackage.Window> _byId = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, string> _seenIds = new(StringComparer.OrdinalIgnoreCase);

    public IReadOnlyList<PackageRecord> Packages => _packages;
    public IReadOnlyList<ShpPackage.Window> Windows => _windows;
    public int RefusalCount => _packages.Sum(package => package.Refusals.Count);

    public ShpPackage.Window? WindowById(string id) => _byId.GetValueOrDefault(id);

    public static AddonPackages Discover(OpenlockConfig config)
    {
        var result = new AddonPackages();
        var gameDir = ClientAddons.GameDirectory;
        var roots = new List<(string Path, string Source)>();
        var seenRoots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var raw in config.ClientAddonPaths ?? [])
        {
            var resolved = ClientAddons.ResolvePath(gameDir, raw);
            if (resolved is not null && seenRoots.Add(resolved))
                roots.Add((resolved, "config"));
        }

        foreach (var (path, source) in ClientAddons.GameSearchPaths(gameDir))
        {
            if (seenRoots.Add(path))
                roots.Add((path, source));
        }

        foreach (var (path, source) in new[]
                 {
                     (Path.Combine(gameDir, "citadel", "deadworks_addons", "vpks"), "deadworks addons"),
                     (Path.Combine(gameDir, "citadel", "deadworks_mods"), "deadworks mods"),
                     (Path.Combine(gameDir, "citadel", "addons", "mods"), "openlock mods"),
                     (Path.Combine(gameDir, "citadel", "addons"), "game addons"),
                 })
        {
            if (seenRoots.Add(path))
                roots.Add((path, source));
        }

        var seenArchives = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var (root, source) in roots)
        {
            if (!Directory.Exists(root))
                continue;

            foreach (var file in Enumerate(root, "*.shpkg"))
            {
                var full = Path.GetFullPath(file);
                if (!seenArchives.Add(full))
                    continue;

                var label = DisplayPath(gameDir, full);
                try
                {
                    var info = new FileInfo(full);
                    if (info.Length > MaxPackageBytes)
                    {
                        result.Refuse(label, source, $"package is {info.Length} bytes; the ceiling is {MaxPackageBytes}");
                        continue;
                    }

                    var package = ShpPackage.LoadFile(full);
                    result.Add(package, label, source, result._seenIds, null, full);
                }
                catch (Exception exception) when (exception is IOException
                    or UnauthorizedAccessException
                    or ArgumentException)
                {
                    result.Refuse(label, source, exception.Message);
                }
            }

            foreach (var archive in Enumerate(root, "*.vpk"))
            {
                if (NumberedShard.IsMatch(Path.GetFileName(archive)))
                    continue;

                var full = Path.GetFullPath(archive);
                if (!seenArchives.Add(full))
                    continue;

                var label = DisplayPath(gameDir, full);
                if (!VpkReader.TryEntries(full, out var entries, out var error))
                {
                    if (LooksLikePackageArchive(full))
                        result.Refuse(label, source, $"VPK index is unreadable: {error}");
                    continue;
                }

                var archiveEntries = new HashSet<string>(entries, StringComparer.OrdinalIgnoreCase);
                foreach (var entry in entries.Where(name => name.EndsWith(PackageExtension, StringComparison.OrdinalIgnoreCase)))
                {
                    var bytes = VpkReader.ReadEntry(full, entry);
                    if (bytes is null)
                    {
                        result.Refuse($"{label}!/{entry}", source, "VPK entry could not be read");
                        continue;
                    }
                    if (bytes.Length > MaxPackageBytes)
                    {
                        result.Refuse($"{label}!/{entry}", source,
                            $"package is {bytes.Length} bytes; the ceiling is {MaxPackageBytes}");
                        continue;
                    }

                    var package = ShpPackage.Parse(bytes, $"{label}!/{entry}");
                    result.Add(package, $"{label}!/{entry}", source, result._seenIds, archiveEntries, full);
                }
            }
        }

        return result;
    }

    /// <summary>
    /// Loads one package after discovery and adds its windows to the live payload. This is the
    /// server-side half of the live bridge: a .shpkg or a VPK carrying one can be handed over
    /// while clients are connected, and the next payload sends its verified recipe and DOM tree
    /// without writing anything into the game's mounted resource paths.
    /// </summary>
    public int Deliver(string path, out string why)
    {
        why = "";
        if (string.IsNullOrWhiteSpace(path))
        {
            why = "no package path was given";
            return 0;
        }

        string full;
        try { full = Path.GetFullPath(path); }
        catch (Exception exception) { why = exception.Message; return 0; }

        if (!File.Exists(full))
        {
            why = $"'{path}' does not exist";
            return 0;
        }

        if (_packages.Count >= MaxPackages)
        {
            why = $"the live package ceiling is {MaxPackages}";
            return 0;
        }

        var before = _windows.Count;
        try
        {
            if (Path.GetExtension(full).Equals(PackageExtension, StringComparison.OrdinalIgnoreCase))
            {
                var info = new FileInfo(full);
                if (info.Length > MaxPackageBytes)
                {
                    why = $"package is {info.Length} bytes; the ceiling is {MaxPackageBytes}";
                    return 0;
                }

                Add(ShpPackage.LoadFile(full), full, "live", _seenIds, null, full);
            }
            else if (Path.GetExtension(full).Equals(".vpk", StringComparison.OrdinalIgnoreCase))
            {
                if (!VpkReader.TryEntries(full, out var entries, out var error))
                {
                    why = $"VPK index is unreadable: {error}";
                    return 0;
                }

                var archiveEntries = new HashSet<string>(entries, StringComparer.OrdinalIgnoreCase);
                foreach (var entry in entries.Where(name => name.EndsWith(PackageExtension, StringComparison.OrdinalIgnoreCase)))
                {
                    var bytes = VpkReader.ReadEntry(full, entry);
                    if (bytes is null)
                    {
                        why = $"VPK entry '{entry}' could not be read";
                        continue;
                    }

                    if (bytes.Length > MaxPackageBytes)
                    {
                        why = $"package '{entry}' is {bytes.Length} bytes; the ceiling is {MaxPackageBytes}";
                        continue;
                    }

                    Add(ShpPackage.Parse(bytes, $"{full}!/{entry}"), $"{full}!/{entry}", "live", _seenIds, archiveEntries, full);
                }
            }
            else
            {
                why = "live delivery takes a .shpkg or a .vpk carrying one";
                return 0;
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException)
        {
            why = exception.Message;
            return 0;
        }

        var added = _windows.Count - before;
        if (added == 0 && why.Length == 0)
        {
            var refusal = _packages.LastOrDefault()?.Refusals.FirstOrDefault();
            why = refusal is null
                ? "the package declares no windows"
                : $"{refusal.Subject}: {refusal.Why}";
        }

        return added;
    }

    public string PayloadJson() => JsonSerializer.Serialize(
        new
        {
            format = PayloadFormat,
            packages = _packages,
            windows = _windows,
        },
        JsonOptions);

    private void Add(
        ShpPackage package,
        string archive,
        string source,
        Dictionary<string, string> seenIds,
        IReadOnlyCollection<string>? archiveEntries,
        string? archivePath)
    {
        if (_packages.Count >= MaxPackages)
        {
            Refuse(archive, source, $"more than {MaxPackages} packages were found; this archive was not read");
            return;
        }

        var record = new PackageRecord
        {
            Id = package.Name,
            Name = package.Name,
            Version = package.Version,
            Archive = archive,
            Source = source,
            Digest = package.PackageDigest,
            Artifacts = package.Artifacts.Keys.ToList(),
        };

        if (string.IsNullOrWhiteSpace(package.Name) || !IsPackageIdentifier(package.Name))
            record.Refusals.Add(new ShpPackage.Refusal(
                archive, 2, package.Name.Length == 0 ? "<missing>" : package.Name,
                "package name is not a canonical identifier"));
        else if (seenIds.TryGetValue(package.Name, out var previous))
            record.Refusals.Add(new ShpPackage.Refusal(
                archive, 1, package.Name,
                $"package id is already declared by {previous}; the second package is not mounted"));

        record.Refusals.AddRange(package.Refusals);
        if (record.Refusals.Count == 0)
            seenIds[package.Name] = archive;

        if (record.Refusals.Count == 0 && package.Windows.Count == 0)
        {
            // A real shploingus package can be rows only (worldgen, biomes). It is a package,
            // not an addon window package; it contributes no window and is not a refusal.
            _packages.Add(record);
            return;
        }

        if (record.Refusals.Count == 0)
        {
            foreach (var window in package.Windows)
            {
                var localId = window.Id;
                var fullId = $"addon:{package.Name}:{window.Id}";
                if (!_byId.TryAdd(fullId, window))
                {
                    record.Refusals.Add(new ShpPackage.Refusal(
                        archive, 1, fullId, "window id is declared twice"));
                    continue;
                }

                window.Id = fullId;
                window.Addon = package.Name;
                window.AddonName = package.Name;
                window.LayoutPath = LayoutPathFor(window, localId, archiveEntries);
                // The mounted path is still the primary way a package is drawn. A live tree is
                // additive: a package carrying only compiled resources keeps BLoadLayout, and a
                // package pushed after launch draws from this tree instead. A layout that exists
                // but cannot become a tree is a real refusal, and the shell shows refusals in the
                // minimal shell, the log and the toast stack.
                window.LiveTree = LayoutTree.Read(package, window, localId, archiveEntries, archivePath, out var liveWhy);
                if (window.LiveTree is null && !string.IsNullOrEmpty(liveWhy))
                    record.Refusals.Add(new ShpPackage.Refusal(
                        archive, 1, localId, "live layout refused: " + liveWhy));
                record.WindowIds.Add(fullId);
                _windows.Add(window);
            }
        }

        _packages.Add(record);
    }

    /// <summary>
    /// Finds the window's XML as a VPK resource, or as a package artifact. The package format's
    /// artifacts and the VPK are both searched by the same names; a path is returned only when
    /// the bytes are actually there, so the shell never asks Panorama to load a layout that was
    /// not delivered. `panorama/layout/foo.xml` is the archive shape and maps to
    /// `file://{resources}/layout/foo.xml`, which is what BLoadLayout takes.
    /// </summary>
    private static string LayoutPathFor(
        ShpPackage.Window window,
        string localId,
        IReadOnlyCollection<string>? archiveEntries)
    {
        if (archiveEntries is null)
            return "";

        foreach (var name in new[] { localId, window.RecordId })
        {
            if (string.IsNullOrEmpty(name))
                continue;

            foreach (var path in new[]
                     {
                         $"panorama/layout/{name}.xml",
                         $"panorama/layout/{name}.vxml_c",
                         $"layout/{name}.xml",
                         $"layout/{name}.vxml_c",
                     })
            {
                if (!archiveEntries.Any(entry => string.Equals(entry, path, StringComparison.OrdinalIgnoreCase)))
                    continue;

                var resource = path.StartsWith("panorama/", StringComparison.OrdinalIgnoreCase)
                    ? path["panorama/".Length..]
                    : path;
                return $"file://{{resources}}/{resource}";
            }
        }

        return "";
    }

    private void Refuse(string archive, string source, string why)
    {
        if (_packages.Count >= MaxPackages)
            return;

        _packages.Add(new PackageRecord
        {
            Archive = archive,
            Source = source,
            Refusals = [new ShpPackage.Refusal(archive, 1, "package", why)],
        });
    }

    private static IEnumerable<string> Enumerate(string root, string pattern)
    {
        try
        {
            return Directory.EnumerateFiles(root, pattern, SearchOption.AllDirectories).ToArray();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    private static bool IsPackageIdentifier(string text) =>
        text.Length is > 0 and <= 64
        && text.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c == '-');

    private static bool LooksLikePackageArchive(string path)
    {
        var text = path.Replace('\\', '/');
        return text.Contains("openlock_packages/", StringComparison.OrdinalIgnoreCase)
            || text.Contains("addons/mods/", StringComparison.OrdinalIgnoreCase)
            || text.Contains("deadworks_addons/", StringComparison.OrdinalIgnoreCase)
            || Path.GetFileName(path).Contains("openlock", StringComparison.OrdinalIgnoreCase);
    }

    private static string DisplayPath(string gameDir, string path)
    {
        try
        {
            return Path.GetRelativePath(gameDir, path).Replace('\\', '/');
        }
        catch
        {
            return path;
        }
    }
}

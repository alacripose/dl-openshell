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
/// A package that refuses any part of its recipe contributes no window. A later delivery of the
/// same package name replaces the mounted version only after every one of its windows has been
/// staged successfully; a refusal leaves the previous version untouched. The window set is
/// therefore applied all-or-nothing, not a window at a time.
/// </para>
/// </summary>
public sealed class AddonPackages
{
    public const string PayloadFormat = "openlock.addons/2";
    public const string PackageExtension = ".shpkg";

    private const int MaxPackages = 64;
    private const long MaxPackageBytes = 16 * 1024 * 1024;

    // The shell parses an addon payload in one scheduled tick and refuses anything larger than
    // this before JSON.parse. A live delivery that would build an unsendable payload is refused
    // here instead of mounting state the client can never receive.
    private const int MaxPayloadChars = 4 * 1024 * 1024;

    private static readonly Regex NumberedShard = new(
        @"_\d{3}\.vpk$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly Regex VersionSeparator = new(
        @"[^0-9A-Za-z]+",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

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

    public IReadOnlyList<PackageRecord> Packages => _packages;
    public IReadOnlyList<ShpPackage.Window> Windows => _windows;
    public int RefusalCount => _packages.Sum(package => package.Refusals.Count);

    /// <summary>Monotonic payload revision. Every committed addon change increments it.</summary>
    public long Revision { get; private set; }

    /// <summary>
    /// The first window of the package the last successful delivery mounted or replaced. Empty
    /// when that delivery carried no windows. The shell names this window in its notice; the
    /// catalog's last entry can belong to an unrelated package.
    /// </summary>
    public string LastChangedWindow { get; private set; } = "";

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
                    result.Add(package, label, source, null, full, false, out _, out _);
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
                    result.Add(package, $"{label}!/{entry}", source, archiveEntries, full, false, out _, out _);
                }
            }
        }

        return result;
    }

    /// <summary>
    /// Loads one package after discovery and adds or replaces its window set in the live payload.
    /// A v2 package replaces v1 atomically; a refused v2 leaves v1 mounted.
    /// </summary>
    public int Deliver(string path, out string why) => Deliver(path, out why, out _);

    /// <summary>
    /// As <see cref="Deliver(string,out string)"/>, with <paramref name="changed"/> reporting
    /// whether the payload must be republished even when the package carries no windows.
    /// </summary>
    public int Deliver(string path, out string why, out bool changed)
    {
        why = "";
        changed = false;
        LastChangedWindow = "";
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

        var added = 0;
        var lastWhy = "";
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

                added += Add(ShpPackage.LoadFile(full), full, "live", null, full, true,
                    out var oneChanged, out lastWhy);
                changed |= oneChanged;
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
                        lastWhy = $"VPK entry '{entry}' could not be read";
                        continue;
                    }

                    if (bytes.Length > MaxPackageBytes)
                    {
                        lastWhy = $"package '{entry}' is {bytes.Length} bytes; the ceiling is {MaxPackageBytes}";
                        continue;
                    }

                    added += Add(ShpPackage.Parse(bytes, $"{full}!/{entry}"),
                        $"{full}!/{entry}", "live", archiveEntries, full, true,
                        out var oneChanged, out lastWhy);
                    changed |= oneChanged;
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

        if (!changed)
            why = lastWhy.Length > 0
                ? lastWhy
                : "the package declares no windows and no package state changed";

        return added;
    }

    public string PayloadJson() => SerializePayload(Revision, _packages, _windows);

    private static string SerializePayload(
        long revision,
        IReadOnlyList<PackageRecord> packages,
        IReadOnlyList<ShpPackage.Window> windows) =>
        JsonSerializer.Serialize(
            new
            {
                format = PayloadFormat,
                revision,
                packages,
                windows,
            },
            JsonOptions);

    /// <summary>
    /// Builds a complete candidate window set before touching live state. The previous version is
    /// removed only after every candidate window passed, which makes a replacement all-or-nothing.
    /// </summary>
    private int Add(
        ShpPackage package,
        string archive,
        string source,
        IReadOnlyCollection<string>? archiveEntries,
        string? archivePath,
        bool enforcePayloadBudget,
        out bool changed,
        out string why)
    {
        changed = false;
        why = "";

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

        var validName = !string.IsNullOrWhiteSpace(package.Name) && IsPackageIdentifier(package.Name);
        var existing = validName
            ? _packages.FirstOrDefault(item => string.Equals(item.Id, package.Name, StringComparison.OrdinalIgnoreCase))
            : null;

        if (!validName)
        {
            record.Refusals.Add(new ShpPackage.Refusal(
                archive, 2, package.Name.Length == 0 ? "<missing>" : package.Name,
                "package name is not a canonical identifier"));
            changed = CommitRefusal(record);
            why = record.Refusals[0].Why;
            return 0;
        }

        if (_packages.Count >= MaxPackages && existing is null)
        {
            why = $"more than {MaxPackages} packages are mounted; this archive was not read";
            Refuse(archive, source, why);
            return 0;
        }

        if (existing is not null)
        {
            var comparison = CompareVersions(package.Version, existing.Version);
            if (comparison < 0)
            {
                why = $"package '{package.Name}' {package.Version} is older than mounted {existing.Version}";
                return 0;
            }

            if (comparison == 0)
            {
                if (string.Equals(existing.Digest, record.Digest, StringComparison.OrdinalIgnoreCase))
                {
                    why = $"package '{package.Name}' {package.Version} is already mounted";
                    return 0;
                }

                why = $"package '{package.Name}' {package.Version} is already mounted with different content; bump the version";
                return 0;
            }
        }

        var built = new List<ShpPackage.Window>();
        var candidateIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var window in package.Windows)
        {
            var localId = window.Id;
            var fullId = $"addon:{package.Name}:{window.Id}";
            if (string.IsNullOrWhiteSpace(localId))
            {
                record.Refusals.Add(new ShpPackage.Refusal(archive, 1, fullId, "window id is empty"));
                continue;
            }

            if (!candidateIds.Add(fullId))
            {
                record.Refusals.Add(new ShpPackage.Refusal(archive, 1, fullId, "window id is declared twice"));
                continue;
            }

            if (_byId.TryGetValue(fullId, out var previous) &&
                !string.Equals(previous.Addon, package.Name, StringComparison.OrdinalIgnoreCase))
            {
                record.Refusals.Add(new ShpPackage.Refusal(
                    archive, 1, fullId,
                    $"window id is already declared by package '{previous.Addon}'"));
                continue;
            }

            window.Id = fullId;
            window.Addon = package.Name;
            window.AddonName = package.Name;
            window.LayoutPath = LayoutPathFor(window, localId, archiveEntries);
            // The mounted path is still the primary way a package is drawn. A live tree is
            // additive: a package carrying only compiled resources keeps BLoadLayout, and a
            // package pushed after launch draws from this tree instead. A layout that exists
            // but cannot become a tree is a real refusal, and this whole candidate set is
            // discarded so the previous version stays mounted.
            window.LiveTree = LayoutTree.Read(package, window, localId, archiveEntries, archivePath, out var liveWhy);
            if (window.LiveTree is null && !string.IsNullOrEmpty(liveWhy))
                record.Refusals.Add(new ShpPackage.Refusal(
                    archive, 1, localId, "live layout refused: " + liveWhy));
            record.WindowIds.Add(fullId);
            built.Add(window);
        }

        record.Refusals.AddRange(package.Refusals);

        if (record.Refusals.Count > 0)
        {
            if (existing is null)
                changed = CommitRefusal(record);

            why = $"{record.Refusals[0].Subject}: {record.Refusals[0].Why}";
            return 0;
        }

        // The client refuses an addon payload above 4 MiB before it parses it. Checking the
        // candidate payload here means a delivery that would cross that ceiling is refused with
        // the previous package still mounted, rather than committed server-side and never sent.
        if (enforcePayloadBudget)
        {
            var candidatePackages = _packages
                .Where(item => !ReferenceEquals(item, existing))
                .Append(record)
                .ToList();
            var candidateWindows = _windows
                .Where(item => existing is null ||
                    !string.Equals(item.Addon, existing.Id, StringComparison.OrdinalIgnoreCase))
                .Concat(built)
                .ToList();
            var candidate = SerializePayload(Revision + 1, candidatePackages, candidateWindows);
            if (candidate.Length > MaxPayloadChars)
            {
                why = $"the mounted payload would be {candidate.Length} characters; the client refuses more than {MaxPayloadChars}";
                return 0;
            }
        }

        var oldWindows = existing is null
            ? []
            : _windows.Where(window => string.Equals(window.Addon, existing.Id, StringComparison.OrdinalIgnoreCase)).ToList();

        var packagesBefore = _packages.ToList();
        var windowsBefore = _windows.ToList();
        var byIdBefore = new Dictionary<string, ShpPackage.Window>(_byId, StringComparer.OrdinalIgnoreCase);

        try
        {
            if (existing is not null)
            {
                _packages.Remove(existing);
                foreach (var old in oldWindows)
                {
                    _windows.Remove(old);
                    _byId.Remove(old.Id);
                }
            }

            foreach (var window in built)
            {
                _windows.Add(window);
                _byId[window.Id] = window;
            }

            _packages.Add(record);
            Revision++;
            changed = true;
            LastChangedWindow = built.Count > 0 ? built[0].Id : "";
        }
        catch (Exception exception) when (exception is ArgumentException or InvalidOperationException)
        {
            _packages.Clear();
            _packages.AddRange(packagesBefore);
            _windows.Clear();
            _windows.AddRange(windowsBefore);
            _byId.Clear();
            foreach (var (id, window) in byIdBefore)
                _byId[id] = window;

            why = "package replacement rolled back: " + exception.Message;
            changed = false;
            return 0;
        }

        return built.Count;
    }

    private bool CommitRefusal(PackageRecord record)
    {
        if (_packages.Count >= MaxPackages)
        {
            // Refusals are package records too. A stream of refused archives must not grow the
            // payload past its ceiling: drop the oldest refusal-only record, and never a record
            // that has windows mounted.
            var oldest = _packages.FindIndex(item => item.Refusals.Count > 0);
            if (oldest < 0)
                return false;
            _packages.RemoveAt(oldest);
        }

        _packages.Add(record);
        Revision++;
        return true;
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
        Revision++;
    }

    private static int CompareVersions(string left, string right)
    {
        var a = VersionTokens(left);
        var b = VersionTokens(right);
        var count = Math.Max(a.Count, b.Count);
        for (var i = 0; i < count; i++)
        {
            var one = i < a.Count ? a[i] : "0";
            var two = i < b.Count ? b[i] : "0";
            if (long.TryParse(one, out var oneNumber) && long.TryParse(two, out var twoNumber))
            {
                var numbers = oneNumber.CompareTo(twoNumber);
                if (numbers != 0)
                    return numbers;
                continue;
            }

            var text = string.Compare(one, two, StringComparison.OrdinalIgnoreCase);
            if (text != 0)
                return text;
        }

        return 0;
    }

    private static List<string> VersionTokens(string version) =>
        VersionSeparator.Split(version ?? "")
            .Where(part => part.Length > 0)
            .ToList();

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

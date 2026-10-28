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
    private const int MaxCoordinate = 20000;
    private const int MinWindowWidth = 120;
    private const int MaxWindowWidth = 16000;
    private const int MinWindowHeight = 64;
    private const int MaxWindowHeight = 9000;

    private static readonly Regex SchemePattern = new(
        "^[a-z0-9][a-z0-9_-]{0,31}$",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly Regex WindowPattern = new(
        "^[A-Za-z0-9_.:-]{1,96}$",
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

    public sealed class Profile
    {
        public string Format { get; set; } = "";
        public string Scheme { get; set; } = "";
        public string Updated { get; set; } = "";
        public Dictionary<string, Rect> Windows { get; set; } = [];
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
    /// Parses <c>scheme@id,x,y,w,h@id,x,y,w,h</c>. Rows use '@' because the snapshot travels
    /// through CitadelConCommand, where ';' starts a second console command and truncates it.
    /// Unknown window ids are shape-valid here: the client owns which windows exist, and it
    /// ignores profile rows it no longer knows.
    /// </summary>
    public bool TryParse(
        string? argument,
        out string scheme,
        out Dictionary<string, Rect> windows,
        out string why)
    {
        scheme = "";
        windows = [];
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

            if (!ValidRect(x, y, w, h))
            {
                why = $"layout row for '{id}' is outside the allowed geometry";
                return false;
            }

            windows[id] = new Rect { X = x, Y = y, W = w, H = h };
        }

        return windows.Count > 0;
    }

    /// <summary>Writes one scheme profile, replacing any previous snapshot with an atomic move.</summary>
    public bool Save(string scheme, IReadOnlyDictionary<string, Rect> windows, out string why)
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
                    pair.Value.X, pair.Value.Y, pair.Value.W, pair.Value.H))
            {
                why = $"window '{pair.Key}' has invalid geometry";
                return false;
            }
        }

        try
        {
            var profile = new Profile
            {
                Format = ProfileFormat,
                Scheme = scheme.Trim().ToLowerInvariant(),
                Updated = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture),
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
        var profiles = new Dictionary<string, Dictionary<string, Rect>>(StringComparer.OrdinalIgnoreCase);
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

                        profiles[scheme] = profile.Windows;
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

            foreach (var pair in profile.Windows)
            {
                if (!WindowPattern.IsMatch(pair.Key) || !ValidRect(
                        pair.Value.X, pair.Value.Y, pair.Value.W, pair.Value.H))
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

    private static bool ValidRect(int x, int y, int w, int h) =>
        Math.Abs(x) <= MaxCoordinate
        && Math.Abs(y) <= MaxCoordinate
        && w >= MinWindowWidth
        && w <= MaxWindowWidth
        && h >= MinWindowHeight
        && h <= MaxWindowHeight;

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

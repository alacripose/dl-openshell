namespace Openlock.Shell;

/// <summary>
/// Reads the installer's build record and the staged-update record from disk.
///
/// <para>
/// The records are written by the same tools that do the work, so the Tools view never has to
/// invent a stage or a byte count. This class only bridges those files to the shell: it caches
/// by modification time, keeps the previous reading when a file is caught mid-write, and returns
/// an empty string when no record exists so the shell can fall back to its baked copy.
/// </para>
/// </summary>
public sealed class BuildStatus
{
    private readonly string[] _buildPaths;
    private readonly string[] _updatePaths;

    private DateTime _nextPoll;
    private DateTime _buildStamp;
    private DateTime _updateStamp;
    private string _build = "";
    private string _update = "";

    public BuildStatus(string shellDirectory)
    {
        var exeDirectory = AppContext.BaseDirectory;

        _buildPaths =
        [
            .. Optional(Environment.GetEnvironmentVariable("OPENLOCK_BUILD_RECORD")),
            Path.Combine(exeDirectory, "openlock.build.json"),
            Path.Combine(shellDirectory, "build.json"),
        ];

        _updatePaths =
        [
            .. Optional(Environment.GetEnvironmentVariable("OPENLOCK_UPDATE_RECORD")),
            Path.Combine(exeDirectory, "openlock.update.json"),
            Path.Combine(shellDirectory, "update.json"),
        ];
    }

    public string BuildJson => _build;
    public string UpdateJson => _update;
    public bool HasBuild => _build.Length > 0;
    public bool HasUpdate => _update.Length > 0;

    /// <summary>
    /// Re-reads the records at most twice a second. Returns true when either published value
    /// changed, so the caller can avoid echoing identical strings to every client.
    /// </summary>
    public bool Poll()
    {
        var now = DateTime.UtcNow;
        if (now < _nextPoll)
            return false;

        _nextPoll = now.AddMilliseconds(500);

        var previousBuild = _build;
        var previousUpdate = _update;

        _build = ReadNewest(_buildPaths, _build, ref _buildStamp);
        _update = ReadNewest(_updatePaths, _update, ref _updateStamp);

        return !string.Equals(previousBuild, _build, StringComparison.Ordinal)
            || !string.Equals(previousUpdate, _update, StringComparison.Ordinal);
    }

    private static string ReadNewest(string[] paths, string current, ref DateTime stamp)
    {
        string newestPath = "";
        DateTime newestStamp = DateTime.MinValue;

        foreach (var path in paths)
        {
            try
            {
                if (!File.Exists(path))
                    continue;

                var write = File.GetLastWriteTimeUtc(path);
                if (write > newestStamp)
                {
                    newestStamp = write;
                    newestPath = path;
                }
            }
            catch
            {
                // A path we cannot stat is simply not a candidate; the next one may be readable.
            }
        }

        if (newestPath.Length == 0)
        {
            stamp = DateTime.MinValue;
            return "";
        }

        if (newestStamp == stamp)
            return current;

        try
        {
            var text = File.ReadAllText(newestPath).Trim();
            if (text.Length == 0)
                return current;

            stamp = newestStamp;
            return text;
        }
        catch (IOException)
        {
            // The writer replaces the file between our stat and read. Keeping the previous
            // reading is honest: the next poll will catch the complete file.
            return current;
        }
        catch (UnauthorizedAccessException)
        {
            return current;
        }
    }

    private static IEnumerable<string> Optional(string? path)
    {
        if (!string.IsNullOrWhiteSpace(path))
            yield return path;
    }
}

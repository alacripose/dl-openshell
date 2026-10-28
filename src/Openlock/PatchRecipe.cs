namespace Openlock;

/// <summary>
/// Reads a <c>shploingus.recipe/3</c> patch recipe: a tab-separated header line
/// (<c>kind&#9;name</c>), its fields indented below it, and a <c>record-id</c> closing each record.
///
/// <para>
/// The recipe is the declaration of what the mode changes and what it refuses to change. Loading
/// it is deliberately read-only: nothing here writes engine state. A record whose
/// <c>status</c> is <c>refused</c> is reported with its <c>reason</c>, so an unwritable base is
/// named instead of being silently replaced by a plausible number.
/// </para>
/// </summary>
public sealed class PatchRecipe
{
    public sealed class Record
    {
        public string Kind = "";
        public string Name = "";
        public readonly Dictionary<string, string> Fields = new(StringComparer.OrdinalIgnoreCase);

        public string? Field(string key) => Fields.TryGetValue(key, out var v) ? v : null;
        public string? Id => Field("record-id");
        public string? Reason => Field("reason");
        public bool Refused => string.Equals(Field("status"), "refused", StringComparison.OrdinalIgnoreCase);
    }

    public string Format { get; private init; } = "";
    public string Package { get; private init; } = "";
    public string Version { get; private init; } = "";
    public IReadOnlyList<Record> Records { get; private init; } = [];

    public bool Refused(string name) =>
        Records.FirstOrDefault(r => string.Equals(r.Name, name, StringComparison.OrdinalIgnoreCase))?.Refused ?? false;

    public float? Target(string name)
    {
        var record = Records.FirstOrDefault(r => string.Equals(r.Name, name, StringComparison.OrdinalIgnoreCase));
        if (record is null || record.Refused)
            return null;

        return float.TryParse(record.Field("target"), out var value) ? value : null;
    }

    public static PatchRecipe? Load(string path)
    {
        if (!File.Exists(path))
            return null;

        var lines = File.ReadAllLines(path);
        if (lines.Length == 0 || !lines[0].StartsWith("shploingus.recipe/", StringComparison.Ordinal))
            return null;

        var records = new List<Record>();
        Record? current = null;
        string package = "";
        string version = "";

        foreach (var raw in lines.Skip(1))
        {
            var line = raw.TrimEnd();
            if (line.Length == 0 || line.TrimStart().StartsWith('#'))
                continue;

            // Field lines are tab-indented, so their first split element is empty.
            if (raw.StartsWith('\t'))
            {
                var fields = raw.TrimStart('\t').Split('\t', StringSplitOptions.None);
                if (current is not null && fields.Length >= 2)
                    current.Fields[fields[0]] = fields[1];

                continue;
            }

            var parts = line.Split('\t', StringSplitOptions.None);

            if (parts[0] == "package")
            {
                package = parts.Length > 1 ? parts[1] : "";
                version = parts.Length > 2 ? parts[2] : "";
                continue;
            }

            if (parts.Length >= 2)
            {
                current = new Record { Kind = parts[0], Name = parts[1] };
                records.Add(current);
            }
        }

        return new PatchRecipe
        {
            Format = lines[0],
            Package = package,
            Version = version,
            Records = records,
        };
    }

    /// <summary>
    /// Logs what the recipe declares, including every refusal and why. Setting records are checked
    /// against the live engine value: a baseline that does not match the running build is refused
    /// and named, rather than being applied on top of whatever is actually there.
    /// </summary>
    public void Report(string path, Func<string, float?>? readLive = null)
    {
        Log.Write($"[Openlock] recipe {Format} {Package} {Version} ({Path.GetFileName(path)})");
        Log.Write($"[Openlock]   {Records.Count} record(s), {Records.Count(r => r.Refused)} refused by declaration");

        foreach (var record in Records)
        {
            if (record.Refused)
            {
                Log.Write(
                    $"[Openlock]   REFUSED {record.Kind}/{record.Name} target={record.Field("target")}: " +
                    $"{record.Reason ?? "no reason declared"}");
                continue;
            }

            if (record.Kind == "setting" && readLive is not null)
            {
                var live = readLive(record.Name);
                if (live is null)
                {
                    Log.Write($"[Openlock]   REFUSED setting/{record.Name}: not present on this build");
                    continue;
                }

                if (!float.TryParse(record.Field("baseline"), out var declared))
                {
                    Log.Write($"[Openlock]   REFUSED setting/{record.Name}: baseline not declared (live {live:0.##})");
                    continue;
                }

                if (MathF.Abs(live.Value - declared) > 0.001f)
                {
                    Log.Write(
                        $"[Openlock]   REFUSED setting/{record.Name}: baseline mismatch, declared {declared:0.##}, " +
                        $"live {live:0.##}");
                    continue;
                }

                Log.Write(
                    $"[Openlock]   accepted setting/{record.Name}: baseline {declared:0.##} matched, " +
                    $"target {record.Field("target")}");
                continue;
            }

            Log.Write($"[Openlock]   accepted {record.Kind}/{record.Name} target={record.Field("target")}");
        }
    }
}

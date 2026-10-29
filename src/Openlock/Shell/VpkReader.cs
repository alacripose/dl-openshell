using System.Text;

namespace Openlock.Shell;

/// <summary>
/// The one reader for Valve VPK directory archives. Discovery, the shell check and addon
/// packages all ask this type: there is no second index parser whose edge cases can disagree.
///
/// <para>
/// A VPK directory archive stores an index of <c>extension / directory / file</c> names.
/// Entries whose archive index is <c>0x7FFF</c> live inline after the index; the rest live in
/// <c>pak01_NNN.vpk</c> beside the directory archive. Both shapes are read here, and a truncated
/// index or a missing part returns no entry rather than guessing at bytes.
/// </para>
/// </summary>
public static class VpkReader
{
    private const uint Magic = 0x55aa1234;
    private const ushort InlineArchive = 0x7FFF;
    private const int TreeCeiling = 64 * 1024 * 1024;

    private sealed class Entry
    {
        public string Path = "";
        public ushort Preload;
        public ushort ArchiveIndex;
        public uint Offset;
        public uint Length;
        public byte[] PreloadBytes = [];
        public long InlineOffset;
    }

    private sealed class Archive
    {
        public required string Path;
        public required long TreeEnd;
        public required List<Entry> Entries;
    }

    private static readonly Dictionary<string, (DateTime Stamp, Archive Archive)> Cache =
        new(StringComparer.OrdinalIgnoreCase);

    private static readonly object Gate = new();

    /// <summary>Every entry path in a directory archive, or an empty set when it is unreadable.</summary>
    public static IReadOnlyList<string> Entries(string path)
    {
        return TryEntries(path, out var names, out _) ? names : [];
    }

    /// <summary>
    /// Reads an archive's entry names, reporting the archive's own failure rather than
    /// treating an unreadable index as an empty one.
    /// </summary>
    public static bool TryEntries(string path, out IReadOnlyList<string> names, out string error)
    {
        names = [];
        error = "";
        try
        {
            var archive = Open(path);
            names = archive.Entries.Select(e => e.Path).ToArray();
            return true;
        }
        catch (Exception exception) when (exception is IOException
            or UnauthorizedAccessException
            or InvalidDataException
            or ArgumentException)
        {
            error = exception.Message;
            return false;
        }
    }

    /// <summary>
    /// Reads one entry by its archive path. The path is matched case-insensitively, as the
    /// game's own search does. A missing entry, an unreadable archive or a missing shard is
    /// <c>null</c>; a caller that needs to name the failure reads <see cref="Entries"/> first.
    /// </summary>
    public static byte[]? ReadEntry(string path, string wanted)
    {
        try
        {
            var archive = Open(path);
            var normalized = Normalize(wanted);
            var entry = archive.Entries.FirstOrDefault(candidate =>
                candidate.Path.Equals(normalized, StringComparison.OrdinalIgnoreCase));
            if (entry is null)
                return null;

            using var stream = File.OpenRead(archive.Path);
            using var reader = new BinaryReader(stream);

            if (entry.Length > int.MaxValue)
                return null;

            byte[] data;
            if (entry.ArchiveIndex == InlineArchive)
            {
                var at = archive.TreeEnd + entry.InlineOffset;
                if (at < 0 || at + entry.Length > stream.Length)
                    return null;

                stream.Position = at;
                data = reader.ReadBytes((int)entry.Length);
                if (data.Length != (int)entry.Length)
                    return null;
            }
            else
            {
                var part = PartPath(archive.Path, entry.ArchiveIndex);
                if (!File.Exists(part))
                    return null;

                using var partStream = File.OpenRead(part);
                if ((long)entry.Offset + entry.Length > partStream.Length)
                    return null;

                partStream.Position = entry.Offset;
                data = new byte[(int)entry.Length];
                var read = partStream.Read(data, 0, data.Length);
                if (read != data.Length)
                    return null;
            }

            if (entry.Preload == 0)
                return data;

            var joined = new byte[entry.PreloadBytes.Length + data.Length];
            entry.PreloadBytes.CopyTo(joined, 0);
            data.CopyTo(joined, entry.PreloadBytes.Length);
            return joined;
        }
        catch (Exception exception) when (exception is IOException
            or UnauthorizedAccessException
            or InvalidDataException
            or ArgumentException)
        {
            return null;
        }
    }

    private static Archive Open(string path)
    {
        var full = Path.GetFullPath(path);
        var stamp = File.GetLastWriteTimeUtc(full);

        lock (Gate)
        {
            if (Cache.TryGetValue(full, out var cached) && cached.Stamp == stamp)
                return cached.Archive;
        }

        var archive = Parse(full);

        lock (Gate)
            Cache[full] = (stamp, archive);

        return archive;
    }

    private static Archive Parse(string path)
    {
        using var stream = File.OpenRead(path);
        using var reader = new BinaryReader(stream, Encoding.UTF8, leaveOpen: false);

        if (reader.ReadUInt32() != Magic)
            throw new InvalidDataException("not a VPK directory archive");

        var version = reader.ReadUInt32();
        var treeSize = reader.ReadUInt32();
        if (treeSize > TreeCeiling || treeSize > stream.Length - stream.Position)
            throw new InvalidDataException($"VPK tree declares {treeSize} bytes and the archive ends first");

        if (version == 2)
        {
            reader.ReadUInt32(); // file data section size
            reader.ReadUInt32(); // archive md5 section size
            reader.ReadUInt32(); // other md5 section size
            reader.ReadUInt32(); // signature section size
        }
        else if (version != 1)
        {
            throw new InvalidDataException($"unsupported VPK version {version}");
        }

        var tree = reader.ReadBytes((int)treeSize);
        if (tree.Length != treeSize)
            throw new InvalidDataException("VPK tree is truncated");

        var treeEnd = stream.Position;
        var entries = ParseTree(tree);
        return new Archive { Path = path, TreeEnd = treeEnd, Entries = entries };
    }

    private static List<Entry> ParseTree(byte[] tree)
    {
        var entries = new List<Entry>();
        var pos = 0;
        long inline = 0;

        while (true)
        {
            var extension = ReadString(tree, ref pos);
            if (extension.Length == 0)
                break;

            while (true)
            {
                var directory = ReadString(tree, ref pos);
                if (directory.Length == 0)
                    break;

                while (true)
                {
                    var name = ReadString(tree, ref pos);
                    if (name.Length == 0)
                        break;

                    if (pos + 18 > tree.Length)
                        throw new InvalidDataException("VPK entry record is truncated");

                    var entry = new Entry
                    {
                        Preload = BitConverter.ToUInt16(tree, pos + 4),
                        ArchiveIndex = BitConverter.ToUInt16(tree, pos + 6),
                        Offset = BitConverter.ToUInt32(tree, pos + 8),
                        Length = BitConverter.ToUInt32(tree, pos + 12),
                    };
                    pos += 18;

                    if (entry.Preload > 0)
                    {
                        if (pos + entry.Preload > tree.Length)
                            throw new InvalidDataException("VPK preload bytes are truncated");
                        entry.PreloadBytes = tree[pos..(pos + entry.Preload)];
                        pos += entry.Preload;
                    }

                    entry.Path = Normalize(
                        string.IsNullOrEmpty(directory.Trim())
                            ? $"{name}.{extension}"
                            : $"{directory}/{name}.{extension}");

                    if (entry.ArchiveIndex == InlineArchive)
                    {
                        entry.InlineOffset = inline;
                        inline += entry.Length;
                    }

                    entries.Add(entry);
                }
            }
        }

        return entries;
    }

    private static string ReadString(byte[] tree, ref int pos)
    {
        var end = Array.IndexOf(tree, (byte)0, pos);
        if (end < 0)
            throw new InvalidDataException("VPK tree string is not terminated");

        var value = Encoding.UTF8.GetString(tree, pos, end - pos);
        pos = end + 1;
        return value;
    }

    private static string Normalize(string path) =>
        path.Replace('\\', '/').Trim().TrimStart('/');

    private static string PartPath(string archive, ushort index)
    {
        var stem = Path.GetFileNameWithoutExtension(archive);
        if (stem.EndsWith("_dir", StringComparison.OrdinalIgnoreCase))
            stem = stem[..^4];

        return Path.Combine(Path.GetDirectoryName(archive) ?? ".", $"{stem}_{index:000}.vpk");
    }
}

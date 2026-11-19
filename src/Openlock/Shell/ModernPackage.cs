using System.Buffers.Binary;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

using Blake3;

namespace Openlock.Shell;

/// <summary>
/// The modern package object, not a frame.
///
/// <para>
/// The family audit replaced the per-project magics with the canonical package object:
/// <c>manifest.json</c> plus <c>payload.bin</c>, with one BLAKE3 identity over the canonical
/// manifest and the payload. The digest preimage is exactly
/// <c>secure-shell.package/&lt;32 hex&gt; || u64be(manifest) || manifest || u64be(payload) || payload</c>
/// (<c>secure_shell_v2/docs/SECURE-SHELL-RESTORE@1.ARCHITECTURE.md</c> §5 and §12.8). Framing,
/// signatures, chunking and transport are deliberately outside the preimage, so a package can be
/// re-signed or streamed without becoming a different package.
/// </para>
///
/// <para>
/// There is no 16 MiB cap and no 32-bit length: the payload is streamed into BLAKE3 and only its
/// <see cref="long"/> length is retained. The declared payload is bounded by the Restore's 64 GiB
/// hard ceiling and by the file's actual length; both are refusals, not truncations.
/// </para>
/// </summary>
public sealed class ModernPackage
{
    public static readonly string ObjectSchema = FormatId.Hash("secure-shell.package", PackageFormatPreimage());
    public static string DigestDomain => ObjectSchema;
    public const string IdentityAlgorithm = "blake3";

    /// <summary>
    /// The contract the package id pins: the fields the reader requires, the transport fields it
    /// excludes, the identity algorithm and the one legacy counter it reads. Change any line and
    /// the id changes; no counter has to be remembered or incremented by hand.
    /// </summary>
    private static string PackageFormatPreimage() =>
        "family\tsecure-shell.package\n"
        + "legacy-family\tsecure-shell.package\n"
        + "legacy-schema\t1\n"
        + "reader\tsecure-shell.package.reader.v1\n"
        + "algorithm\tblake3\n"
        + "field\tname\nfield\trevision\nfield\tschemas\nfield\tdependencies\n"
        + "field\tentry_points\nfield\tlengths\n"
        + "exclude\tsignature\nexclude\tsignature_algorithm\nexclude\treceived_at\n"
        + "exclude\tadmitted_at\nexclude\thash\nexclude\tdigest\nexclude\tnonce\n"
        + "exclude\tchunk_frame\n";
    public const long MaxPayloadBytes = 64L * 1024 * 1024 * 1024;

    private static readonly string[] RequiredFields =
    [
        "name", "revision", "schemas", "dependencies", "entry_points", "lengths",
    ];

    private static readonly HashSet<string> Excluded =
    [
        "signature", "signature_algorithm", "received_at", "admitted_at", "hash", "digest",
        "nonce", "chunk_frame",
    ];

    private static readonly JsonDocumentOptions DocumentOptions = new()
    {
        AllowTrailingCommas = false,
        CommentHandling = JsonCommentHandling.Disallow,
        MaxDepth = 64,
    };

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        Indented = false,
        SkipValidation = false,
    };

    public string ManifestPath { get; private set; } = "";
    public string PayloadPath { get; private set; } = "";
    public string Name { get; private set; } = "";
    public long Revision { get; private set; }
    public List<string> Schemas { get; } = [];
    public bool UsesLegacyFormat { get; private set; }
    public List<string> Dependencies { get; } = [];
    public List<string> EntryPoints { get; } = [];
    public Dictionary<string, long> Lengths { get; } = new(StringComparer.Ordinal);
    public long PayloadBytes { get; private set; }
    public byte[] CanonicalManifest { get; private set; } = [];
    public string ContentDigest { get; private set; } = "";
    public string Identity => $"{Name}@{Revision}+{ContentDigest}";

    /// <summary>
    /// Loads and verifies one canonical package. The payload is read once, in bounded chunks;
    /// nothing allocates a buffer proportional to its length.
    /// </summary>
    public static bool TryLoad(string manifestPath, string payloadPath,
        out ModernPackage package, out string why)
    {
        package = new ModernPackage { ManifestPath = manifestPath, PayloadPath = payloadPath };
        why = "";

        if (!File.Exists(manifestPath))
        {
            why = $"manifest '{manifestPath}' does not exist";
            return false;
        }
        if (!File.Exists(payloadPath))
        {
            why = $"payload '{payloadPath}' does not exist";
            return false;
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(File.ReadAllBytes(manifestPath), DocumentOptions);
        }
        catch (Exception exception) when (exception is IOException
            or UnauthorizedAccessException
            or JsonException)
        {
            why = "manifest is not readable JSON: " + exception.Message;
            return false;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                why = "manifest root is not an object";
                return false;
            }

            if (!ValidateManifest(root, package, out why))
                return false;

            var payloadInfo = new FileInfo(payloadPath);
            if (payloadInfo.Length != package.PayloadBytes)
            {
                why = $"payload is {payloadInfo.Length} bytes; the manifest declares {package.PayloadBytes}";
                return false;
            }
            if (package.PayloadBytes > MaxPayloadBytes)
            {
                why = $"payload is {package.PayloadBytes} bytes; the hard ceiling is {MaxPayloadBytes}";
                return false;
            }

            try
            {
                package.CanonicalManifest = CanonicalJson(root);
            }
            catch (InvalidDataException exception)
            {
                why = exception.Message;
                return false;
            }

            try
            {
                package.ContentDigest = DigestPackage(package.CanonicalManifest, payloadPath, package.PayloadBytes);
            }
            catch (Exception exception) when (exception is IOException
                or UnauthorizedAccessException
                or InvalidDataException)
            {
                why = "payload could not be read completely: " + exception.Message;
                return false;
            }
            return true;
        }
    }

    /// <summary>
    /// Reads a small text payload after <see cref="TryLoad"/> has verified the package. The
    /// surface reader never opens the payload itself, so a surface read always follows a checked
    /// `secure-shell.package/<32 hex>` identity.
    /// </summary>
    public bool TryReadPayloadText(int maxBytes, out string text, out string why)
    {
        text = "";
        why = "";
        if (ContentDigest.Length == 0)
        {
            why = "package has not been verified";
            return false;
        }
        if (maxBytes < 0)
        {
            why = "text ceiling is negative";
            return false;
        }
        if (PayloadBytes > maxBytes)
        {
            why = $"payload is {PayloadBytes} bytes; the text ceiling is {maxBytes}";
            return false;
        }

        try
        {
            var bytes = new byte[PayloadBytes];
            using var stream = new FileStream(PayloadPath, FileMode.Open, FileAccess.Read,
                FileShare.Read, 1 << 20, FileOptions.SequentialScan);
            var read = 0;
            while (read < bytes.Length)
            {
                var got = stream.Read(bytes, read, bytes.Length - read);
                if (got == 0)
                {
                    why = $"payload read {read} of {bytes.Length} bytes";
                    return false;
                }
                read += got;
            }
            if (stream.ReadByte() != -1)
            {
                why = $"payload is longer than the declared {PayloadBytes} bytes";
                return false;
            }
            text = new UTF8Encoding(false, true).GetString(bytes);
            return true;
        }
        catch (Exception exception) when (exception is IOException
            or UnauthorizedAccessException
            or DecoderFallbackException
            or ArgumentException)
        {
            why = "payload text is not readable: " + exception.Message;
            return false;
        }
    }

    /// <summary>
    /// The canonical digest from <c>secure_shell_v2/impl/packages/identity.py</c>: the domain,
    /// each field's 8-byte big-endian length, then the field. The payload is streamed.
    /// </summary>
    public static string DigestPackage(ReadOnlySpan<byte> canonicalManifest, string payloadPath,
        long expectedLength)
    {
        if (expectedLength < 0)
            throw new ArgumentOutOfRangeException(nameof(expectedLength));

        using var hasher = Hasher.New();
        hasher.Update(Encoding.UTF8.GetBytes(DigestDomain));

        Span<byte> length = stackalloc byte[8];
        BinaryPrimitives.WriteUInt64BigEndian(length, (ulong)canonicalManifest.Length);
        hasher.Update(length);
        hasher.Update(canonicalManifest);

        using var stream = new FileStream(payloadPath, FileMode.Open, FileAccess.Read,
            FileShare.Read, 1 << 20, FileOptions.SequentialScan);
        BinaryPrimitives.WriteUInt64BigEndian(length, (ulong)expectedLength);
        hasher.Update(length);

        // Hash exactly the declared payload. A file that is short is a refusal; a file that is
        // long is a refusal too, rather than silently hashing bytes the manifest never named.
        var buffer = new byte[1 << 20];
        long total = 0;
        while (total < expectedLength)
        {
            var want = (int)Math.Min(buffer.Length, expectedLength - total);
            var read = stream.Read(buffer, 0, want);
            if (read == 0)
                throw new InvalidDataException($"payload read {total} of {expectedLength} bytes");
            total += read;
            hasher.Update(buffer.AsSpan(0, read));
        }

        if (stream.ReadByte() != -1)
            throw new InvalidDataException($"payload is longer than the declared {expectedLength} bytes");

        var digest = hasher.Finalize();
        return IdentityAlgorithm + ":" + Convert.ToHexString(digest.AsSpan()).ToLowerInvariant();
    }

    private static bool ValidateManifest(JsonElement root, ModernPackage package, out string why)
    {
        why = "";
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in root.EnumerateObject())
        {
            if (Excluded.Contains(property.Name))
                continue;
            if (!RequiredFields.Contains(property.Name, StringComparer.Ordinal))
            {
                why = $"manifest declares unknown key '{property.Name}'";
                return false;
            }
            if (!seen.Add(property.Name))
            {
                why = $"manifest declares '{property.Name}' twice";
                return false;
            }
        }

        foreach (var field in RequiredFields)
        {
            if (!seen.Contains(field))
            {
                why = $"manifest is missing '{field}'";
                return false;
            }
        }

        if (!root.TryGetProperty("name", out var nameElement)
            || nameElement.ValueKind != JsonValueKind.String
            || !IsName(nameElement.GetString() ?? ""))
        {
            why = "manifest name is not a lowercase hyphenated package name";
            return false;
        }
        package.Name = nameElement.GetString()!;

        if (!root.TryGetProperty("revision", out var revisionElement)
            || revisionElement.ValueKind != JsonValueKind.Number
            || !revisionElement.TryGetInt64(out var revision)
            || revision < 1)
        {
            why = "manifest revision is not a positive integer";
            return false;
        }
        package.Revision = revision;

        if (!ReadStringArray(root, "schemas", package.Schemas, out why))
            return false;
        if (package.Schemas.Count == 0
            || !package.Schemas.Any(id => FormatId.SameFamily(id, ObjectSchema)
                && (id == ObjectSchema || FormatId.IsNumeric(id))))
        {
            why = $"manifest schemas do not include {ObjectSchema} or its numeric legacy id";
            return false;
        }
        package.UsesLegacyFormat = package.Schemas.Any(id =>
            FormatId.SameFamily(id, ObjectSchema) && FormatId.IsNumeric(id));
        for (var i = 0; i < package.Schemas.Count; i++)
        {
            if (!SchemaId(package.Schemas[i]))
            {
                why = $"schema id '{package.Schemas[i]}' is not family/<numeric legacy> or family/<32 hex>";
                return false;
            }
            if (i > 0 && string.CompareOrdinal(package.Schemas[i - 1], package.Schemas[i]) >= 0)
            {
                why = "manifest schemas are not ordered and unique";
                return false;
            }
        }

        if (!ReadStringArray(root, "dependencies", package.Dependencies, out why))
            return false;
        for (var i = 0; i < package.Dependencies.Count; i++)
        {
            if (!Dependency(package.Dependencies[i]))
            {
                why = $"dependency '{package.Dependencies[i]}' is not a package identity";
                return false;
            }
            if (i > 0 && string.CompareOrdinal(package.Dependencies[i - 1], package.Dependencies[i]) >= 0)
            {
                why = "manifest dependencies are not ordered and unique";
                return false;
            }
        }

        if (!ReadStringArray(root, "entry_points", package.EntryPoints, out why))
            return false;
        for (var i = 0; i < package.EntryPoints.Count; i++)
        {
            if (!EntryPoint(package.EntryPoints[i]))
            {
                why = $"entry point '{package.EntryPoints[i]}' is not a relative path";
                return false;
            }
            if (i > 0 && string.CompareOrdinal(package.EntryPoints[i - 1], package.EntryPoints[i]) >= 0)
            {
                why = "manifest entry points are not ordered and unique";
                return false;
            }
        }

        if (!root.TryGetProperty("lengths", out var lengthsElement)
            || lengthsElement.ValueKind != JsonValueKind.Object)
        {
            why = "manifest lengths is not an object";
            return false;
        }

        foreach (var property in lengthsElement.EnumerateObject())
        {
            if (property.Name.Length == 0
                || property.Value.ValueKind != JsonValueKind.Number
                || !property.Value.TryGetInt64(out var value)
                || value < 0)
            {
                why = $"manifest length '{property.Name}' is not a non-negative integer";
                return false;
            }
            package.Lengths[property.Name] = value;
        }

        if (!package.Lengths.TryGetValue("payload", out var payload))
        {
            why = "manifest lengths does not declare payload";
            return false;
        }
        if (payload > MaxPayloadBytes)
        {
            why = $"manifest declares a {payload}-byte payload; the hard ceiling is {MaxPayloadBytes}";
            return false;
        }
        package.PayloadBytes = payload;
        return true;
    }

    private static bool ReadStringArray(JsonElement root, string name, List<string> target, out string why)
    {
        why = "";
        if (!root.TryGetProperty(name, out var element) || element.ValueKind != JsonValueKind.Array)
        {
            why = $"manifest {name} is not an array";
            return false;
        }
        foreach (var item in element.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String)
            {
                why = $"manifest {name} contains a non-string";
                return false;
            }
            target.Add(item.GetString()!);
        }
        return true;
    }

    /// <summary>
    /// Deterministic JSON: object keys sorted by ordinal byte order, no incidental whitespace,
    /// UTF-8. This is the same shape <c>json.dumps(sort_keys=True, separators=(",", ":"))</c>
    /// produces for the manifest vocabulary.
    /// </summary>
    public static byte[] CanonicalJson(JsonElement element)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream, WriterOptions))
            WriteCanonical(writer, element, true);
        return stream.ToArray();
    }

    private static void WriteCanonical(Utf8JsonWriter writer, JsonElement element, bool root = false)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                var keys = new HashSet<string>(StringComparer.Ordinal);
                foreach (var property in element.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                {
                    // Only the manifest's own transport fields are excluded. A nested
                    // `lengths.digest` is content and must stay in the preimage.
                    if (root && Excluded.Contains(property.Name))
                        continue;
                    if (!keys.Add(property.Name))
                        throw new InvalidDataException($"manifest declares '{property.Name}' twice");
                    writer.WritePropertyName(property.Name);
                    WriteCanonical(writer, property.Value);
                }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in element.EnumerateArray())
                    WriteCanonical(writer, item, false);
                writer.WriteEndArray();
                break;
            case JsonValueKind.String:
                writer.WriteStringValue(element.GetString());
                break;
            case JsonValueKind.Number:
                writer.WriteRawValue(element.GetRawText(), skipInputValidation: false);
                break;
            case JsonValueKind.True:
                writer.WriteBooleanValue(true);
                break;
            case JsonValueKind.False:
                writer.WriteBooleanValue(false);
                break;
            case JsonValueKind.Null:
                writer.WriteNullValue();
                break;
            default:
                throw new InvalidDataException($"manifest contains {element.ValueKind}");
        }
    }

    private static bool IsName(string text) =>
        text.Length is > 0 and <= 64
        && !text.Contains("--", StringComparison.Ordinal)
        && text.Split('-', StringSplitOptions.RemoveEmptyEntries).All(part =>
            part.Length > 0 && part.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c)))
        && text[0] != '-' && text[^1] != '-';

    private static bool SchemaId(string text) =>
        FormatId.IsFamily(FormatId.Family(text))
        && (FormatId.IsNumeric(text) || FormatId.IsHashed(text));

    private static bool Dependency(string text)
    {
        var at = text.IndexOf('@');
        if (at <= 0)
            return false;
        var name = text[..at];
        var rest = text[(at + 1)..];
        var plus = rest.IndexOf("+blake3:", StringComparison.Ordinal);
        if (plus <= 0)
            return false;
        var revision = rest[..plus];
        var digest = rest[(plus + "+blake3:".Length)..];
        if (revision.Length == 0 || revision[0] == '0' || !revision.All(char.IsAsciiDigit))
            return false;
        if (digest.Length < 64 || !digest[..64].All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f'))
            return false;
        return IsName(name) && (digest.Length == 64 || digest[64] == '(');
    }

    private static bool EntryPoint(string text)
    {
        if (text.Length == 0 || text[0] == '/' || text.Contains('\\', StringComparison.Ordinal))
            return false;
        foreach (var part in text.Split('/'))
        {
            if (part.Length == 0 || part is "." or "..")
                return false;
            if (!(char.IsAsciiLetterOrDigit(part[0]) || part[0] == '_')
                || part.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-')))
                return false;
        }
        return true;
    }
}

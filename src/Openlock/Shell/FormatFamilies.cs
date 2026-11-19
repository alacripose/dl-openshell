using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace Openlock.Shell;

/// <summary>
/// The family declarations that use the one hash-pinned format-id rule.
///
/// <para>
/// A family's id is computed from its contract text, never from a counter. Its reader accepts a
/// numeric suffix from the same family as a legacy migration input, upgrades it to
/// <see cref="Current"/>, and refuses a hash from another family or contract. The same current id
/// is the digest domain for the family, so an id cannot describe one grammar while digesting
/// another.
/// </para>
/// </summary>
public sealed class FormatFamily
{
    public FormatFamily(string name, string preimage)
    {
        Name = name;
        Preimage = preimage;
        Current = FormatId.Hash(name, preimage);
    }

    public string Name { get; }
    public string Preimage { get; }
    public string Current { get; }
    public string DigestDomain => Current;

    /// <summary>
    /// Reads a declared id and returns the id a writer must emit. A different family, a foreign
    /// hash, or an absent id is refused; any numeric counter in this family is a legacy input.
    /// </summary>
    public bool TryUpgrade(string declared, out string upgraded, out string refusal)
    {
        upgraded = "";
        refusal = "";
        if (!FormatId.SameFamily(declared, Current))
        {
            // A different family or a different contract hash is the same refusal: the id is not
            // this family's computed contract. There is no counter special case.
            refusal = string.IsNullOrWhiteSpace(declared) ? "format-schema" : "format-hash-mismatch";
            return false;
        }

        switch (FormatId.Classify(declared, Current))
        {
            case FormatId.Match.Current:
            case FormatId.Match.Legacy:
                upgraded = Current;
                return true;
            case FormatId.Match.Mismatch:
                refusal = "format-hash-mismatch";
                return false;
            default:
                refusal = "format-schema";
                return false;
        }
    }

    /// <summary>Whether a header carries a numeric legacy id that needs upgrading on emission.</summary>
    public bool IsLegacy(string declared) =>
        FormatId.SameFamily(declared, Current)
        && FormatId.Classify(declared, Current) == FormatId.Match.Legacy;
}

public static class FormatFamilies
{
    private static FormatFamily Simple(string family, int legacySchema) => new(family,
        $"family\t{family}\n"
        + $"legacy-family\t{family}\n"
        + $"legacy-schema\t{legacySchema}\n"
        + $"reader\t{family}.reader.v1\n");

    public static readonly FormatFamily Game = Simple("openlock.game", 1);
    public static readonly FormatFamily Recipe = Simple("shploingus.recipe", 3);
    public static readonly FormatFamily Cells = Simple("shploingus.cells", 1);
    public static readonly FormatFamily CellFrame = Simple("shploingus.cellframe", 1);
    public static readonly FormatFamily Deadlock = Simple("shploingus.deadlock", 1);
    public static readonly FormatFamily Layout = Simple("openlock.layout", 1);
    public static readonly FormatFamily Layouts = Simple("openlock.layouts", 1);
    public static readonly FormatFamily Envelope = Simple("openlock.envelope", 1);
    public static readonly FormatFamily Build = Simple("openlock.build", 1);
    public static readonly FormatFamily Observer = Simple("openlock.observer", 1);
    public static readonly FormatFamily Theme = Simple("shploingus.theme", 1);
    public static readonly FormatFamily Form = Simple("shploingus.form", 1);
    public static readonly FormatFamily PopitElements = Simple("openlock.popit-elements", 2);
    public static readonly FormatFamily CuaClient = Simple("openlock.cua-client", 1);
    public static readonly FormatFamily Axis = Simple("secure-shell.axis", 1);
    public static readonly FormatFamily FleetSummary = Simple("cua.fleet.summary", 1);
    public static readonly FormatFamily GooseVanilla = Simple("goose.vanilla", 1);
    public static readonly FormatFamily GooseClient = Simple("goose.client", 1);
    public static readonly FormatFamily GooseJava = Simple("goose.java", 1);
    public static readonly FormatFamily GooseNative = Simple("goose.native", 1);
    public static readonly FormatFamily DlEnclaveSignature = Simple("dl-enclave.sig", 1);

    public static readonly FormatFamily Addons = new("openlock.addons",
        "family\topenlock.addons\n"
        + "legacy-family\topenlock.addons\n"
        + "legacy-schema\t2\n"
        + "reader\topenlock.addons.reader.v1\n"
        + "field\tformat\nfield\trevision\nfield\tpackages\n"
        + "field\twindows\nfield\tliveTree\nfield\tbudgets\n"
        + "refusal\tformat\nrefusal\trevision\n"
        + "refusal\twindow\nrefusal\tnode\nrefusal\tbudget\n");

    public static readonly FormatFamily GooseMod = new("goose.mod",
        "family\tgoose.mod\n"
        + "legacy-family\tgoose.mod\n"
        + "legacy-schema\t1\n"
        + "reader\tgoose.mod.reader.v1\n"
        + "field\tmod\nfield\tsource\nfield\tjava\nfield\tentrypoint\n"
        + "field\trequires\nfield\tcontent\nfield\tformat\n");

    public static readonly FormatFamily DlEnclavePackage = new("dl-enclave.pkg",
        "family\tdl-enclave.pkg\n"
        + "legacy-family\tdl-enclave.pkg\n"
        + "legacy-schema\t1\n"
        + "reader\tdl-enclave.pkg.reader.v1\n"
        + "field\tpackage\nfield\tbuilt-by\nfield\tpayload\n"
        + "field\tmodule\nfield\tformat\nfield\taxes\nfield\trequires\nfield\trecord-id\n"
        + "refusal\tmagic\nrefusal\tframe-version\nrefusal\tflags\n"
        + "refusal\theader-oversize\nrefusal\theader-key\nrefusal\tmodule-kind\n"
        + "refusal\tmodule-path\nrefusal\tpayload-digest\nrefusal\ttrailer-digest\n"
        + "refusal\tlength\n");
}

/// <summary>
/// A <c>goose.mod</c> TSV module. The reader is deliberately header-only: the addon family has no
/// package converter here, but its declared format id still goes through the shared rule.
/// </summary>
public sealed class GooseModDocument
{
    public static string CurrentFormat => FormatFamilies.GooseMod.Current;
    public static string DigestDomain => FormatFamilies.GooseMod.DigestDomain;

    public string Format { get; private set; } = "";
    public string Text { get; private set; } = "";
    public bool UsesLegacyFormat { get; private set; }

    public static bool TryRead(string text, out GooseModDocument document, out string why)
    {
        document = new GooseModDocument();
        why = "";
        var lines = text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
        if (lines.Length == 0 || lines[0].Length == 0)
        {
            why = "format-schema: the mod header is missing";
            return false;
        }

        if (!FormatFamilies.GooseMod.TryUpgrade(lines[0], out var current, out var refusal))
        {
            why = $"{refusal}: {lines[0]}";
            return false;
        }

        document.Format = current;
        document.UsesLegacyFormat = FormatFamilies.GooseMod.IsLegacy(lines[0]);
        lines[0] = current;
        document.Text = string.Join('\n', lines);
        return true;
    }

    /// <summary>Emits the upgraded document: a legacy numeric input always leaves as the hashed id.</summary>
    public string Upgrade() => Text;
}

/// <summary>
/// The <c>dl-enclave.pkg</c> binary frame. The reader validates the frame enough to locate and
/// replace the header's format row; payload semantics stay with the enclave's own reader.
/// </summary>
public sealed class DlEnclaveFrame
{
    public static string CurrentFormat => FormatFamilies.DlEnclavePackage.Current;
    public static string DigestDomain => FormatFamilies.DlEnclavePackage.DigestDomain;

    private static readonly byte[] Magic = [0x44, 0x4c, 0x45, 0x50, 0, 0, 0, 1];
    private const int HeaderMax = 1 << 20;

    public bool UsesLegacyFormat { get; private set; }
    public byte[] Bytes { get; private set; } = [];

    public static bool TryUpgrade(byte[] frame, out DlEnclaveFrame upgraded, out string why)
    {
        upgraded = new DlEnclaveFrame();
        why = "";
        if (frame.Length < 16 + 8 + 32)
        {
            why = "length: frame is shorter than the minimum";
            return false;
        }
        if (!frame.AsSpan(0, 8).SequenceEqual(Magic))
        {
            why = "magic: expected DLEP frame";
            return false;
        }
        if (frame[8] != 1 || frame[9] != 0)
        {
            why = "frame-version: unsupported frame version or flags";
            return false;
        }

        var headerLength = (int)BinaryPrimitives.ReadUInt32LittleEndian(frame.AsSpan(12, 4));
        if (headerLength > HeaderMax || frame.Length < 16 + headerLength + 8 + 32)
        {
            why = "header-oversize: header length is outside the frame";
            return false;
        }

        var headerBytes = frame.AsSpan(16, headerLength);
        string header;
        try
        {
            header = new UTF8Encoding(false, true).GetString(headerBytes);
        }
        catch (DecoderFallbackException)
        {
            why = "header-encoding: header is not UTF-8";
            return false;
        }

        var newline = header.IndexOf('\n');
        var firstLine = newline < 0 ? header : header[..newline];
        if (!FormatFamilies.DlEnclavePackage.TryUpgrade(firstLine, out var current, out var refusal))
        {
            why = $"{refusal}: {firstLine}";
            return false;
        }

        upgraded.UsesLegacyFormat = FormatFamilies.DlEnclavePackage.IsLegacy(firstLine);
        if (!upgraded.UsesLegacyFormat)
        {
            upgraded.Bytes = frame;
            return true;
        }

        var newHeader = current + header[firstLine.Length..];
        var newHeaderBytes = Encoding.UTF8.GetBytes(newHeader);
        if (newHeaderBytes.Length > HeaderMax)
        {
            why = "header-oversize: upgraded header is too large";
            return false;
        }

        var payloadStart = 16 + headerLength;
        var payload = frame.AsSpan(payloadStart);
        var bodyLength = 16 + newHeaderBytes.Length + payload.Length;
        var result = new byte[bodyLength + 32];
        frame.AsSpan(0, 12).CopyTo(result);
        BinaryPrimitives.WriteUInt32LittleEndian(result.AsSpan(12, 4), (uint)newHeaderBytes.Length);
        newHeaderBytes.CopyTo(result, 16);
        payload.CopyTo(result.AsSpan(16 + newHeaderBytes.Length));
        SHA256.HashData(result.AsSpan(0, bodyLength), result.AsSpan(bodyLength, 32));
        upgraded.Bytes = result;
        return true;
    }
}

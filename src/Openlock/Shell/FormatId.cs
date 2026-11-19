using System.Security.Cryptography;
using System.Text;

namespace Openlock.Shell;

/// <summary>
/// The shared format-id rule: a modern id is <c>family/&lt;32 hex&gt;</c>; a numeric suffix is a
/// legacy counter that names no grammar. Every family uses the same rule, so an upgrader does not
/// need a special case for one counter value.
/// </summary>
public static class FormatId
{
    public enum Match
    {
        Current,
        Legacy,
        Mismatch,
        NotFormat,
    }

    /// <summary>The 32-hex identity of one contract text, under its family.</summary>
    public static string Hash(string family, string preimage)
    {
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(preimage));
        return family + "/" + Convert.ToHexString(digest.AsSpan(0, 16)).ToLowerInvariant();
    }

    /// <summary>
    /// Classifies one declared id against the id this reader computes. A numeric id is a legacy
    /// format and is read, not refused; a different hash is a different grammar.
    /// </summary>
    public static Match Classify(string declared, string current)
    {
        if (declared == current)
            return Match.Current;
        // A 32-character all-digit suffix is also a valid numeric string; the hash shape wins,
        // so it is refused as a foreign grammar rather than mistaken for a legacy counter.
        if (IsHashed(declared))
            return Match.Mismatch;
        if (IsNumeric(declared))
            return Match.Legacy;
        return Match.NotFormat;
    }

    public static bool IsNumeric(string id)
    {
        var (family, suffix) = Split(id);
        return family.Length > 0
            && suffix.Length > 0
            && !IsHashed(id)
            && suffix.All(char.IsAsciiDigit);
    }

    public static bool IsHashed(string id)
    {
        var (_, suffix) = Split(id);
        return suffix.Length == 32
            && suffix.All(c => char.IsAsciiDigit(c) || c is >= 'a' and <= 'f');
    }

    public static bool SameFamily(string left, string right) =>
        string.Equals(Family(left), Family(right), StringComparison.Ordinal);

    public static string Family(string id)
    {
        var slash = id.LastIndexOf('/');
        return slash <= 0 ? "" : id[..slash];
    }

    public static string Suffix(string id)
    {
        var slash = id.LastIndexOf('/');
        return slash <= 0 || slash == id.Length - 1 ? "" : id[(slash + 1)..];
    }

    /// <summary>Whether a family/noun has the shape every format id uses.</summary>
    public static bool IsFamily(string family) =>
        family.Length > 0
        && family.Split('.').All(part =>
            part.Length > 0
            && !part.Contains("--", StringComparison.Ordinal)
            && char.IsAsciiLetterLower(part[0])
            && part.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c == '-'));

    private static (string Family, string Suffix) Split(string id)
    {
        var slash = id.LastIndexOf('/');
        if (slash <= 0 || slash == id.Length - 1)
            return ("", "");
        return (id[..slash], id[(slash + 1)..]);
    }
}

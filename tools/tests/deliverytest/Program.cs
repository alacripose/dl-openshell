using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Openlock.Shell;

// Deterministic checks over the server half of live delivery: versioned replacement, the
// zero-window success signal, and bounded refusal records. The panorama half is
// tools/tests/test_delivery.js.

static void Check(bool condition, string what)
{
    if (condition)
    {
        Console.WriteLine("ok   " + what);
        return;
    }

    Console.Error.WriteLine("FAIL " + what);
    Environment.Exit(1);
}

static string Describe(AddonPackages addons)
{
    var json = addons.PayloadJson();
    using var doc = JsonDocument.Parse(json);
    var root = doc.RootElement;
    var packages = root.GetProperty("packages");
    var windows = root.GetProperty("windows");
    var version = packages.GetArrayLength() > 0 ? packages[0].GetProperty("version").GetString() : "-";
    var title = windows.GetArrayLength() > 0 ? windows[0].GetProperty("title").GetString() : "-";
    return $"rev={root.GetProperty("revision").GetInt64()} packages={packages.GetArrayLength()} windows={windows.GetArrayLength()} version={version} title={title}";
}

// SHPKG002: magic, little-endian recipe length, SHA-256 of the recipe, recipe.
static string WriteFrame(string dir, string name, string recipe)
{
    var source = Encoding.UTF8.GetBytes(recipe.EndsWith('\n') ? recipe : recipe + "\n");
    var frame = new byte[44 + source.Length];
    Encoding.ASCII.GetBytes("SHPKG002").CopyTo(frame, 0);
    BitConverter.GetBytes((uint)source.Length).CopyTo(frame, 8);
    SHA256.HashData(source).CopyTo(frame, 12);
    source.CopyTo(frame, 44);
    var path = Path.Combine(dir, name + ".shpkg");
    File.WriteAllBytes(path, frame);
    return path;
}

var scratch = Path.Combine(Path.GetTempPath(), "openlock-delivery-" + Guid.NewGuid().ToString("N"));
var frames = Path.Combine(scratch, "frames");
Directory.CreateDirectory(frames);
var fixtures = Path.GetFullPath("tools/tests/fixtures");

static byte[] LegacyVersion(byte[] frame, string from, string to)
{
    var oldLength = (int)BitConverter.ToUInt32(frame, 8);
    var source = Encoding.UTF8.GetString(frame, 44, oldLength).Replace(from, to);
    var recipe = Encoding.UTF8.GetBytes(source);
    var tail = frame[(44 + oldLength)..];
    var result = new byte[44 + recipe.Length + tail.Length];
    frame[..44].CopyTo(result, 0);
    BitConverter.GetBytes((uint)recipe.Length).CopyTo(result, 8);
    SHA256.HashData(recipe).CopyTo(result, 12);
    recipe.CopyTo(result, 44);
    tail.CopyTo(result, 44 + recipe.Length);
    return result;
}

var addons = new AddonPackages();
var v1 = Path.Combine(fixtures, "proof-v1.shpkg");
var v2 = Path.Combine(frames, "proof-v2.shpkg");
var bad = Path.Combine(frames, "proof-v3-bad.shpkg");
var v1Bytes = File.ReadAllBytes(v1);
File.WriteAllBytes(v2, LegacyVersion(v1Bytes, "1-0-0", "2-0-0"));
File.WriteAllBytes(bad, LegacyVersion(v1Bytes, "1-0-0", "0-9-0"));

var added = addons.Deliver(v1, out var why, out var changed);
Check(added == 1 && changed && why.Length == 0, "v1 mounts one window");
Check(addons.LastChangedWindow == "addon:proof-ui:proof-panel", "v1 names its changed window");
Console.WriteLine($"     v1 {Describe(addons)}");

added = addons.Deliver(v2, out why, out changed);
Check(added == 1 && changed && why.Length == 0, "v2 replaces v1");
Check(addons.Windows.Count == 1 && addons.Packages.Count == 1, "v2 keeps one package and one window");
Check(addons.LastChangedWindow == "addon:proof-ui:proof-panel", "v2 names its changed window");
Console.WriteLine($"     v2 {Describe(addons)}");

added = addons.Deliver(v1, out why, out changed);
Check(added == 0 && !changed && why.Length > 0, "an older version is refused");
Check(addons.Packages[0].Version == "2-0-0", "the older version leaves v2 mounted");
Check(addons.LastChangedWindow.Length == 0, "a refused delivery names no window");
Console.WriteLine($"     v1-again {Describe(addons)}");

added = addons.Deliver(bad, out why, out changed);
Check(added == 0 && !changed && why.Length > 0, "a refused replacement is reported and not republished");
Check(addons.Packages[0].Version == "2-0-0" && addons.Windows.Count == 1, "a refused replacement leaves v2 mounted");
Check(addons.LastChangedWindow.Length == 0, "a refused replacement names no window");
Console.WriteLine($"     v3-bad {Describe(addons)}");

added = addons.Deliver(v2, out why, out changed);
Check(added == 0 && !changed && why.Length > 0, "an unchanged v2 is already mounted, not re-added");
Console.WriteLine($"     v2-again {Describe(addons)}");

// A valid package with no windows commits state but mounts nothing. That is a successful
// delivery, not a refusal: the payload revision advances and the previous zero-window version
// is replaced. CmdDeliver's final reply is decided from exactly these three values.
var zeroRecipe = "shploingus.recipe/3\npackage\tzero-demo\t1-0-0\nrow\tnote-1\tzero windows\n";
var zeroPath = WriteFrame(frames, "zero-v1", zeroRecipe);
var direct = ShpPackage.LoadFile(zeroPath);
foreach (var refusal in direct.Refusals)
    Console.WriteLine($"     zero refusal {refusal.Line} {refusal.Subject}: {refusal.Why}");
Check(direct.Windows.Count == 0 && direct.Rows.Count == 1 && direct.Refusals.Count == 0,
    "a zero-window recipe parses cleanly");

var zero = new AddonPackages();
added = zero.Deliver(zeroPath, out why, out changed);
Check(added == 0 && changed && why.Length == 0, "a zero-window package reports success, not a refusal");
Check(zero.Packages.Count == 1 && zero.Windows.Count == 0, "a zero-window package is recorded with no windows");
Check(zero.Revision == 1, "a zero-window package advances the revision");
Check(zero.LastChangedWindow.Length == 0, "a zero-window package names no window");
Console.WriteLine($"     zero {Describe(zero)}");

var zero2Path = WriteFrame(frames, "zero-v2", "shploingus.recipe/3\npackage\tzero-demo\t2-0-0\nrow\tnote-1\tzero windows\n");
added = zero.Deliver(zero2Path, out why, out changed);
Check(added == 0 && changed && why.Length == 0, "a zero-window replacement reports success");
Check(zero.Packages.Count == 1 && zero.Packages[0].Version == "2-0-0", "a zero-window replacement replaces the record");
Console.WriteLine($"     zero-v2 {Describe(zero)}");

// Refused archives with invalid names are the unbounded path: they reach CommitRefusal before
// the mounted-package ceiling. The record list must stay at MaxPackages, not grow per refusal.
var cap = new AddonPackages();
for (var i = 0; i < 80; i++)
{
    var badName = WriteFrame(frames, "bad-name-" + i,
        "shploingus.recipe/3\npackage\tBAD" + i + "\t1-0-0\n");
    cap.Deliver(badName, out _, out _);
}

Check(cap.Packages.Count <= 64, "refusal records stay bounded by the package ceiling");
Check(cap.Packages.Count == 64, "the bounded set keeps the newest refusals (64 of 80)");
Check(cap.RefusalCount > 0 && cap.Windows.Count == 0, "bounded records are refusals, not mounted windows");
Check(cap.Revision == 80, "every committed refusal still advanced the revision");
Console.WriteLine($"     cap packages={cap.Packages.Count} refusals={cap.RefusalCount} revision={cap.Revision}");

Console.WriteLine("server delivery harness: PASS");

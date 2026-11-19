using System.Buffers.Binary;
using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

using Blake3;
using Openlock.Shell;

var root = Path.GetFullPath(args.Length > 0 ? args[0] : Directory.GetCurrentDirectory());
var scratch = Path.Combine(root, "artifacts", "packagetests");
Directory.CreateDirectory(scratch);
var fixtures = Path.Combine(root, "tools", "tests", "fixtures");
var checks = 0;

void Check(bool condition, string name)
{
    checks++;
    if (!condition)
        throw new InvalidOperationException("FAILED: " + name);
    Console.WriteLine("ok " + checks + " - " + name);
}

Check(SurfaceDocument.CurrentFormat == "secure-shell.surface/7af4f34e745ebf547b3fc71146ef314c",
    "surface format id pins the current contract");
Check(ModernPackage.ObjectSchema == "secure-shell.package/ff53bde81a9e26562c739676fff7d28e",
    "package format id pins the current contract");
Check(FormatFamilies.Addons.Current == "openlock.addons/a5d7cf25e0a40c0a06b836992556491d",
    "addon format id pins the current contract");
Check(FormatFamilies.GooseMod.Current == "goose.mod/0aae19884ea41415867d1385deea60e3",
    "goose.mod format id pins the current contract");
Check(FormatFamilies.DlEnclavePackage.Current == "dl-enclave.pkg/7eda1d82c5a03cc74883059912e73f71",
    "enclave package format id pins the current contract");
Check(AddonPackages.PayloadFormat == FormatFamilies.Addons.Current,
    "the addon emitter uses the shared family id");

// These are the ids recorded by the shipped and generated surfaces. They are written down here,
// not read from those surfaces, so a change to any contract byte or to a recorded artifact is a
// failing test rather than a silently updated expectation. The companion Python drift guard
// checks every occurrence in release, dist, landing, docs and generated data against this table.
var expectedFamilyIds = new Dictionary<string, string>(StringComparer.Ordinal)
{
    ["openlock.game"] = "openlock.game/05b2d815a8a5f1006596d6b0d9e0fa27",
    ["shploingus.recipe"] = "shploingus.recipe/30444cad3419800564faba6d4e252431",
    ["shploingus.cells"] = "shploingus.cells/f6306ccc4ce664c4fe78a6fad235d513",
    ["shploingus.cellframe"] = "shploingus.cellframe/3424d7cb9aa673dc7d5c9da7e0c9e1e7",
    ["shploingus.deadlock"] = "shploingus.deadlock/56f44490493209422686cb3e00c27183",
    ["openlock.layout"] = "openlock.layout/9702e4449ba6ae96c573b5cd8306ec38",
    ["openlock.layouts"] = "openlock.layouts/dbae98d8aa591e237c57be5542bc77e3",
    ["openlock.envelope"] = "openlock.envelope/d593054cb466a871f47d4804b3e2f333",
    ["openlock.build"] = "openlock.build/c0fe71e57305319a492946bbe18ea9dd",
    ["openlock.observer"] = "openlock.observer/2a438fa886e575a6ae8b071e5c67616e",
    ["shploingus.theme"] = "shploingus.theme/339926f6b1b54ebb89810d4c6238d523",
    ["shploingus.form"] = "shploingus.form/0c51154398407e2a79127583436d2808",
    ["openlock.popit-elements"] = "openlock.popit-elements/2e5179fe9a5d337f5c0f68914bfa04b7",
    ["openlock.cua-client"] = "openlock.cua-client/9d35178a82c4bf0c0cc46c87f793d2e4",
    ["secure-shell.axis"] = "secure-shell.axis/63b0129a9a354ccfa21b74b17e4af1a3",
    ["cua.fleet.summary"] = "cua.fleet.summary/2975721bba429d4f123977ab18fe5587",
    ["goose.vanilla"] = "goose.vanilla/109e73f54aaaa7e072bbcb452569ebde",
    ["goose.client"] = "goose.client/d6f8a8b171f8c253b095d99f92e95b4a",
    ["goose.java"] = "goose.java/3541a98228cfcdb8f1ba8e9b9b6ada4c",
    ["goose.native"] = "goose.native/a9e76f386aa82fc858d89977af1637f0",
    ["dl-enclave.sig"] = "dl-enclave.sig/e9c5728c3745931d112839d8cdb0ced6",
    ["openlock.addons"] = "openlock.addons/a5d7cf25e0a40c0a06b836992556491d",
    ["goose.mod"] = "goose.mod/0aae19884ea41415867d1385deea60e3",
    ["dl-enclave.pkg"] = "dl-enclave.pkg/7eda1d82c5a03cc74883059912e73f71",
};

// Every declared family goes through the same rule. Reflection keeps this table honest when a
// family is added: no family can be covered only by a hand-written one-off test.
var familyFields = typeof(FormatFamilies)
    .GetFields(BindingFlags.Public | BindingFlags.Static)
    .Where(field => field.FieldType == typeof(FormatFamily))
    .OrderBy(field => field.Name, StringComparer.Ordinal)
    .ToArray();
Check(GooseModDocument.DigestDomain == FormatFamilies.GooseMod.Current
    && DlEnclaveFrame.DigestDomain == FormatFamilies.DlEnclavePackage.Current,
    "reader digest domains are the same computed ids as their families");
Check(familyFields.Length >= 21, "the family table exposes every declared format family");
Check(familyFields.Length == expectedFamilyIds.Count,
    "the expected-id table covers every declared family; add a family without its recorded id is a failure");
foreach (var field in familyFields)
{
    var family = (FormatFamily)field.GetValue(null)!;
    Check(expectedFamilyIds.TryGetValue(family.Name, out var expectedId),
        $"{family.Name}: a recorded id exists for the family");
    Check(family.Current == expectedId,
        $"{family.Name}: contract bytes still compute the recorded id");
    Check(family.DigestDomain == family.Current,
        $"{family.Name}: the computed id is the digest domain");
    Check(family.TryUpgrade($"{family.Name}/0", out var zeroUpgrade, out _)
        && zeroUpgrade == family.Current,
        $"{family.Name}: counter /0 is a legacy input");
    Check(family.TryUpgrade($"{family.Name}/0007", out var paddedUpgrade, out _)
        && paddedUpgrade == family.Current,
        $"{family.Name}: leading-zero counter /0007 is a legacy input");
    Check(family.TryUpgrade($"{family.Name}/37", out var numericUpgrade, out _)
        && numericUpgrade == family.Current,
        $"{family.Name}: counter /37 is a legacy input");
    Check(family.TryUpgrade(family.Current, out var hashed, out _)
        && hashed == family.Current,
        $"{family.Name}: the current hash is discovered");
    Check(!family.TryUpgrade($"{family.Name}/00000000000000000000000000000000", out _, out var sameFamilyRefusal)
        && sameFamilyRefusal == "format-hash-mismatch",
        $"{family.Name}: a foreign hash in the same family is refused");
    Check(!family.TryUpgrade("not.a.family/7", out _, out var foreignFamilyRefusal)
        && foreignFamilyRefusal == "format-hash-mismatch",
        $"{family.Name}: a foreign family is refused");
}

// BLAKE3 itself must agree with the family implementation before the preimage is trusted.
using (var empty = Hasher.New())
{
    empty.Update(ReadOnlySpan<byte>.Empty);
    var digest = Convert.ToHexString(empty.Finalize().AsSpan()).ToLowerInvariant();
    Check(digest == "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
        "BLAKE3 empty-string vector");
}

// The old frame is a read-only decoder. Loading it must produce exactly the same package it did
// before the modern carrier existed.
var legacyPath = Path.Combine(fixtures, "proof-v1.shpkg");
var legacy = ShpPackage.LoadFile(legacyPath);
Check(legacy.Refusals.Count == 0, "legacy SHPKG003 fixture loads without refusals");
Check(legacy.Magic == "SHPKG003", "legacy fixture keeps its SHPKG003 magic");
Check(legacy.Name == "proof-ui" && legacy.Version == "1-0-0", "legacy name and version are unchanged");
Check(legacy.Windows.Count == 1 && legacy.Windows[0].Id == "proof-panel",
    "legacy window is unchanged");
Check(legacy.Windows[0].Content == "readout" && legacy.Windows[0].Geometry.SequenceEqual([180, 150, 460, 320]),
    "legacy window content and geometry are unchanged");
Check(legacy.SourceDigest.Length == 64 && legacy.PackageDigest.Length == 64,
    "legacy source and frame digests are still SHA-256 hex");

// SHPKG002 is the same payload without the artifact table; both legacy magics must still read.
var legacyFrame = File.ReadAllBytes(legacyPath);
var legacySourceLength = BitConverter.ToUInt32(legacyFrame, 8);
var sourceOnly = legacyFrame[..(44 + (int)legacySourceLength)];
System.Text.Encoding.ASCII.GetBytes(ShpPackage.MagicSource).CopyTo(sourceOnly, 0);
var legacy2 = ShpPackage.Parse(sourceOnly, "synthetic-002");
Check(legacy2.Refusals.Count == 0 && legacy2.Magic == "SHPKG002", "legacy SHPKG002 still reads");
Check(legacy2.Name == legacy.Name && legacy2.Windows.Count == legacy.Windows.Count,
    "SHPKG002 and SHPKG003 decode to the same declaration");

var proofDir = Path.Combine(scratch, "modern-proof");
var payloadPath = Path.Combine(proofDir, "payload.bin");
if (File.Exists(payloadPath))
    File.Delete(payloadPath);

var start = new ProcessStartInfo("python")
{
    WorkingDirectory = root,
    RedirectStandardOutput = true,
    RedirectStandardError = true,
    UseShellExecute = false,
};
start.ArgumentList.Add("tools/modern_package.py");
start.ArgumentList.Add("--proof");
start.ArgumentList.Add("--out");
start.ArgumentList.Add(proofDir);
start.ArgumentList.Add("--name");
start.ArgumentList.Add("openlock-size-proof");
using var process = Process.Start(start) ?? throw new InvalidOperationException("python did not start");
var stdout = process.StandardOutput.ReadToEnd();
var stderr = process.StandardError.ReadToEnd();
process.WaitForExit();
Check(process.ExitCode == 0, "modern packer exits cleanly: " + stderr.Trim());
using var written = JsonDocument.Parse(stdout);
var report = written.RootElement;
Check(report.GetProperty("state").GetString() == "held", "modern packer holds the package");
var expectedLength = report.GetProperty("length").GetInt64();
var expectedDigest = report.GetProperty("digest").GetString() ?? "";
var expectedIdentity = report.GetProperty("identity").GetString() ?? "";
Check(expectedLength > 4L * 1024 * 1024 * 1024, "packer payload is larger than 4 GiB");
Check(expectedLength == 4L * 1024 * 1024 * 1024 + 1, "packer writes the exact 4 GiB + 1 payload");

var manifestPath = Path.Combine(proofDir, "manifest.json");
Check(ModernPackage.TryLoad(manifestPath, payloadPath, out var modern, out var why),
    "C# reader loads the modern package: " + why);
File.WriteAllBytes(Path.Combine(proofDir, "manifest.canonical.csharp"), modern.CanonicalManifest);
Check(modern.PayloadBytes == expectedLength, "reader sees the exact 64-bit payload length");
Check(modern.Lengths["payload"] == expectedLength, "manifest length and filesystem length agree");
Check(modern.ContentDigest == expectedDigest, $"reader reproduces the packer's BLAKE3 payload content digest ({modern.ContentDigest} vs {expectedDigest})");
Check(modern.Identity == expectedIdentity, "reader reproduces the full package identity");
Check(File.ReadAllText(Path.Combine(proofDir, "identity.txt")).Trim() == expectedIdentity,
    "identity file matches the computed identity");
Check(modern.Schemas.Contains(ModernPackage.ObjectSchema), "modern package carries its hashed format id");

using (var payload = File.OpenRead(payloadPath))
{
    payload.Seek(0, SeekOrigin.Begin);
    Check(payload.ReadByte() == 2, "4 GiB payload's first offset witness is present");
    payload.Seek(expectedLength / 2, SeekOrigin.Begin);
    Check(payload.ReadByte() == 3, "4 GiB payload's middle offset witness is present");
    payload.Seek(-1, SeekOrigin.End);
    Check(payload.ReadByte() == 1, "4 GiB payload's final sentinel byte is present");
}

// A declared length that is not the file's length is a refusal, not a truncation.
var tamperedPath = Path.Combine(proofDir, "manifest-tampered.json");
var node = JsonNode.Parse(File.ReadAllText(manifestPath))!.AsObject();
node["lengths"]!.AsObject()["payload"] = expectedLength + 1;
File.WriteAllText(tamperedPath, node.ToJsonString());
Check(!ModernPackage.TryLoad(tamperedPath, payloadPath, out _, out var refusal),
    "reader refuses a manifest that declares the wrong payload length");
Check(refusal.Contains("declares", StringComparison.Ordinal), "wrong-length refusal names the declaration");

var treeDir = Path.Combine(fixtures, "modern-tree");
Check(ModernPackage.TryLoad(Path.Combine(treeDir, "manifest.json"), Path.Combine(treeDir, "payload.bin"),
        out var treePackage, out var treeWhy),
    "C# reader loads a modern file-index package: " + treeWhy);
Check(treePackage.Identity == File.ReadAllText(Path.Combine(treeDir, "identity.txt")).Trim(),
    "file-index package identity is stable");

// A numeric package schema is a legacy migration input, not a /1 special case.
var legacyManifestPath = Path.Combine(scratch, "legacy-package-manifest.json");
var legacyManifest = JsonNode.Parse(File.ReadAllText(Path.Combine(treeDir, "manifest.json")))!.AsObject();
legacyManifest["schemas"] = new JsonArray(
    JsonValue.Create("secure-shell.files/1f5ac72f412f8462bff666a8e3b36eea"),
    JsonValue.Create("secure-shell.package/7"));
File.WriteAllText(legacyManifestPath, legacyManifest.ToJsonString());
Check(ModernPackage.TryLoad(legacyManifestPath, Path.Combine(treeDir, "payload.bin"),
        out var legacyPackage, out var legacyManifestWhy)
    && legacyPackage.UsesLegacyFormat,
    "numeric package schema is read as a legacy migration input: " + legacyManifestWhy);

// The modern surface path: pack a surface document into the canonical package, then deliver that
// directory through the real AddonPackages path.
var surfaceSource = Path.Combine(root, "examples", "motd-addon", "package.surface");
var surfaceDir = Path.Combine(scratch, "modern-surface");
var packedSurface = RunPython("tools/modern_package.py", "--surface", surfaceSource, "--out", surfaceDir,
    "--name", "motd-demo");
Check(packedSurface.Code == 0, "surface packer exits cleanly: " + packedSurface.Stderr.Trim());

var addonRoot = Path.Combine(scratch, "addon-root");
if (Directory.Exists(addonRoot))
    Directory.Delete(addonRoot, true);
Directory.CreateDirectory(addonRoot);
var installedPackage = Path.Combine(addonRoot, "motd-demo.pkg");
Directory.CreateDirectory(installedPackage);
foreach (var file in new[] { "manifest.json", "payload.bin", "identity.txt" })
    File.Copy(Path.Combine(surfaceDir, file), Path.Combine(installedPackage, file));
var discovered = AddonPackages.DiscoverFromRoots([addonRoot]);
Check(discovered.Windows.Count == 1 && discovered.Packages.Count == 1,
    "addon discovery finds the modern .pkg directory");
Check(discovered.Windows[0].Id == "addon:motd-demo:motd-panel",
    "discovered modern window has the addon-qualified id");

var addons = new AddonPackages();
var added = addons.Deliver(surfaceDir, out var addWhy);
Check(added == 1, "real AddonPackages path discovers one modern surface window: " + addWhy);
Check(addons.Windows.Count == 1, "modern surface produces exactly one window");
var modernWindow = addons.Windows[0];
Check(modernWindow.Id == "addon:motd-demo:motd-panel", "modern window keeps the addon-qualified id");
Check(modernWindow.Title == "Server MOTD" && modernWindow.Content == "readout",
    "modern window carries title and content");
Check(modernWindow.Lane == "tab" && modernWindow.Extent == "square-pixels",
    "modern window carries lane and pixel extent");
Check(modernWindow.Geometry.SequenceEqual([180, 150, 460, 320]),
    "modern window carries the surface geometry");
Check(modernWindow.MinSize.SequenceEqual([280, 150]), "modern window carries the surface minimum");
Check(modernWindow.Layout == "title-position,minimize,maximize,close",
    "modern chrome becomes the same title-bar layout policy");
Check(modernWindow.Behavior == "drag,resize,minimize,maximize,close",
    "modern moves and chrome become the same behavior policy");
Check(modernWindow.ThemeRole == "surface" && modernWindow.Pinnable,
    "modern window carries theme role and pinnable");
Check(modernWindow.Rule == "right-dock" && !modernWindow.Pinned,
    "surface placement rule and pinned state are preserved");
Check(modernWindow.SurfaceRequires == "observe", "surface capability is preserved");
Check(modernWindow.SurfaceNodes.Count == 3 && modernWindow.LiveTree is { Count: 1 },
    "surface nodes and the live tree travel together");
Check(addons.Packages.Count == 1 && addons.Packages[0].Carrier == "modern"
    && addons.Packages[0].Surface == "motd-demo"
    && addons.Packages[0].Digest.StartsWith("blake3:", StringComparison.Ordinal),
    "package record names the modern carrier and BLAKE3 identity");
Check(addons.PayloadJson().Contains("surfaceNodes", StringComparison.Ordinal),
    "surface node rows survive serialization into the addon payload");
Check(addons.PayloadJson().Contains("\"format\":\"" + FormatFamilies.Addons.Current + "\"", StringComparison.Ordinal),
    "the addon payload emits only the hashed family id");

// One shared rule, applied per family: any numeric counter is a legacy input; a foreign hash is a
// different grammar. The examples use counters other than /1 and /2 deliberately.
Check(FormatFamilies.Addons.TryUpgrade("openlock.addons/7", out var addonUpgrade, out _)
    && addonUpgrade == FormatFamilies.Addons.Current,
    "addon /7 is a legacy input upgraded to the hashed id");
Check(FormatFamilies.GooseMod.TryUpgrade("goose.mod/9", out var modUpgrade, out _)
    && modUpgrade == FormatFamilies.GooseMod.Current,
    "goose.mod /9 is a legacy input upgraded to the hashed id");
Check(FormatFamilies.DlEnclavePackage.TryUpgrade("dl-enclave.pkg/12", out var enclaveUpgrade, out _)
    && enclaveUpgrade == FormatFamilies.DlEnclavePackage.Current,
    "enclave package /12 is a legacy input upgraded to the hashed id");
Check(!FormatFamilies.Addons.TryUpgrade("secure-shell.surface/7af4f34e745ebf547b3fc71146ef314c", out _, out var foreignFamily)
    && foreignFamily == "format-hash-mismatch",
    "a hash from another family is refused by name");
Check(!FormatFamilies.GooseMod.TryUpgrade("goose.mod/00000000000000000000000000000000", out _, out var foreignHash)
    && foreignHash == "format-hash-mismatch",
    "a foreign hash in the same family is refused by name");
Check(FormatFamilies.Addons.TryUpgrade(FormatFamilies.Addons.Current, out var addonHashed, out _)
    && addonHashed == FormatFamilies.Addons.Current,
    "the current addon hash is discovered as the family id");
Check(FormatFamilies.GooseMod.TryUpgrade(FormatFamilies.GooseMod.Current, out var modHashed, out _)
    && modHashed == FormatFamilies.GooseMod.Current,
    "the current goose.mod hash is discovered as the family id");
Check(FormatFamilies.DlEnclavePackage.TryUpgrade(FormatFamilies.DlEnclavePackage.Current, out var enclaveHashed, out _)
    && enclaveHashed == FormatFamilies.DlEnclavePackage.Current,
    "the current enclave package hash is discovered as the family id");

// The goose.mod and dl-enclave.pkg readers upgrade the header they read; only the header is in
// scope here. The full payload semantics stay with each family's own reader.
Check(GooseModDocument.TryRead("goose.mod/17\nmod\tproof\t1.0.0\n", out var gooseMod, out var modWhy)
    && gooseMod.UsesLegacyFormat
    && gooseMod.Format == FormatFamilies.GooseMod.Current
    && gooseMod.Upgrade().StartsWith(FormatFamilies.GooseMod.Current + "\n", StringComparison.Ordinal),
    "goose.mod reader accepts a numeric counter and re-emits the hashed id: " + modWhy);
Check(GooseModDocument.TryRead(FormatFamilies.GooseMod.Current + "\nmod\tproof\t1.0.0\n",
        out var hashedGooseMod, out var hashedModWhy)
    && !hashedGooseMod.UsesLegacyFormat
    && hashedGooseMod.Format == FormatFamilies.GooseMod.Current,
    "goose.mod reader discovers the current hashed id: " + hashedModWhy);
Check(!GooseModDocument.TryRead("goose.mod/ffffffffffffffffffffffffffffffff\n", out _, out var gooseRefusal)
    && gooseRefusal.Contains("format-hash-mismatch", StringComparison.Ordinal),
    "goose.mod reader refuses a foreign hash");

var legacyEnclave = MakeEnclaveFrame("dl-enclave.pkg/23");
Check(DlEnclaveFrame.TryUpgrade(legacyEnclave, out var upgradedEnclave, out var enclaveWhy)
    && upgradedEnclave.UsesLegacyFormat
    && ReadEnclaveHeader(upgradedEnclave.Bytes).StartsWith(FormatFamilies.DlEnclavePackage.Current + "\n", StringComparison.Ordinal),
    "dl-enclave.pkg reader accepts a numeric counter and re-emits the hashed id: " + enclaveWhy);
Check(ReadEnclaveTrailer(upgradedEnclave.Bytes).SequenceEqual(
        SHA256.HashData(upgradedEnclave.Bytes.AsSpan(0, upgradedEnclave.Bytes.Length - 32))),
    "the upgraded enclave frame has a trailer over the new header");
Check(DlEnclaveFrame.TryUpgrade(MakeEnclaveFrame(FormatFamilies.DlEnclavePackage.Current), out var hashedEnclave, out var hashedEnclaveWhy)
    && !hashedEnclave.UsesLegacyFormat
    && hashedEnclave.Bytes.SequenceEqual(MakeEnclaveFrame(FormatFamilies.DlEnclavePackage.Current)),
    "dl-enclave.pkg reader discovers the current hashed id: " + hashedEnclaveWhy);
Check(!DlEnclaveFrame.TryUpgrade(MakeEnclaveFrame("dl-enclave.pkg/00000000000000000000000000000000"), out _, out var enclaveRefusal)
    && enclaveRefusal.Contains("format-hash-mismatch", StringComparison.Ordinal),
    "dl-enclave.pkg reader refuses a foreign hash");

// The Python rewriters follow the same path, including the `upgraded` receipt for counters other
// than /1 and /2, and report the refusal by name.
var addonLegacyPath = Path.Combine(scratch, "legacy-addons.json");
File.WriteAllText(addonLegacyPath, "{\"format\":\"openlock.addons/7\",\"revision\":1,\"packages\":[],\"windows\":[]}");
var addonRewrite = RunPython("tools/modern_package.py", "--addons", addonLegacyPath,
    "--out", Path.Combine(scratch, "legacy-addons"));
Check(addonRewrite.Code == 0 && addonRewrite.Stdout.Contains("\"upgraded\": true", StringComparison.Ordinal),
    "addon rewriter reports a numeric legacy id as upgraded: " + addonRewrite.Stderr.Trim());
Check(File.ReadAllText(Path.Combine(scratch, "legacy-addons", "addons.json"))
        .Contains(FormatFamilies.Addons.Current, StringComparison.Ordinal),
    "addon rewriter emits the hashed id");

var modLegacyPath = Path.Combine(scratch, "legacy-goose.mod.tsv");
File.WriteAllText(modLegacyPath, "goose.mod/9\nmod\tproof\t1.0.0\n");
var modRewrite = RunPython("tools/modern_package.py", "--mod", modLegacyPath,
    "--out", Path.Combine(scratch, "legacy-mod"));
Check(modRewrite.Code == 0 && modRewrite.Stdout.Contains("\"upgraded\": true", StringComparison.Ordinal),
    "mod rewriter reports a numeric legacy id as upgraded: " + modRewrite.Stderr.Trim());
Check(File.ReadAllText(Path.Combine(scratch, "legacy-mod", "goose.mod.tsv"))
        .StartsWith(FormatFamilies.GooseMod.Current + "\n", StringComparison.Ordinal),
    "mod rewriter emits the hashed id");

var enclaveLegacyPath = Path.Combine(scratch, "legacy-enclave.dle");
File.WriteAllBytes(enclaveLegacyPath, MakeEnclaveFrame("dl-enclave.pkg/12"));
var enclaveRewrite = RunPython("tools/modern_package.py", "--enclave", enclaveLegacyPath,
    "--out", Path.Combine(scratch, "legacy-enclave"));
Check(enclaveRewrite.Code == 0 && enclaveRewrite.Stdout.Contains("\"upgraded\": true", StringComparison.Ordinal),
    "enclave rewriter reports a numeric legacy id as upgraded: " + enclaveRewrite.Stderr.Trim());
var enclaveRewrittenPath = Path.Combine(scratch, "legacy-enclave", "package.dle");
var enclaveRewritten = File.ReadAllBytes(enclaveRewrittenPath);
Check(ReadEnclaveHeader(enclaveRewritten).StartsWith(FormatFamilies.DlEnclavePackage.Current + "\n", StringComparison.Ordinal),
    "enclave rewriter emits the hashed id");
Check(ReadEnclaveTrailer(enclaveRewritten).SequenceEqual(
        SHA256.HashData(enclaveRewritten.AsSpan(0, enclaveRewritten.Length - 32))),
    "enclave rewriter recomputes the trailer");

var foreignAddonPath = Path.Combine(scratch, "foreign-addons.json");
File.WriteAllText(foreignAddonPath, "{\"format\":\"secure-shell.surface/7af4f34e745ebf547b3fc71146ef314c\"}");
var foreignAddon = RunPython("tools/modern_package.py", "--addons", foreignAddonPath,
    "--out", Path.Combine(scratch, "foreign-addons"));
Check(foreignAddon.Code != 0 && foreignAddon.Stdout.Contains("format-hash-mismatch", StringComparison.Ordinal),
    "addon rewriter refuses a foreign family");
var foreignMod = RunPython("tools/modern_package.py", "--mod", modLegacyPath,
    "--out", Path.Combine(scratch, "foreign-mod"));
Check(foreignMod.Code == 0 && foreignMod.Stdout.Contains("\"upgraded\": true", StringComparison.Ordinal),
    "a same-family numeric mod id remains a migration input");
var foreignModPath = Path.Combine(scratch, "foreign-goose.mod.tsv");
File.WriteAllText(foreignModPath, "goose.mod/00000000000000000000000000000000\n");
var foreignModHash = RunPython("tools/modern_package.py", "--mod", foreignModPath,
    "--out", Path.Combine(scratch, "foreign-mod-hash"));
Check(foreignModHash.Code != 0 && foreignModHash.Stdout.Contains("format-hash-mismatch", StringComparison.Ordinal),
    "mod rewriter refuses a foreign hash");
File.WriteAllBytes(enclaveLegacyPath, MakeEnclaveFrame("dl-enclave.pkg/00000000000000000000000000000000"));
var foreignEnclave = RunPython("tools/modern_package.py", "--enclave", enclaveLegacyPath,
    "--out", Path.Combine(scratch, "foreign-enclave"));
Check(foreignEnclave.Code != 0 && foreignEnclave.Stdout.Contains("format-hash-mismatch", StringComparison.Ordinal),
    "enclave rewriter refuses a foreign hash");

// A manifest name that does not match the surface id is refused, not mounted.
var mismatchDir = Path.Combine(scratch, "modern-surface-mismatch");
if (Directory.Exists(mismatchDir))
    Directory.Delete(mismatchDir, true);
Directory.CreateDirectory(mismatchDir);
File.Copy(Path.Combine(surfaceDir, "payload.bin"), Path.Combine(mismatchDir, "payload.bin"));
var mismatchManifest = JsonNode.Parse(File.ReadAllText(Path.Combine(surfaceDir, "manifest.json")))!.AsObject();
mismatchManifest["name"] = "different-name";
File.WriteAllText(Path.Combine(mismatchDir, "manifest.json"), mismatchManifest.ToJsonString());
var mismatchAddons = new AddonPackages();
Check(mismatchAddons.Deliver(mismatchDir, out var mismatchWhy) == 0
    && mismatchAddons.Windows.Count == 0
    && mismatchWhy.Contains("surface-declared-id", StringComparison.Ordinal),
    "manifest/surface id mismatch is refused by name: " + mismatchWhy);

// Duplicate window ids in the surface itself are refused before anything is mounted.
var badSurfacePath = Path.Combine(scratch, "bad-surface.surface");
File.WriteAllText(badSurfacePath, SurfaceDocument.CurrentFormat + "\nsurface\tbad-surface\nrequires\tobserve\n"
    + "window\tone\tOne\ttab\tfill\t0\t0\t100\t100\t0\t0\ttrue\tfalse\tnone\tdrag\tsurface\treadout\n"
    + "window\tone\tAgain\ttab\tfill\t0\t0\t100\t100\t0\t0\ttrue\tfalse\tnone\tdrag\tsurface\treadout\n");
var badDir = Path.Combine(scratch, "modern-surface-bad");
var packedBad = RunPython("tools/modern_package.py", "--surface", badSurfacePath, "--out", badDir,
    "--name", "bad-surface");
Check(packedBad.Code == 0, "bad-surface fixture packs for the refusal test");
var badAddons = new AddonPackages();
Check(badAddons.Deliver(badDir, out var badWhy) == 0
    && badAddons.Windows.Count == 0
    && badWhy.Contains("duplicate-window", StringComparison.Ordinal),
    "duplicate surface window is refused by name: " + badWhy);

// Window order is the document's order, not a dictionary's order.
var multiSurfacePath = Path.Combine(scratch, "multi.surface");
File.WriteAllText(multiSurfacePath, SurfaceDocument.CurrentFormat + "\nsurface\tmulti\nrequires\tobserve\n"
    + "window\tfirst\tFirst\ttab\tfill\t0\t0\t100\t100\t0\t0\ttrue\tfalse\tnone\tdrag\tsurface\treadout\n"
    + "window\tsecond\tSecond\ttab\tfill\t20\t20\t120\t120\t0\t0\ttrue\tfalse\tnone\tdrag\tsurface\treadout\n");
var multiDir = Path.Combine(scratch, "modern-surface-multi");
var packedMulti = RunPython("tools/modern_package.py", "--surface", multiSurfacePath, "--out", multiDir,
    "--name", "multi");
Check(packedMulti.Code == 0, "multi-window surface packs");
var multiRoot = Path.Combine(scratch, "multi-root");
if (Directory.Exists(multiRoot))
    Directory.Delete(multiRoot, true);
Directory.CreateDirectory(Path.Combine(multiRoot, "multi.pkg"));
foreach (var file in new[] { "manifest.json", "payload.bin", "identity.txt" })
    File.Copy(Path.Combine(multiDir, file), Path.Combine(multiRoot, "multi.pkg", file));
var multi = AddonPackages.DiscoverFromRoots([multiRoot]);
Check(multi.Windows.Count == 2
    && multi.Windows[0].RecordId == "first"
    && multi.Windows[1].RecordId == "second",
    "surface windows preserve document order");

Check(!SurfaceDocument.TryParse("unknown.family/2\n", "fixture", out _, out var unknownSchema)
    && unknownSchema.Code == "surface-schema", "unknown schema id is refused");

// Every numeric legacy id is a migration input, not one special /1 case. The packer rewrites
// the header to the current hashed id, and the shell then mounts the upgraded package.
var legacySurfacePath = Path.Combine(scratch, "legacy-surface.surface");
File.WriteAllText(legacySurfacePath, "dl-enclave.surface/7\nsurface\tlegacy-surface\nrequires\tobserve\n"
    + "window\tlegacy-panel\tLegacy\ttab\tfill\t0\t0\t100\t100\t0\t0\ttrue\tfalse\tnone\tdrag\tsurface\treadout\n");
var legacyDir = Path.Combine(scratch, "legacy-surface");
var packedLegacy = RunPython("tools/modern_package.py", "--surface", legacySurfacePath, "--out", legacyDir,
    "--name", "legacy-surface");
Check(packedLegacy.Code == 0
    && packedLegacy.Stdout.Contains("\"upgraded\": true", StringComparison.Ordinal),
    "legacy surface header is upgraded on emission: " + packedLegacy.Stderr.Trim());
var legacyPayload = File.ReadAllText(Path.Combine(legacyDir, "payload.bin"));
Check(legacyPayload.StartsWith(SurfaceDocument.CurrentFormat + "\n", StringComparison.Ordinal),
    "upgraded surface carries the hashed id, not the numeric one");
var legacyAddons = new AddonPackages();
Check(legacyAddons.Deliver(legacyDir, out var legacyWhy) == 1
    && legacyAddons.Windows.Count == 1
    && legacyAddons.Windows[0].RecordId == "legacy-panel",
    "upgraded legacy surface reaches the shell: " + legacyWhy);

var mismatchedSurfacePath = Path.Combine(scratch, "mismatched-surface.surface");
File.WriteAllText(mismatchedSurfacePath, "secure-shell.surface/" + new string('0', 32)
    + "\nsurface\tmismatched\nrequires\tobserve\n");
var mismatchedPack = RunPython("tools/modern_package.py", "--surface", mismatchedSurfacePath,
    "--out", Path.Combine(scratch, "mismatched-surface"), "--name", "mismatched");
Check(mismatchedPack.Code != 0 && mismatchedPack.Stdout.Contains("format-hash-mismatch", StringComparison.Ordinal),
    "a foreign surface hash is refused by name");
Check(!SurfaceDocument.TryParse("", "fixture", out _, out var missing)
    && missing.Code == "surface-schema", "missing declaration is refused");

if (File.Exists(payloadPath))
    File.Delete(payloadPath);

Console.WriteLine($"packagetests: {checks} checks passed");

byte[] MakeEnclaveFrame(string format)
{
    var header = Encoding.UTF8.GetBytes(format + "\npackage\tproof\t1.0.0\t1\n");
    var body = new byte[16 + header.Length + 8];
    new byte[] { 0x44, 0x4c, 0x45, 0x50, 0, 0, 0, 1 }.CopyTo(body, 0);
    body[8] = 1;
    BinaryPrimitives.WriteUInt32LittleEndian(body.AsSpan(12, 4), (uint)header.Length);
    header.CopyTo(body, 16);
    var result = new byte[body.Length + 32];
    body.CopyTo(result, 0);
    SHA256.HashData(body, result.AsSpan(body.Length, 32));
    return result;
}

string ReadEnclaveHeader(byte[] frame)
{
    var length = (int)BinaryPrimitives.ReadUInt32LittleEndian(frame.AsSpan(12, 4));
    return Encoding.UTF8.GetString(frame, 16, length);
}

byte[] ReadEnclaveTrailer(byte[] frame) => frame[^32..];

(string Stdout, string Stderr, int Code) RunPython(params string[] arguments)
{
    var info = new ProcessStartInfo("python")
    {
        WorkingDirectory = root,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        UseShellExecute = false,
    };
    foreach (var argument in arguments)
        info.ArgumentList.Add(argument);
    using var child = Process.Start(info) ?? throw new InvalidOperationException("python did not start");
    var output = child.StandardOutput.ReadToEnd();
    var error = child.StandardError.ReadToEnd();
    child.WaitForExit();
    return (output, error, child.ExitCode);
}
